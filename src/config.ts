import { type } from "arktype";

import { SystemOneError } from "./errors.js";
import type { EndpointConfig } from "./schemas.js";

// ---------------------------------------------------------------------------
// Quirks
// ---------------------------------------------------------------------------
//
// Everything one System One backend needs to bend the shared evaluation wire
// protocol to its own endpoint, expressed as data instead of a fork of the
// client. Every field here must be JSON-safe: quirks ride inside persisted
// configuration, so a function-valued field would silently fail to survive
// that round trip.

// Per-endpoint accommodations for the System One evaluation protocol. Every
// field is optional; an absent field resolves to the protocol default, so a
// caller that supplies no quirks gets no accommodation.
export const SystemOneQuirks = type({
  "baseUrl?": "string",
  "model?": "string",
  "+": "reject",
});
export type SystemOneQuirks = typeof SystemOneQuirks.infer;

// The official System One endpoint: the documented Jev systemone route with
// the stable model alias. Callers needing the proxied route use `gateway`;
// callers with their own deployment use `custom` with an explicit `url`.
export const SYSTEM_ONE_DEFAULT_QUIRKS = {
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
} satisfies SystemOneQuirks;

// The Vercel AI Gateway proxy for the Jev model, TypeSafe-compatible REST
// shape. Callers select it per call with `endpoint: { kind: "gateway" }`.
export const GATEWAY_QUIRKS = {
  baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  model: "typesafe-ai/jev",
} satisfies SystemOneQuirks;

// Credential sources, one per endpoint: a TypeSafe key never authenticates
// to the gateway and a gateway key never authenticates to TypeSafe direct,
// so each endpoint reads its own names. `SYSTEM_ONE_API_KEY` stays as the
// legacy universal fallback (and the key for `custom` endpoints).
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";
export const GATEWAY_OIDC_ENV = "VERCEL_OIDC_TOKEN";
export const SYSTEM_ONE_API_KEY_ENV = "SYSTEM_ONE_API_KEY";

// ---------------------------------------------------------------------------
// Edge defaults and endpoint resolution
// ---------------------------------------------------------------------------
//
// Defaults resolve here, at the `evaluate` edge, never inside a schema:
// schemas parse, they don't fill in defaults.

/**
 * Default bound for one evaluation round trip in milliseconds. 1500ms: a
 * single non-streaming POST over an already-warm connection should answer
 * far inside a second, and there is no published pilot SLO to calibrate
 * against yet — so the default fails fast to a typed `FallbackResult`
 * instead of holding the caller's round trip hostage. Callers with slower
 * backends (or a custom endpoint across regions) set `timeoutMs` per call.
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** One resolved evaluation target: the URL to POST, the model to send. */
export type ResolvedEndpoint = {
  url: string;
  backend: "corbits-system-one" | "gateway" | "custom";
  model: string;
};

/**
 * Resolves an evaluation endpoint to a concrete POST target. A per-call
 * `endpoint` wins over the package default (`official`); `custom` must
 * carry its own `url` and throws a typed `SystemOneError` when it does
 * not. A `custom` target keeps the `'custom'` backend label so telemetry
 * distinguishes caller-routed traffic from the official endpoint —
 * `'gateway'` is reserved for the proxy quirks path. The model always
 * resolves here: a `custom` target without one sends `typesafe-ai/jev`.
 */
export function resolveEndpoint(endpoint?: EndpointConfig): ResolvedEndpoint {
  if (endpoint?.kind === "custom") {
    if (endpoint.url === "") {
      throw new SystemOneError(
        "config-error",
        'evaluate: endpoint kind "custom" requires an explicit url',
      );
    }
    return {
      url: endpoint.url,
      backend: "custom",
      model: endpoint.model ?? GATEWAY_QUIRKS.model,
    };
  }
  const kind = endpoint?.kind ?? "official";
  const quirks =
    kind === "gateway" ? GATEWAY_QUIRKS : SYSTEM_ONE_DEFAULT_QUIRKS;
  const url = quirks.baseUrl;
  if (url === undefined || url === "") {
    throw new SystemOneError(
      "backend-unreachable",
      `evaluate: no baseUrl configured for endpoint kind "${kind}"`,
    );
  }
  return {
    url,
    backend: kind === "gateway" ? "gateway" : "corbits-system-one",
    model: endpoint?.model ?? quirks.model,
  };
}
