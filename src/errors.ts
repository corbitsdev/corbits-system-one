import type { FallbackReason } from "./schemas";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The typed taxonomy for every failure `evaluate` can report by throwing.
// Failures a caller handles as data instead live on `FallbackResult`; the
// reason literals are shared so the two can never drift apart. Transport
// failures use the three subclasses below (never raw `TypeError`s,
// `AbortError`s, or `SyntaxError`s); only caller-side misuse (invalid input,
// unconfigured endpoint) throws the bare `SystemOneError`.

/** Every error code `evaluate` can throw. Thrown-only codes (`"not-implemented"`, `"config-error"`) never appear as fallback reasons. */
export type SystemOneErrorCode =
  | FallbackReason
  | "not-implemented"
  | "config-error";

/** Typed error thrown when `evaluate` cannot return a result at all. */
export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;

  constructor(code: SystemOneErrorCode, message: string) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
  }
}

/**
 * The evaluation POST exceeded its timeout budget. Thrown by `postEvaluate`;
 * `evaluate` reports it as a `FallbackResult` with reason `'timeout'`.
 */
export class TimeoutError extends SystemOneError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("timeout", `system-one request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The evaluation POST never completed an HTTP exchange (DNS/TLS failure,
 * refused connection, reset stream) or the 200 body was not valid JSON.
 * Thrown by `postEvaluate`; `evaluate` reports it as a `FallbackResult`
 * with reason `'network'`.
 */
export class NetworkError extends SystemOneError {
  constructor(message: string) {
    super("network", message);
    this.name = "NetworkError";
  }
}

/**
 * The evaluation POST completed with a non-2xx status. Carries the status
 * only — never the response body, which is untrusted vendor output.
 * Thrown by `postEvaluate`; `evaluate` reports it as a `FallbackResult`
 * with reason `'http-error'`.
 */
export class HttpError extends SystemOneError {
  readonly httpStatus: number;

  constructor(httpStatus: number) {
    super("http-error", `system-one request failed with HTTP ${httpStatus}`);
    this.name = "HttpError";
    this.httpStatus = httpStatus;
  }
}
