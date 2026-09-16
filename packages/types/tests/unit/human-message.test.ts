import { describe, expect, test } from "bun:test";
import { logicalMessageKey, normalizeHumanMessageText } from "../../src/human-message";

describe("M230 Human message helpers", () => {
  test("normalizes send and edit text with trim semantics only", () => {
    expect(normalizeHumanMessageText("  hello \n world  ")).toBe("hello \n world");
  });

  test("uses immutable fingerprints only for Human logical turns", () => {
    expect(logicalMessageKey({ id: 12, role: "user", fingerprint: "fp:v1:human:abc" }))
      .toBe("turn:fp:v1:human:abc");
    expect(logicalMessageKey({ id: 13, role: "assistant", fingerprint: "fp:v1:ai:def" }))
      .toBe("row:13");
    expect(logicalMessageKey({ id: 14, role: "user", fingerprint: null }))
      .toBe("row:14");
  });
});
