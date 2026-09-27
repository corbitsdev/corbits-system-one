# Changelog

## 0.2.0

### Breaking

- `HttpError`, `NetworkError` and `TimeoutError` are gone. Transport
  failures surface as `FallbackResult`s; misuse throws `SystemOneError`,
  whose transport variants carry an `InferenceError` `reason`.
- A 2xx body that is not JSON is a `parse-error` fallback (was
  `network`); a timeout during the body read is `timeout`. Transport
  fallbacks carry the transport message in `detail`.
- `recordTelemetryEvent`, `drainTelemetryEvents` and
  `MAX_BUFFERED_TELEMETRY_EVENTS` are gone: pass
  `evaluate(input, { onTelemetry })` instead.
- `evaluate` takes an optional second `options` argument
  (`onTelemetry`, `deps: { fetch, scheduler }`).
- Removed from the entry: `postEvaluate`, `toWireQuestions`,
  `toDecision`, `Wire*` types, `EvaluateResponseBody`,
  `SystemOneQuirks` and the quirks presets, `APPROXIMATE_SUM_TOLERANCE`,
  `JsonRecord`, `Confidence`, and the env-var name constants
  (`TYPESAFE_API_KEY_ENV`, `GATEWAY_API_KEY_ENV`, `GATEWAY_OIDC_ENV`,
  `SYSTEM_ONE_API_KEY_ENV`).
- A `custom` endpoint without a `model` sends `typesafe-ai/jev`, and the
  adapter reports that model instead of `"unknown"`.
- Peers are `@intx/inference` and `@intx/types` `^0.4.0` (was
  `>=0.4.0`); `engines.node` is `>=24`.

### Unchanged

- Environment variables: `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`,
  `VERCEL_OIDC_TOKEN`, and `SYSTEM_ONE_API_KEY` as a supported alias for
  every endpoint. Existing deployments need no config change.
