# @corbits/system-one

A typed-decision evaluation client for System One (Jev-class) models: ask
choice/score/boolean questions over a JSON state record and get back typed
decisions — or a typed fallback when the backend is unreachable. Endpoint
differences (official, gateway, custom) are config, not forked code.

> Scaffold status: the surface below is aspirational — `evaluate()` throws a
> typed `not-implemented` error until the evaluate-core step lands. Schemas,
> config shapes, and the error taxonomy are real and validated by tests.

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
    { kind: "choice", id: "route", options: ["allow", "step-up", "deny"] },
    { kind: "score", id: "risk", min: 0, max: 100 },
    { kind: "boolean", id: "escalate" },
  ],
});

if (result.fallback) {
  // A FallbackResult: result.reason is one of 'no-key' | 'timeout' |
  // 'network' | 'http-error' | 'parse-error' | 'backend-unreachable'.
} else {
  // An EvaluateResult: result.decisions, result.modelId, result.backend.
}
```

## Endpoint override

`EvaluateConfig.endpoint` selects the backend: `official` (the default when
omitted), `gateway` (the proxy endpoint, with `GATEWAY_QUIRKS` applied), or
`custom` with an explicit `url`. An optional `model` pins the model id per
evaluation.

```ts
await evaluate({
  state: {},
  questions: [{ kind: "boolean", id: "escalate" }],
  config: {
    endpoint: { kind: "gateway", model: "jev-1" },
    timeoutMs: 5000,
  },
});
```

## Auth precedence

1. An explicit `apiKey` in `EvaluateConfig`.
2. The `SYSTEM_ONE_API_KEY` environment variable.
3. No key anywhere → a `FallbackResult` with reason `'no-key'` (missing auth
   never throws; it is data, like every other fallback).

## Timeout / fallback semantics

`timeoutMs` bounds one evaluation round trip (the built-in default, applied
when omitted, is fixed in the evaluate-core step). When the bound is hit —
or the backend is unreachable, returns an HTTP error, or returns output that
fails schema validation — `evaluate` resolves to a `FallbackResult` carrying
the `reason`, `latencyMs`, the `backendAttempted`, and `httpStatus` when an
HTTP exchange produced one. Only scaffold-time misuse (calling the
not-yet-implemented `evaluate`) throws, as a `SystemOneError`.

## Telemetry

Every evaluation emits `SystemOneTelemetryEvent`s — `evaluate.start`,
`evaluate.success`, `evaluate.fallback` — carrying `backend`, `modelId`,
`latencyMs`, and the fallback `reason` when one applies. The sink that ships
these is decided in the evaluate-core step.

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

- `evaluate()`, the POST transport, and the `ProviderAdapter` wiring are
  stubs until the evaluate-core step (they throw `not-implemented`).
- The `Decision.distribution` wire shape is `unknown` until the backend
  contract lands.
- The telemetry sink is undecided.

## License

LGPL-2.1-only.
