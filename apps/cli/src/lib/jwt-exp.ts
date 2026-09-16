/**
 * Read JWT `exp` claim (seconds since epoch) without verification —
 * advisory TTL for CLI session persistence only.
 */
export function jwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    if (!payload) return null;
    const body = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof body.exp === "number" ? body.exp * 1000 : null;
  } catch {
    return null;
  }
}
