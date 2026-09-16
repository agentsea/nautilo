/**
 * M101 Phase 4 — validate operator-pasted Logto password-reset URLs.
 *
 * Allows normal https reset links and local dev (`http://localhost…`).
 * Rejects obvious non-http(s) schemes and `http://` hosts other than localhost.
 */

const LOCALHOST_HTTP_PREFIX = /^http:\/\/localhost(?=[:/?#]|$)/;

export function validatePasteResetUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (!(s.startsWith("https://") || LOCALHOST_HTTP_PREFIX.test(s))) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return true;
}
