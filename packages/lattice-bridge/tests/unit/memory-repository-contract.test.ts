import { describe, expect, test } from "bun:test";

import {
  MEMORY_PAYLOAD_VERSION,
  assertMemoryRevisionLifecycle,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type MemoryRevisionLifecycle,
} from "../../src/index.ts";

const MEMORY_A = "10000000-0000-4000-8000-000000000001";
const MEMORY_B = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_A = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "20000000-0000-4000-8000-000000000002";

function digest(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function lifecycle(
  overrides: Partial<MemoryRevisionLifecycle> = {},
): MemoryRevisionLifecycle {
  return Object.freeze({
    sequence: 1,
    memoryId: MEMORY_A,
    contentRevision: 1,
    anchorNamespaceId: NAMESPACE_A,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_A,
      contentRevision: 1,
    }),
    payloadVersion: MEMORY_PAYLOAD_VERSION,
    allocationRequestDigest: digest(1),
    requiredNamespaceFingerprint: fingerprintRequiredMemoryNamespaces([
      NAMESPACE_A,
    ]),
    completion: "pending",
    disposition: "active",
    attemptCount: 0,
    nextAttemptAt: new Date(0),
    leaseToken: null,
    leaseExpiresAt: null,
    failureCode: null,
    cryptoCompletedAt: null,
    ...overrides,
  });
}

describe("Memory repository identity contract", () => {
  test("derives opaque object identity only from product coordinates", () => {
    const first = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_A,
      contentRevision: 1,
    });
    expect(first).toBe(deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_A,
      contentRevision: 1,
    }));
    expect(first).not.toBe(deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_A,
      contentRevision: 2,
    }));
    expect(first).not.toBe(deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_B,
      contentRevision: 1,
    }));
    expect(first).toMatch(/^memory:v1:[0-9a-f]{64}$/);
  });

  test("fingerprints only a canonical bounded exact Namespace set", () => {
    const fingerprint = fingerprintRequiredMemoryNamespaces([
      NAMESPACE_A,
      NAMESPACE_B,
    ]);
    expect(fingerprint).toHaveLength(32);
    expect(fingerprint).not.toEqual(
      fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
    );
    expect(() => fingerprintRequiredMemoryNamespaces([
      NAMESPACE_B,
      NAMESPACE_A,
    ])).toThrow("unique and sorted");
    expect(() => fingerprintRequiredMemoryNamespaces([
      NAMESPACE_A,
      NAMESPACE_A,
    ])).toThrow("unique and sorted");
    expect(() => fingerprintRequiredMemoryNamespaces([])).toThrow(
      "not bounded",
    );
  });

  test("rejects forged lifecycle coordinates and unbounded retries", () => {
    expect(() => assertMemoryRevisionLifecycle(lifecycle())).not.toThrow();
    expect(() => assertMemoryRevisionLifecycle(lifecycle({
      cryptoObjectId: "memory:v1:forged",
    }))).toThrow("not canonical");
    expect(() => assertMemoryRevisionLifecycle(lifecycle({
      attemptCount: 9,
    }))).toThrow("attempt count is invalid");
    expect(() => assertMemoryRevisionLifecycle(lifecycle({
      allocationRequestDigest: new Uint8Array(31),
    }))).toThrow("exactly 32 bytes");
  });
});
