import { describe, expect, test } from "bun:test";
import { CompatibilityCache } from "../../src/compatibility-cache";
import { verifyExecutableBytes } from "../../src/compatibility-contract";
import { observeProtocolSchemas } from "../../src/schema-observation";

const key = (executableFingerprint: string, schemaMarker: string) =>
  observeProtocolSchemas([{
    relativePath: "schema.json",
    bytes: new TextEncoder().encode(JSON.stringify({ schemaMarker })),
  }], undefined, verifyExecutableBytes([
    new TextEncoder().encode(executableFingerprint),
  ]));

describe("CompatibilityCache", () => {
  test("keys exact executable/schema pairs and isolates mutations", () => {
    const cache = new CompatibilityCache<{ nested: { value: number } }>();
    const source = { nested: { value: 1 } };
    const stored = cache.set(key("ab", "c"), source);
    source.nested.value = 2;
    expect(cache.get(key("a", "bc"))).toBeUndefined();
    expect(cache.get(key("ab", "c"))).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(stored.nested)).toBe(true);
    expect(() => cache.get({
      executable: key("ab", "c").executable,
      schemaFingerprint: key("ab", "c").schemaFingerprint,
      observation: { members: {}, fields: {} },
    })).toThrow("not verified");
  });

  test("is LRU and does not cache failed computations", () => {
    const cache = new CompatibilityCache<number>(2);
    cache.set(key("a", "s"), 1);
    cache.set(key("b", "s"), 2);
    expect(cache.get(key("a", "s"))).toBe(1);
    cache.set(key("c", "s"), 3);
    expect(cache.get(key("b", "s"))).toBeUndefined();
    expect(() => cache.getOrCompute(key("d", "s"), () => { throw new Error("no"); })).toThrow();
    expect(cache.size).toBe(2);
  });

  test("cannot poison a cached result through evidence mutation", () => {
    const evidence = key("immutable-executable", "immutable-schema");
    const cache = new CompatibilityCache<{ enabled: boolean }>();
    cache.set(evidence, { enabled: true });
    expect(() => {
      evidence.observation.members["poison"] = ["mutation"];
    }).toThrow();
    expect(cache.get(evidence)).toEqual({ enabled: true });
  });
});
