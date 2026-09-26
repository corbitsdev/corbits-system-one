# AGENTS.md

## Purpose

A typed-decision evaluation client for System One (Jev-class) models.
Callers ask choice/score/boolean questions over a JSON state record and get
back typed decisions — or a typed fallback when the backend is unreachable.
Endpoint differences (official, gateway, custom) are config, not forked code.

## Layout

`src/schemas.ts` owns every trust boundary — questions, input, decisions,
results — as arktype schemas. `src/index.ts` is the sole public entry:

- `src/schemas.ts` — everything data-shaped: `State`, `Description`,
  `ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `BooleanQuestion`,
  the `Question` union, `QuestionList`, `JsonRecord`, `EndpointConfig`,
  `EvaluateConfig`, `EvaluateInput`, `Confidence`, `ProbabilityMap`,
  `WireQuestion`/`WireRequest`/`WireAnswer`/`WireResponseBody`, `Decision`,
  `Usage`, `EvaluateResult`, `FallbackReason`, `FallbackResult`, plus the
  `toWireQuestions`/`toDecision` mapping functions.
- `src/config.ts` — quirks-as-data: `SystemOneQuirks`, the
  `SYSTEM_ONE_DEFAULT_QUIRKS` / `GATEWAY_QUIRKS` endpoint presets, env-var
  names, `DEFAULT_TIMEOUT_MS`, and `resolveEndpoint`.
- `src/client.ts` — the module-private fetch POST transport (`postEvaluate`): one JSON
  round trip with abort-bounded timeout, Bearer auth, typed errors only.
- `src/evaluate.ts` — `evaluate()`: input validation, credential
  resolution, strict answer cross-validation, and the fallback mapping.
- `src/adapter.ts` — `createSystemOneAdapter`: an Interchange
  `ProviderAdapter` bridge (buildRequest/parseResponse/parseJSONResponse/
  extractRetryAfterMs) plus the `SYSTEM_ONE_PROVIDER` id (`corbits-system-one`).
- `src/errors.ts` — the typed error taxonomy (`SystemOneError`,
  `SystemOneErrorCode`); transport failures carry an `InferenceError`
  `reason` from the `@intx/inference` classifiers.
- `src/telemetry.ts` — the telemetry event shape `evaluate` passes to the
  caller's `onTelemetry` sink.
- `src/index.ts` — re-exports the public subset of the above.
- `*.test.ts` next to the source they cover (pure units).
- `e2e/harness.test.ts` — adapter turn and `evaluate` timeout through the
  `@intx/inference-testing` harness; `e2e/live.test.ts` — the real
  endpoint, gated on `TYPESAFE_API_KEY`.

## Rules

- Consume `@intx/inference` and `@intx/types` as `peerDependencies`
  (`^0.4.0`), pinned `0.4.0` in `devDependencies` for typecheck — never
  vendor, never `workspace:`. A host must resolve exactly one copy; a second
  copy breaks `instanceof` checks against the host's own classes.
- Parse every trust boundary (caller `EvaluateInput`, every backend response
  body) with arktype; never `as T` untrusted input.
- `exactOptionalPropertyTypes` is on: omit optional keys, never assign
  `undefined` to one.
- No product strings baked in — anything endpoint-specific is a config field
  the caller supplies.
- Public surface is `src/index.ts`'s export list only: `evaluate`, the
  adapter, the timeout default, errors, telemetry event, and the question,
  input and result schemas. Wire types, `postEvaluate`, `toWireQuestions`,
  `toDecision`, tolerances and endpoint quirks are module-private; unit
  tests for them import the owning submodule.
- Tests only for load-bearing risk (schema accept/reject on hostile input,
  timeout/fallback transitions, wire-format encoding) — not for trivial
  mapping or "returns what I passed in".
- The wire contract is the live Jev API; the source of truth is
  https://docs.typesafe.ai (`api.md`, `primitives/*`).
  `state` is `string | object | array`; `instructions` and `criteria`
  values are `string | object | array` (structured forms are legal);
  answers require their kind's fields (`noul`, `choice`/`score` +
  `probabilities` + `confidence`, `legend` for score); the envelope may
  carry `usage.input_tokens`/`output_tokens`.

## Local development

```sh
bun install && bun run check
```
