import { createDependencies, runInference } from "@intx/inference";
import {
  createSystemOneAdapter,
  SYSTEM_ONE_PROVIDER,
  type QuestionList,
} from "@corbits/system-one";

const deps = createDependencies({
  has: (provider) => provider === SYSTEM_ONE_PROVIDER,
  resolve: () => createSystemOneAdapter(),
});

const questions = [
  {
    id: "escalate",
    type: "boolean",
    instructions: "Must this request be escalated for human approval?",
  },
] satisfies QuestionList;

let seq = 0;
for await (const event of runInference({
  deps,
  source: {
    id: "system-one",
    provider: SYSTEM_ONE_PROVIDER,
    baseURL: "https://api.typesafe.ai/v1/systemone",
    credentialId: "TYPESAFE_API_KEY",
    model: "jev-latest",
  },
  turns: [
    {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: "Deploy to production?" }],
    },
  ],
  inferenceOptions: { providerOptions: { systemOne: { questions } } },
  nextSeq: () => seq++,
  readMaterial: (id) => {
    const secret = process.env[id];
    if (secret === undefined) throw new Error(`${id} is not set`);
    return { secret };
  },
})) {
  if (event.type === "inference.text.delta")
    console.log(JSON.parse(event.data.token));
}
