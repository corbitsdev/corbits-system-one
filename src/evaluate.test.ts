import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDefaultScheduler } from "@intx/inference";

import { SystemOneError } from "./errors";
import { checkAnswers, evaluate } from "./evaluate";
import type { Question, WireAnswer } from "./schemas";

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
    [
      "illegal option",
      (a) => (a["route"] = { ...must(a["route"]), choice: "maybe" }),
    ],
    [
      "score out of range",
      (a) => (a["risk"] = { ...must(a["risk"]), score: 9 }),
    ],
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

describe("evaluate without a transport", () => {
  const ENV_KEYS = [
    "SYSTEM_ONE_API_KEY",
    "TYPESAFE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
  ];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

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
