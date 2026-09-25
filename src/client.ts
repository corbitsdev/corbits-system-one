import { DEFAULT_TIMEOUT_MS } from "./config.js";
import {
  HttpError,
  NetworkError,
  SystemOneError,
  TimeoutError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
//
// The POST transport for evaluation requests: one JSON round trip with a
// caller-resolved timeout and Bearer auth. Every failure is a typed error
// from `errors.ts` — never a raw `AbortError`, `TypeError`, or
// `SyntaxError` — so `evaluate` can map each one to a `FallbackResult`
// reason without sniffing error shapes.

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

/**
 * POSTs an evaluation payload and returns the decoded JSON body. Sends
 * `Authorization: Bearer <apiKey>` only when a key is present; aborts the
 * exchange when `timeoutMs` elapses. A `timeoutMs` that is not a finite
 * number >= 0 falls back to `DEFAULT_TIMEOUT_MS`. Throws `TimeoutError` on
 * timeout, `HttpError` (status only, never the body) on non-2xx, and
 * `NetworkError` when no HTTP exchange completes or the 2xx body is not
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
      if (controller.signal.aborted) throw new TimeoutError(timeoutMs);
      throw new NetworkError(
        `system-one request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!res.ok) throw new HttpError(res.status);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new NetworkError("system-one response body is not valid JSON");
    }
    return { data, latencyMs: Date.now() - start, httpStatus: res.status };
  } finally {
    clearTimeout(timer);
  }
}
