import { type } from "arktype";

import { SystemOneError } from "./errors";
import { FallbackReason } from "./schemas";

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
//
// Event shapes for evaluation observability. Data only, no sink: events are
// validated and buffered in a bounded in-memory ring the host drains with
// `drainTelemetryEvents` and forwards wherever it wants (stdout, OTLP, a
// host hook). A ring — not a pluggable sink — because a sink interface is a
// second public surface to version for no load-bearing reason: the host
// already owns every destination, it only needs lossless-per-call access to
// the events. The cap keeps a chatty loop from growing memory without bound
// (oldest events drop first). No event field ever carries key material.

/** One evaluation lifecycle event. */
export const SystemOneTelemetryEvent = type({
  event: "'evaluate.start' | 'evaluate.success' | 'evaluate.fallback'",
  backend: "'system-one' | 'gateway' | 'custom'",
  "modelId?": "string",
  latencyMs: "number",
  "reason?": FallbackReason,
  "+": "reject",
});
export type SystemOneTelemetryEvent = typeof SystemOneTelemetryEvent.infer;

/** Maximum buffered events; beyond this the oldest drop first. */
export const MAX_BUFFERED_TELEMETRY_EVENTS = 256;

const bufferedEvents: SystemOneTelemetryEvent[] = [];

/**
 * Records one telemetry event to the in-memory ring. Validates the shape
 * (a malformed event is caller misuse and throws a typed `SystemOneError`)
 * and never touches the network, disk, or console.
 */
export function recordTelemetryEvent(event: SystemOneTelemetryEvent): void {
  const parsed = SystemOneTelemetryEvent(event);
  if (parsed instanceof type.errors) {
    throw new SystemOneError(
      "parse-error",
      `recordTelemetryEvent: invalid event: ${parsed.summary}`,
    );
  }
  bufferedEvents.push(parsed);
  if (bufferedEvents.length > MAX_BUFFERED_TELEMETRY_EVENTS) {
    bufferedEvents.splice(
      0,
      bufferedEvents.length - MAX_BUFFERED_TELEMETRY_EVENTS,
    );
  }
}

/**
 * Drains the buffered telemetry events in arrival order and clears the
 * buffer. The host calls this after each evaluation (or on its own cadence)
 * to forward events to its own sink.
 */
export function drainTelemetryEvents(): SystemOneTelemetryEvent[] {
  return bufferedEvents.splice(0, bufferedEvents.length);
}
