import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
} from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";

import {
  createSystemOneAdapter,
  DEFAULT_TIMEOUT_MS,
  drainTelemetryEvents,
  evaluate,
  GATEWAY_QUIRKS,
  HttpError,
  MAX_BUFFERED_TELEMETRY_EVENTS,
  postEvaluate,
  SYSTEM_ONE_DEFAULT_QUIRKS,
  SystemOneError,
  type EvaluateInput,
  type EvaluateResult,
  type FallbackReason,
  type FallbackResult,
  type Question,
} from "./index";

// ---------------------------------------------------------------------------
// Fetch stubbing (mocked fetch only — zero network in this suite)
// ---------------------------------------------------------------------------

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

interface FetchBehavior {
  url: string;
  init: RequestInit;
  signal: AbortSignal | null;
}

let seen: SeenRequest[] = [];
let behavior: (request: FetchBehavior) => Response | Promise<Response> = () => {
  throw new Error("fetch behavior not set for this test");
};

function installFetchStub(): void {
  seen = [];
  const respond = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const flat: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      flat[key] = value;
    });
    if (typeof init?.body !== "string") {
      throw new Error("expected a string request body");
    }
    seen.push({ url, headers: flat, bodyText: init.body });
    return Promise.resolve(
      behavior({ url, init: init ?? {}, signal: init?.signal ?? null }),
    );
  };
  // Bun's fetch carries a `preconnect` extra; keep it so the stub stays
  // assignable to `typeof fetch` with no cast.
  const stub = Object.assign(respond, {
    preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
  });
  globalThis.fetch = stub;
}

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "SYSTEM_ONE_API_KEY",
  "TYPESAFE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

beforeEach(() => {
  installFetchStub();
  drainTelemetryEvents();
  delete process.env["SYSTEM_ONE_API_KEY"];
  delete process.env["TYPESAFE_API_KEY"];
  delete process.env["AI_GATEWAY_API_KEY"];
  delete process.env["VERCEL_OIDC_TOKEN"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEnv("SYSTEM_ONE_API_KEY");
  restoreEnv("TYPESAFE_API_KEY");
  restoreEnv("AI_GATEWAY_API_KEY");
  restoreEnv("VERCEL_OIDC_TOKEN");
});

function restoreEnv(key: (typeof ENV_KEYS)[number]): void {
  const saved = savedEnv[key];
  if (saved === undefined) {
    if (key === "SYSTEM_ONE_API_KEY") delete process.env["SYSTEM_ONE_API_KEY"];
    if (key === "TYPESAFE_API_KEY") delete process.env["TYPESAFE_API_KEY"];
    if (key === "AI_GATEWAY_API_KEY") delete process.env["AI_GATEWAY_API_KEY"];
    if (key === "VERCEL_OIDC_TOKEN") delete process.env["VERCEL_OIDC_TOKEN"];
  } else if (key === "SYSTEM_ONE_API_KEY") {
    process.env["SYSTEM_ONE_API_KEY"] = saved;
  } else if (key === "TYPESAFE_API_KEY") {
    process.env["TYPESAFE_API_KEY"] = saved;
  } else if (key === "AI_GATEWAY_API_KEY") {
    process.env["AI_GATEWAY_API_KEY"] = saved;
  } else {
    process.env["VERCEL_OIDC_TOKEN"] = saved;
  }
}

// ---------------------------------------------------------------------------
// Narrowing helpers (no `as` casts on trusted-instrospection data)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function bodyOf(bodyText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(bodyText);
  if (!isRecord(parsed)) throw new Error("request body is not a JSON object");
  return parsed;
}

function firstRequest(): SeenRequest {
  const request = seen[0];
  if (request === undefined) throw new Error("expected one fetch call");
  return request;
}

function lastRequest(): SeenRequest {
  const request = seen[seen.length - 1];
  if (request === undefined)
    throw new Error("expected at least one fetch call");
  return request;
}

function must(value: string | undefined): string {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function header(request: SeenRequest, name: string): string {
  return must(request.headers[name]);
}

function asSuccess(result: EvaluateResult | FallbackResult): EvaluateResult {
  if (result.fallback !== false) throw new Error("expected an EvaluateResult");
  return result;
}

function asFallback(
  result: EvaluateResult | FallbackResult,
  reason: FallbackReason,
): FallbackResult {
  if (result.fallback !== true) throw new Error("expected a FallbackResult");
  expect(result.reason).toBe(reason);
  return result;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Fixtures (live Jev shapes)
// ---------------------------------------------------------------------------

function routeQuestion(): Question {
  return {
    id: "route",
    type: "choice",
    instructions: "What permission decision does this request warrant?",
    criteria: {
      allow: "Low-risk request",
      "step-up": "Elevate for approval",
      deny: "Refuse the request",
    },
  };
}

function riskQuestion(): Question {
  return {
    id: "risk",
    type: "score",
    instructions: "Rate the permission risk of granting this request.",
    criteria: ["Low risk", "Moderate risk", "High risk", "Critical risk"],
  };
}

function escalateQuestion(): Question {
  return {
    id: "escalate",
    type: "noul",
    instructions: "Must this request be escalated for human approval?",
    criteria: {
      true: "Destructive action with no approval",
      false: "Routine action",
    },
  };
}

function mixedInput(): EvaluateInput {
  return {
    state: { goal: "route, rate, and gate one request" },
    questions: [routeQuestion(), riskQuestion(), escalateQuestion()],
  };
}

function mixedAnswers(): Record<string, unknown> {
  return {
    route: {
      type: "choice",
      choice: "step-up",
      probabilities: { allow: 0.15, "step-up": 0.7, deny: 0.15 },
      confidence: 0.68,
    },
    risk: {
      type: "score",
      score: 1.4,
      legend: {
        "0": "Low risk",
        "1": "Moderate risk",
        "2": "High risk",
        "3": "Critical risk",
      },
      probabilities: { "0": 0.1, "1": 0.5, "2": 0.3, "3": 0.1 },
      confidence: 0.62,
    },
    escalate: { type: "noul", noul: 0.91 },
  };
}

function liveBody(): Record<string, unknown> {
  return { model: "jev-1.13.0", answers: mixedAnswers() };
}

function keyedInput(): EvaluateInput {
  return { ...mixedInput(), config: { apiKey: "test-key" } };
}

// ---------------------------------------------------------------------------
// Happy path + wire shape
// ---------------------------------------------------------------------------

describe("evaluate — happy path", () => {
  test("round-trips mixed kinds in one POST with model + map body", async () => {
    behavior = () => jsonResponse(liveBody());
    const result = asSuccess(await evaluate(keyedInput()));
    expect(seen).toHaveLength(1);
    const body = bodyOf(firstRequest().bodyText);
    expect(body["model"]).toBe("jev-latest");
    const questions = body["questions"];
    if (!isRecord(questions)) throw new Error("questions is not a map");
    expect(Object.keys(questions).sort()).toEqual([
      "escalate",
      "risk",
      "route",
    ]);
    const route = questions["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    expect(route["type"]).toBe("choice");
    expect(isRecord(route["criteria"])).toBe(true);
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.map((d) => d.id)).toEqual([
      "route",
      "risk",
      "escalate",
    ]);
    const [routeDecision, riskDecision, escalateDecision] = result.decisions;
    if (routeDecision?.type !== "choice")
      throw new Error("expected a choice decision");
    expect(routeDecision.choice).toBe("step-up");
    if (riskDecision?.type !== "score")
      throw new Error("expected a score decision");
    expect(riskDecision.score).toBe(1.4);
    if (escalateDecision?.type !== "noul")
      throw new Error("expected a noul decision");
    expect(escalateDecision.noul).toBe(0.91);
    expect("confidence" in escalateDecision).toBe(false);
    expect(result.modelId).toBe("jev-1.13.0");
    expect(result.backend).toBe("system-one");
  });

  test("boolean alias maps to native noul on the wire", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { gate: { type: "noul", noul: 0.2 } },
      });
    const result = asSuccess(
      await evaluate({
        state: {},
        questions: [{ id: "gate", type: "boolean", instructions: "Gate it?" }],
        config: { apiKey: "test-key" },
      }),
    );
    const questions = bodyOf(firstRequest().bodyText)["questions"];
    if (!isRecord(questions)) throw new Error("questions is not a map");
    const gate = questions["gate"];
    if (!isRecord(gate)) throw new Error("gate is not a record");
    expect(gate["type"]).toBe("noul");
    const decision = result.decisions[0];
    if (decision?.type !== "noul") throw new Error("expected a noul decision");
    expect(decision.noul).toBe(0.2);
  });

  test("a caller-set custom URL is the one fetched (URL-provider proof)", async () => {
    behavior = () => jsonResponse(liveBody());
    const custom = "https://proxy.test/jev/evaluate";
    const result = asSuccess(
      await evaluate({
        ...mixedInput(),
        config: {
          apiKey: "test-key",
          endpoint: { kind: "custom", url: custom },
        },
      }),
    );
    expect(firstRequest().url).toBe(custom);
    expect(result.backend).toBe("custom");
    expect(result.decisions).toHaveLength(3);
  });

  test("a custom endpoint without a url throws before any fetch", async () => {
    let thrown: unknown;
    try {
      await evaluate({
        ...mixedInput(),
        config: {
          apiKey: "test-key",
          // @ts-expect-error deliberately invalid: url is required on custom
          endpoint: { kind: "custom" },
        },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(seen).toHaveLength(0);
  });

  test("gateway endpoint posts to the gateway URL with the gateway model", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          route: {
            type: "choice",
            choice: "allow",
            probabilities: { allow: 0.9, "step-up": 0.07, deny: 0.03 },
            confidence: 0.88,
          },
        },
      });
    const result = asSuccess(
      await evaluate({
        state: {},
        questions: [routeQuestion()],
        config: { apiKey: "gw-key", endpoint: { kind: "gateway" } },
      }),
    );
    expect(firstRequest().url).toBe(must(GATEWAY_QUIRKS.baseUrl));
    expect(bodyOf(firstRequest().bodyText)["model"]).toBe("typesafe-ai/jev");
    expect(result.backend).toBe("gateway");
    const decision = result.decisions[0];
    if (decision?.type !== "choice")
      throw new Error("expected a choice decision");
    expect(decision.choice).toBe("allow");
  });

  test("per-decision extras validate and are ignored, never echoed", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    route["reasoning"] = "backend-attached metadata";
    behavior = () => jsonResponse({ model: "jev-1.13.0", answers });
    const result = asSuccess(await evaluate(keyedInput()));
    const returned = result.decisions[0];
    expect(returned).toEqual({
      id: "route",
      type: "choice",
      choice: "step-up",
      probabilities: { allow: 0.15, "step-up": 0.7, deny: 0.15 },
      confidence: 0.68,
    });
    expect("reasoning" in (returned ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("evaluate — input validation", () => {
  test("duplicate question ids throw a typed error before any fetch", async () => {
    let thrown: unknown;
    try {
      await evaluate({
        state: {},
        questions: [routeQuestion(), routeQuestion()],
        config: { apiKey: "test-key" },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(seen).toHaveLength(0);
  });

  test("instructions are required and criteria counts are bounded", async () => {
    const cases: Question[] = [
      { id: "q", type: "choice", instructions: "", criteria: { a: null } },
      { id: "q", type: "score", instructions: "Rate.", criteria: ["only-one"] },
    ];
    for (const question of cases) {
      let thrown: unknown;
      try {
        await evaluate({
          state: {},
          questions: [question],
          config: { apiKey: "test-key" },
        });
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(SystemOneError);
    }
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

describe("evaluate — response validation", () => {
  function withAnswers(
    answers: Record<string, unknown>,
  ): (request: FetchBehavior) => Response {
    return () => jsonResponse({ model: "jev-1.13.0", answers });
  }

  test("unknown answer ids fail closed", async () => {
    const answers = mixedAnswers();
    answers["ghost"] = { type: "noul", noul: 0.5 };
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("dropped answers fail closed", async () => {
    const { risk: _dropped, ...rest } = mixedAnswers();
    behavior = withAnswers(rest);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("duplicate answer ids are impossible in a map, unknown ids catch typos", async () => {
    const answers = { route: mixedAnswers()["route"] };
    if (!isRecord(answers["route"])) throw new Error("route is not a record");
    behavior = withAnswers({
      ...answers,
      Route: {
        type: "choice",
        choice: "allow",
        probabilities: { allow: 1 },
        confidence: 1,
      },
    });
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("kind mismatch fails closed", async () => {
    const answers = mixedAnswers();
    answers["route"] = {
      type: "score",
      score: 1,
      legend: { "0": "a", "1": "b" },
      probabilities: { "0": 0.5, "1": 0.5 },
      confidence: 0.5,
    };
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("boolean questions require native noul answers", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          gate: {
            type: "choice",
            choice: "x",
            probabilities: { x: 1 },
            confidence: 1,
          },
        },
      });
    asFallback(
      await evaluate({
        state: {},
        questions: [{ id: "gate", type: "boolean", instructions: "Gate it?" }],
        config: { apiKey: "test-key" },
      }),
      "parse-error",
    );
  });

  test("illegal choice options and out-of-range scores fail closed", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    route["choice"] = "maybe";
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");

    const answers2 = mixedAnswers();
    const risk = answers2["risk"];
    if (!isRecord(risk)) throw new Error("risk is not a record");
    risk["score"] = 9;
    behavior = withAnswers(answers2);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("confidence out-of-range fails closed", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    route["confidence"] = 2;
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("noul answers without confidence are valid", async () => {
    const answers = mixedAnswers();
    const escalate = answers["escalate"];
    if (!isRecord(escalate)) throw new Error("escalate is not a record");
    expect("confidence" in escalate).toBe(false);
    behavior = withAnswers(answers);
    const result = asSuccess(await evaluate(keyedInput()));
    const decision = result.decisions[2];
    if (decision?.type !== "noul") throw new Error("expected a noul decision");
    expect(decision.noul).toBe(0.91);
  });

  test("a noul answer with no noul value fails closed", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { gate: { type: "noul" } },
      });
    const failed = asFallback(
      await evaluate({
        state: {},
        questions: [{ id: "gate", type: "boolean", instructions: "Gate it?" }],
        config: { apiKey: "test-key" },
      }),
      "parse-error",
    );
    expect(failed.detail).toContain("noul");
  });

  test("a choice answer missing confidence fails closed", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    delete route["confidence"];
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("probability maps with extra keys fail closed", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    route["probabilities"] = {
      allow: 0.5,
      "step-up": 0.49,
      deny: 0,
      junk: 0.01,
    };
    behavior = withAnswers(answers);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("approximate probability sums pass, skewed sums fail", async () => {
    const answers = mixedAnswers();
    const route = answers["route"];
    if (!isRecord(route)) throw new Error("route is not a record");
    route["probabilities"] = { allow: 0.15, "step-up": 0.7, deny: 0.16 };
    behavior = withAnswers(answers);
    asSuccess(await evaluate(keyedInput()));

    const answers2 = mixedAnswers();
    const route2 = answers2["route"];
    if (!isRecord(route2)) throw new Error("route is not a record");
    route2["probabilities"] = { allow: 0.5, "step-up": 0.7, deny: 0.5 };
    behavior = withAnswers(answers2);
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("missing legend or legend key mismatch fails closed", async () => {
    const base = mixedAnswers();
    const risk = base["risk"];
    if (!isRecord(risk)) throw new Error("risk is not a record");
    const { legend: _dropped, ...riskParts } = risk;
    behavior = withAnswers({ ...base, risk: riskParts });
    asFallback(await evaluate(keyedInput()), "parse-error");
  });

  test("string state and structured instructions/criteria pass through", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: 0.5 } },
      });
    const result = asSuccess(
      await evaluate({
        state: "Help! My payouts have been failing for 3 days.",
        questions: [
          {
            id: "q",
            type: "noul",
            instructions: {
              context: { note: "3-day outage" },
              question: "Does this convey urgency about `context`?",
            },
            criteria: {
              true: { means: "explicitly time-sensitive" },
              false: "no urgency expressed",
            },
          },
        ],
        config: { apiKey: "test-key" },
      }),
    );
    const body = bodyOf(firstRequest().bodyText);
    expect(body["state"]).toBe(
      "Help! My payouts have been failing for 3 days.",
    );
    const q = body["questions"];
    if (!isRecord(q) || !isRecord(q["q"])) throw new Error("missing q");
    expect(isRecord(q["q"]["instructions"])).toBe(true);
    expect(result.decisions).toHaveLength(1);
  });

  test("a 422 naming the field maps to parse-error", async () => {
    behavior = (_request) =>
      jsonResponse(
        {
          message:
            "questions.route.type: expected one of 'noul', 'choice', 'score'",
          error_type: "validation",
        },
        422,
      );
    const failed = asFallback(await evaluate(keyedInput()), "http-error");
    expect(failed.httpStatus).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Auth, timeout, transport
// ---------------------------------------------------------------------------

describe("evaluate — auth and transport", () => {
  test("no key anywhere fails closed with zero fetch", async () => {
    const result = asFallback(await evaluate(mixedInput()), "no-key");
    expect(seen).toHaveLength(0);
    expect(result.backendAttempted).toBe(
      must(SYSTEM_ONE_DEFAULT_QUIRKS.baseUrl),
    );
  });

  test("official prefers TYPESAFE_API_KEY, then legacy fallback", async () => {
    behavior = () => jsonResponse(liveBody());
    process.env["TYPESAFE_API_KEY"] = "ts-key";
    process.env["SYSTEM_ONE_API_KEY"] = "legacy-key";
    await evaluate(mixedInput());
    expect(header(firstRequest(), "authorization")).toBe("Bearer ts-key");
    delete process.env["TYPESAFE_API_KEY"];
    await evaluate(mixedInput());
    expect(header(lastRequest(), "authorization")).toBe("Bearer legacy-key");
  });

  test("gateway prefers AI_GATEWAY_API_KEY, then OIDC, then legacy", async () => {
    behavior = () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          route: {
            type: "choice",
            choice: "allow",
            probabilities: { allow: 0.9, "step-up": 0.07, deny: 0.03 },
            confidence: 0.88,
          },
        },
      });
    const gatewayInput: EvaluateInput = {
      state: {},
      questions: [routeQuestion()],
      config: { endpoint: { kind: "gateway" } },
    };
    process.env["VERCEL_OIDC_TOKEN"] = "oidc-token";
    process.env["SYSTEM_ONE_API_KEY"] = "legacy-key";
    await evaluate(gatewayInput);
    expect(header(firstRequest(), "authorization")).toBe("Bearer oidc-token");
    process.env["AI_GATEWAY_API_KEY"] = "gw-key";
    await evaluate(gatewayInput);
    expect(header(lastRequest(), "authorization")).toBe("Bearer gw-key");
  });

  test("per-call apiKey wins; empty string falls through to env", async () => {
    behavior = () => jsonResponse(liveBody());
    process.env["TYPESAFE_API_KEY"] = "env-key";
    await evaluate({ ...mixedInput(), config: { apiKey: "" } });
    expect(header(firstRequest(), "authorization")).toBe("Bearer env-key");
    await evaluate({ ...mixedInput(), config: { apiKey: "call-key" } });
    expect(header(lastRequest(), "authorization")).toBe("Bearer call-key");
  });

  test("default 1500ms budget aborts, per-call override respected", async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    behavior = (request) => {
      observed.signal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    const failed = asFallback(
      await evaluate({
        ...mixedInput(),
        config: { apiKey: "k", timeoutMs: 20 },
      }),
      "timeout",
    );
    expect(failed.latencyMs).toBeLessThan(DEFAULT_TIMEOUT_MS);
    if (observed.signal === null) throw new Error("expected an abort signal");
    expect(observed.signal.aborted).toBe(true);
  });

  test("invalid timeoutMs falls back to the default", async () => {
    behavior = () => jsonResponse(liveBody());
    const result = asSuccess(
      await evaluate({
        ...mixedInput(),
        config: { apiKey: "k", timeoutMs: Number.NaN },
      }),
    );
    expect(result.fallback).toBe(false);
  });

  test("HTTP 500 maps to http-error with status; refused fetch maps to network", async () => {
    behavior = () =>
      jsonResponse({ message: "boom", error_type: "server" }, 500);
    const failed = asFallback(await evaluate(keyedInput()), "http-error");
    expect(failed.httpStatus).toBe(500);
    behavior = () => {
      throw new TypeError("fetch failed");
    };
    asFallback(await evaluate(keyedInput()), "network");
  });

  test("non-JSON 2xx body maps to network", async () => {
    behavior = () => new Response("not json{{{", { status: 200 });
    asFallback(await evaluate(keyedInput()), "network");
  });

  test("backendAttempted strips URL credentials", async () => {
    behavior = () => {
      throw new TypeError("fetch failed");
    };
    const failed = asFallback(
      await evaluate({
        ...mixedInput(),
        config: {
          apiKey: "test-key",
          endpoint: {
            kind: "custom",
            url: "https://user:s3cret@proxy.test/evaluate",
          },
        },
      }),
      "network",
    );
    expect(failed.backendAttempted).toBe("https://proxy.test/evaluate");
  });

  test("no-key fallback details which sources were checked", async () => {
    const failed = asFallback(await evaluate(mixedInput()), "no-key");
    expect(failed.detail).toContain("TYPESAFE_API_KEY");
  });

  test("usage is surfaced on the result when the backend reports it", async () => {
    behavior = () =>
      jsonResponse({
        ...liveBody(),
        usage: { input_tokens: 296, output_tokens: 20 },
      });
    const result = asSuccess(await evaluate(keyedInput()));
    expect(result.usage).toEqual({ inputTokens: 296, outputTokens: 20 });
  });

  test("key material never appears in errors or telemetry", async () => {
    const secret = "super-secret-key";
    behavior = () => jsonResponse({ message: "nope", error_type: "auth" }, 401);
    const failed = asFallback(
      await evaluate({ ...mixedInput(), config: { apiKey: secret } }),
      "http-error",
    );
    expect(JSON.stringify(failed)).not.toContain(secret);

    let thrown: unknown;
    try {
      await evaluate({
        state: {},
        questions: [routeQuestion(), routeQuestion()],
        config: { apiKey: secret },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(String(thrown)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

describe("adapter", () => {
  function turns(): ConversationTurn[] {
    return [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "Deploy?" }],
      },
      {
        role: "assistant",
        timestamp: 0,
        content: [{ type: "text", text: "Approved." }],
      },
    ];
  }

  test("buildRequest posts map body with model and sentinel auth", () => {
    const adapter = createSystemOneAdapter();
    const request = adapter.buildRequest(turns(), "jev-latest", {});
    expect(request.url).toBe(must(SYSTEM_ONE_DEFAULT_QUIRKS.baseUrl));
    expect(request.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    const body = bodyOf(request.body);
    expect(body["model"]).toBe("jev-latest");
    const questions = body["questions"];
    if (!isRecord(questions)) throw new Error("questions is not a map");
    const response = questions["response"];
    if (!isRecord(response)) throw new Error("response is not a record");
    expect(response["type"]).toBe("noul");
  });

  test("buildRequest rejects invalid providerOptions.systemOne", () => {
    const adapter = createSystemOneAdapter();
    let thrown: unknown;
    try {
      adapter.buildRequest(turns(), "jev-latest", {
        providerOptions: { systemOne: { questions: [{ nope: true }] } },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ProtocolMismatchError);
  });

  test("providerOptions.systemOne rejects duplicate question ids", () => {
    const adapter = createSystemOneAdapter();
    let thrown: unknown;
    try {
      adapter.buildRequest(turns(), "jev-latest", {
        providerOptions: {
          systemOne: {
            questions: [
              { id: "dup", type: "boolean", instructions: "Q1?" },
              { id: "dup", type: "boolean", instructions: "Q2?" },
            ],
          },
        },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ProtocolMismatchError);
  });

  test("extractRetryAfterMs parses seconds and HTTP dates", () => {
    const adapter = createSystemOneAdapter();
    const extract = adapter.extractRetryAfterMs;
    if (extract === undefined) throw new Error("expected extractRetryAfterMs");
    expect(extract(new Headers({ "retry-after": "2" }))).toBe(2000);
    const at = new Date(Date.now() + 60_000).toUTCString();
    const ms = extract(new Headers({ "retry-after": at }));
    if (ms === undefined) throw new Error("expected a delay");
    expect(ms).toBeGreaterThan(0);
    expect(extract(new Headers())).toBeUndefined();
    expect(extract(new Headers({ "retry-after": "garbage" }))).toBeUndefined();
  });

  test("usage event carries real token counts when reported", () => {
    const adapter = createSystemOneAdapter();
    const events = adapter.parseJSONResponse(
      JSON.stringify({
        model: "jev-1.13.0",
        usage: { input_tokens: 296, output_tokens: 20 },
        answers: { response: { type: "noul", noul: 0.4 } },
      }),
    );
    const usage = events.find((e) => e.type === "inference.usage");
    if (usage?.type !== "inference.usage")
      throw new Error("expected a usage event");
    expect(usage.data.usage.input).toBe(296);
    expect(usage.data.usage.output).toBe(20);
  });

  test("parseJSONResponse decodes answers map to text deltas + usage", () => {
    const adapter = createSystemOneAdapter();
    const events = adapter.parseJSONResponse(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          response: { type: "noul", noul: 0.4 },
        },
      }),
    );
    const deltas = events.filter((e) => e.type === "inference.text.delta");
    const usage = events.filter((e) => e.type === "inference.usage");
    expect(deltas).toHaveLength(1);
    expect(usage).toHaveLength(1);
    const first = deltas[0];
    if (first === undefined) throw new Error("expected one text delta");
    if (first.type !== "inference.text.delta") {
      throw new Error("expected a text delta event");
    }
    const token = first.data.token;
    if (typeof token !== "string") throw new Error("expected a string token");
    const decision: unknown = JSON.parse(token);
    if (!isRecord(decision)) throw new Error("expected a decision record");
    expect(decision["id"]).toBe("response");
    expect(decision["type"]).toBe("noul");
  });

  test("parseResponse is an alias of parseJSONResponse", () => {
    const adapter = createSystemOneAdapter();
    const body = JSON.stringify({
      model: "jev-1.13.0",
      answers: { response: { type: "noul", noul: 0.4 } },
    });
    expect(adapter.parseResponse(body)).toEqual(
      adapter.parseJSONResponse(body),
    );
  });

  test("parseJSONResponse rejects off-schema bodies", () => {
    const adapter = createSystemOneAdapter();
    let thrown: unknown;
    try {
      adapter.parseJSONResponse(
        JSON.stringify({ answers: { x: { type: "bogus" } } }),
      );
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ProtocolMismatchError);
    let malformed: unknown;
    try {
      adapter.parseJSONResponse("{{{not json");
    } catch (cause) {
      malformed = cause;
    }
    expect(malformed).toBeInstanceOf(ProtocolMismatchError);
    let missingValue: unknown;
    try {
      adapter.parseJSONResponse(
        JSON.stringify({ answers: { x: { type: "noul" } } }),
      );
    } catch (cause) {
      missingValue = cause;
    }
    expect(missingValue).toBeInstanceOf(ProtocolMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Telemetry ring
// ---------------------------------------------------------------------------

describe("telemetry", () => {
  test("ring caps buffered events and drains in order", async () => {
    behavior = () => jsonResponse(liveBody());
    for (let i = 0; i < MAX_BUFFERED_TELEMETRY_EVENTS + 5; i++) {
      await evaluate(keyedInput());
    }
    const events = drainTelemetryEvents();
    expect(events.length).toBeLessThanOrEqual(MAX_BUFFERED_TELEMETRY_EVENTS);
    expect(drainTelemetryEvents()).toHaveLength(0);
    for (const event of events) {
      expect("modelId" in event).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// postEvaluate unit behavior
// ---------------------------------------------------------------------------

describe("postEvaluate", () => {
  test("sends JSON with bearer auth only when keyed", async () => {
    behavior = () => jsonResponse({ ok: true });
    await postEvaluate("https://example.test/eval", { a: 1 }, { apiKey: "k" });
    expect(header(firstRequest(), "authorization")).toBe("Bearer k");
    await postEvaluate("https://example.test/eval", { a: 1 }, {});
    expect(lastRequest().headers["authorization"]).toBeUndefined();
  });

  test("non-2xx throws HttpError with status", async () => {
    behavior = () =>
      jsonResponse({ message: "denied", error_type: "auth" }, 401);
    let thrown: unknown;
    try {
      await postEvaluate("https://example.test/eval", {}, { apiKey: "k" });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(HttpError);
  });
});

// ---------------------------------------------------------------------------
// Live keyed cases (skip cleanly without credentials — T1..T7)
// ---------------------------------------------------------------------------

const LIVE_URL = process.env["SYSTEM_ONE_LIVE_URL"];
const LIVE_KEY = process.env["SYSTEM_ONE_LIVE_KEY"];
const LIVE_MODEL = process.env["SYSTEM_ONE_LIVE_MODEL"] ?? "typesafe-ai/jev";
const liveDescribe =
  LIVE_URL !== undefined && LIVE_KEY !== undefined ? describe : describe.skip;

liveDescribe("live — permission-risk cases against a real endpoint", () => {
  // The outer harness stubs fetch for mocked tests; live cases need the real
  // transport back. This runs after the outer beforeEach, so it wins.
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  function liveInput(
    state: Record<string, unknown>,
    questions: Question[],
  ): EvaluateInput {
    return {
      state,
      questions,
      config: {
        apiKey: must(LIVE_KEY),
        endpoint: { kind: "custom", url: must(LIVE_URL), model: LIVE_MODEL },
      },
    };
  }

  test("T1 — choice route returns a valid option with full coverage", async () => {
    const result = asSuccess(
      await evaluate(
        liveInput(
          {
            principal: "deploy-bot",
            action: "prod.deploy",
            scope: "payments-api",
            mfa: true,
            priorDenies: 0,
            window: "2026-09-19T02:10Z",
          },
          [routeQuestion()],
        ),
      ),
    );
    const decision = result.decisions[0];
    if (decision?.type !== "choice") {
      throw new Error("expected a choice decision");
    }
    expect(["allow", "step-up", "deny"]).toContain(decision.choice);
    for (const option of ["allow", "step-up", "deny"]) {
      const probability = decision.probabilities[option];
      if (probability === undefined)
        throw new Error(`missing probability for ${option}`);
      expect(probability).toBeGreaterThanOrEqual(0);
    }
  });

  test("T2 — score risk rubric lands inside the level range", async () => {
    const result = asSuccess(
      await evaluate(
        liveInput(
          {
            principal: "deploy-bot",
            action: "prod.deploy",
            scope: "payments-api",
          },
          [riskQuestion()],
        ),
      ),
    );
    const decision = result.decisions[0];
    if (decision?.type !== "score") {
      throw new Error("expected a score decision");
    }
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.score).toBeLessThanOrEqual(3);
    expect(Object.keys(decision.legend)).toHaveLength(4);
  });

  test("T3/T4 — noul gates escalate destructive actions, pass routine reads", async () => {
    const yes = asSuccess(
      await evaluate(
        liveInput(
          {
            action: "db.dropTable",
            table: "ledger",
            approval: "none",
            actor: "intern",
          },
          [escalateQuestion()],
        ),
      ),
    );
    const yesDecision = yes.decisions[0];
    if (yesDecision?.type !== "noul") {
      throw new Error("expected a noul decision");
    }
    expect(yesDecision.noul).toBeGreaterThanOrEqual(0.8);

    const no = asSuccess(
      await evaluate(
        liveInput(
          {
            action: "docs.read",
            resource: "runbook",
            approval: "n/a",
            actor: "oncall",
          },
          [escalateQuestion()],
        ),
      ),
    );
    const noDecision = no.decisions[0];
    if (noDecision?.type !== "noul") {
      throw new Error("expected a noul decision");
    }
    expect(noDecision.noul).toBeLessThanOrEqual(0.2);
  });

  test("T5 — parallel mixed call answers all three primitives", async () => {
    const result = asSuccess(
      await evaluate(
        liveInput({ goal: "route, rate, gate" }, mixedInput().questions),
      ),
    );
    expect(result.decisions.map((d) => d.id).sort()).toEqual([
      "escalate",
      "risk",
      "route",
    ]);
  });

  test("T6 — ambiguous state returns valid shapes for human review", async () => {
    const result = await evaluate(
      liveInput({ action: "grant", scope: "unknown", actor: "unknown" }, [
        routeQuestion(),
        riskQuestion(),
      ]),
    );
    if (result.fallback === true)
      throw new Error(`unexpected fallback: ${result.reason}`);
    expect(result.decisions).toHaveLength(2);
  });

  test("T7 — bad key maps to http-error with 401, never a throw", async () => {
    const result = await evaluate({
      state: { principal: "deploy-bot" },
      questions: [routeQuestion()],
      config: {
        apiKey: "INVALID",
        endpoint: { kind: "custom", url: must(LIVE_URL), model: LIVE_MODEL },
      },
    });
    const failed = asFallback(result, "http-error");
    expect(failed.httpStatus).toBe(401);
  });
});
