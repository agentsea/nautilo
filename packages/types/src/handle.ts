/**
 * M107 — shared handle (= Logto username = local part of federated
 * `@user@server` identity) validation. Single source of truth for the
 * regex used by:
 *   - apps/workbench (invite-redeem wizard preview, forgot-password Tab A)
 *   - packages/server (invites + account routes, redeem-invite lib)
 *   - bin/nautilo-dev (verify-user-link, reset-logto-user-password,
 *     migrate-to-username-identity)
 *
 * The shape is the server's pre-M107 form: letter-leading, 3–30 chars,
 * lowercase letters + digits + underscore. Sits strictly inside
 * Logto's `[A-Za-z0-9_]+` username superset so any string passing
 * HANDLE_RE is also a valid Logto username.
 *
 * Do NOT inline this regex anywhere — import HANDLE_RE from
 * `@nautilo/types`. A guard test in
 * `packages/server/tests/unit/handle-regex.test.ts` asserts there is
 * exactly one source.
 */
export const HANDLE_RE = /^[a-z][a-z0-9_]{2,29}$/;

/** Maximum number of characters in a handle. */
export const HANDLE_MAX_LEN = 30;

/** Minimum number of characters in a handle. */
export const HANDLE_MIN_LEN = 3;

/**
 * Human-readable error string for failed HANDLE_RE matches. Stable
 * copy so server and workbench surfaces can show the same thing without each
 * inventing a phrasing.
 */
export const HANDLE_INVALID_MESSAGE =
  "Choose a handle that's 3–30 lowercase letters, digits, or underscores, starting with a letter.";

/** Normalize a user-supplied handle: trim + lowercase. Does NOT validate. */
export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase();
}

/** Convenience: normalize then test. */
export function isValidHandle(input: string): boolean {
  return HANDLE_RE.test(normalizeHandle(input));
}

/**
 * M156 — Slugify an arbitrary Agent name into a HANDLE_RE-compatible *base*
 * (letter-leading, lowercase letters/digits/underscore, <= HANDLE_MAX_LEN).
 * Returns "" when nothing usable remains (caller must fall back).
 *
 * Note: this returns a *base* candidate. It does NOT guarantee minimum
 * length — callers must check `HANDLE_MIN_LEN` and supply a fallback.
 */
export function slugifyToHandleBase(name: string): string {
  let s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // collapse runs of non-charset to "_"
    .replace(/^_+|_+$/g, ""); // trim leading/trailing "_"
  // HANDLE_RE requires a letter lead — strip any leading non-letters.
  s = s.replace(/^[^a-z]+/, "");
  return s.slice(0, HANDLE_MAX_LEN);
}
