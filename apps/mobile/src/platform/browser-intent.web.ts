export type BrowserMobileIntent =
  | { readonly kind: "route"; readonly pathname: string; readonly search: string }
  | { readonly kind: "callback" }
  | { readonly kind: "rejected"; readonly reason: "cross-origin" | "native" | "outside-mobile" | "secret-bearing" | "invalid" };

const SECRET_QUERY_KEYS = new Set([
  "access_token", "authorization", "code", "id_token", "nonce",
  "password", "pin", "push", "refresh_token", "secret", "share", "state", "token",
]);

/** Parse only an explicit same-origin `/mobile` browser location. */
export function parseBrowserMobileIntent(raw: string, servingOrigin: string): BrowserMobileIntent {
  if (/^(?:nautilo|exp|intent):/i.test(raw.trim())) return { kind: "rejected", reason: "native" };
  let origin: string;
  let url: URL;
  try {
    origin = new URL(servingOrigin).origin;
    url = new URL(raw, origin);
  } catch {
    return { kind: "rejected", reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "rejected", reason: "native" };
  if (url.origin !== origin || url.username || url.password) return { kind: "rejected", reason: "cross-origin" };
  if (url.hash || [...url.searchParams.keys()].some((key) => SECRET_QUERY_KEYS.has(key.toLowerCase()))) {
    return { kind: "rejected", reason: "secret-bearing" };
  }
  if (url.pathname === "/mobile/callback" || url.pathname === "/mobile/callback/") {
    return { kind: "callback" };
  }
  if (url.pathname !== "/mobile" && !url.pathname.startsWith("/mobile/")) {
    return { kind: "rejected", reason: "outside-mobile" };
  }
  const pathname = url.pathname.slice("/mobile".length) || "/";
  return { kind: "route", pathname, search: url.search };
}
