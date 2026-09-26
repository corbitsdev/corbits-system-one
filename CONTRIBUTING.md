# Contributing

## How it works

- **Wire.** Live Jev contract ([docs.typesafe.ai](https://docs.typesafe.ai)):
  `state` is string | object | array; questions go out as an id-keyed
  map; answers come back the same way.
- **Adapter.** Transcript → evaluation state; each decision →
  `inference.text.delta`; token counts → `inference.usage`.
- **Schemas.** Every trust boundary is arktype (`src/schemas.ts`).
  Confidence is narrowed, not clamped. Public surface is
  `src/index.ts` only.
- **Telemetry.** `evaluate(input, { onTelemetry })` passes
  `evaluate.start` / `.success` / `.fallback` events to the sink. No keys
  in events.

## Development

```
bun install
bun run check   # typecheck + lint + format:check + test
```

`examples/quickstart.ts` and `examples/interchange.ts` are the README snippets
verbatim. Typecheck covers them, so edit both together.

Compiled `dist/` is built with `tsc -p tsconfig.build.json` (no
bundler) and ships on npm; `prepack` rebuilds so every pack/publish
carries fresh output.
