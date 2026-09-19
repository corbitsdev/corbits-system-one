import { type } from "arktype";

import { SystemOneError } from "./errors";
import { FallbackReason } from "./schemas";

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
//
// Event shapes for evaluation observability. Data only: the sink that ships
// these (stdout, OTLP, a host hook) is decided in the evaluate-core step.

/** One evaluation lifecycle event. */
export const SystemOneTelemetryEvent = type({
  event: "'evaluate.start' | 'evaluate.success' | 'evaluate.fallback'",
  backend: "'system-one' | 'gateway'",
  "modelId?": "string",
  latencyMs: "number",
  "reason?": FallbackReason,
  "+": "reject",
});
export type SystemOneTelemetryEvent = typeof SystemOneTelemetryEvent.infer;

/** Emits one telemetry event to the configured sink. Stub until core lands. */
export function recordTelemetryEvent(_event: SystemOneTelemetryEvent): void {
  throw new SystemOneError(
    "not-implemented",
    "not implemented: recordTelemetryEvent (evaluate-core step)",
  );
}
