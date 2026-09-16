/**
 * D103 P4d.8 — Server URL host canonicalization.
 *
 * `127.0.0.1` and `localhost` are *separate web origins* per browser /
 * Electron rules. If the user pastes one form into the first-run picker
 * but the server self-declares the other, four downstream surfaces break
 * subtly:
 *
 *   1. **Logto OIDC redirect URIs** are origin-allowlisted. Only one of
 *      `http://localhost:3001/auth/callback` or
 *      `http://127.0.0.1:3001/auth/callback` is registered (see
 *      `nautilo-server`'s instance.json). Pasting the other form makes
 *      Logto reject the redirect with `invalid_redirect_uri` and the
 *      sign-in screen sticks on "redirecting...".
 *   2. **CORS** in `packages/server/src/app.ts` registers cors with
 *      `origin: true` in dev (so it does not bite today), but cloud mode
 *      (`origin: false`) would reject the cross-origin request silently.
 *   3. **Cookies** are scoped per-origin. A user who pairs to one form
 *      and later edits the URL to the other silently loses every cookie
 *      the workbench set.
 *   4. **`/api/setup/status`'s `serverUrl` field** comes from
 *      `~/.nautilo/instance.json` and is the canonical answer. Drift
 *      between cfg.serverUrl and the server-declared URL leaks into
 *      logging, telemetry, and any "where am I connected to?" UI.
 *
 * Rule: parse the user input with `new URL()`. When the input origin and
 * the server-declared origin are both loopback but disagree on host
 * literal, rewrite the input origin to match the server's (via the shared
 * `@nautilo/config/loopback-origin` helper). Non-loopback hosts (cloud,
 * LAN IP, custom domain) are left alone — only loopback↔loopback drift is
 * canonicalized.
 *
 * Also strips a trailing slash so `http://localhost:3001/` and
 * `http://localhost:3001` round-trip to the same persisted form (the
 * picker accepts both).
 */

import {
  canonicalizeLoopbackOrigin,
  isLoopbackHostname,
} from "@nautilo/config/loopback-origin";

/**
 * M161 Phase 1 — single source of truth for the canonical server URL
 * string used by recent-servers dedupe, token filenames, persistent
 * partitions, registry scopes, and fingerprints.
 *
 * Behavior contract:
 *   - Non-loopback hosts round-trip identically to
 *     `canonicalizeRecentServerUrl` (trim → `new URL()` → strip trailing
 *     slash). `URL` normalization lowercases the host and preserves
 *     protocol/path/query/hash casing.
 *   - When `serverDeclaredUrl` is supplied and both origins are loopback
 *     with matching protocol/port, the input origin is rewritten to the
 *     declared one via `canonicalizeLoopbackOrigin` — matching
 *     `canonicalizeServerUrl`'s loopback rewrite.
 *   - Idempotent: feeding the output back in yields the same string.
 *
 * `serverDeclaredUrl` is optional: recents/token filenames call without
 * it (no server on hand); boot/registry call with the server-declared
 * URL so loopback drift (`127.0.0.1` ↔ `localhost`) collapses.
 */
export function canonicalServerScope(
  input: string,
  serverDeclaredUrl?: string | null,
): string {
  const u = new URL(input.trim());

  if (serverDeclaredUrl) {
    let declared: URL | null = null;
    try {
      declared = new URL(serverDeclaredUrl);
    } catch {
      // Malformed declared URL — bail out of the loopback rewrite.
      // Persist the user's input verbatim rather than crashing.
    }
    if (declared) {
      const canonicalOrigin = canonicalizeLoopbackOrigin(u.origin, [
        declared.origin,
      ]);
      if (canonicalOrigin !== u.origin) {
        const rebuilt = new URL(
          `${u.pathname}${u.search}${u.hash}`,
          `${canonicalOrigin}/`,
        );
        return rebuilt.toString().replace(/\/$/, "");
      }
    }
  }

  // Trailing-slash strip. `URL.toString()` always emits a trailing `/`
  // for origin-only URLs (e.g. `new URL("http://x:1").toString() ===
  // "http://x:1/"`), which silently differs from the bare `http://x:1`
  // the user typed and breaks string-equality checks downstream.
  return u.toString().replace(/\/$/, "");
}

export function canonicalizeServerUrl(
  input: string,
  serverDeclaredUrl: string | null,
): string {
  // M161 Phase 1 — delegate to the shared canonical helper so loopback
  // rewrite + trailing-slash policy has exactly one implementation.
  // `canonicalizeServerUrl` historically did NOT trim its input; we trim
  // here for parity with recents. Inputs reaching this handler are
  // server-resolved URLs without surrounding whitespace, so observable
  // behavior is unchanged.
  return canonicalServerScope(input, serverDeclaredUrl);
}

/**
 * M161 Phase 6.4 — pure loopback *dedupe-only* key.
 *
 * Normalizes the loopback host literals `localhost`, `127.0.0.1`,
 * `[::1]` / `::1` to a single host literal (`localhost`) while
 * preserving protocol + port (+ path/query/hash). Non-loopback hosts
 * round-trip through `canonicalServerScope` (trim, lowercase host,
 * strip trailing slash) so two non-loopback URLs that differ only in
 * casing/trailing slash also collapse.
 *
 * Scope — dedupe-only, never persisted:
 *   Used ONLY to collapse visually-identical alias rows in
 *   `ServerSessionRegistry.listEnriched()` and the recent-servers
 *   view. NEVER use this for persisted auth/relay token scopes, Electron
 *   partition identity (`persist:server-<scope>`), token filenames, or
 *   any string that lands on disk as a stable key — those keep using
 *   `canonicalServerScope` (the persisted identity authority). The
 *   deeper on-disk token/partition canonical migration is TRACKED to
 *   D133 and is explicitly out of scope here.
 *
 * Idempotent: feeding the output back in yields the same string.
 */
export function loopbackDedupeKey(input: string): string {
  const canonical = canonicalServerScope(input);
  const u = new URL(canonical);
  if (isLoopbackHostname(u.hostname)) {
    u.hostname = "localhost";
    return u.toString().replace(/\/$/, "");
  }
  return canonical;
}
