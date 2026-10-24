import { describe, expect, test } from "bun:test";
import { PasswordPolicyChecker } from "@logto/core-kit";
import { parseLogtoPasswordPolicy } from "../../src/lib/logto-password-policy";

describe("identity password-policy defaults", () => {
  test("retains every canonical nested default", () => {
    const policy = parseLogtoPasswordPolicy({});
    expect(policy).toEqual({
      length: { min: 8, max: 256 },
      characterTypes: { min: 1 },
      rejects: { pwned: true, repetitionAndSequence: true, userInfo: true, words: [] },
    });
    expect(new PasswordPolicyChecker(policy).fastCheck("x")).toContainEqual({
      code: "password_rejected.too_short", interpolation: { min: 8 },
    });
  });
  test("preserves partial and explicit policies without relaxing defaults", () => {
    const policy = parseLogtoPasswordPolicy({ length: { min: 12 }, rejects: { pwned: false } });
    expect(policy.length).toEqual({ min: 12, max: 256 });
    expect(policy.characterTypes).toEqual({ min: 1 });
    expect(policy.rejects).toEqual({ pwned: false, repetitionAndSequence: true, userInfo: true, words: [] });
    expect(parseLogtoPasswordPolicy(policy)).toEqual(policy);
  });
  test("rejects malformed policies", () => {
    for (const value of [null, [], "invalid", { length: { min: 0 } }, { rejects: { pwned: "false" } }]) {
      expect(() => parseLogtoPasswordPolicy(value)).toThrow();
    }
  });
});
