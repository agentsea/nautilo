import { describe, test, expect } from "bun:test";
import { hashPin, verifyPin } from "../../src/pin-hash";

describe("PIN hash utilities", () => {
  test("hashPin returns Argon2id PHC format", async () => {
    const result = await hashPin("1234");
    expect(result).toStartWith("$argon2id$");
  });

  test("same PIN produces different hashes (random salt)", async () => {
    const a = await hashPin("1234");
    const b = await hashPin("1234");
    expect(a).not.toBe(b);
  });

  test("verifyPin returns true for correct PIN", async () => {
    const stored = await hashPin("5678");
    const result = await verifyPin("5678", stored);
    expect(result).toBe(true);
  });

  test("verifyPin returns false for wrong PIN", async () => {
    const stored = await hashPin("5678");
    const result = await verifyPin("9999", stored);
    expect(result).toBe(false);
  });

  test("verifyPin returns false for malformed stored value", async () => {
    const result = await verifyPin("1234", "not-a-valid-hash");
    expect(result).toBe(false);
  });

  test("works with longer PINs (up to 8 chars)", async () => {
    const stored = await hashPin("12345678");
    expect(await verifyPin("12345678", stored)).toBe(true);
    expect(await verifyPin("1234567", stored)).toBe(false);
  });
});
