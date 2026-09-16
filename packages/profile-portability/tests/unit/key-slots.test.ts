import { describe, test, expect } from "bun:test";
import { validateKeySlot, validateKeySlots } from "../../src/key-slots/validate";
import { errorCodes } from "../../src/errors";
import { validRecoverySlot } from "../fixtures/valid";
import {
  malformedRecoverySlotKdfOutOfBound,
  malformedRecoverySlotSaltLength,
  malformedKeychainSlot,
} from "../fixtures/malformed";

describe("validateKeySlot (recovery)", () => {
  test("accepts the valid recovery slot", () => {
    expect(validateKeySlot(validRecoverySlot).ok).toBe(true);
  });

  test("rejects KDF param out of bounds", () => {
    const r = validateKeySlot(malformedRecoverySlotKdfOutOfBound);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("KDF_PARAM_OUT_OF_BOUNDS");
  });

  test("rejects wrong salt length", () => {
    const r = validateKeySlot(malformedRecoverySlotSaltLength);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SALT_LENGTH_INVALID");
  });
});

describe("validateKeySlot (keychain — deferred)", () => {
  test("reports not-implemented for a well-shaped keychain slot", () => {
    const r = validateKeySlot(malformedKeychainSlot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("KEYCHAIN_SLOT_NOT_IMPLEMENTED");
  });
});

describe("validateKeySlots (registry)", () => {
  test("accepts a single valid recovery slot", () => {
    expect(validateKeySlots([validRecoverySlot]).ok).toBe(true);
  });

  test("rejects duplicate slot ids", () => {
    const r = validateKeySlots([validRecoverySlot, { ...validRecoverySlot }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SLOT_ID_DUPLICATE");
  });

  test("rejects empty registry", () => {
    const r = validateKeySlots([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SLOT_COUNT_OUT_OF_BOUNDS");
  });

  test("rejects non-array registry", () => {
    expect(validateKeySlots("nope").ok).toBe(false);
  });
});
