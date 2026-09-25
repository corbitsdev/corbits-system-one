import { describe, expect, test } from "bun:test";
import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
} from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";

import { createSystemOneAdapter } from "./adapter";
import { SYSTEM_ONE_DEFAULT_QUIRKS } from "./config";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function bodyOf(bodyText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(bodyText);
  if (!isRecord(parsed)) throw new Error("request body is not a JSON object");
  return parsed;
}

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
    expect<string | undefined>(request.url).toBe(
      SYSTEM_ONE_DEFAULT_QUIRKS.baseUrl,
    );
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
