import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { SystemOneError } from "./errors";
import {
  EvaluateInput,
  toDecision,
  toWireQuestions,
  WireResponseBody,
} from "./schemas";

describe("toWireQuestions", () => {
  test("keys questions by id and sends boolean as native noul", () => {
    expect(
      toWireQuestions([
        {
          id: "route",
          type: "choice",
          instructions: "Route?",
          criteria: { allow: "ok", deny: "no" },
        },
        { id: "gate", type: "boolean", instructions: "Gate?" },
      ]),
    ).toEqual({
      route: {
        type: "choice",
        instructions: "Route?",
        criteria: { allow: "ok", deny: "no" },
      },
      gate: { type: "noul", instructions: "Gate?" },
    });
  });
});

describe("toDecision", () => {
  test("keeps only the kind's fields", () => {
    expect(
      toDecision("gate", { type: "noul", noul: 0.9, confidence: 0.4 }),
    ).toEqual({ id: "gate", type: "noul", noul: 0.9 });
  });

  test("throws a parse-error when the kind's fields are missing", () => {
    let thrown: unknown;
    try {
      toDecision("route", { type: "choice", choice: "allow" });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SystemOneError);
    expect(thrown instanceof SystemOneError && thrown.code).toBe("parse-error");
  });
});

describe("schemas", () => {
  test("out-of-range confidence is rejected, not clamped", () => {
    const parsed = WireResponseBody({
      answers: {
        route: {
          type: "choice",
          choice: "allow",
          probabilities: { allow: 1 },
          confidence: 2,
        },
      },
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("input rejects duplicate ids, empty instructions and one-level scores", () => {
    const invalid = [
      [
        { id: "q", type: "boolean", instructions: "A?" },
        { id: "q", type: "boolean", instructions: "B?" },
      ],
      [{ id: "q", type: "choice", instructions: "", criteria: { a: null } }],
      [{ id: "q", type: "score", instructions: "Rate.", criteria: ["one"] }],
    ];
    for (const questions of invalid) {
      expect(
        EvaluateInput({ state: {}, questions }) instanceof type.errors,
      ).toBe(true);
    }
  });
});
