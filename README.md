# @corbits/system-one

[![License: LGPL-2.1](https://img.shields.io/badge/license-LGPL--2.1-green.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.2%2B-black.svg)](#development)

**Typed decisions from System One (Jev-class) models — as an Interchange
inference provider, or as a direct `evaluate()` call.**

Ask choice, score, and boolean questions over a state payload. You get
back per-kind decisions, or a typed fallback when the backend is
unreachable. Official, gateway, and custom endpoints are config, not
forked code.

## Contents

- [Why](#why)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Development](#development)
- [License](#license)

## Why

Interchange agents and workflows already speak providers. This package
is the System One adapter for that surface:

- **One provider id.** `SYSTEM_ONE_PROVIDER` is `"corbits-system-one"`
  — same naming as the other Corbits libraries, not a generic
  `"system-one"`. Use it in `defineAgent` / workflow inference sources
  the way you would `"anthropic"`.
- **Questions on the call.** Pass Jev questions (and optional state)
  through `providerOptions.systemOne`. The transcript is the default
  state when you omit it.
- **Two output shapes.** Direct `evaluate()` returns an
  `EvaluateResult` or `FallbackResult`. The adapter unwraps the same
  decisions into Interchange `inference.text.delta` / `inference.usage`
  events so an agent step can consume them.
- **Host-owned credentials.** The adapter sends Interchange's bearer
  sentinel; the harness injects the real key. Peers are
  `@intx/inference` and `@intx/types` — one copy, the host's.

## Quickstart

Requires [Bun](https://bun.sh/) 1.2+. Peers resolve to the host's
Interchange copies.

```
bun add @corbits/system-one
```

Shared questions used below:

```ts
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
];
```

### Direct `evaluate()` — typed result object

No Interchange runtime. You get a discriminated result: success
(`fallback: false`) or a typed fallback (`fallback: true`). Boolean
questions answer as native `noul` (0..1).

```ts
import { evaluate } from "@corbits/system-one";

const result = await evaluate({
  state: { action: "deploy", env: "production" },
  questions,
  config: { apiKey: process.env.TYPESAFE_API_KEY },
});
```

Success looks like:

```ts
{
  fallback: false,
  backend: "corbits-system-one", // official endpoint; "gateway" | "custom" otherwise
  modelId: "jev-1.13.0",
  latencyMs: 412,
  usage: { inputTokens: 296, outputTokens: 20 },
  decisions: [
    {
      id: "route",
      type: "choice",
      choice: "deny",
      confidence: 0.86,
      probabilities: { allow: 0.14, deny: 0.86 },
    },
    {
      id: "escalate",
      type: "noul",
      noul: 0.91,
    },
  ],
}
```

No key / timeout / HTTP / parse failure looks like:

```ts
{
  fallback: true,
  reason: "no-key", // or "timeout" | "network" | "http-error" | "parse-error" | "backend-unreachable"
  latencyMs: 2,
  backendAttempted: "https://api.typesafe.ai/...",
  detail: "no API key in config.apiKey, TYPESAFE_API_KEY, or SYSTEM_ONE_API_KEY",
}
```

Invalid caller input (bad questions, custom endpoint without `url`)
still **throws** a `SystemOneError` — that is not a fallback.

Auth: `config.apiKey`, else `TYPESAFE_API_KEY` (official),
`AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` (gateway), else
`SYSTEM_ONE_API_KEY`. Endpoint: omit for official (`jev-latest`);
`{ kind: "gateway" }`; `{ kind: "custom", url }`.

### Adapter — Interchange events, same decisions

`createSystemOneAdapter()` is a `ProviderAdapter`. Register
`"corbits-system-one"`, put questions on the call. The harness
streams events instead of returning `EvaluateResult`.

```ts
import { createAgent, defineAgent } from "@intx/agent";
import {
  createSystemOneAdapter,
  SYSTEM_ONE_PROVIDER, // "corbits-system-one"
} from "@corbits/system-one";

const def = defineAgent({
  id: "permission-gate",
  systemPrompt: "Decide whether this request needs human approval.",
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: SYSTEM_ONE_PROVIDER, model: "jev-latest" }],
  },
});

const agent = await createAgent(def, {
  source: {
    id: SYSTEM_ONE_PROVIDER,
    provider: SYSTEM_ONE_PROVIDER,
    model: "jev-latest",
    apiKey: process.env.TYPESAFE_API_KEY,
    adapter: createSystemOneAdapter(),
  },
});

const { reply } = await agent.send("Deploy to production?", {
  providerOptions: { systemOne: { questions } },
});
```

What the adapter emits (what `reply` is assembled from):

```ts
[
  {
    type: "inference.text.delta",
    data: {
      index: 0,
      token:
        '{"id":"route","type":"choice","choice":"deny","confidence":0.86,"probabilities":{"allow":0.14,"deny":0.86}}',
    },
  },
  {
    type: "inference.text.delta",
    data: {
      index: 1,
      token: '{"id":"escalate","type":"noul","noul":0.91}',
    },
  },
  {
    type: "inference.usage",
    data: {
      usage: {
        input: 296,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    },
  },
];
```

`JSON.parse` each `token` and you have the same decision objects as
`result.decisions`. There is no `fallback` flag on this path: a bad
wire body is a `ProtocolMismatchError`; auth/retry stay with the
harness (`retry-after` is surfaced for 429/529).

### Workflow step

Same provider and options bag:

```ts
import { defineWorkflow } from "@intx/workflow";
import {
  createSystemOneAdapter,
  SYSTEM_ONE_PROVIDER,
} from "@corbits/system-one";

export const refundGate = defineWorkflow({
  id: "refund-gate",
  steps: [
    {
      id: "decide",
      inference: {
        source: {
          provider: SYSTEM_ONE_PROVIDER,
          model: "jev-latest",
          adapter: createSystemOneAdapter(),
        },
        providerOptions: {
          systemOne: {
            state: { amount: 48, priorRefunds: 1 },
            questions: [
              {
                id: "approve",
                type: "boolean",
                instructions: "Approve this refund without review?",
              },
            ],
          },
        },
      },
    },
  ],
});
```

The step's inference output is the same event list: one text delta
whose token is `{"id":"approve","type":"noul","noul":0.2}`, then
usage.

## How it works

- **Wire.** Live Jev contract ([docs.typesafe.ai](https://docs.typesafe.ai)):
  `state` is string | object | array; questions go out as an id-keyed
  map; answers come back the same way.
- **Adapter.** Transcript → evaluation state; each decision →
  `inference.text.delta`; token counts → `inference.usage`.
- **Schemas.** Every trust boundary is arktype (`src/schemas.ts`).
  Confidence is narrowed, not clamped. Public surface is
  `src/index.ts` only.
- **Telemetry.** Direct `evaluate()` records `evaluate.start` /
  `.success` / `.fallback` in-memory (`drainTelemetryEvents`). No keys
  in events.

## Development

```
bun install
bun run check   # typecheck + lint + format:check + test
```

Compiled `dist/` is built with `tsc -p tsconfig.build.json` (no
bundler) and ships on npm; `prepack` rebuilds so every pack/publish
carries fresh output.

## License

LGPL-2.1-only.
