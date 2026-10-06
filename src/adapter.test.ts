import { describe, expect, test } from "bun:test";
import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
} from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";

import {
  createSystemOneAdapter,
  createSystemOneAdapterFactory,
} from "./adapter";

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

  test("usage source reports the responding model, not the last request", () => {
    const adapter = createSystemOneAdapter();
    adapter.buildRequest(turns(), "model-a", {});
    adapter.buildRequest(turns(), "model-b", {});
    const answers = { response: { type: "noul", noul: 0.5 } };
    const usageModel = (body: object) => {
      const last = adapter.parseJSONResponse(JSON.stringify(body)).at(-1);
      if (last?.type !== "inference.usage") throw new Error("expected usage");
      return last.data.source.model;
    };
    expect(usageModel({ answers, model: "model-a-v1" })).toBe("model-a-v1");
    expect(usageModel({ answers })).toBe("jev-latest");
  });
});

describe("adapter factory", () => {
  const source = { sourceId: "s", provider: "corbits-system-one", model: "m" };
  const turns = (): ConversationTurn[] => [
    { role: "user", timestamp: 0, content: [{ type: "text", text: "Hi" }] },
  ];

  test("no quirks routes to the provider baseURL with sentinel auth", () => {
    const request = createSystemOneAdapterFactory(source).buildRequest(
      turns(),
      "jev-latest",
      {},
    );
    expect(request.url).toBe("/systemone");
    expect(JSON.parse(request.body).model).toBe("jev-latest");
    expect(request.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
  });

  test("an explicit official endpoint keeps the absolute URL", () => {
    const request = createSystemOneAdapterFactory(source, {
      endpoint: { kind: "official" },
    }).buildRequest(turns(), "jev-latest", {});
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  test("a quirk model overrides the catalog model on the wire", () => {
    const adapter = createSystemOneAdapterFactory(source, {
      model: "typesafe-ai/jev",
    });
    const body = JSON.parse(adapter.buildRequest(turns(), "decision", {}).body);
    expect(body.model).toBe("typesafe-ai/jev");
  });

  test("quirks endpoint and default questions apply; call questions win", () => {
    const adapter = createSystemOneAdapterFactory(source, {
      endpoint: { kind: "custom", url: "https://opencode.ai/zen/v1/systemone" },
      model: "jev-1.13",
      questions: [{ type: "boolean", id: "gate", instructions: "Allow?" }],
    });
    const dflt = adapter.buildRequest(turns(), "", {});
    expect(dflt.url).toBe("https://opencode.ai/zen/v1/systemone");
    const body = JSON.parse(dflt.body);
    expect(body.model).toBe("jev-1.13");
    expect(Object.keys(body.questions)).toEqual(["gate"]);
    const override = adapter.buildRequest(turns(), "jev-1.13", {
      providerOptions: {
        systemOne: {
          questions: [{ type: "boolean", id: "other", instructions: "?" }],
        },
      },
    });
    expect(Object.keys(JSON.parse(override.body).questions)).toEqual(["other"]);
  });

  test("usage retains the supplied source and honors the response model", () => {
    const attributedSource = {
      sourceId: "offering-source",
      provider: "system-one-deployment",
      model: "m",
    };
    const adapter = createSystemOneAdapterFactory(attributedSource);
    const answers = { response: { type: "noul", noul: 0.5 } };
    const usageSource = (body: object) => {
      const last = adapter.parseJSONResponse(JSON.stringify(body)).at(-1);
      if (last?.type !== "inference.usage") throw new Error("expected usage");
      return last.data.source;
    };

    expect(usageSource({ answers })).toEqual(attributedSource);
    expect(usageSource({ answers, model: "m-backend" })).toEqual({
      ...attributedSource,
      model: "m-backend",
    });
  });

  test("invalid quirks throw", () => {
    expect(() => createSystemOneAdapterFactory(source, { bogus: 1 })).toThrow(
      /invalid quirks/,
    );
  });
});
