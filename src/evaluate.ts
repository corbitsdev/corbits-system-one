import { SystemOneError } from "./errors";
import type { EvaluateInput, EvaluateResult, FallbackResult } from "./schemas";

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Runs one typed-decision evaluation against System One (or its gateway) and
 * returns either the backend's decisions or a typed fallback. Stub: throws a
 * `not-implemented` SystemOneError until the evaluate-core step lands.
 */
export async function evaluate(
  _input: EvaluateInput,
): Promise<EvaluateResult | FallbackResult> {
  throw new SystemOneError(
    "not-implemented",
    "not implemented: evaluate (evaluate-core step)",
  );
}
