import { describe, expect, test } from "bun:test";
import {
  isDeterministicallyLocalHostname,
  isSafePromotionOrigin,
  planServerTarget,
} from "../../electron/server-target";

describe("D514 server target policy", () => {
  test("bare public host is HTTPS-only and canonicalized as an origin", () => {
    const planned = planServerTarget("  ALPHA.example.test ");
    expect(planned).toMatchObject({
      ok: true,
      canonicalOrigin: "https://alpha.example.test",
      explicitScheme: null,
    });
    if (planned.ok) {
      expect(planned.candidates).toEqual([
        { origin: "https://alpha.example.test", scheme: "https", reason: "bare-https" },
      ]);
    }
  });

  test("only deterministic literal loopback/LAN targets get automatic HTTP fallback", () => {
    for (const input of ["localhost:3001", "127.0.0.1:3001", "10.0.0.8:3001", "192.168.1.8:3001", "[fd00::1]:3001"]) {
      const planned = planServerTarget(input);
      expect(planned.ok).toBe(true);
      if (planned.ok) expect(planned.candidates.map((candidate) => candidate.scheme)).toEqual(["https", "http"]);
    }
    // `.local` names are intentionally excluded: DNS/mDNS resolution is not
    // deterministic proof that clear-text fallback remains inside a LAN.
    for (const hostname of ["alpha.example.test", "my-nas.local", "8.8.8.8", "172.32.0.1"]) {
      expect(isDeterministicallyLocalHostname(hostname)).toBe(false);
    }
  });

  test("explicit schemes are preserved, while prior HTTPS blocks only silent fallback", () => {
    const priorHttps = "https://localhost:3001";
    const bare = planServerTarget("localhost:3001", { previousVerifiedOrigin: priorHttps });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.previousHttpsEvidence).toBe(true);
      expect(bare.candidates.map((candidate) => candidate.scheme)).toEqual(["https"]);
    }
    const explicit = planServerTarget("http://localhost:3001", { previousVerifiedOrigin: priorHttps });
    expect(explicit).toMatchObject({ ok: true, explicitScheme: "http", requiresExplicitDowngradeConfirmation: true });
  });

  test("rejects unsafe or non-origin target material", () => {
    for (const input of ["", "ftp://server.test", "https://user:password@server.test", "https://server.test/path", "https://server.test/?token=secret", "https://server.test/#secret"]) {
      expect(planServerTarget(input).ok).toBe(false);
    }
  });

  test("promotion facts must stay at the verified candidate origin", () => {
    expect(isSafePromotionOrigin("https://alpha.example.test", "https://alpha.example.test/api/setup/status")).toBe(true);
    expect(isSafePromotionOrigin("https://alpha.example.test", "https://other.example.test/")).toBe(false);
    expect(isSafePromotionOrigin("https://alpha.example.test", "http://alpha.example.test/")).toBe(false);
  });
});
