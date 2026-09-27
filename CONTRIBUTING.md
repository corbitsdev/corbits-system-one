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

`e2e/live.test.ts` calls the real endpoint when `TYPESAFE_API_KEY` is
set and skips otherwise.

Compiled `dist/` is built with `tsc -p tsconfig.build.json` (no
bundler) and ships on npm; `prepack` rebuilds so every pack/publish
carries fresh output.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
