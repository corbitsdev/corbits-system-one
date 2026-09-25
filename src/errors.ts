import type { InferenceError } from "@intx/types/runtime";

import type { FallbackReason } from "./schemas.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The typed taxonomy for every failure `evaluate` can report by throwing.
// Failures a caller handles as data instead live on `FallbackResult`; the
// reason literals are shared so the two can never drift apart. Transport
// failures carry an `InferenceError` classification as `reason` (never a raw
// `TypeError`, `AbortError`, or `SyntaxError`); caller-side misuse (invalid
// input, unconfigured endpoint) throws without one.

/** Every error code `evaluate` can throw. Thrown-only codes (`"not-implemented"`, `"config-error"`) never appear as fallback reasons. */
export type SystemOneErrorCode =
  FallbackReason | "not-implemented" | "config-error";

/** Typed error thrown when `evaluate` cannot return a result at all. */
export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;
  readonly reason?: InferenceError;

  constructor(
    code: SystemOneErrorCode,
    message: string,
    reason?: InferenceError,
  ) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

/**
 * Maps a transport classification to its fallback reason: a timeout stays
 * `'timeout'`, an unreadable body is `'parse-error'`, anything with an HTTP
 * status is `'http-error'`, and the rest never completed an exchange
 * (`'network'`).
 */
export function transportFallbackReason(
  reason: InferenceError,
): FallbackReason {
  if (reason.category === "timeout") return "timeout";
  if (reason.category === "protocol_mismatch") return "parse-error";
  if (reason.statusCode !== undefined) return "http-error";
  return "network";
}
