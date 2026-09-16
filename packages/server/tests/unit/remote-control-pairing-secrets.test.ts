import { describe, expect, test } from "bun:test";
import {
  PairingPepperConfigurationError,
  digestPairingVerifier,
  mintPairingVerifierSecrets,
  normalizeManualCode,
  pairingVerifierMatches,
  requirePairingPepper,
} from "../../src/remote-control/pairing-secrets";

const PEPPER = "d458-test-pepper-must-be-at-least-thirty-two-bytes";

describe("D458 pairing verifier secrets", () => {
  test("fails closed when the deployment pepper is absent or too short", () => {
    expect(() => requirePairingPepper({})).toThrow(PairingPepperConfigurationError);
    expect(() => requirePairingPepper({ NAUTILO_REMOTE_PAIRING_PEPPER: "short" })).toThrow(
      PairingPepperConfigurationError,
    );
  });

  test("mints 256-bit QR material and a normalized 60-bit manual code", () => {
    const first = mintPairingVerifierSecrets();
    const second = mintPairingVerifierSecrets();
    expect(first.qrSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.manualCode).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect(first.qrSecret).not.toBe(second.qrSecret);
    expect(first.manualCode).not.toBe(second.manualCode);
  });

  test("normalizes manual Crockford input before HMAC and compares safely", () => {
    expect(normalizeManualCode(" abcd-efgh-jkmn ")).toBe("ABCDEFGHJKMN");
    expect(normalizeManualCode("abcd-efgh-ijkl")).toBe("ABCDEFGH1JK1");
    expect(normalizeManualCode("not enough")).toBeNull();

    const stored = digestPairingVerifier(PEPPER, "manual", "ABCD-EFGH-JKMN");
    const candidate = digestPairingVerifier(PEPPER, "manual", "abcd efgh jkmn");
    const wrong = digestPairingVerifier(PEPPER, "manual", "ABCD-EFGH-JKMP");
    expect(stored).not.toBeNull();
    expect(pairingVerifierMatches(stored!, candidate)).toBe(true);
    expect(pairingVerifierMatches(stored!, wrong)).toBe(false);
    expect(pairingVerifierMatches(stored!, "bad")).toBe(false);
  });
});
