# @corbits/system-one

[![License: LGPL-2.1](https://img.shields.io/badge/license-LGPL--2.1-green.svg)](https://github.com/corbitsdev/corbits-system-one/blob/main/LICENSE)

Typed choice, score and yes/no decisions about a JSON state from TypeSafe's Jev model, returned as a validated result or a typed fallback. An inference provider for Corbits and Interchange agents: registers as an `@intx/inference` adapter, and also works standalone through `evaluate()`.

## Why @corbits/system-one?

1. **Typed decisions, not free text.** You send questions with ids; you get back one validated decision per id, with probabilities and confidence. No prompt parsing.
2. **Failures are data.** A missing key, timeout, HTTP error or bad body returns a `FallbackResult` with a `reason`, so a gate can fail closed without a `try`. Only invalid caller input throws.
3. **One call, many questions.** Every question in a list goes out in one POST, bounded by a 1.5 s default timeout.

It evaluates structured state against questions. For open-ended chat completions, use a general inference provider such as [`@corbits/openai-responses`](https://github.com/corbitsdev/corbits-openai-responses).

## Install

```bash
bun add @corbits/system-one @intx/inference@^0.4.0 @intx/types@^0.4.0
```

Runs on Bun >= 1.2 or Node >= 24.

## Quickstart

Needs `TYPESAFE_API_KEY` set.

```ts
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
```

On success it prints one decision per question, or the fallback reason on failure:

```ts
[{ id: "escalate", type: "noul", noul: 0.91 }];
```

Boolean questions answer as `noul`, a probability from 0 to 1 that the answer is yes.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals (accounts that hold their own identity, permissions and credentials). Corbits packages add what an agent product needs around it.

- **Runs in:** the agent sidecar (the runtime next to each agent), or any process. `evaluate()` needs no Interchange runtime.
- **Plugs into:** the [`@intx/inference`](https://github.com/faremeter/interchange/tree/main/packages/inference) adapter registry, as the adapter for the `corbits-system-one` provider id.
- **Pairs with:** [`@corbits/openai-responses`](https://github.com/corbitsdev/corbits-openai-responses) and [`@corbits/ollama-adapter`](https://github.com/corbitsdev/corbits-ollama-adapter), the other Corbits inference providers.

## Reference

| Export                            | Description                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `evaluate(input, options?)`       | Runs one evaluation. Returns `EvaluateResult`: decisions or a `FallbackResult`.  |
| `createSystemOneAdapter(config?)` | Returns a `ProviderAdapter` for `runInference`. `config` is an `EvaluateConfig`. |
| `SYSTEM_ONE_PROVIDER`             | The `"corbits-system-one"` provider id.                                          |
| `DEFAULT_TIMEOUT_MS`              | `1500`, the default `timeoutMs`.                                                 |
| `SystemOneError`                  | Thrown for invalid input or a `custom` endpoint without a `url`.                 |
| `SystemOneTelemetryEvent`         | Schema and type for events passed to `onTelemetry`.                              |
| `EvaluateOptions`, `EvaluateDeps` | Types for `options`: `onTelemetry`, and `deps: { fetch, scheduler }`.            |

`Question`, `QuestionList`, `Decision`, `EvaluateInput`, `EvaluateConfig`, `EndpointConfig`, `EvaluateResult` and `FallbackResult` are exported as arktype schemas and types.

### Questions

| `type`    | Fields                                                                          | Decision fields                                  |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `choice`  | `instructions`, `criteria` (option name → description or `null`, 1–255 options) | `choice`, `probabilities`, `confidence`          |
| `score`   | `instructions`, `criteria` (2–10 descriptions)                                  | `score`, `legend`, `probabilities`, `confidence` |
| `boolean` | `instructions`, optional `criteria: { true?, false? }`                          | `noul`                                           |
| `noul`    | Same as `boolean`                                                               | `noul`                                           |

Every question has an `id`, unique within the list.

### Config

`input.config` for `evaluate`, or the argument to `createSystemOneAdapter`:

| Field       | Type             | Default                | Description                                                                      |
| ----------- | ---------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `endpoint`  | `EndpointConfig` | `{ kind: "official" }` | `official`, `gateway`, or `custom` with a `url`. Each takes an optional `model`. |
| `timeoutMs` | `number`         | `1500`                 | Bound for the whole round trip.                                                  |
| `apiKey`    | `string`         | from the environment   | Overrides the environment key.                                                   |

### Endpoints and keys

| `kind`     | URL                                                  | Default model     | Key from the environment                       |
| ---------- | ---------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `official` | `https://api.typesafe.ai/v1/systemone`               | `jev-latest`      | `TYPESAFE_API_KEY`                             |
| `gateway`  | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN` |
| `custom`   | `url`                                                | `typesafe-ai/jev` | `SYSTEM_ONE_API_KEY`                           |

`SYSTEM_ONE_API_KEY` is also a supported alias on every endpoint, read after the endpoint's own key.

### Fallback reasons

| `reason`      | When                                                          |
| ------------- | ------------------------------------------------------------- |
| `no-key`      | No key in `apiKey` or the environment. No request is sent.    |
| `timeout`     | The round trip, including the body read, exceeds `timeoutMs`. |
| `network`     | The request fails before a response.                          |
| `http-error`  | Non-2xx response. `httpStatus` holds the status.              |
| `parse-error` | The body is not JSON or fails validation.                     |

`detail` carries the underlying message.

## Using with Interchange

Register the adapter under `SYSTEM_ONE_PROVIDER` and pass questions per call in `providerOptions.systemOne` (`{ state?, questions? }`). Without `state`, the adapter sends the transcript text as state. Without `questions`, it asks one boolean question with id `response`.

```ts
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
```

The adapter emits one `inference.text.delta` per decision, whose `token` is the decision as JSON, then an `inference.usage` event. The harness supplies the credential through `readMaterial` and owns retries. A malformed response body is a `ProtocolMismatchError`, not a fallback.

## Upgrading from 0.1

- `HttpError`, `NetworkError` and `TimeoutError` are removed. Transport failures return a `FallbackResult`.
- A 2xx body that is not JSON is `parse-error` (was `network`). A timeout during the body read is `timeout`.
- `recordTelemetryEvent` and `drainTelemetryEvents` are removed. Pass `evaluate(input, { onTelemetry })`.
- Wire helpers, quirks presets, `JsonRecord`, `Confidence` and the env-var name constants are no longer exported.
- A `custom` endpoint without a `model` sends `typesafe-ai/jev`.
- Peers are `@intx/inference` and `@intx/types` `^0.4.0`.
- Environment variables are unchanged, including `SYSTEM_ONE_API_KEY`.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-system-one/blob/main/LICENSE)
