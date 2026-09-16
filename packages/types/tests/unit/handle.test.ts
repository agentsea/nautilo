import { describe, expect, test } from "bun:test";

import {
  HANDLE_MAX_LEN,
  HANDLE_MIN_LEN,
  HANDLE_RE,
  slugifyToHandleBase,
} from "../../src/handle";

describe("slugifyToHandleBase", () => {
  test('slugifyToHandleBase("Genie") === "genie"', () => {
    expect(slugifyToHandleBase("Genie")).toBe("genie");
  });

  test('slugifyToHandleBase("My Cool Bot!!") === "my_cool_bot"', () => {
    expect(slugifyToHandleBase("My Cool Bot!!")).toBe("my_cool_bot");
  });

  test('slugifyToHandleBase("123robot") === "robot" (leading digits stripped)', () => {
    expect(slugifyToHandleBase("123robot")).toBe("robot");
  });

  test('slugifyToHandleBase("   ") === ""', () => {
    expect(slugifyToHandleBase("   ")).toBe("");
  });

  test('slugifyToHandleBase("!!!") === ""', () => {
    expect(slugifyToHandleBase("!!!")).toBe("");
  });

  test("bases of length >= HANDLE_MIN_LEN match HANDLE_RE", () => {
    for (const name of ["Genie", "My Cool Bot", "Robot Helper 9000"]) {
      const base = slugifyToHandleBase(name);
      expect(base.length).toBeGreaterThanOrEqual(HANDLE_MIN_LEN);
      expect(HANDLE_RE.test(base)).toBe(true);
    }
  });

  test("truncates to HANDLE_MAX_LEN", () => {
    const longName = "a".repeat(60);
    const result = slugifyToHandleBase(longName);
    expect(result.length).toBe(HANDLE_MAX_LEN);
  });
});
