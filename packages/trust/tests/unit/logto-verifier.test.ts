/**
 * M052 — `logto-verifier.ts` unit tests.
 *
 * Mints test JWTs with `jose`'s in-memory key generation. The
 * verifier's JWKS singleton is replaced with a test resolver that
 * always returns the matching public key, so no network calls run.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, type KeyObject } from "jose";
import {
  verifyLogtoAccessToken,
  _resetJwksForTests,
  _setJwksKeyForTests,
} from "../../src/logto-verifier";
import {
  _resetClockSkewForTests,
  _setProbeForTests,
} from "../../src/logto-clock-skew";

const ISSUER = "http://localhost:3301/oidc";
const AUDIENCE = "https://api.nautilo.local";
const JWKS_URI = "http://localhost:3301/oidc/jwks";

let publicKey: KeyObject;
let privateKey: KeyObject;

async function mintToken(opts?: {
  sub?: string;
  iss?: string;
  aud?: string;
  expSecondsFromNow?: number;
  extra?: Record<string, unknown>;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts?.expSecondsFromNow ?? 3600);
  const sub = opts?.sub ?? "logto-user-123";
  const builder = new SignJWT({ ...(opts?.extra ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(opts?.iss ?? ISSUER)
    .setAudience(opts?.aud ?? AUDIENCE)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(exp);
  return await builder.sign(privateKey);
}

describe("verifyLogtoAccessToken", () => {
  beforeEach(async () => {
    process.env["LOGTO_JWKS_URI"] = JWKS_URI;
    process.env["LOGTO_ISSUER"] = ISSUER;
    process.env["LOGTO_RESOURCE"] = AUDIENCE;

    const kp = await generateKeyPair("RS256", { extractable: true });
    publicKey = kp.publicKey as unknown as KeyObject;
    privateKey = kp.privateKey as unknown as KeyObject;

    _resetJwksForTests();
    _setJwksKeyForTests(async () => publicKey);
    _resetClockSkewForTests();
  });

  afterEach(() => {
    delete process.env["LOGTO_JWKS_URI"];
    delete process.env["LOGTO_ISSUER"];
    delete process.env["LOGTO_RESOURCE"];
    _resetJwksForTests();
    _resetClockSkewForTests();
  });

  test("valid signed JWT → returns payload with the expected claims", async () => {
    const token = await mintToken({
      sub: "logto-user-abc",
      extra: {
        name: "Test User",
        preferred_username: "test-user",
        email: "test-user@example.com",
        email_verified: true,
      },
    });
    const payload = await verifyLogtoAccessToken(token);
    expect(payload.sub).toBe("logto-user-abc");
    expect(payload.name).toBe("Test User");
    expect(payload.preferred_username).toBe("test-user");
    expect(payload.email).toBe("test-user@example.com");
    expect(payload.email_verified).toBe(true);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
  });

  test("wrong issuer → throws", async () => {
    const token = await mintToken({ iss: "http://attacker.example/oidc" });
    expect(verifyLogtoAccessToken(token)).rejects.toThrow();
  });

  test("wrong audience → throws", async () => {
    const token = await mintToken({ aud: "https://api.attacker.example" });
    expect(verifyLogtoAccessToken(token)).rejects.toThrow();
  });

  test("expired (`exp` past) → throws", async () => {
    const token = await mintToken({ expSecondsFromNow: -10 });
    expect(verifyLogtoAccessToken(token)).rejects.toThrow();
  });

  test("bad signature → throws", async () => {
    // Mint with one key, then verify against a *different* key.
    const goodToken = await mintToken();
    const otherKp = await generateKeyPair("RS256", { extractable: true });
    _setJwksKeyForTests(async () => otherKp.publicKey as unknown as KeyObject);
    expect(verifyLogtoAccessToken(goodToken)).rejects.toThrow();
  });

  test("missing `sub` → throws", async () => {
    // Manually craft a JWT without `sub` (bypassing setSubject).
    const now = Math.floor(Date.now() / 1000);
    const noSub = await new SignJWT({ name: "Anonymous" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    expect(verifyLogtoAccessToken(noSub)).rejects.toThrow(
      /missing required `sub`/,
    );
  });

  test("missing LOGTO_JWKS_URI → throws on first call", async () => {
    delete process.env["LOGTO_JWKS_URI"];
    _resetJwksForTests();
    // Don't pre-install the resolver — let getJwks() try to read env.
    const token = await mintToken();
    expect(verifyLogtoAccessToken(token)).rejects.toThrow(
      /LOGTO_JWKS_URI/,
    );
  });

  test("missing LOGTO_ISSUER or LOGTO_RESOURCE → throws", async () => {
    delete process.env["LOGTO_ISSUER"];
    const token = await mintToken();
    expect(verifyLogtoAccessToken(token)).rejects.toThrow(
      /LOGTO_ISSUER and LOGTO_RESOURCE/,
    );

    process.env["LOGTO_ISSUER"] = ISSUER;
    delete process.env["LOGTO_RESOURCE"];
    expect(verifyLogtoAccessToken(token)).rejects.toThrow(
      /LOGTO_ISSUER and LOGTO_RESOURCE/,
    );
  });

  test("exportJWK round-trips the test public key (sanity check)", async () => {
    const jwk = await exportJWK(publicKey);
    expect(jwk.kty).toBe("RSA");
    expect(jwk.n).toBeString();
  });

  // M055 — Logto-vs-host clock skew. Logto runs in Docker; on macOS
  // the VM clock can drift by hours from the host clock. The verifier
  // compensates by evaluating exp/iat against Logto's clock view.
  describe("clock-skew compensation (M055)", () => {
    test("token issued 3 hours ago (Logto clock 3h behind host) verifies via probe-supplied offset", async () => {
      // Mint a token with iat = now - 3h, exp = now - 3h + 1h.
      // From the host's perspective this is "expired 2 hours ago"
      // — but Logto's clock is 3h behind the host, so the probe
      // returns offsetMs = -3h * 1000. Adding offsetMs to host's
      // now produces Logto's view, against which the token is
      // freshly issued + valid for ~1h.
      const threeHoursS = 3 * 60 * 60;
      const token = await mintToken({ expSecondsFromNow: -threeHoursS + 3600 });
      // ↑ exp = now - 3h + 1h. iat (auto from setIssuedAt-less path
      // in mintToken) — actually mintToken always uses now. Let me
      // mint manually with explicit iat.
      const nowS = Math.floor(Date.now() / 1000);
      const skewedToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("logto-user-skewed")
        .setIssuedAt(nowS - threeHoursS)
        .setExpirationTime(nowS - threeHoursS + 3600)
        .sign(privateKey);

      _setProbeForTests(async () => -threeHoursS * 1000);

      const payload = await verifyLogtoAccessToken(skewedToken);
      expect(payload.sub).toBe("logto-user-skewed");
      // Sanity: prove the unrelated `token` reference is not unused
      // (avoid a knip false-positive without weakening the test).
      expect(token).toBeString();
    });

    test("token genuinely expired against Logto's own clock → still throws", async () => {
      // Skew probe says Logto is 3h behind. Mint a token that's
      // expired even by Logto's clock (iat = now - 3h - 2h, so by
      // Logto's view iat was 2h ago, exp 1h ago).
      const offsetSec = -3 * 60 * 60;
      _setProbeForTests(async () => offsetSec * 1000);

      const nowS = Math.floor(Date.now() / 1000);
      const reallyExpired = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("logto-user-expired")
        .setIssuedAt(nowS + offsetSec - 2 * 60 * 60)
        .setExpirationTime(nowS + offsetSec - 60 * 60)
        .sign(privateKey);

      expect(verifyLogtoAccessToken(reallyExpired)).rejects.toThrow();
    });

    test("first verify fails on stale offset, force-reprobe recovers (Mac wakes mid-session)", async () => {
      // Simulate: cached offset is 0 (recent boot, host and Logto
      // were in sync). Mac sleeps; container clock drifts to
      // -3h. A token issued now (post-drift) has iat ~3h in the
      // past from the host's view. First verify fails (offset 0);
      // the verifier re-probes, gets the correct offset, and
      // retries successfully.
      const driftS = -3 * 60 * 60;
      let probeCalls = 0;
      _setProbeForTests(async () => {
        probeCalls += 1;
        // First probe (initial cache fill, called by verifier
        // before first attempt) returns 0 — we haven't noticed
        // the drift yet. Second probe (forced re-probe after the
        // first verify fails) returns the real offset.
        return probeCalls === 1 ? 0 : driftS * 1000;
      });

      const nowS = Math.floor(Date.now() / 1000);
      const driftedToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("logto-user-drifted")
        .setIssuedAt(nowS + driftS)
        .setExpirationTime(nowS + driftS + 3600)
        .sign(privateKey);

      const payload = await verifyLogtoAccessToken(driftedToken);
      expect(payload.sub).toBe("logto-user-drifted");
      expect(probeCalls).toBe(2);
    });
  });
});
