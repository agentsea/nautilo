import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";
import {
  isCanonicalNautiloInstanceId,
  NAUTILO_INSTANCE_ID_PATTERN,
  resolveNautiloStorageRoot,
  validateNautiloInstanceIdValue,
} from "../../src/instance-id";

describe("instance-id (M071 2A)", () => {
  test("validateNautiloInstanceIdValue accepts empty and valid ids", () => {
    expect(validateNautiloInstanceIdValue("")).toBeNull();
    expect(validateNautiloInstanceIdValue("  ")).toBeNull();
    expect(validateNautiloInstanceIdValue("beta")).toBeNull();
    expect(validateNautiloInstanceIdValue("stack-b")).toBeNull();
    expect(validateNautiloInstanceIdValue("a1")).toBeNull();
  });

  test("validateNautiloInstanceIdValue rejects invalid shapes", () => {
    expect(validateNautiloInstanceIdValue("Beta")).not.toBeNull();
    expect(validateNautiloInstanceIdValue("-bad")).not.toBeNull();
    expect(validateNautiloInstanceIdValue("bad!")).not.toBeNull();
    expect(validateNautiloInstanceIdValue("a".repeat(33))).not.toBeNull();
  });

  test("resolveNautiloStorageRoot default vs named", () => {
    const home = "/Users/tester";
    expect(resolveNautiloStorageRoot(home, "")).toBe(
      normalize(join(home, ".nautilo")),
    );
    expect(resolveNautiloStorageRoot(home, "beta")).toBe(
      normalize(join(home, ".nautilo-beta")),
    );
  });

  test("resolveNautiloStorageRoot throws on invalid id", () => {
    expect(() => resolveNautiloStorageRoot("/h", "BAD")).toThrow(/NAUTILO_INSTANCE_ID/);
  });

  test("NAUTILO_INSTANCE_ID_PATTERN matches task spec", () => {
    expect(NAUTILO_INSTANCE_ID_PATTERN.test("b")).toBe(true);
    expect(NAUTILO_INSTANCE_ID_PATTERN.test("beta")).toBe(true);
    expect(NAUTILO_INSTANCE_ID_PATTERN.test("b2")).toBe(true);
  });

  describe("isCanonicalNautiloInstanceId", () => {
    test("accepts exact default and valid named ids", () => {
      expect(isCanonicalNautiloInstanceId("")).toBe(true);
      expect(isCanonicalNautiloInstanceId("beta")).toBe(true);
      expect(isCanonicalNautiloInstanceId("stack-b")).toBe(true);
      expect(isCanonicalNautiloInstanceId("a1")).toBe(true);
    });

    test("rejects whitespace-only and surrounding whitespace", () => {
      expect(isCanonicalNautiloInstanceId("  ")).toBe(false);
      expect(isCanonicalNautiloInstanceId("\t")).toBe(false);
      expect(isCanonicalNautiloInstanceId(" beta")).toBe(false);
      expect(isCanonicalNautiloInstanceId("beta ")).toBe(false);
      expect(isCanonicalNautiloInstanceId(" beta ")).toBe(false);
    });

    test("rejects invalid patterns", () => {
      expect(isCanonicalNautiloInstanceId("Beta")).toBe(false);
      expect(isCanonicalNautiloInstanceId("-bad")).toBe(false);
      expect(isCanonicalNautiloInstanceId("bad!")).toBe(false);
      expect(isCanonicalNautiloInstanceId("a".repeat(33))).toBe(false);
    });

    test("rejects non-strings", () => {
      expect(isCanonicalNautiloInstanceId(null)).toBe(false);
      expect(isCanonicalNautiloInstanceId(undefined)).toBe(false);
      expect(isCanonicalNautiloInstanceId(0)).toBe(false);
      expect(isCanonicalNautiloInstanceId({})).toBe(false);
    });
  });
});
