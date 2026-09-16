import { describe, test, expect } from "bun:test";
import { canonicalJson, computeRecordHash, computeSemanticRoot } from "../../src/canonical";
import { CanonicalEncodingError } from "../../src/canonical";

describe("canonicalJson", () => {
  test("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  test("key order is irrelevant to output", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("nested objects are sorted", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  test("arrays preserve order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  test("escapes control characters", () => {
    expect(canonicalJson({ a: "\u0001" })).toBe('{"a":"\\u0001"}');
  });

  test("rejects undefined", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalEncodingError);
  });

  test("rejects bigint", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalEncodingError);
  });

  test("rejects binary buffers", () => {
    expect(() => canonicalJson({ a: new Uint8Array(1) })).toThrow(CanonicalEncodingError);
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalEncodingError);
  });
});

describe("computeRecordHash / computeSemanticRoot", () => {
  test("record hash is stable regardless of insertion key order", () => {
    const r1 = { recordKind: "identity", name: "Aria", handleIntent: null } as const;
    const r2 = { handleIntent: null, name: "Aria", recordKind: "identity" } as const;
    expect(computeRecordHash(r1)).toBe(computeRecordHash(r2));
  });

  test("semantic root is order-independent over the record set", () => {
    const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    expect(computeSemanticRoot(hashes)).toBe(computeSemanticRoot([...hashes].reverse()));
  });

  test("different record sets produce different roots", () => {
    const h1 = ["a".repeat(64)];
    const h2 = ["b".repeat(64)];
    expect(computeSemanticRoot(h1)).not.toBe(computeSemanticRoot(h2));
  });
});
