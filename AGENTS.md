# AGENTS.md

## Purpose

A typed-decision evaluation client for System One (Jev-class) models.
Callers ask choice/score/boolean questions over a JSON state record and get
back typed decisions — or a typed fallback when the backend is unreachable.
Endpoint differences (official, gateway, custom) are config, not forked code.

## Layout

`src/schemas.ts` owns every trust boundary — questions, input, decisions,
results — as arktype schemas; the other modules are thin stubs until the
evaluate-core step lands. `src/index.ts` is the sole public entry:

- `src/schemas.ts` — everything data-shaped: `ChoiceQuestion`,
  `ScoreQuestion`, `BooleanQuestion`, the `Question` union, `JsonRecord`,
  `EndpointConfig`, `EvaluateConfig`, `EvaluateInput`, `Confidence`,
  `Decision`, `EvaluateResult`, `FallbackReason`, `FallbackResult`.
- `src/config.ts` — quirks-as-data: `SystemOneQuirks` plus the
  `SYSTEM_ONE_DEFAULT_QUIRKS` / `GATEWAY_QUIRKS` placeholders.
- `src/client.ts` — the fetch POST stub (`postEvaluate`).
- `src/evaluate.ts` — the `evaluate()` signature stub.
- `src/adapter.ts` — the `ProviderAdapter` wiring stub against
  `@intx/inference` plus the `SYSTEM_ONE_PROVIDER` id.
- `src/errors.ts` — the typed error taxonomy (`SystemOneError`,
  `SystemOneErrorCode`).
- `src/telemetry.ts` — the telemetry event shape plus its sink stub.
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

## Local development

```
bun install
bun run check   # typecheck + lint + format:check + test
```

## Distribution

The package ships TypeScript source on npm as `@corbits/system-one`:
`exports` points at `src/index.ts`, there is no build step and no `dist/`.
Consumers install it with `bun add @corbits/system-one` and Bun runs
the source as-is. It requires Bun >=1.2.0 per the `engines` field. To
publish, bump the version and run `npm publish --access public`.
