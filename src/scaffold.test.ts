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
  SystemOneError,
  SystemOneTelemetryEvent,
} from "./index";

describe("public entry", () => {
  test("exports exist", () => {
    expect(typeof evaluate).toBe("function");
    expect(typeof createSystemOneAdapter).toBe("function");
    expect(typeof postEvaluate).toBe("function");
    expect(typeof recordTelemetryEvent).toBe("function");
    expect(SYSTEM_ONE_PROVIDER).toBe("system-one");
    expect(SYSTEM_ONE_DEFAULT_QUIRKS).toEqual({});
    expect(GATEWAY_QUIRKS).toEqual({});
  });

  test("evaluate throws a typed not-implemented error until core lands", async () => {
    const parsed = EvaluateInput({
      state: { failedAttempts: 2 },
      questions: [{ kind: "choice", id: "route", options: ["allow", "deny"] }],
    });
    expect(parsed instanceof type.errors).toBe(false);
    if (parsed instanceof type.errors) throw new Error(parsed.summary);
    const result = await evaluate(parsed).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(SystemOneError);
    if (result instanceof SystemOneError)
      expect(result.code).toBe("not-implemented");
  });
});

describe("schemas", () => {
  test("choice requires at least two options", () => {
    const ok = ChoiceQuestion({
      kind: "choice",
      id: "route",
      options: ["allow", "deny"],
    });
    expect(ok instanceof type.errors).toBe(false);
    const one = ChoiceQuestion({
      kind: "choice",
      id: "route",
      options: ["allow"],
    });
    expect(one instanceof type.errors).toBe(true);
  });

  test("score and boolean parse", () => {
    const score = ScoreQuestion({
      kind: "score",
      id: "risk",
      min: 0,
      max: 100,
    });
    expect(score instanceof type.errors).toBe(false);
    const boolean = BooleanQuestion({ kind: "boolean", id: "escalate" });
    expect(boolean instanceof type.errors).toBe(false);
  });

  test("question union discriminates on kind", () => {
    const ok = Question({ kind: "boolean", id: "escalate" });
    expect(ok instanceof type.errors).toBe(false);
    const bad = Question({ kind: "rank", id: "escalate" });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("evaluate input requires at least one question", () => {
    const empty = EvaluateInput({ state: {}, questions: [] });
    expect(empty instanceof type.errors).toBe(true);
    const full = EvaluateInput({
      state: { deviceClass: "iot" },
      questions: [{ kind: "score", id: "risk", min: 0, max: 100 }],
      config: { timeoutMs: 5000 },
    });
    expect(full instanceof type.errors).toBe(false);
  });

  test("decision confidence is 0..1, never clamped", () => {
    const base = { id: "risk", kind: "score", value: 42 };
    const lo = Decision({ ...base, confidence: 0 });
    expect(lo instanceof type.errors).toBe(false);
    const hi = Decision({ ...base, confidence: 1 });
    expect(hi instanceof type.errors).toBe(false);
    const over = Decision({ ...base, confidence: 2 });
    expect(over instanceof type.errors).toBe(true);
  });

  test("evaluate result parses, fallback flag is literal false", () => {
    const ok = EvaluateResult({
      decisions: [
        { id: "route", kind: "choice", value: "allow", confidence: 0.9 },
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
