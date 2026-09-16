import { describe, test, expect } from "bun:test";
import {
  validateProtectionSuiteDeclared,
  validateFrameAad,
  PROTECTION_SUITE_BOUNDS,
  DECLARED_PROTECTION_SUITE,
} from "../../src/protection/suite";
import { errorCodes } from "../../src/errors";

describe("validateProtectionSuiteDeclared", () => {
  test("accepts the declared suite with no declared params", () => {
    expect(validateProtectionSuiteDeclared("xchacha20poly1305-framed-v1", undefined).ok).toBe(true);
  });

  test("accepts matching declared bounds", () => {
    const r = validateProtectionSuiteDeclared("xchacha20poly1305-framed-v1", {
      keyBytes: 32,
      nonceBytes: 24,
      tagBytes: 16,
      aadMaxBytes: 1024,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects unknown suite", () => {
    const r = validateProtectionSuiteDeclared("aes-256-gcm-v1", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("UNKNOWN_PROTECTION_SUITE");
  });

  test("rejects plaintext downgrade", () => {
    expect(validateProtectionSuiteDeclared("plaintext", undefined).ok).toBe(false);
    expect(validateProtectionSuiteDeclared("none", undefined).ok).toBe(false);
    expect(validateProtectionSuiteDeclared("", undefined).ok).toBe(false);
  });

  test("rejects mismatched declared bounds", () => {
    const r = validateProtectionSuiteDeclared("xchacha20poly1305-framed-v1", { keyBytes: 16 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SUITE_PARAM_OUT_OF_BOUNDS");
  });

  test("rejects non-string suite", () => {
    expect(validateProtectionSuiteDeclared(123, undefined).ok).toBe(false);
  });

  test("bounds are opaque constants, not crypto behavior", () => {
    expect(PROTECTION_SUITE_BOUNDS.keyBytes).toBe(32);
    expect(PROTECTION_SUITE_BOUNDS.nonceBytes).toBe(24);
    expect(PROTECTION_SUITE_BOUNDS.tagBytes).toBe(16);
    expect(DECLARED_PROTECTION_SUITE.id).toBe("xchacha20poly1305-framed-v1");
  });
});

describe("validateFrameAad", () => {
  test("accepts within ceiling", () => {
    expect(validateFrameAad(new Uint8Array(1024)).ok).toBe(true);
  });

  test("rejects above ceiling", () => {
    const r = validateFrameAad(new Uint8Array(1025));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SUITE_AAD_OVERSIZED");
  });
});
