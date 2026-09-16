/**
 * M097 + M106 — pure stale-bearer detection helpers extracted from
 * `use-auth.ts` so they can be unit-tested without dragging the React
 * + Logto SDK module into the test loader. Their dedicated test
 * (`use-auth-stale-token.test.ts`) was breaking on CI when a sibling
 * test that does `mock.module("../../src/hooks/use-auth", ...)`
 * happened to run first — Bun's module mock is process-persistent and
 * can't be torn down per-file, so the next file's `import { ... }
 * from "../../src/hooks/use-auth"` would fail with a missing-export
 * SyntaxError. Splitting the pure helpers into this leaf file means
 * the dedicated tests import from a module that nothing else mocks.
 */
import type { WhoamiResponse } from "@nautilo/types";

function whoamiResponseLooksStaleBearer(
  data: Partial<WhoamiResponse>,
): boolean {
  return (data.sessionUserId ?? null) === null;
}

/**
 * M097 — A whoami response is "stale-bearer" when we presented a non-empty bearer
 * but the server treated us as unauthenticated (no session user).
 * Centralizes Workbench stale-auth detection.
 */
export function detectStaleWhoamiResponse(
  token: string | null | undefined,
  data: Partial<WhoamiResponse>,
): boolean {
  const hadNonEmptyToken = typeof token === "string" && token.length > 0;
  if (!hadNonEmptyToken) return false;
  return whoamiResponseLooksStaleBearer(data);
}

/** Pure ref-step for stale bearer recovery (unit-tested). */
export function computeStaleBearerSignOutAction(args: {
  nonEmptyToken: boolean;
  whoami: Partial<WhoamiResponse>;
  staleSignOutAlreadyTriggered: boolean;
}): { shouldSignOut: boolean; nextStaleSignOutTriggered: boolean } {
  if (!args.nonEmptyToken) {
    return { shouldSignOut: false, nextStaleSignOutTriggered: false };
  }
  const looksStale = whoamiResponseLooksStaleBearer(args.whoami);
  if (!looksStale) {
    return { shouldSignOut: false, nextStaleSignOutTriggered: false };
  }
  if (args.staleSignOutAlreadyTriggered) {
    return { shouldSignOut: false, nextStaleSignOutTriggered: true };
  }
  return { shouldSignOut: true, nextStaleSignOutTriggered: true };
}
