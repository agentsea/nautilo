import { createHash } from "node:crypto";

/**
 * Expo Router's only inline executable in the static export. The export
 * verifier pins this byte sequence so the CSP hash cannot silently drift.
 */
export const MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY =
  "globalThis.__EXPO_ROUTER_HYDRATE__=true;" as const;

export const MOBILE_WEB_EXPO_HYDRATION_SCRIPT_SHA256 = `sha256-${createHash("sha256")
  .update(MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY, "utf8")
  .digest("base64")}`;

function logtoConnectOrigin(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol !== "http:") return null;
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Mobile Web is a static document, but its browser Logto SDK fetches the
 * configured identity-provider origin. Keep that one origin explicit; all
 * static export resources remain same-origin.
 */
export function buildMobileWebContentSecurityPolicy(logtoEndpoint?: string): string {
  const connectSources = ["'self'", logtoConnectOrigin(logtoEndpoint)].filter(
    (value): value is string => value !== null,
  );
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' '${MOBILE_WEB_EXPO_HYDRATION_SCRIPT_SHA256}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob: data:",
    "manifest-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
  ].join("; ");
}

export function buildMobileWebSecurityHeaders(logtoEndpoint?: string): Readonly<Record<string, string>> {
  return {
    "content-security-policy": buildMobileWebContentSecurityPolicy(logtoEndpoint),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
  };
}
