import { describe, expect, test } from "bun:test";

import {
  MemoryAuthorityResolutionError,
  resolveRequiredMemoryNamespaceIds,
} from "../../src/memory/required-namespace-set.ts";

describe("required Memory Namespace set", () => {
  test("unions ordinary attachments with one retained scope-origin coordinate", () => {
    expect(resolveRequiredMemoryNamespaceIds({
      namespaceIds: ["namespace-b", "namespace-a", "namespace-a"],
      scopeOrigins: ["seed", "scope", "scope"],
      originWritableNamespaceId: "namespace-c",
    })).toEqual(["namespace-a", "namespace-b", "namespace-c"]);
  });

  test("seed attachments preserve ordinary Namespace authority", () => {
    expect(resolveRequiredMemoryNamespaceIds({
      namespaceIds: ["namespace-seed"],
      scopeOrigins: ["seed"],
      originWritableNamespaceId: null,
    })).toEqual(["namespace-seed"]);
  });

  test("fails closed for missing, stale, or empty authority", () => {
    for (const input of [
      { namespaceIds: [], scopeOrigins: ["scope"] as const, originWritableNamespaceId: null },
      { namespaceIds: ["namespace-a"], scopeOrigins: ["seed"] as const, originWritableNamespaceId: "namespace-stale" },
      { namespaceIds: [], scopeOrigins: [] as const, originWritableNamespaceId: null },
    ]) {
      expect(() => resolveRequiredMemoryNamespaceIds(input)).toThrow(MemoryAuthorityResolutionError);
    }
  });
});
