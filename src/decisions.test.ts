import type { EvaluateDeps } from "./client";
import { describe, expect, test } from "bun:test";
import { createDefaultScheduler } from "@intx/inference";

import { Image, image, withAssets } from "./assets";
import { box, choice, noul, score, systemOne } from "./decisions";
import { SystemOneError } from "./errors";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function deps(fetchImpl: EvaluateDeps["fetch"]): EvaluateDeps {
  return { fetch: fetchImpl, scheduler: createDefaultScheduler() };
}

function okBody() {
  return {
    model: "jev-latest",
    answers: {
      category: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.8, technical: 0.2 },
        confidence: 0.7,
      },
      escalate: { type: "noul", noul: 0.2 },
      severity: {
        type: "score",
        score: 1,
        legend: { "0": "none", "1": "cosmetic", "2": "unusable" },
        probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
        confidence: 0.5,
      },
    },
  };
}

describe("systemOne", () => {
  test("returns named answers and falls back without throwing", async () => {
    let calls = 0;
    const result = await systemOne(
      {
        state: { document: "charged twice" },
        questions: {
          category: choice("What is this?", { billing: null, technical: null }),
          escalate: noul("Must this be escalated?"),
          severity: score("How severe?", ["none", "cosmetic", "unusable"]),
        },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async () => {
          calls += 1;
          return new Response(JSON.stringify(okBody()), { status: 200 });
        }),
      },
    );
    expect(calls).toBe(1);
    if (result.fallback) throw new Error("expected answers");
    expect(result.answers.category.choice).toBe("billing");
    expect(result.answers.category.probabilities.billing).toBe(0.8);
    expect(result.answers.category.confidence).toBe(0.7);
    expect(result.answers.escalate.noul).toBe(0.2);
    expect(result.answers.severity.score).toBe(1);

    const fallback = await systemOne(
      {
        state: { document: "x" },
        questions: { escalate: noul("Must this be escalated?") },
      },
      {
        deps: deps(() => Promise.reject(new Error("fetch must not be called"))),
      },
    );
    expect(fallback.fallback).toBe(true);
    if (!fallback.fallback) throw new Error("expected fallback");
    expect(fallback.reason).toBe("no-key");

    const http = await systemOne(
      {
        state: { document: "x" },
        questions: { escalate: noul("Must this be escalated?") },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async () => new Response("no", { status: 500 })),
      },
    );
    expect(http.fallback).toBe(true);
    if (!http.fallback) throw new Error("expected fallback");
    expect(http.reason).toBe("http-error");
  });

  test("sends images as multipart and rejects other formats first", async () => {
    const bodies: { headers: Headers; text: string; raw: Uint8Array }[] = [];
    const photo = image(png);
    const result = await systemOne(
      {
        state: { photo },
        questions: {
          region: box("The damaged area"),
          damaged: noul("Is it damaged?"),
        },
        model: "jev-preview",
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async (_url, init) => {
          const headers = new Headers(init?.headers);
          const raw = await bodyBytes(init?.body);
          const text = new TextDecoder().decode(raw);
          bodies.push({ headers, text, raw });
          return new Response(
            JSON.stringify({
              answers: {
                region: {
                  type: "box",
                  box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.5 },
                  confidence: null,
                },
                damaged: { type: "noul", noul: 0.9 },
              },
            }),
            { status: 200 },
          );
        }),
      },
    );
    if (result.fallback) throw new Error(result.reason);
    expect(result.answers.region.box).toEqual({
      top: 0.1,
      bottom: 0.4,
      left: 0.2,
      right: 0.5,
    });
    expect(result.answers.region.confidence).toBeNull();
    const sent = bodies[0];
    if (sent === undefined) throw new Error("expected a request");
    expect(sent.headers.get("TypeSafe-Danger-Zone-Images")).toBe("true");
    expect(sent.headers.get("content-type")).toStartWith("multipart/form-data");
    const requestPart = multipartRequest(sent.headers, sent.raw);
    const assetKey = Object.keys(requestPart.assets)[0];
    if (assetKey === undefined) throw new Error("expected an asset");
    expect(requestPart.assets[assetKey]?.part).toBe("asset-0");
    expect(requestPart.parts["asset-0"]).toEqual(png);
    expect(requestPart.jsonBytes.includes(png[0] ?? 0)).toBe(false);
    expect(sent.text).toContain("jev-preview");

    let fetched = false;
    let thrown: unknown;
    try {
      await systemOne(
        {
          state: image(gif),
          questions: { damaged: noul("Is it damaged?") },
          config: { apiKey: "test-key" },
        },
        {
          deps: deps(async () => {
            fetched = true;
            return new Response("{}", { status: 200 });
          }),
        },
      );
    } catch (cause) {
      thrown = cause;
    }
    expect(fetched).toBe(false);
    expect(thrown).toBeInstanceOf(SystemOneError);
  });

  test("rejects a plain template image and requires every asset name", async () => {
    const photo = image(jpeg);
    let fetched = false;
    const transport = deps(async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });
    await expect(
      systemOne(
        {
          state: `see ${photo}`,
          questions: { damaged: noul("Is it damaged?") },
          config: { apiKey: "test-key" },
        },
        { deps: transport },
      ),
    ).rejects.toBeInstanceOf(SystemOneError);

    await expect(
      systemOne(
        {
          state: "no photo here",
          questions: { damaged: noul("Is it damaged?") },
          assets: { "<catalog>": image(png) },
          config: { apiKey: "test-key" },
        },
        { deps: transport },
      ),
    ).rejects.toBeInstanceOf(SystemOneError);
    expect(fetched).toBe(false);

    await expect(
      systemOne(
        {
          state: { document: "state type" },
          questions: { damaged: noul("Is it damaged?") },
          assets: { t: image(png) },
          config: { apiKey: "test-key" },
        },
        { deps: transport },
      ),
    ).rejects.toBeInstanceOf(SystemOneError);

    const taggedBodies: { headers: Headers; raw: Uint8Array }[] = [];
    const tagged = await systemOne(
      {
        state: withAssets`compare ${photo}`,
        questions: {
          same: noul(withAssets`Does ${photo} match?`),
        },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async (_url, init) => {
          taggedBodies.push({
            headers: new Headers(init?.headers),
            raw: await bodyBytes(init?.body),
          });
          return new Response(
            JSON.stringify({
              answers: { same: { type: "noul", noul: 0.4 } },
            }),
            { status: 200 },
          );
        }),
      },
    );
    if (tagged.fallback) throw new Error(tagged.reason);
    expect(tagged.answers.same.noul).toBe(0.4);
    const taggedSent = taggedBodies[0];
    if (taggedSent === undefined) throw new Error("expected a request");
    const taggedRequest = multipartRequest(taggedSent.headers, taggedSent.raw);
    const taggedKey = Object.keys(taggedRequest.assets)[0];
    if (taggedKey === undefined) throw new Error("expected an asset");
    expect(taggedRequest.assets[taggedKey]?.part).toBe("asset-0");
    expect(taggedRequest.parts["asset-0"]).toEqual(jpeg);
    expect(taggedRequest.jsonBytes.includes(jpeg[0] ?? 0)).toBe(false);

    const joined = withAssets.join([image(png), image(jpeg)], ", ");
    expect(String(joined)).toContain("<image:");

    const named = await systemOne(
      {
        state: "See <catalog> please",
        questions: { damaged: noul("Is <catalog> damaged?") },
        assets: {
          "<catalog>": Image.fromBase64(Buffer.from(png).toString("base64")),
        },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async (_url, init) => {
          const text = await new Response(init?.body as Blob).text();
          expect(text).toContain("<catalog>");
          expect(text).toContain("image/png");
          return new Response(
            JSON.stringify({
              answers: { damaged: { type: "noul", noul: 0.1 } },
            }),
            { status: 200 },
          );
        }),
      },
    );
    if (named.fallback) throw new Error(named.reason);
    expect(named.answers.damaged.noul).toBe(0.1);
  });

  test("rejects extraction questions", async () => {
    await expect(
      systemOne(
        {
          state: "x",
          // @ts-expect-error extraction questions are not decisions
          questions: { field: { type: "extract", instructions: "pull it" } },
          config: { apiKey: "k" },
        },
        { deps: deps(async () => new Response("{}", { status: 200 })) },
      ),
    ).rejects.toBeInstanceOf(SystemOneError);
  });

  test("asset names match only state, instructions, and criteria", async () => {
    let fetched = false;
    const transport = deps(async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });
    const unreferenced: {
      state: unknown;
      questions: Record<string, unknown>;
      assets: Record<string, Image>;
    }[] = [
      {
        state: "plain",
        questions: { q: choice("look", { a: null }) },
        assets: { choice: image(png) },
      },
      {
        state: "plain",
        questions: { q: noul("look") },
        assets: { noul: image(png) },
      },
      {
        state: "plain",
        questions: { q: score("look", ["none", "some"]) },
        assets: { score: image(png) },
      },
      {
        state: "plain",
        questions: { q: box("the region") },
        assets: { box: image(png) },
      },
      {
        state: { shot: image(png) },
        questions: { q: noul("look") },
        assets: { image: image(jpeg) },
      },
      {
        state: { photo: "x" },
        questions: { q: noul("look") },
        assets: { photo: image(png) },
      },
      {
        state: { "a3f1c2e8-found": "x" },
        questions: { q: noul("look") },
        assets: { found: image(png) },
      },
      {
        state: "photograph",
        questions: { q: noul("look") },
        assets: { photo: image(png) },
      },
      {
        state: "plain",
        questions: { q: choice("look", { photo: null }) },
        assets: { photo: image(png) },
      },
    ];
    for (const input of unreferenced) {
      await expect(
        systemOne(
          { ...input, config: { apiKey: "test-key" } },
          { deps: transport },
        ),
      ).rejects.toThrow(/not referenced/);
    }
    expect(fetched).toBe(false);

    const photo = image(png);
    const named = await systemOne(
      {
        state: withAssets`see image ${photo}`,
        questions: { q: noul("use choice") },
        assets: { image: image(jpeg), choice: image(png) },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ answers: { q: { type: "noul", noul: 0.2 } } }),
              { status: 200 },
            ),
          ),
        ),
      },
    );
    if (named.fallback) throw new Error(named.reason);
    expect(named.answers.q.noul).toBe(0.2);
  });

  test("sends the images header for a box question with no upload", async () => {
    const seen = { header: "", contentType: "" };
    const result = await systemOne(
      {
        state: "a form",
        questions: { region: box("the signature") },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async (_url, init) => {
          const headers = new Headers(init?.headers);
          seen.header = headers.get("TypeSafe-Danger-Zone-Images") ?? "";
          seen.contentType = headers.get("content-type") ?? "";
          return new Response(
            JSON.stringify({
              answers: {
                region: {
                  type: "box",
                  box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.5 },
                  confidence: 0.4,
                },
              },
            }),
            { status: 200 },
          );
        }),
      },
    );
    expect(seen.header).toBe("true");
    expect(seen.contentType).toBe("application/json");
    if (result.fallback) throw new Error(result.detail ?? result.reason);

    const choiceSeen = { header: "unset" };
    await systemOne(
      {
        state: "plain",
        questions: { category: choice("What?", { a: null }) },
        config: { apiKey: "test-key" },
      },
      {
        deps: deps(async (_url, init) => {
          choiceSeen.header =
            new Headers(init?.headers).get("TypeSafe-Danger-Zone-Images") ?? "";
          return new Response(
            JSON.stringify({
              answers: {
                category: {
                  type: "choice",
                  choice: "a",
                  probabilities: { a: 1 },
                  confidence: 0.5,
                },
              },
            }),
            { status: 200 },
          );
        }),
      },
    );
    expect(choiceSeen.header).toBe("");
  });

  test("rejects an inverted box instead of returning a decision", async () => {
    const ask = (edges: {
      top: number;
      bottom: number;
      left: number;
      right: number;
    }) =>
      systemOne(
        {
          state: "a form",
          questions: { region: box("the signature") },
          config: { apiKey: "test-key" },
        },
        {
          deps: deps(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  answers: {
                    region: { type: "box", box: edges, confidence: 0.5 },
                  },
                }),
                { status: 200 },
              ),
            ),
          ),
        },
      );
    for (const edges of [
      { top: 0.8, bottom: 0.1, left: 0.2, right: 0.5 },
      { top: 0.4, bottom: 0.4, left: 0.2, right: 0.5 },
      { top: 0.1, bottom: 0.4, left: 0.9, right: 0.2 },
      { top: 0.1, bottom: 0.4, left: 0.5, right: 0.5 },
      { top: -0.1, bottom: 0.4, left: 0.2, right: 0.5 },
    ]) {
      const result = await ask(edges);
      expect(result.fallback).toBe(true);
      if (!result.fallback) throw new Error("expected fallback");
      expect(result.reason).toBe("parse-error");
    }
  });
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body as Blob).arrayBuffer());
}

function multipartRequest(
  headers: Headers,
  raw: Uint8Array,
): {
  assets: Record<string, { part?: string }>;
  parts: Record<string, Uint8Array>;
  jsonBytes: Uint8Array;
} {
  const contentType = headers.get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error("missing multipart boundary");
  const marker = new TextEncoder().encode(`--${boundary}`);
  const chunks: Uint8Array[] = [];
  let from = 0;
  while (from < raw.length) {
    const at = indexOfBytes(raw, marker, from);
    if (at < 0) break;
    if (at > from) chunks.push(raw.subarray(from, at));
    from = at + marker.length;
  }
  const parts: Record<string, Uint8Array> = {};
  let requestJson = "";
  let jsonBytes = new Uint8Array();
  for (const chunk of chunks) {
    const headerEnd = indexOfBytes(
      chunk,
      new TextEncoder().encode("\r\n\r\n"),
      0,
    );
    if (headerEnd < 0) continue;
    const header = new TextDecoder().decode(chunk.subarray(0, headerEnd));
    const name = /name="([^"]+)"/.exec(header)?.[1];
    if (name === undefined) continue;
    let content = chunk.subarray(headerEnd + 4);
    if (
      content.length >= 2 &&
      content[content.length - 2] === 13 &&
      content[content.length - 1] === 10
    ) {
      content = content.subarray(0, content.length - 2);
    }
    if (name === "request") {
      jsonBytes = new Uint8Array(content);
      requestJson = new TextDecoder().decode(content);
    } else {
      parts[name] = new Uint8Array(content);
    }
  }
  const payload = JSON.parse(requestJson) as {
    assets?: Record<string, { part?: string }>;
  };
  const pngAt = indexOfBytes(jsonBytes, Uint8Array.from(PNG_SIGNATURE), 0);
  if (pngAt >= 0) throw new Error("PNG bytes leaked into the JSON part");
  return { assets: payload.assets ?? {}, parts, jsonBytes };
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  for (let index = from; index <= haystack.length - needle.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return index;
  }
  return -1;
}
