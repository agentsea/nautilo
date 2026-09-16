import { createHmac, timingSafeEqual } from "node:crypto";
import { invariant } from "../core/errors.js";

export function createTokens(secret, clock) {
  invariant(typeof secret === "string" && secret.length > 0, 500, "configuration", "A signing key is required");
  const sign = (encoded) => createHmac("sha256", secret).update(encoded).digest("base64url");
  function issue(claims) {
    invariant(Number.isFinite(claims.expiresAt), 400, "expiry_required", "An explicit expiry is required");
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${encoded}.${sign(encoded)}`;
  }
  function verifySignature(token) {
    invariant(typeof token === "string", 401, "token_required", "A signed token is required");
    const parts = token.split(".");
    invariant(parts.length === 2, 401, "invalid_token", "Token format is invalid");
    const expected = Buffer.from(sign(parts[0]));
    const actual = Buffer.from(parts[1]);
    invariant(actual.length === expected.length && timingSafeEqual(actual, expected), 401, "invalid_signature", "Token signature is invalid");
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
    catch { invariant(false, 401, "invalid_token", "Token payload is invalid"); }
    invariant(claims && typeof claims === "object" && !Array.isArray(claims), 401, "invalid_token", "Token claims are invalid");
    invariant(!clock.isExpired(claims.expiresAt), 401, "token_expired", "Token has expired");
    return claims;
  }
  function verify(token, { audience, purpose }) {
    const claims = verifySignature(token);
    invariant(claims.audience === audience && claims.purpose === purpose, 403, "token_context", "Token is not valid for this operation");
    return claims;
  }
  return { issue, verify, verifySignature };
}
