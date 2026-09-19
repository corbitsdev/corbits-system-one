import type { ProviderAdapter } from "@intx/inference";

import { SystemOneError } from "./errors";
import type { EvaluateConfig } from "./schemas";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Provider id this package serves once the evaluate-core step wires it up. */
export const SYSTEM_ONE_PROVIDER = "system-one";

/**
 * Builds the Interchange `ProviderAdapter` for System One. Stub: throws until
 * the evaluate-core step implements request building and response parsing
 * against the host's single copy of `@intx/inference`.
 */
export function createSystemOneAdapter(
  _config?: EvaluateConfig,
): ProviderAdapter {
  throw new SystemOneError(
    "not-implemented",
    "not implemented: createSystemOneAdapter (evaluate-core step)",
  );
}
