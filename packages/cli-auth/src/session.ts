/**
 * Session helpers — Phase 0 (M108) re-exports the canonical single-file
 * CLI session store from `@nautilo/api-client`. Phase 1 adds per-profile
 * path resolution on top.
 */
import {
  loadCliSession as baseLoadCliSession,
  saveCliSession as baseSaveCliSession,
  clearCliSession as baseClearCliSession,
  requireSession as baseRequireSession,
  touchCliSessionObtainedAt as baseTouch,
  type CliSessionV1Payload,
} from "@nautilo/api-client";

export {
  loadCliSession,
  saveCliSession,
  clearCliSession,
  requireSession,
  touchCliSessionObtainedAt,
  CliSessionMissingError,
  CliSessionExpiredError,
  CliSessionFileModeError,
} from "@nautilo/api-client";
export type { CliSessionV1Payload } from "@nautilo/api-client";

/**
 * Per-profile session helpers (M108 Phase 1.1).
 *
 * Callers in apps/cli inject a `resolveActiveProfile` function via
 * `setActiveProfileResolver(fn)` so this package does not depend on
 * apps/cli internals. The no-arg API remains for compatibility.
 */
export type ActiveProfileResolver = () => string | undefined;

let resolver: ActiveProfileResolver | null = null;

export function setActiveProfileResolver(fn: ActiveProfileResolver | null): void {
  resolver = fn;
}

function currentProfile(): string | undefined {
  const name = resolver?.();
  if (name && name.length > 0) return name;
  return undefined;
}

export async function loadCliSessionForActiveProfile(): Promise<CliSessionV1Payload | null> {
  const profile = currentProfile();
  return baseLoadCliSession(profile ? { profile } : undefined);
}

export async function saveCliSessionForActiveProfile(
  payload: CliSessionV1Payload,
): Promise<void> {
  const profile = currentProfile();
  return baseSaveCliSession(payload, profile ? { profile } : undefined);
}

export async function dropCliSessionForActiveProfile(): Promise<void> {
  const profile = currentProfile();
  return baseClearCliSession(profile ? { profile } : undefined);
}

export async function requireSessionForActiveProfile(): Promise<CliSessionV1Payload> {
  const profile = currentProfile();
  return baseRequireSession(profile ? { profile } : undefined);
}

export async function touchCliSessionObtainedAtForActiveProfile(): Promise<void> {
  const profile = currentProfile();
  return baseTouch(profile ? { profile } : undefined);
}
