import {
  classifyHTTPError,
  classifyNetworkError,
  classifyProtocolMismatch,
  type Dependencies,
} from "@intx/inference";
import type { InferenceError } from "@intx/types/runtime";

import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { SystemOneError, TransportError } from "./errors.js";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
//
// The POST transport for evaluation requests: one JSON round trip with a
// caller-resolved timeout and Bearer auth. Every transport failure is a
// `SystemOneError` whose `reason` is an `InferenceError` classification —
// never a raw `AbortError`, `TypeError`, or `SyntaxError` — so `evaluate`
// derives the `FallbackResult` reason from data, not error shapes.

/** Options for one evaluation POST: timeout and auth, resolved by `evaluate`. */
export type PostEvaluateOptions = {
  timeoutMs?: number;
  apiKey?: string;
};

/** Transport dependencies: the `fetch` to POST with and the timeout scheduler. */
export type EvaluateDeps = Pick<Dependencies, "fetch" | "scheduler">;

/** The decoded JSON body of a 2xx evaluation response, with its latency. */
export type PostEvaluateResponse = {
  data: unknown;
  latencyMs: number;
  httpStatus: number;
};

/**
 * POSTs an evaluation payload and returns the decoded JSON body. Sends
 * `Authorization: Bearer <apiKey>` only when a key is present; aborts the
 * exchange when `timeoutMs` elapses on `deps.scheduler`. A `timeoutMs`
 * that is not a finite number >= 0 falls back to `DEFAULT_TIMEOUT_MS`.
 * Throws a `TransportError` carrying a `timeout` classification on
 * timeout, a `classifyHTTPError` classification (status only, never the
 * body) on non-2xx, a `classifyNetworkError` classification when no HTTP
 * exchange completes, and a `classifyProtocolMismatch` classification when
 * the 2xx body is not valid JSON.
 */
export async function postEvaluate(
  url: string,
  body: unknown,
  options: PostEvaluateOptions,
  deps: EvaluateDeps,
): Promise<PostEvaluateResponse> {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new SystemOneError(
      "parse-error",
      "postEvaluate: request body is not JSON-serializable",
    );
  }
  const rawTimeoutMs = options.timeoutMs;
  const timeoutMs =
    rawTimeoutMs !== undefined &&
    Number.isFinite(rawTimeoutMs) &&
    rawTimeoutMs >= 0
      ? rawTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const cancelTimeout = deps.scheduler.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const start = deps.scheduler.now();
  // The timeout can fire while awaiting headers or while reading the body.
  const timedOut: InferenceError = {
    category: "timeout",
    message: `system-one request timed out after ${timeoutMs}ms`,
  };
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (options.apiKey !== undefined && options.apiKey !== "") {
      headers["authorization"] = `Bearer ${options.apiKey}`;
    }
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "POST",
        headers,
        body: serialized,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new TransportError(
        controller.signal.aborted ? timedOut : classifyNetworkError(cause),
      );
    }
    if (!res.ok) {
      throw new TransportError(
        classifyHTTPError(
          res.status,
          `system-one request failed with HTTP ${res.status}`,
        ),
      );
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new TransportError(
        controller.signal.aborted
          ? timedOut
          : classifyProtocolMismatch(
              "system-one response body could not be read as JSON",
            ),
      );
    }
    return {
      data,
      latencyMs: deps.scheduler.now() - start,
      httpStatus: res.status,
    };
  } finally {
    cancelTimeout();
  }
}
