/**
 * Coerce Human-entered server input into a canonical HTTP(S) origin.
 *
 * This module is deliberately pure so deep-link classification can run before
 * React Native or the authenticated API singleton is initialized.
 */
export function normalizeServerUrl(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (explicitScheme && !/^https?$/i.test(explicitScheme[1] ?? "")) return null;
  if (!explicitScheme && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/]+:\d+$/.test(value)) {
    return null;
  }
  if (!explicitScheme) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

/** Only literal loopback/private addresses earn an automatic clear-text try. */
export function isDeterministicallyLocalServerHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    isPrivateIpv4(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized);
}

/**
 * Human-entered server targets use HTTPS by default. A bare, provably local
 * literal gets one bounded HTTP fallback; public names and `.local` DNS names
 * never silently downgrade.
 */
export function serverUrlCandidates(raw: string): readonly string[] {
  const entered = raw.trim();
  if (!entered) return [];
  const explicit = /^https?:\/\//i.test(entered);
  const normalized = normalizeServerUrl(entered);
  if (!normalized) return [];
  try {
    const parsed = new URL(normalized);
    if (explicit || !isDeterministicallyLocalServerHost(parsed.hostname)) {
      return [normalized];
    }
    const clearText = new URL(normalized);
    clearText.protocol = "http:";
    return [normalized, clearText.origin];
  } catch {
    return [];
  }
}

/** Invite locators require an exact origin, not a URL silently narrowed to one. */
export function normalizeInviteServerOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
