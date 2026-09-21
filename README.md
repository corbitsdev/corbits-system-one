# @corbits/system-one

A typed-decision evaluation client for System One (Jev-class) models: ask
choice/score/noul questions over a state payload and get back typed
decisions — or a typed fallback when the backend is unreachable. Endpoint
differences (official, gateway, custom) are config, not forked code. The wire
follows the live Jev contract (docs.typesafe.ai/api): `state` is a string,
object, or array; `instructions` and `criteria` accept structured objects;
questions serialize to an id-keyed map and answers arrive in an `answers`
map keyed by the same ids.

## Install

Requires Bun >=1.2.0 (see the `engines` field in `package.json`). The
package ships TypeScript source with no build step; Bun consumes it directly.

```
bun add @corbits/system-one
```

`@intx/inference` and `@intx/types` are peer dependencies and resolve to
the host's own copy.

## Usage

```ts
import { evaluate } from "@corbits/system-one";

const result = await evaluate({
  state: { failedAttempts: 2, deviceClass: "iot" },
  questions: [
    {
      id: "route",
      type: "choice",
      instructions: "What permission decision does this request warrant?",
      criteria: { allow: "Low-risk request", deny: "Refuse the request" },
    },
    {
      id: "risk",
      type: "score",
      instructions: "Rate the permission risk.",
      criteria: ["Low risk", "Moderate risk", "High risk", "Critical risk"],
    },
    {
      id: "escalate",
      type: "boolean",
      instructions: "Must this request be escalated for human approval?",
    },
  ],
});

if (result.fallback) {
  // A FallbackResult: result.reason is one of 'no-key' | 'timeout' |
  // 'network' | 'http-error' | 'parse-error' | 'backend-unreachable',
  // with result.detail explaining parse-error and no-key failures.
} else {
  // An EvaluateResult: result.decisions is a per-kind discriminated
  // union — `if (d.type === "choice") d.choice` is always present —
  // plus result.modelId, result.backend, and result.usage when the
  // backend reports token counts.
}
```

## Endpoint override

`EvaluateConfig.endpoint` selects the backend: `official` (the default when
omitted — the documented Jev systemone route with model `jev-latest`),
`gateway` (the Vercel AI Gateway proxy with model `typesafe-ai/jev`), or
`custom` with a required `url` (model defaults to `typesafe-ai/jev`). `url`
only exists on `custom` — the schema rejects it on other kinds rather than
silently ignoring it. An optional `model` pins the model id per evaluation:

```ts
await evaluate({
  state: {},
  questions: [
    {
      id: "escalate",
      type: "boolean",
      instructions: "Must this request be escalated?",
    },
  ],
  config: {
    endpoint: { kind: "custom", url: "https://jev.internal.example/evaluate" },
    timeoutMs: 5000,
  },
});
```

## Auth precedence

1. A non-empty explicit `apiKey` in `EvaluateConfig` (an empty string falls
   through to the environment instead of shadowing it).
2. The endpoint's environment key: `TYPESAFE_API_KEY` for `official`,
   `AI_GATEWAY_API_KEY` then `VERCEL_OIDC_TOKEN` for `gateway`. A TypeSafe
   key never authenticates to the gateway and vice versa.
3. The legacy `SYSTEM_ONE_API_KEY` fallback (and the key for `custom`).
4. No key anywhere → a `FallbackResult` with reason `'no-key'` (missing auth
   never throws; it is data, like every other fallback).

## Timeout / fallback semantics

`timeoutMs` bounds one evaluation round trip. The built-in default, applied
when omitted, is `DEFAULT_TIMEOUT_MS` — 1500ms. A `timeoutMs` that is not a
finite number >= 0 falls back to `DEFAULT_TIMEOUT_MS` rather than throwing.
No pilot SLO is published,
so the default is a tight interactive budget: fail fast to a typed fallback
rather than hang the caller. Callers with a different budget override it
per call via `EvaluateConfig.timeoutMs`. When the bound is hit — or the
backend is unreachable, returns an HTTP error, or returns output that
fails strict validation — `evaluate` resolves to a `FallbackResult`
carrying the `reason`, `latencyMs`, the `backendAttempted` (credentials in
custom URLs are stripped), `httpStatus` when an HTTP exchange produced one,
and `detail` describing validation violations. Only caller-side misuse
(invalid input, a `custom` endpoint without a `url`) throws, as a typed
`SystemOneError`.

## Telemetry

Each evaluation that passes input validation and endpoint resolution emits
`SystemOneTelemetryEvent`s — `evaluate.start`, `evaluate.success`,
`evaluate.fallback` — carrying `backend`, `modelId`, `latencyMs`, the
fallback `reason`, and a `detail` when one applies. Caller-side misuse that throws before
any event is recorded (invalid input, a `custom` endpoint without a `url`)
emits none. There is no sink:
events buffer to an in-memory ring (capped at
`MAX_BUFFERED_TELEMETRY_EVENTS`, oldest dropped past the cap) that the host
drains with `drainTelemetryEvents`. Events never carry key material.

## Interchange adapter

`createSystemOneAdapter()` returns an Interchange `ProviderAdapter`
(`@intx/inference`) so Jev slots into intx workflows and agents: the
conversation transcript becomes the evaluation `state`, each decision is
emitted as an `inference.text.delta` carrying its JSON, and the response's
token counts flow through as `inference.usage`. `extractRetryAfterMs`
surfaces the backend's `retry-after` header so the host harness honors
429/529 backoff. Auth stays host-side — requests carry the bearer sentinel.
Per call, `providerOptions.systemOne` (`{ state?, questions? }`) overrides
the transcript-derived defaults.

## API

See `src/index.ts` for the full public surface; every schema field is
documented individually in `src/schemas.ts`.

## Design notes

- `quirks` are JSON (persisted and sent over the wire); code-shaped
  accommodations never ride the quirks bag.
- Defaults resolve at the `evaluate` edge, never inside a schema: schemas
  parse, they don't fill in defaults.
- Confidence is narrowed, not clamped: an out-of-range backend value fails
  validation rather than being silently squeezed into 0..1.
- A host must resolve one copy of `@intx/inference`: it's a peer dependency,
  and an adapter built against a second copy fails `instanceof` checks in
  the host's harness.

## Not supported

- Publish: the package is not published to a registry yet.
- Host seam: no host-side wiring is prescribed — a credential-store hook
  beyond per-call key / environment keys, and forwarding of drained
  telemetry to a host sink, are host concerns.
- Parity harness: no recorded vendor fixtures or live-backend parity run —
  the wire contract is encoded from the documented Jev shape, with strict
  validation routing mismatches to fallback. Seven keyed live cases ship in
  the suite and skip cleanly without credentials.

## License

LGPL-2.1-only.
