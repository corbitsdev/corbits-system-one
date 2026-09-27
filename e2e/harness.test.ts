// End-to-end through the @intx/inference-testing harness: the adapter runs
// inside a production `runInference` turn, and `evaluate` runs on the
// harness's virtual clock and fetch. Everything imports from the public
// entry.

import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRegistry } from "@intx/inference";
import { setupHarness, type Harness } from "@intx/inference-testing";
import type { InferenceEvent, InferenceSource } from "@intx/types/runtime";

import {
  createSystemOneAdapter,
  Decision,
  evaluate,
  SYSTEM_ONE_PROVIDER,
  SystemOneError,
  type EvaluateInput,
  type SystemOneTelemetryEvent,
} from "../src/index";

const URL_ = "https://system-one.test/evaluate";

const registry: AdapterRegistry = {
  has: (provider) => provider === SYSTEM_ONE_PROVIDER,
  resolve: () =>
    createSystemOneAdapter({ endpoint: { kind: "custom", url: URL_ } }),
};

const source: InferenceSource = {
  id: "system-one:jev",
  provider: SYSTEM_ONE_PROVIDER,
  baseURL: URL_,
  credentialId: "key",
  model: "jev-latest",
};

const answerBody = {
  model: "jev-1.13.0",
  answers: {
    route: {
      type: "choice",
      choice: "deny",
      probabilities: { allow: 0.14, deny: 0.86 },
      confidence: 0.86,
    },
    escalate: { type: "noul", noul: 0.91 },
  },
  usage: { input_tokens: 296, output_tokens: 20 },
};

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("adapter turn through runInference", () => {
  test("emits one decision delta per answer, then usage", async () => {
    harness = setupHarness({ adapters: registry });
    const stream = harness.scenario.createStream();
    harness.scenario.whenRequestMatches((req) => req.url === URL_, stream, {
      headers: { "content-type": "application/json" },
    });
    stream.enqueueAll([new TextEncoder().encode(JSON.stringify(answerBody))], {
      startAt: 0,
    });

    const events: InferenceEvent[] = [];
    let seq = 0;
    const drain = (async () => {
      for await (const event of harness.runInference({
        turns: [
          {
            role: "user",
            timestamp: 0,
            content: [{ type: "text", text: "Deploy to production?" }],
          },
        ],
        source,
        nextSeq: () => seq++,
        readMaterial: (credentialId) => ({ secret: credentialId }),
      }))
        events.push(event);
    })();
    await harness.run();
    await drain;

    const [request] = harness.scenario.matchedRequests();
    expect(request?.headers.get("authorization")).toBe("Bearer key");

    const decisions = events.flatMap((event) =>
      event.type === "inference.text.delta"
        ? [Decision.assert(JSON.parse(event.data.token))]
        : [],
    );
    expect(decisions).toEqual([
      {
        id: "route",
        type: "choice",
        choice: "deny",
        confidence: 0.86,
        probabilities: { allow: 0.14, deny: 0.86 },
      },
      { id: "escalate", type: "noul", noul: 0.91 },
    ]);
    const usage = events.find((event) => event.type === "inference.usage");
    expect(usage?.type === "inference.usage" && usage.data.usage).toMatchObject(
      { input: 296, output: 20 },
    );
    expect(events.some((event) => event.type === "inference.error")).toBe(
      false,
    );
  });
});

const input: EvaluateInput = {
  state: { action: "deploy" },
  questions: [
    {
      id: "route",
      type: "choice",
      instructions: "Route?",
      criteria: { allow: "ok", deny: "no" },
    },
    { id: "escalate", type: "boolean", instructions: "Escalate?" },
  ],
  config: { apiKey: "key", endpoint: { kind: "custom", url: URL_ } },
};

async function evaluateAgainst(
  body: string,
  status: number,
  events: SystemOneTelemetryEvent[] = [],
  call: EvaluateInput = input,
  url: string = URL_,
): Promise<Awaited<ReturnType<typeof evaluate>>> {
  const active = setupHarness();
  harness = active;
  const stream = active.scenario.createStream();
  active.scenario.whenRequestMatches((req) => req.url === url, stream, {
    status,
    headers: { "content-type": "application/json" },
  });
  stream.enqueueAll([new TextEncoder().encode(body)], { startAt: 0 });
  const pending = evaluate(call, {
    deps: active.deps,
    onTelemetry: (event) => events.push(event),
  });
  await active.run();
  return pending;
}

describe("evaluate over the harness transport", () => {
  test("returns decisions and emits start then success telemetry", async () => {
    const events: SystemOneTelemetryEvent[] = [];
    const result = await evaluateAgainst(
      JSON.stringify(answerBody),
      200,
      events,
    );
    expect(result).toMatchObject({
      fallback: false,
      modelId: "jev-1.13.0",
      usage: { inputTokens: 296, outputTokens: 20 },
    });
    expect(result.fallback === false && result.decisions.length).toBe(2);
    expect(events.map((event) => event.event)).toEqual([
      "evaluate.start",
      "evaluate.success",
    ]);
  });

  test.each([503, 422])(
    "HTTP %d is an http-error fallback carrying the status",
    async (status) => {
      const events: SystemOneTelemetryEvent[] = [];
      const result = await evaluateAgainst("{}", status, events);
      expect(result).toMatchObject({
        fallback: true,
        reason: "http-error",
        httpStatus: status,
      });
      expect(events.at(-1)).toMatchObject({
        event: "evaluate.fallback",
        reason: "http-error",
      });
    },
  );

  test("the gateway endpoint posts to the gateway URL with the gateway model", async () => {
    const gatewayUrl = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
    const result = await evaluateAgainst(
      JSON.stringify(answerBody),
      200,
      [],
      {
        state: input.state,
        questions: input.questions,
        config: { apiKey: "gw-key", endpoint: { kind: "gateway" } },
      },
      gatewayUrl,
    );
    expect(result).toMatchObject({ fallback: false, backend: "gateway" });
    const [request] = harness?.scenario.matchedRequests() ?? [];
    expect(request?.url).toBe(gatewayUrl);
    expect(await request?.json()).toMatchObject({ model: "typesafe-ai/jev" });
  });

  test("per-decision extras are validated and never echoed", async () => {
    const withExtra = {
      model: answerBody.model,
      answers: {
        route: {
          type: "choice",
          choice: "deny",
          probabilities: { allow: 0.14, deny: 0.86 },
          confidence: 0.86,
          reasoning: "backend note",
        },
        escalate: answerBody.answers.escalate,
      },
    };
    const result = await evaluateAgainst(JSON.stringify(withExtra), 200);
    expect(result.fallback === false && result.decisions[0]).toEqual({
      id: "route",
      type: "choice",
      choice: "deny",
      confidence: 0.86,
      probabilities: { allow: 0.14, deny: 0.86 },
    });
  });

  test("a custom endpoint without a url throws before any fetch", async () => {
    harness = setupHarness();
    let fetches = 0;
    const pending = evaluate(
      {
        state: input.state,
        questions: input.questions,
        config: { apiKey: "key", endpoint: { kind: "custom", url: "" } },
      },
      {
        deps: {
          fetch: () => {
            fetches += 1;
            return Promise.reject(new Error("unexpected fetch"));
          },
          scheduler: harness.deps.scheduler,
        },
      },
    );
    const thrown = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(thrown).toMatchObject({ code: "config-error" });
    expect(fetches).toBe(0);
  });

  test("no key is a no-key fallback naming every source it checked", async () => {
    harness = setupHarness();
    const saved = process.env["TYPESAFE_API_KEY"];
    const legacy = process.env["SYSTEM_ONE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];
    delete process.env["SYSTEM_ONE_API_KEY"];
    try {
      const result = await evaluate(
        { state: input.state, questions: input.questions },
        { deps: harness.deps },
      );
      expect(result).toMatchObject({ fallback: true, reason: "no-key" });
      const detail = result.fallback ? result.detail : undefined;
      expect(detail).toContain("config.apiKey");
      expect(detail).toContain("TYPESAFE_API_KEY");
      expect(detail).toContain("SYSTEM_ONE_API_KEY");
    } finally {
      if (saved !== undefined) process.env["TYPESAFE_API_KEY"] = saved;
      if (legacy !== undefined) process.env["SYSTEM_ONE_API_KEY"] = legacy;
    }
  });

  test("a non-JSON 2xx body is a parse-error fallback", async () => {
    const result = await evaluateAgainst("not json{{{", 200);
    expect(result).toMatchObject({ fallback: true, reason: "parse-error" });
  });

  test("a refused connection is a network fallback", async () => {
    harness = setupHarness();
    const result = await evaluate(input, {
      deps: {
        fetch: () => Promise.reject(new TypeError("connection refused")),
        scheduler: harness.deps.scheduler,
      },
    });
    expect(result).toMatchObject({ fallback: true, reason: "network" });
  });
});

describe("evaluate on the virtual clock", () => {
  test("a /evaluate body stalled past timeoutMs fails closed with a timeout fallback", async () => {
    harness = setupHarness({ enableInferenceTimers: true });
    const stall = harness.scenario.stall();

    const pending = evaluate(
      {
        state: { action: "deploy" },
        questions: [
          { id: "escalate", type: "boolean", instructions: "Escalate?" },
        ],
        config: {
          apiKey: "key",
          endpoint: { kind: "custom", url: URL_ },
          timeoutMs: 50,
        },
      },
      { deps: harness.deps },
    );
    await harness.run();
    const result = await pending;

    expect(stall.aborted).toBe(true);
    expect(result).toMatchObject({
      fallback: true,
      reason: "timeout",
      latencyMs: 50,
      backendAttempted: URL_,
    });
  });
});
