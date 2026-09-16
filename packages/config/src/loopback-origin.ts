/**
 * Browser-safe loopback origin canonicalization — zero imports.
 *
 * Sub-path export `@nautilo/config/loopback-origin` for consumers that
 * must not pull the main config barrel (which transitively imports
 * `@nautilo/logger` / Node-only modules).
 *
 * Construction-only: builds Nautilo-owned redirect/server URLs from
 * trusted canonical origins. Not for validating arbitrary inbound OAuth
 * redirect_uri values.
 */

function urlFromOrigin(origin: string): URL | null {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

/** True when `hostname` is a loopback host literal. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function isSupportedOriginProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * When `currentOrigin` is loopback, rewrite it to a trusted canonical
 * loopback origin with the same protocol and port. Non-loopback origins
 * and malformed input are returned unchanged.
 */
export function canonicalizeLoopbackOrigin(
  currentOrigin: string,
  canonicalOrigins: readonly string[],
): string {
  const current = urlFromOrigin(currentOrigin);
  if (!current || !isLoopbackHostname(current.hostname)) return currentOrigin;
  if (!isSupportedOriginProtocol(current.protocol)) return currentOrigin;

  for (const candidateOrigin of canonicalOrigins) {
    const candidate = urlFromOrigin(candidateOrigin);
    if (!candidate || !isLoopbackHostname(candidate.hostname)) continue;
    if (!isSupportedOriginProtocol(candidate.protocol)) continue;
    if (candidate.protocol !== current.protocol) continue;
    if (candidate.port !== current.port) continue;
    return candidate.origin;
  }

  return current.origin;
}

/** Build a redirect URI from a path and loopback-canonicalized origin. */
export function buildRedirectUri(
  path: string,
  currentOrigin: string,
  canonicalOrigins: readonly string[],
): string {
  const origin = canonicalizeLoopbackOrigin(currentOrigin, canonicalOrigins);
  return new URL(normalizePath(path), `${origin}/`).href;
}
