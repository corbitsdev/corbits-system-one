# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

`bun run test:e2e` runs the harness suite; `e2e/live.test.ts` calls the real endpoint when `TYPESAFE_API_KEY` is set and skips otherwise.

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

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.
