/**
 * M052 (Logto cluster) — JWT validator.
 *
 * Verifies a Logto-issued access token against Logto's JWKS, with
 * `iss` / `aud` / `exp` / signature checks. Pure — no DB, no HTTP
 * beyond what `jose` does internally for JWKS fetching.
 *
 * Design: `research/logto-integration-v1.md` §4.2 + §4.8 (identity-only
 * JWT — we DO NOT read `scope`; authorization stays in the trust layer).
 *
 * Env vars consumed (read on first verify, then cached by `jose`):
 *   - LOGTO_JWKS_URI    (e.g. http://localhost:3301/oidc/jwks)
 *   - LOGTO_ISSUER      (e.g. http://localhost:3301/oidc)
 *   - LOGTO_RESOURCE    (audience claim, e.g. https://api.nautilo.local)
 *
 * `jose`'s `createRemoteJWKSet` handles JWKS caching + rotation; we
 * don't need our own cache.
 */

import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type KeyObject,
} from "jose";
import { getLogtoClockOffsetMs } from "./logto-clock-skew";

export interface LogtoTokenPayload extends JWTPayload {
  /** Logto user id (OIDC `sub` claim). The link target for `users.external_id`. */
  sub: string;
  /** OIDC standard claim — display name. */
  name?: string;
  /** OIDC standard claim — Logto's username field. */
  preferred_username?: string;
  /** OIDC standard claim — primary email. */
  email?: string;
  /** OIDC standard claim — whether the email has been verified. */
  email_verified?: boolean;
}

/**
 * Lazy JWKS fetcher singleton. Reset by `_setJwksKeyForTests` for unit
 * tests; production code never touches it directly.
 */
let JWKS:
  | ReturnType<typeof createRemoteJWKSet>
  | ((header: unknown, token: unknown) => Promise<KeyObject>)
  | null = null;

function getJwks(): NonNullable<typeof JWKS> {
  if (JWKS) return JWKS;
  const uri = process.env["LOGTO_JWKS_URI"];
  if (!uri) {
    throw new Error("LOGTO_JWKS_URI env var is required for Logto JWT verification");
  }
  JWKS = createRemoteJWKSet(new URL(uri));
  return JWKS;
}

/**
 * Verifies a Logto access token. Returns the payload on success;
 * throws on invalid signature, wrong issuer/audience, or expired token.
 *
 * Callers (the server preHandler) catch the throw and fall through to
 * guest context — never 401. This matches today's "invalid bearer →
 * guest" semantics.
 */
export async function verifyLogtoAccessToken(
  bearer: string,
): Promise<LogtoTokenPayload> {
  const issuer = process.env["LOGTO_ISSUER"];
  const audience = process.env["LOGTO_RESOURCE"];
  if (!issuer || !audience) {
    throw new Error(
      "LOGTO_ISSUER and LOGTO_RESOURCE are required for Logto JWT verification",
    );
  }

  // M055 — evaluate `exp`/`iat` against Logto's clock view, not the
  // host's. Logto runs in Docker; on macOS/Windows the VM clock
  // drifts from the host (post-sleep especially), so a freshly
  // issued JWT can look "already expired" to the host even though
  // it's perfectly valid relative to the issuer. The offset is
  // probed from Logto's HTTP `Date:` header — see logto-clock-skew.ts.
  const jwks = getJwks() as Parameters<typeof jwtVerify>[1];
  const offsetMs = await getLogtoClockOffsetMs();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(bearer, jwks, {
      issuer,
      audience,
      currentDate: new Date(Date.now() + offsetMs),
    }));
  } catch (err) {
    // Two ways to land here:
    //  1. The skew has shifted since our last probe (Mac woke up,
    //     container clock jumped). A forced re-probe + retry
    //     recovers without bouncing the user back to sign-in.
    //  2. The token actually IS expired/invalid. The retry against
    //     the fresh offset throws too, and we fall through to the
    //     diagnostic log + re-throw below.
    if (isClockClaimError(err)) {
      try {
        const freshOffsetMs = await getLogtoClockOffsetMs(true);
        ({ payload } = await jwtVerify(bearer, jwks, {
          issuer,
          audience,
          currentDate: new Date(Date.now() + freshOffsetMs),
        }));
        // Retry succeeded — return the verified payload below.
      } catch (retryErr) {
        logUnverifiedClaims(bearer, retryErr);
        throw retryErr;
      }
    } else {
      logUnverifiedClaims(bearer, err);
      throw err;
    }
  }

  // jose guarantees `sub` is a string when present; we still assert it
  // because Logto access tokens always carry one and our downstream
  // (`findActorByLogtoSub` in `resolve-bearer.ts`, post-M126) keys on it.
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Logto JWT missing required `sub` claim");
  }
  return payload as LogtoTokenPayload;
}

/**
 * True for jose errors caused by the `exp` / `iat` / `nbf` claim
 * checks failing (i.e. the kind of failure a clock-offset re-probe
 * can plausibly recover from). We match on `code` first; jose's
 * `code = "ERR_JWT_EXPIRED"` covers `exp`, and the generic
 * `JWTClaimValidationFailed` covers `iat`/`nbf` with a `claim`
 * field on the error. Falls back to message-substring matching for
 * extra resilience against minor jose version drift.
 */
function isClockClaimError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    claim?: string;
    message?: string;
  };
  if (e.code === "ERR_JWT_EXPIRED") return true;
  if (
    e.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" &&
    (e.claim === "iat" || e.claim === "exp" || e.claim === "nbf")
  ) {
    return true;
  }
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (
      m.includes(`"exp"`) ||
      m.includes(`"iat"`) ||
      m.includes(`"nbf"`) ||
      m.includes("expired")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Diagnostic — emit unverified JWT claims + host-now so the operator
 * can see at a glance whether the failure is "token actually old"
 * (small `iat`-to-now gap, exp-now negative by ~lifetime) vs
 * "container clock skew" (large `iat`-to-now gap, exp-now negative
 * by hours). The post-retry path uses this to surface the residual
 * failure mode after the offset re-probe.
 */
function logUnverifiedClaims(bearer: string, err: unknown): void {
  try {
    const claims = decodeJwt(bearer);
    const nowS = Math.floor(Date.now() / 1000);
    const expNum =
      typeof claims.exp === "number" ? claims.exp - nowS : "?";
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "(no-code)";
     
    console.warn(
      `[logto-verifier] verify failed (${code}); unverified claims: iss=${String(claims.iss)} aud=${String(claims.aud)} sub=${String(claims.sub)} iat=${String(claims.iat)} exp=${String(claims.exp)} now=${nowS} (exp-now=${expNum})`,
    );
  } catch {
    /* ignore — the original error is what matters */
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Resets the lazy JWKS singleton so the next `verifyLogtoAccessToken`
 * call re-reads `LOGTO_JWKS_URI`. Tests use this to swap env vars
 * between cases.
 */
export function _resetJwksForTests(): void {
  JWKS = null;
}

/**
 * Test-only: install an in-memory key resolver in place of the remote
 * JWKS fetcher. Enables fully offline unit tests that mint their own
 * JWTs with `jose`'s `SignJWT` against a generated keypair.
 */
export function _setJwksKeyForTests(
  resolver: (header: unknown, token: unknown) => Promise<KeyObject>,
): void {
  JWKS = resolver;
}
