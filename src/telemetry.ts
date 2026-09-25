import { type } from "arktype";

import { FallbackReason } from "./schemas.js";

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
//
// Event shape for evaluation observability. `evaluate` hands each event to
// the caller's `onTelemetry` sink, which forwards it wherever the host wants
// (stdout, OTLP, a host hook); no state is kept between calls. No event
// field ever carries key material.

/** One evaluation lifecycle event. */
export const SystemOneTelemetryEvent = type({
  event: "'evaluate.start' | 'evaluate.success' | 'evaluate.fallback'",
  backend: "'corbits-system-one' | 'gateway' | 'custom'",
  "modelId?": "string",
  latencyMs: "number",
  "reason?": FallbackReason,
  "detail?": "string",
  "+": "reject",
});
export type SystemOneTelemetryEvent = typeof SystemOneTelemetryEvent.infer;
