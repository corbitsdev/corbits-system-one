import {
  classifyHTTPError,
  classifyNetworkError,
  classifyProtocolMismatch,
} from "@intx/inference";
import type { InferenceError } from "@intx/types/runtime";

import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { SystemOneError, transportFallbackReason } from "./errors.js";

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

/** The decoded JSON body of a 2xx evaluation response, with its latency. */
export type PostEvaluateResponse = {
  data: unknown;
  latencyMs: number;
  httpStatus: number;
};

function transportError(reason: InferenceError): SystemOneError {
  return new SystemOneError(
    transportFallbackReason(reason),
    reason.message,
    reason,
  );
}

/**
 * POSTs an evaluation payload and returns the decoded JSON body. Sends
 * `Authorization: Bearer <apiKey>` only when a key is present; aborts the
 * exchange when `timeoutMs` elapses. A `timeoutMs` that is not a finite
 * number >= 0 falls back to `DEFAULT_TIMEOUT_MS`. Throws a `SystemOneError`
 * carrying a `timeout` classification on timeout, a `classifyHTTPError`
 * classification (status only, never the body) on non-2xx, a
 * `classifyNetworkError` classification when no HTTP exchange completes,
 * and a `classifyProtocolMismatch` classification when the 2xx body is not
 * valid JSON.
 */
export async function postEvaluate(
  url: string,
  body: unknown,
  options: PostEvaluateOptions,
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
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const start = Date.now();
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
      res = await fetch(url, {
        method: "POST",
        headers,
        body: serialized,
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw transportError({
          category: "timeout",
          message: `system-one request timed out after ${timeoutMs}ms`,
        });
      }
      throw transportError(classifyNetworkError(cause));
    }
    if (!res.ok) {
      throw transportError(
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
      throw transportError(
        classifyProtocolMismatch("system-one response body is not valid JSON"),
      );
    }
    return { data, latencyMs: Date.now() - start, httpStatus: res.status };
  } finally {
    clearTimeout(timer);
  }
}
