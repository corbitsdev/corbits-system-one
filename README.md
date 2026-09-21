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

- **One provider id.** `SYSTEM_ONE_PROVIDER` (`"system-one"`) slots
  into `defineAgent` / workflow inference sources the same way
  Anthropic or an OpenAI-compatible relay does.
- **Questions on the call.** Pass Jev questions (and optional state)
  through `providerOptions.systemOne`. The transcript is the default
  state when you omit it.
- **Fail closed, stay typed.** Invalid input throws. Timeouts, HTTP
  errors, and off-schema answers resolve to a `FallbackResult` —
  never an untyped throw from the backend path.
- **Host-owned credentials.** The adapter sends Interchange's bearer
  sentinel; the harness injects the real key. Peers are
  `@intx/inference` and `@intx/types` — one copy, the host's.

## Quickstart

Requires [Bun](https://bun.sh/) 1.2+. Peers resolve to the host's
Interchange copies.

```
bun add @corbits/system-one
```

### Agent step

Register the adapter, point the agent at `system-one`, and put the
decision questions on the send:

```ts
import { createAgent, defineAgent } from "@intx/agent";
import {
  createSystemOneAdapter,
  SYSTEM_ONE_PROVIDER,
} from "@corbits/system-one";

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
  // storage, audit, authorize, directors — same as any Interchange agent
});

const { reply } = await agent.send("Deploy to production?", {
  providerOptions: { systemOne: { questions } },
});
```

Decisions come back as `inference.text.delta` events (JSON per
question) plus `inference.usage` when the backend reports tokens.

### Workflow step

Same provider, same options, on a workflow inference step:

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

### Direct `evaluate()`

When you are not inside an Interchange run, call the client:

```ts
import { evaluate } from "@corbits/system-one";

const result = await evaluate({
  state: { failedAttempts: 2, deviceClass: "iot" },
  questions: [
    {
      id: "escalate",
      type: "boolean",
      instructions: "Must this request be escalated?",
    },
  ],
});

if (!result.fallback) {
  const decision = result.decisions[0];
  if (decision?.type === "boolean") {
    decision.noul; // true | false
  }
}
```

Auth: explicit `config.apiKey`, else `TYPESAFE_API_KEY` (official),
`AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` (gateway), else
`SYSTEM_ONE_API_KEY`. Missing auth is a `'no-key'` fallback, not a
throw.

Endpoint: omit `config.endpoint` for official (`jev-latest`);
`{ kind: "gateway" }` for the Vercel AI Gateway; `{ kind: "custom",
url }` for a private route.

## How it works

- **Wire.** Live Jev contract ([docs.typesafe.ai](https://docs.typesafe.ai)):
  `state` is string | object | array; questions go out as an id-keyed
  map; answers come back the same way.
- **Adapter.** `createSystemOneAdapter()` is an Interchange
  `ProviderAdapter`. Transcript → evaluation state; decisions → text
  deltas; `retry-after` is honored on 429/529.
- **Schemas.** Every trust boundary is arktype (`src/schemas.ts`).
  Confidence is narrowed, not clamped. Public surface is
  `src/index.ts` only.
- **Telemetry.** `evaluate.start` / `.success` / `.fallback` buffer
  in-memory (`drainTelemetryEvents`). No keys in events.

## Development

```
bun install
bun run check   # typecheck + lint + format:check + test
```

TypeScript source on npm — no `dist/`. Bun runs `src/index.ts` as-is.

## License

LGPL-2.1-only.
