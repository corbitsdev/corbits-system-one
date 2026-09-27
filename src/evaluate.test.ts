import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDefaultScheduler } from "@intx/inference";

import type { EvaluateDeps } from "./client";
import { DEFAULT_TIMEOUT_MS } from "./config";
import { SystemOneError } from "./errors";
import type { SystemOneTelemetryEvent } from "./telemetry";
import { checkAnswers, evaluate } from "./evaluate";
import type {
  EndpointConfig,
  EvaluateConfig,
  Question,
  WireAnswer,
} from "./schemas";

const questions: Question[] = [
  {
    id: "route",
    type: "choice",
    instructions: "Route?",
    criteria: { allow: "ok", "step-up": "elevate", deny: "no" },
  },
  {
    id: "risk",
    type: "score",
    instructions: "Rate the risk.",
    criteria: ["Low", "Moderate", "High", "Critical"],
  },
  { id: "gate", type: "boolean", instructions: "Escalate?" },
];

function answers(): Record<string, WireAnswer> {
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
      legend: { "0": "Low", "1": "Moderate", "2": "High", "3": "Critical" },
      probabilities: { "0": 0.1, "1": 0.5, "2": 0.3, "3": 0.1 },
      confidence: 0.62,
    },
    gate: { type: "noul", noul: 0.91 },
  };
}

describe("checkAnswers", () => {
  test("accepts answers matching every question, with approximate sums", () => {
    const valid = answers();
    valid["route"] = {
      type: "choice",
      choice: "deny",
      probabilities: { allow: 0.15, "step-up": 0.7, deny: 0.16 },
      confidence: 0.5,
    };
    expect(checkAnswers(questions, valid)).toBeUndefined();
  });

  const violations: [string, (a: Record<string, WireAnswer>) => void][] = [
    ["unknown id", (a) => (a["ghost"] = { type: "noul", noul: 0.5 })],
    ["dropped answer", (a) => delete a["risk"]],
    ["kind mismatch", (a) => (a["gate"] = { type: "choice", choice: "x" })],
    ["noul without value", (a) => (a["gate"] = { type: "noul" })],
    ["illegal option", (a) => (must(a["route"]).choice = "maybe")],
    ["score out of range", (a) => (must(a["risk"]).score = 9)],
    ["choice without confidence", (a) => delete must(a["route"]).confidence],
    ["missing legend", (a) => delete must(a["risk"]).legend],
    [
      "extra probability key",
      (a) =>
        (must(a["route"]).probabilities = {
          allow: 0.5,
          "step-up": 0.49,
          deny: 0,
          junk: 0.01,
        }),
    ],
    [
      "skewed probability sum",
      (a) =>
        (must(a["route"]).probabilities = {
          allow: 0.5,
          "step-up": 0.7,
          deny: 0.5,
        }),
    ],
  ];
  for (const [name, mutate] of violations) {
    test(`rejects ${name}`, () => {
      const broken = answers();
      mutate(broken);
      expect(checkAnswers(questions, broken)).toBeString();
    });
  }
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const ENV_KEYS = [
  "SYSTEM_ONE_API_KEY",
  "TYPESAFE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
];
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

describe("evaluate without a transport", () => {
  const deps = {
    fetch: () => Promise.reject(new Error("fetch must not be called")),
    scheduler: createDefaultScheduler(),
  };

  test("no key fails closed without fetching and strips URL credentials", async () => {
    const result = await evaluate(
      {
        state: {},
        questions,
        config: {
          endpoint: { kind: "custom", url: "https://user:pw@host.test/eval" },
        },
      },
      { deps },
    );
    expect(result).toMatchObject({
      fallback: true,
      reason: "no-key",
      backendAttempted: "https://host.test/eval",
    });
  });

  test("invalid input throws a SystemOneError with key material redacted", async () => {
    const secret = "super-secret-key";
    let thrown: unknown;
    try {
      await evaluate(
        {
          state: {},
          questions: [must(questions[0]), must(questions[0])],
          config: { apiKey: secret },
        },
        { deps },
      );
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(String(thrown)).not.toContain(secret);
  });
});

// Records the bearer key and timeout of the one POST `evaluate` makes; the
// POST fails at once, so each call ends in a network fallback.
function recordingDeps(): {
  deps: EvaluateDeps;
  seen: { authorization: string | null; timeoutMs: number | undefined };
} {
  const seen: { authorization: string | null; timeoutMs: number | undefined } =
    { authorization: null, timeoutMs: undefined };
  const deps: EvaluateDeps = {
    fetch: (_input, init) => {
      seen.authorization = new Headers(init?.headers).get("authorization");
      return Promise.reject(new TypeError("offline"));
    },
    scheduler: {
      setTimeout: (_callback, delayMs) => {
        seen.timeoutMs = delayMs;
        return () => undefined;
      },
      now: () => 0,
    },
  };
  return { deps, seen };
}

async function bearerFor(
  endpoint: EndpointConfig | undefined,
  apiKey?: string,
): Promise<string | null> {
  const { deps, seen } = recordingDeps();
  const config: EvaluateConfig = {};
  if (endpoint !== undefined) config.endpoint = endpoint;
  if (apiKey !== undefined) config.apiKey = apiKey;
  await evaluate({ state: {}, questions, config }, { deps });
  return seen.authorization;
}

describe("credential precedence", () => {
  test("official prefers TYPESAFE_API_KEY, then SYSTEM_ONE_API_KEY", async () => {
    process.env["SYSTEM_ONE_API_KEY"] = "legacy";
    expect(await bearerFor(undefined)).toBe("Bearer legacy");
    process.env["TYPESAFE_API_KEY"] = "typesafe";
    expect(await bearerFor(undefined)).toBe("Bearer typesafe");
  });

  test("gateway prefers AI_GATEWAY_API_KEY, then VERCEL_OIDC_TOKEN, then SYSTEM_ONE_API_KEY", async () => {
    const gateway: EndpointConfig = { kind: "gateway" };
    process.env["TYPESAFE_API_KEY"] = "typesafe";
    process.env["SYSTEM_ONE_API_KEY"] = "legacy";
    expect(await bearerFor(gateway)).toBe("Bearer legacy");
    process.env["VERCEL_OIDC_TOKEN"] = "oidc";
    expect(await bearerFor(gateway)).toBe("Bearer oidc");
    process.env["AI_GATEWAY_API_KEY"] = "gateway";
    expect(await bearerFor(gateway)).toBe("Bearer gateway");
  });

  test("custom reads only SYSTEM_ONE_API_KEY", async () => {
    const custom: EndpointConfig = { kind: "custom", url: "https://h.test/e" };
    process.env["TYPESAFE_API_KEY"] = "typesafe";
    process.env["SYSTEM_ONE_API_KEY"] = "legacy";
    expect(await bearerFor(custom)).toBe("Bearer legacy");
  });

  test("a per-call apiKey wins; an empty one falls through to the environment", async () => {
    process.env["TYPESAFE_API_KEY"] = "typesafe";
    expect(await bearerFor(undefined, "per-call")).toBe("Bearer per-call");
    expect(await bearerFor(undefined, "")).toBe("Bearer typesafe");
  });
});

describe("timeout budget", () => {
  async function timeoutFor(timeoutMs?: number): Promise<number | undefined> {
    const { deps, seen } = recordingDeps();
    const config: EvaluateConfig = { apiKey: "key" };
    if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
    await evaluate({ state: {}, questions, config }, { deps });
    return seen.timeoutMs;
  }

  test("defaults to DEFAULT_TIMEOUT_MS and honors a per-call override", async () => {
    expect(await timeoutFor()).toBe(DEFAULT_TIMEOUT_MS);
    expect(await timeoutFor(250)).toBe(250);
  });

  test("a negative or non-finite timeoutMs falls back to the default", async () => {
    expect(await timeoutFor(-1)).toBe(DEFAULT_TIMEOUT_MS);
    expect(await timeoutFor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("key material", () => {
  test("never appears in an http-error fallback or its telemetry", async () => {
    const secret = "super-secret-key";
    const events: SystemOneTelemetryEvent[] = [];
    const result = await evaluate(
      { state: {}, questions, config: { apiKey: secret } },
      {
        deps: {
          fetch: () =>
            Promise.resolve(
              new Response(`{"echo":"${secret}"}`, { status: 401 }),
            ),
          scheduler: createDefaultScheduler(),
        },
        onTelemetry: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({ fallback: true, reason: "http-error" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
