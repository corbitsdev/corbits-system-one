// Scaffold smoke test: the public entry's exports exist and the arktype
// schemas accept/reject the shapes they own. Load-bearing only — the
// evaluate-core step extends this file as behavior lands. Everything imports
// through the public entry, never a submodule directly.

import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  BooleanQuestion,
  ChoiceQuestion,
  createSystemOneAdapter,
  Decision,
  EndpointConfig,
  evaluate,
  EvaluateConfig,
  EvaluateInput,
  EvaluateResult,
  FallbackResult,
  GATEWAY_QUIRKS,
  postEvaluate,
  Question,
  recordTelemetryEvent,
  ScoreQuestion,
  SYSTEM_ONE_DEFAULT_QUIRKS,
  SYSTEM_ONE_PROVIDER,
  SystemOneTelemetryEvent,
} from "./index";

describe("public entry", () => {
  test("exports exist", () => {
    expect(typeof evaluate).toBe("function");
    expect(typeof createSystemOneAdapter).toBe("function");
    expect(typeof postEvaluate).toBe("function");
    expect(typeof recordTelemetryEvent).toBe("function");
    expect(typeof SYSTEM_ONE_PROVIDER).toBe("string");
    expect(SYSTEM_ONE_PROVIDER).toBe("system-one");
    expect(typeof SYSTEM_ONE_DEFAULT_QUIRKS.baseUrl).toBe("string");
    expect(typeof SYSTEM_ONE_DEFAULT_QUIRKS.model).toBe("string");
    expect(typeof GATEWAY_QUIRKS.baseUrl).toBe("string");
    expect(GATEWAY_QUIRKS.baseUrl).toContain("gateway");
    expect(typeof GATEWAY_QUIRKS.model).toBe("string");
  });

  test("evaluate fail-closes to a no-key fallback when keyless", async () => {
    const parsed = EvaluateInput({
      state: { failedAttempts: 2 },
      questions: [
        {
          id: "route",
          type: "choice",
          instructions: "Route it?",
          criteria: { allow: "Low risk", deny: "No" },
        },
      ],
    });
    expect(parsed instanceof type.errors).toBe(false);
    if (parsed instanceof type.errors) throw new Error(parsed.summary);
    const saved = process.env["SYSTEM_ONE_API_KEY"];
    delete process.env["SYSTEM_ONE_API_KEY"];
    try {
      const result = await evaluate(parsed);
      if (result.fallback !== true) throw new Error("expected a fallback");
      expect(result.reason).toBe("no-key");
    } finally {
      if (saved === undefined) delete process.env["SYSTEM_ONE_API_KEY"];
      else process.env["SYSTEM_ONE_API_KEY"] = saved;
    }
  });
});

describe("schemas", () => {
  test("choice requires one to 255 criteria options", () => {
    const ok = ChoiceQuestion({
      id: "route",
      type: "choice",
      instructions: "Route it?",
      criteria: { allow: "Low risk", deny: "No" },
    });
    expect(ok instanceof type.errors).toBe(false);
    const none = ChoiceQuestion({
      id: "route",
      type: "choice",
      instructions: "Route it?",
      criteria: {},
    });
    expect(none instanceof type.errors).toBe(true);
  });

  test("score and boolean parse", () => {
    const score = ScoreQuestion({
      id: "risk",
      type: "score",
      instructions: "Rate it?",
      criteria: ["Low", "High"],
    });
    expect(score instanceof type.errors).toBe(false);
    const boolean = BooleanQuestion({
      id: "escalate",
      type: "boolean",
      instructions: "Gate it?",
    });
    expect(boolean instanceof type.errors).toBe(false);
  });

  test("question union discriminates on type", () => {
    const ok = Question({
      id: "escalate",
      type: "boolean",
      instructions: "Gate it?",
    });
    expect(ok instanceof type.errors).toBe(false);
    const bad = Question({
      id: "escalate",
      type: "rank",
      instructions: "Gate it?",
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("evaluate input requires at least one question", () => {
    const empty = EvaluateInput({ state: {}, questions: [] });
    expect(empty instanceof type.errors).toBe(true);
    const full = EvaluateInput({
      state: { deviceClass: "iot" },
      questions: [
        {
          id: "risk",
          type: "score",
          instructions: "Rate it?",
          criteria: ["Low", "High"],
        },
      ],
      config: { timeoutMs: 5000 },
    });
    expect(full instanceof type.errors).toBe(false);
  });

  test("decision confidence is 0..1, never clamped", () => {
    const base = {
      id: "risk",
      type: "score",
      score: 1.5,
      legend: { "0": "low", "1": "mid", "2": "high" },
      probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
    };
    const lo = Decision({ ...base, confidence: 0 });
    expect(lo instanceof type.errors).toBe(false);
    const hi = Decision({ ...base, confidence: 1 });
    expect(hi instanceof type.errors).toBe(false);
    const over = Decision({ ...base, confidence: 2 });
    expect(over instanceof type.errors).toBe(true);
  });

  test("decisions are per-kind discriminated and complete", () => {
    const noul = Decision({ id: "gate", type: "noul", noul: 0.9 });
    expect(noul instanceof type.errors).toBe(false);
    const emptyNoul = Decision({ id: "gate", type: "noul" });
    expect(emptyNoul instanceof type.errors).toBe(true);
    const thinChoice = Decision({
      id: "route",
      type: "choice",
      choice: "allow",
    });
    expect(thinChoice instanceof type.errors).toBe(true);
  });

  test("evaluate result parses, fallback flag is literal false", () => {
    const ok = EvaluateResult({
      decisions: [
        {
          id: "route",
          type: "choice",
          choice: "allow",
          probabilities: { allow: 1 },
          confidence: 0.9,
        },
      ],
      modelId: "jev-1",
      backend: "system-one",
      latencyMs: 12,
      fallback: false,
    });
    expect(ok instanceof type.errors).toBe(false);
    const flagged = EvaluateResult({
      decisions: [],
      modelId: "jev-1",
      backend: "system-one",
      latencyMs: 12,
      fallback: true,
    });
    expect(flagged instanceof type.errors).toBe(true);
  });

  test("fallback result parses minimal and full shapes", () => {
    const minimal = FallbackResult({
      fallback: true,
      reason: "timeout",
      latencyMs: 5,
      backendAttempted: "system-one",
    });
    expect(minimal instanceof type.errors).toBe(false);
    const full = FallbackResult({
      fallback: true,
      reason: "http-error",
      latencyMs: 5,
      httpStatus: 503,
      backendAttempted: "gateway",
    });
    expect(full instanceof type.errors).toBe(false);
    const badReason = FallbackResult({
      fallback: true,
      reason: "no-idea",
      latencyMs: 5,
      backendAttempted: "system-one",
    });
    expect(badReason instanceof type.errors).toBe(true);
  });

  test("endpoint and evaluate configs parse", () => {
    const endpoint = EndpointConfig({ kind: "gateway" });
    expect(endpoint instanceof type.errors).toBe(false);
    const config = EvaluateConfig({
      endpoint: { kind: "custom", url: "https://example.test/eval" },
    });
    expect(config instanceof type.errors).toBe(false);
    // url only exists on custom: it would be silently ignored elsewhere
    const ignored = EndpointConfig({ kind: "official", url: "https://x.test" });
    expect(ignored instanceof type.errors).toBe(true);
  });

  test("telemetry event parses", () => {
    const ok = SystemOneTelemetryEvent({
      event: "evaluate.fallback",
      backend: "gateway",
      latencyMs: 5,
      reason: "timeout",
    });
    expect(ok instanceof type.errors).toBe(false);
  });
});
