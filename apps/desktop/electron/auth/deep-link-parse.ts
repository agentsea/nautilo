/**
 * M101 Phase 3 — pure parsing for `nautilo://` deep links (no Electron).
 */

export type DeepLinkKind = "invite" | "reset-password" | "account";

export interface DeepLink {
  kind: DeepLinkKind;
  payload: Record<string, string>;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export function parseDeepLink(rawUrl: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }

  if (u.protocol !== "nautilo:") return null;
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase();
  if (!host) return null;

  if (u.search !== "" || u.hash !== "") return null;
  if (hasControlChars(u.href)) return null;

  const pathBody = u.pathname.replace(/^\/+|\/+$/g, "");
  const segments = pathBody.length === 0 ? [] : pathBody.split("/");

  if (host === "account") {
    if (segments.length > 0) return null;
    return { kind: "account", payload: {} };
  }

  if (host === "invite" || host === "reset-password") {
    if (segments.length !== 1) return null;
    const token = segments[0]!;
    if (!TOKEN_RE.test(token)) return null;
    return {
      kind: host === "invite" ? "invite" : "reset-password",
      payload: { token },
    };
  }

  return null;
}

export function parseDeepLinksFromArgv(argv: string[]): DeepLink[] {
  const out: DeepLink[] = [];
  for (const arg of argv) {
    if (typeof arg !== "string" || !arg.startsWith("nautilo://")) continue;
    const link = parseDeepLink(arg);
    if (link) out.push(link);
  }
  return out;
}
