import { describe, expect, test } from "bun:test";
import { validateIanaTimezone } from "../../src/lib/timezone";

describe("validateIanaTimezone", () => {
  test("accepts valid IANA names", () => {
    expect(validateIanaTimezone("Europe/Athens")).toBe("Europe/Athens");
    expect(validateIanaTimezone("America/New_York")).toBe("America/New_York");
    expect(validateIanaTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(validateIanaTimezone("UTC")).toBe("UTC");
  });

  test("rejects garbage strings", () => {
    expect(validateIanaTimezone("Mars/Olympus")).toBeNull();
    expect(validateIanaTimezone("not-a-zone")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateIanaTimezone("")).toBeNull();
  });

  test("rejects oversize string", () => {
    expect(validateIanaTimezone("A".repeat(65))).toBeNull();
  });

  test("rejects non-strings", () => {
    expect(validateIanaTimezone(undefined)).toBeNull();
    expect(validateIanaTimezone(null)).toBeNull();
    expect(validateIanaTimezone(123)).toBeNull();
    expect(validateIanaTimezone({})).toBeNull();
  });
});
