import { evaluate } from "@corbits/system-one";

const result = await evaluate({
  state: { action: "deploy", env: "production" },
  questions: [
    {
      id: "escalate",
      type: "boolean",
      instructions: "Must this request be escalated for human approval?",
    },
  ],
});

console.log(result.fallback ? result.reason : result.decisions);
