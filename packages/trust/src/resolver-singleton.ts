import type { PolicyResolver } from "./types";

let _resolver: PolicyResolver | null = null;

/**
 * Initialize the global PolicyResolver. Called once at server boot.
 */
export function initPolicyResolver(resolver: PolicyResolver): void {
  _resolver = resolver;
}

/**
 * Get the global PolicyResolver. Returns null if not initialized
 * (e.g., in tests or when the trust layer is not configured).
 */
export function getPolicyResolver(): PolicyResolver | null {
  return _resolver;
}
