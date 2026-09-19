import type { FallbackReason } from "./schemas";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The typed taxonomy for every failure `evaluate` can report by throwing.
// Failures a caller handles as data instead live on `FallbackResult`; the
// reason literals are shared so the two can never drift apart.

/** Every error code `evaluate` can throw. */
export type SystemOneErrorCode = FallbackReason | "not-implemented";

/** Typed error thrown when `evaluate` cannot return a result at all. */
export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;

  constructor(code: SystemOneErrorCode, message: string) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
  }
}
