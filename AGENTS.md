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
- `src/client.ts` — the fetch POST transport (`postEvaluate`): one JSON
  round trip with abort-bounded timeout, Bearer auth, typed errors only.
- `src/evaluate.ts` — `evaluate()`: input validation, credential
  resolution, strict answer cross-validation, and the fallback mapping.
- `src/adapter.ts` — `createSystemOneAdapter`: an Interchange
  `ProviderAdapter` bridge (buildRequest/parseResponse/parseJSONResponse/
  extractRetryAfterMs) plus the `SYSTEM_ONE_PROVIDER` id (`corbits-system-one`).
- `src/errors.ts` — the typed error taxonomy (`SystemOneError`,
  `SystemOneErrorCode`, `TimeoutError`, `NetworkError`, `HttpError`).
- `src/telemetry.ts` — the telemetry event shape and the bounded in-memory
  ring (`recordTelemetryEvent`/`drainTelemetryEvents`).
- `src/index.ts` — re-exports of the above only.
- `*.test.ts` next to the source they cover.

## Rules

- Consume `@intx/inference` and `@intx/types` as `peerDependencies`
  (`>=0.3.0`), pinned `0.3.0` in `devDependencies` for typecheck — never
  vendor, never `workspace:`. A host must resolve exactly one copy; a second
  copy breaks `instanceof` checks against the host's own classes.
- Parse every trust boundary (caller `EvaluateInput`, every backend response
  body) with arktype; never `as T` untrusted input.
- `exactOptionalPropertyTypes` is on: omit optional keys, never assign
  `undefined` to one.
- No product strings baked in — anything endpoint-specific is a config field
  the caller supplies.
- Public surface is `src/index.ts`'s export list only. Everything not
  re-exported there is module-private. Tests go through the public entry only
  — never import a submodule directly from a test.
- Tests only for load-bearing risk (schema accept/reject on hostile input,
  timeout/fallback transitions, wire-format encoding) — not for trivial
  mapping or "returns what I passed in".

- The wire contract is the live Jev API — source of truth is
  https://docs.typesafe.ai (see `api.md`, `primitives/*`). The
  `typesafe-ai` skill is installed at `.devin/skills/typesafe-ai/`.
  `state` is `string | object | array`; `instructions` and `criteria`
  values are `string | object | array` (structured forms are legal);
  answers require their kind's fields (`noul`, `choice`/`score` +
  `probabilities` + `confidence`, `legend` for score); the envelope may
  carry `usage.input_tokens`/`output_tokens`.

## Local development

```
bun install
bun run check   # typecheck + lint + format:check + test
```

## Distribution

The package ships compiled `dist/` on npm as `@corbits/system-one`.
`exports["."]` is the intx-src triple: Bun workspaces with the `intx-src`
condition load `src/index.ts` as-is; everyone else loads `dist/index.js`
with types from `dist/index.d.ts`. `files` is dist-only (`dist`, `README.md`,
`LICENSE`) — `src/` never publishes. `bun run build` (`tsc -p
tsconfig.build.json`, no bundler) emits `dist/`; `prepack` runs the build so
every pack/publish carries fresh output. Relative imports in `src/` carry
`.js` suffixes so the emitted ESM resolves under Node. It requires Bun

> =1.2.0 per the `engines` field. To publish, bump the version and run `npm
publish --access public`.
