import { describe, expect, test } from "bun:test";
import { ProtocolMismatchError } from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";

import { createSystemOneAdapter } from "./adapter";

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
