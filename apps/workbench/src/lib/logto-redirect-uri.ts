/**
 * Browser-side OIDC redirect URI helpers.
 *
 * Local dev can be opened through either localhost or 127.0.0.1, but
 * Logto redirect URI matching is exact. These helpers align loopback
 * aliases with the canonical origins advertised by `/health`.
 */

import { canonicalizeLoopbackOrigin } from "@nautilo/config/loopback-origin";

export { canonicalizeLoopbackOrigin };

/**
 * Post-logout destinations the Workbench may deliberately request from
 * Logto. Keep this closed: logout must never relay arbitrary local paths,
 * invite tokens, or capability-bearing values through the OIDC provider.
 */
export const WORKBENCH_POST_LOGOUT_RETURN_PATHS = ["/claim"] as const;
export type WorkbenchPostLogoutReturnPath =
  (typeof WORKBENCH_POST_LOGOUT_RETURN_PATHS)[number];

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function buildWorkbenchRedirectUri(
  path: string,
  currentOrigin: string,
  _canonicalOrigins: readonly string[],
): string {
  // Browser SPA sign-in state lives in sessionStorage under the current
  // origin. Redirecting a 127.0.0.1 sign-in callback to localhost strands
  // the SDK state and leaves `/auth/callback` stuck on "Completing sign-in".
  return new URL(normalizePath(path), `${currentOrigin}/`).href;
}

/**
 * Build the registered post-logout URI for an explicit Workbench return
 * destination. Omitting the path preserves the ordinary product-root logout.
 */
export function buildWorkbenchPostLogoutRedirectUri(
  returnPath: WorkbenchPostLogoutReturnPath | undefined,
  currentOrigin: string,
  canonicalOrigins: readonly string[],
): string {
  const origin = canonicalizeLoopbackOrigin(currentOrigin, canonicalOrigins);
  return returnPath === undefined
    ? origin
    : new URL(returnPath, `${origin}/`).href;
}
