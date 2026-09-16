import type { RedeemResult } from "@nautilo/api-client";

/** Prefer Logto access token from claim handoff; fall back to legacy session token. */
export function extractRedeemBearer(redeem: RedeemResult): string | null {
  const a = redeem.logtoSession?.accessToken?.trim();
  if (a && a.length > 0) return a;
  const s = redeem.sessionToken?.trim();
  if (s && s.length > 0) return s;
  return null;
}
