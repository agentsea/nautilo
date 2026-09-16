// D369 Phase 4 — pure deep-link classifier for nautilo:// URLs.
// No React, no side-effects, never throws — safe to unit-test in isolation.
// The hook (hooks/use-deep-link.ts) consumes this and routes; the QR scanner
// (app/(onboarding)/scan-qr.tsx) reuses it to validate scanned payloads.
//
// Schemes handled:
//   nautilo://callback[...]            → { kind: "callback" }   (auth owns it; we ignore)
//   nautilo://add-server?url=<encoded> → { kind: "add-server", url }
//   nautilo://add-server/<host>        → { kind: "add-server", url }
//   nautilo://invite/<token>           → { kind: "invite", token }
//   nautilo://invite?token=<token>     → { kind: "invite", token }
//   <anything else>                    → { kind: "unknown", raw }
//
// `normalizeServerUrl` is reused from the api-client so a single source of
// truth decides what a "valid" server URL looks like (adds https://, strips
// trailing slashes, rejects garbage). Invalid add-server payloads collapse
// to `unknown` rather than surfacing a half-built URL to the router.
import { normalizeInviteServerOrigin, normalizeServerUrl } from "@/lib/server-url";

export type ParsedDeepLink =
  | { kind: "add-server"; url: string }
  | { kind: "invite"; serverUrl: string; token: string }
  | { kind: "invalid-invite"; reason: "missing-server" | "invalid-server" | "invalid-token" }
  | {
      kind: "remote-pair";
      challengeId: string;
      secret: string;
      ceremonyContext: string;
    }
  | { kind: "callback" }
  | { kind: "unknown"; raw: string };

const NAUTILO_SCHEME_RE = /^nautilo:\/\//i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CEREMONY_CONTEXT = /^[0-9a-f]{64}$/;
const INVITE_TOKEN_RE = /^inv_[A-Za-z0-9_-]+$/;

function parseHttpsInvite(raw: string): ParsedDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) {
    return { kind: "invalid-invite", reason: "invalid-server" };
  }
  const match = url.pathname.match(/^\/redeem\/([^/]+)\/?$/);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1] ?? "");
  } catch {
    return { kind: "invalid-invite", reason: "invalid-token" };
  }
  return INVITE_TOKEN_RE.test(token)
    ? { kind: "invite", serverUrl: url.origin, token }
    : { kind: "invalid-invite", reason: "invalid-token" };
}

/** Parse a raw deep-link string into a tagged union. Never throws. */
export function parseDeepLink(raw: string): ParsedDeepLink {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "unknown", raw: "" };
  if (!NAUTILO_SCHEME_RE.test(s)) return parseHttpsInvite(s) ?? { kind: "unknown", raw: s };

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { kind: "unknown", raw: s };
  }

  const host = u.hostname.toLowerCase();
  // Non-special schemes: pathname is everything after `nautilo://<host>`;
  // strip leading/trailing slashes but preserve internal segments (invite
  // tokens may carry base64 chars; we keep them verbatim).
  const path = u.pathname.replace(/^\/+|\/+$/g, "");

  // nautilo://callback, nautilo://callback/... — expo-auth-session owns the
  // round-trip; the deep-link hook just classifies and ignores.
  if (host === "callback" || path === "callback" || path.startsWith("callback/")) {
    return { kind: "callback" };
  }

  if (host === "add-server") {
    // Query form: nautilo://add-server?url=<encoded>
    const queryUrl = u.searchParams.get("url");
    if (queryUrl) {
      const norm = normalizeServerUrl(queryUrl);
      return norm ? { kind: "add-server", url: norm } : { kind: "unknown", raw: s };
    }
    // Path form: nautilo://add-server/<host>[:port][/path]. Reconstruct a
    // clean http(s) URL by handing the segment to normalizeServerUrl.
    if (path) {
      const norm = normalizeServerUrl(path);
      return norm ? { kind: "add-server", url: norm } : { kind: "unknown", raw: s };
    }
    return { kind: "unknown", raw: s };
  }

  if (host === "invite") {
    const token = u.searchParams.get("token") ?? path.split("/")[0] ?? "";
    if (!INVITE_TOKEN_RE.test(token)) return { kind: "invalid-invite", reason: "invalid-token" };
    const serverRaw = u.searchParams.get("server");
    if (!serverRaw) return { kind: "invalid-invite", reason: "missing-server" };
    const serverUrl = normalizeInviteServerOrigin(serverRaw);
    return serverUrl
      ? { kind: "invite", serverUrl, token }
      : { kind: "invalid-invite", reason: "invalid-server" };
  }

  if (host === "remote" && path === "pair") {
    const challengeId = u.searchParams.get("challengeId") ?? "";
    const secret = u.searchParams.get("secret") ?? "";
    const ceremonyContext = u.searchParams.get("ceremonyContext") ?? "";
    if (
      UUID.test(challengeId) &&
      secret.length > 0 &&
      secret.length <= 512 &&
      CEREMONY_CONTEXT.test(ceremonyContext)
    ) {
      return {
        kind: "remote-pair",
        challengeId,
        secret,
        ceremonyContext,
      };
    }
    return { kind: "unknown", raw: s };
  }

  return { kind: "unknown", raw: s };
}
