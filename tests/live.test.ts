// Live check against the official /evaluate endpoint. Runs only when
// TYPESAFE_API_KEY is set; skips otherwise.

import { describe, expect, test } from "bun:test";

import { evaluate, type QuestionList } from "../src/index";

const liveDescribe =
  process.env["TYPESAFE_API_KEY"] === undefined ? describe.skip : describe;

liveDescribe("live /evaluate", () => {
  test("answers one choice and one boolean question", async () => {
    const questions = [
      {
        id: "route",
        type: "choice",
        instructions: "What permission decision does this request warrant?",
        criteria: { allow: "Low-risk request", deny: "Refuse the request" },
      },
      {
        id: "escalate",
        type: "boolean",
        instructions: "Must this request be escalated for human approval?",
      },
    ] satisfies QuestionList;

    const result = await evaluate({
      state: { action: "drop-database", env: "production", approvals: 0 },
      questions,
      config: { timeoutMs: 15_000 },
    });

    if (result.fallback) throw new Error(`fallback: ${result.reason}`);
    const [route, escalate] = result.decisions;
    if (route?.type !== "choice") throw new Error("expected a choice");
    expect(["allow", "deny"]).toContain(route.choice);
    expect(escalate?.type).toBe("noul");
  });
});
