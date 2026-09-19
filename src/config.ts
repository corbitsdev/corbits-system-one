import { type } from "arktype";

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

// TODO(evaluate-core): fill in the official endpoint quirks (base URL,
// default model) once the backend contract lands.
export const SYSTEM_ONE_DEFAULT_QUIRKS: SystemOneQuirks = {};

// TODO(evaluate-core): fill in the gateway endpoint quirks (gateway base URL,
// header routing) once the gateway contract lands.
export const GATEWAY_QUIRKS: SystemOneQuirks = {};
