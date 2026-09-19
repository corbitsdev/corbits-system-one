import { SystemOneError } from "./errors";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
//
// The (not yet implemented) POST transport for evaluation requests.
// Stub-only: the evaluate-core step supplies the fetch call, timeout via
// AbortSignal, auth header precedence, and JSON decoding.

/** Options for one evaluation POST: timeout and auth, resolved by `evaluate`. */
export type PostEvaluateOptions = {
  timeoutMs: number;
  apiKey?: string;
};

/**
 * POSTs an evaluation payload and returns the decoded JSON body. Stub: throws
 * until the evaluate-core step implements the transport.
 */
export async function postEvaluate(
  _url: string,
  _body: unknown,
  _options: PostEvaluateOptions,
): Promise<unknown> {
  throw new SystemOneError(
    "not-implemented",
    "not implemented: postEvaluate (evaluate-core step)",
  );
}
