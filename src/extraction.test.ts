import { describe, expect, test } from "bun:test";

import { choice, systemOne } from "./decisions";
import { date, estimate, extract, list, number, text } from "./extraction";

describe("extract", () => {
  test("posts Clairic fields and maps answers", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const result = await extract(
      {
        state: "Invoice INV-2291 issued 2026-09-02, net 30.",
        fields: {
          invoice_number: text(),
          due_date: date("Issue date plus the net payment days"),
          total: number({
            decimals: 2,
            unit: "USD",
            instructions: "Amount due including shipping",
          }),
          contacts: list("text"),
          days_to_pay: estimate({
            min: 0,
            max: 120,
            step: 1,
            instructions: "Days until paid",
          }),
        },
      },
      {
        accountId: "acct",
        token: "tok",
        fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response(
            JSON.stringify({
              result: {
                answers: {
                  invoice_number: { value: "INV-2291", start: 8, end: 16 },
                  due_date: { value: "2026-10-02" },
                  total: { value: 1080, unit: "USD" },
                  contacts: { value: ["Dana Ruiz"] },
                  days_to_pay: { median: 30, interval: { p10: 12, p90: 45 } },
                },
              },
            }),
            { status: 200 },
          );
        },
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected a fetch");
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clairic",
    );
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(String(call.init?.body))).toEqual({
      model: "clairic",
      state: "Invoice INV-2291 issued 2026-09-02, net 30.",
      fields: {
        invoice_number: { type: "text" },
        due_date: {
          type: "date",
          instructions: "Issue date plus the net payment days",
        },
        total: {
          type: "number",
          decimals: 2,
          unit: "USD",
          instructions: "Amount due including shipping",
        },
        contacts: { type: "list", items: "text" },
        days_to_pay: {
          type: "estimate",
          min: 0,
          max: 120,
          step: 1,
          instructions: "Days until paid",
        },
      },
    });
    if (result.fallback) throw new Error("expected answers");
    expect(result.answers.invoice_number).toEqual({
      value: "INV-2291",
      start: 8,
      end: 16,
    });
    expect(result.answers.due_date.value).toBe("2026-10-02");
    expect(result.answers.total.value).toBe(1080);
    expect(result.answers.contacts.value).toEqual(["Dana Ruiz"]);
    expect(result.answers.days_to_pay.median).toBe(30);
    expect(result.answers.days_to_pay.interval).toEqual({ p10: 12, p90: 45 });
  });

  test("falls back without credentials, on non-2xx, and on bad JSON", async () => {
    const missing = await extract(
      { state: "x", fields: { invoice_number: text() } },
      {
        fetch: () => Promise.reject(new Error("fetch must not be called")),
      },
    );
    expect(missing).toMatchObject({ fallback: true, reason: "no-key" });

    const http = await extract(
      { state: "x", fields: { invoice_number: text() } },
      {
        accountId: "acct",
        token: "tok",
        fetch: async () => new Response("no", { status: 500 }),
      },
    );
    expect(http).toMatchObject({
      fallback: true,
      reason: "http-error",
      httpStatus: 500,
    });

    const bad = await extract(
      { state: "x", fields: { invoice_number: text() } },
      {
        accountId: "acct",
        token: "tok",
        fetch: async () => new Response("not-json", { status: 200 }),
      },
    );
    expect(bad).toMatchObject({ fallback: true, reason: "parse-error" });
  });
});

describe("extraction and decisions stay disjoint", () => {
  test("number is not a decision question and choice is not an extraction field", () => {
    async function probe(): Promise<void> {
      await systemOne({
        state: "x",
        questions: {
          category: choice("What is this?", { billing: null }),
          // @ts-expect-error number fields are not decision questions
          total: number(),
        },
      });

      await extract({
        state: "x",
        fields: {
          invoice_number: text(),
          // @ts-expect-error choice questions are not extraction fields
          category: choice("What is this?", { billing: null }),
        },
      });
    }
    expect(probe).toBeFunction();
  });
});
