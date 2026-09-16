import { describe, expect, test } from "bun:test";

import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  createDormantMemoryShadowRepository,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryProductMappingCasResult,
  type MemoryProductStorePort,
  type MemoryCryptoRevisionReference,
  type MemoryRevisionLifecycle,
  type MemoryRevisionState,
  type PreparedMemoryCryptoRevision,
  type VerifiedMemoryCryptoRevision,
} from "../../src/index.ts";

const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_A = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "20000000-0000-4000-8000-000000000002";
const REQUIRED_NAMESPACES = Object.freeze([NAMESPACE_A, NAMESPACE_B]);

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function lifecycle(
  overrides: Partial<MemoryRevisionLifecycle> = {},
): MemoryRevisionLifecycle {
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: MEMORY_ID,
    contentRevision: 1,
  });
  return Object.freeze({
    sequence: 1,
    memoryId: MEMORY_ID,
    contentRevision: 1,
    anchorNamespaceId: NAMESPACE_A,
    cryptoObjectId,
    payloadVersion: MEMORY_PAYLOAD_VERSION,
    allocationRequestDigest: bytes(1),
    requiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces(REQUIRED_NAMESPACES),
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

function prepared(
  overrides: Partial<PreparedMemoryCryptoRevision> = {},
): PreparedMemoryCryptoRevision {
  const base = lifecycle();
  return Object.freeze({
    memoryId: base.memoryId,
    contentRevision: base.contentRevision,
    objectId: base.cryptoObjectId,
    objectType: MEMORY_OBJECT_TYPE,
    payloadVersion: MEMORY_PAYLOAD_VERSION,
    requiredNamespaceIds: REQUIRED_NAMESPACES,
    ...overrides,
  });
}

class FakeMemoryProductStore implements MemoryProductStorePort {
  readonly events: string[];
  state: MemoryRevisionState;
  nextMapping: MemoryProductMappingCasResult = "applied";
  throwAfterMarkCommit = false;
  throwAfterMappingCommit = false;
  tooManyCandidates = false;

  constructor(events: string[]) {
    this.events = events;
    this.state = Object.freeze({
      product: Object.freeze({
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoObjectId: null,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: null,
      }),
      lifecycle: lifecycle(),
      requiredNamespaceIds: REQUIRED_NAMESPACES,
    });
  }

  async getRevision(): Promise<MemoryRevisionState | null> {
    this.events.push("product:get");
    return this.state;
  }

  async markCryptoComplete(input: {
    readonly cryptoObjectId: string;
    readonly leaseToken: string | null;
  }): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    this.events.push("product:complete");
    if (input.cryptoObjectId !== this.state.lifecycle.cryptoObjectId) {
      return "conflict";
    }
    const duplicate = this.state.lifecycle.completion === "complete";
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        completion: "complete",
        cryptoCompletedAt: new Date(1),
      }),
    });
    if (this.throwAfterMarkCommit) {
      this.throwAfterMarkCommit = false;
      throw new Error("lost completion response");
    }
    return duplicate ? "duplicate" : "applied";
  }

  async compareAndSwapCryptoMapping(): Promise<MemoryProductMappingCasResult> {
    this.events.push("product:map");
    const result = this.nextMapping;
    if (result === "applied") {
      this.state = Object.freeze({
        ...this.state,
        product: Object.freeze({
          ...this.state.product!,
          cryptoObjectId: this.state.lifecycle.cryptoObjectId,
          cryptoAccessRevision: 0,
          cryptoRequiredNamespaceFingerprint:
            this.state.lifecycle.requiredNamespaceFingerprint,
        }),
        lifecycle: lifecycle({
          ...this.state.lifecycle,
          completion: "complete",
          disposition: "mapped",
          cryptoCompletedAt: new Date(1),
        }),
      });
      if (this.throwAfterMappingCommit) {
        this.throwAfterMappingCommit = false;
        throw new Error("lost mapping response");
      }
    } else if (result === "stale") {
      this.state = Object.freeze({
        ...this.state,
        lifecycle: lifecycle({
          ...this.state.lifecycle,
          completion: "complete",
          disposition: "stale_mapping",
          cryptoCompletedAt: new Date(1),
        }),
      });
    }
    return result;
  }

  async quarantineRevision(): Promise<
    "applied" | "duplicate" | "missing" | "conflict"
  > {
    this.events.push("product:quarantine");
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        disposition: "quarantined",
      }),
    });
    return "applied";
  }

  async claimReconciliationCandidates(input: {
    readonly leaseToken: string;
    readonly limit: number;
  }): Promise<
    readonly MemoryRevisionState[]
  > {
    this.events.push("product:claim");
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(60_000),
      }),
    });
    return this.tooManyCandidates ? [this.state, this.state] : [this.state];
  }

  async failReconciliationClaim(): Promise<MemoryRevisionLifecycle | null> {
    this.events.push("product:fail");
    return this.state.lifecycle;
  }
}

class FakeMemoryCryptoCompletion implements AtomicMemoryCryptoCompletionPort {
  readonly events: string[];
  stored: VerifiedMemoryCryptoRevision | null = null;
  lastReference: MemoryCryptoRevisionReference | null = null;
  incomplete = false;
  throwAfterCompleteCommit = false;

  constructor(events: string[]) {
    this.events = events;
  }

  async complete(
    revision: PreparedMemoryCryptoRevision,
  ): Promise<"created" | "duplicate"> {
    this.events.push("crypto:complete");
    if (this.incomplete) return "created";
    const duplicate = this.stored !== null;
    this.stored = Object.freeze({
      memoryId: revision.memoryId,
      contentRevision: revision.contentRevision,
      objectId: revision.objectId,
      objectType: revision.objectType,
      payloadVersion: revision.payloadVersion,
      requiredNamespaceIds: Object.freeze([...revision.requiredNamespaceIds]),
    });
    if (this.throwAfterCompleteCommit) {
      this.throwAfterCompleteCommit = false;
      throw new Error("lost crypto completion response");
    }
    return duplicate ? "duplicate" : "created";
  }

  async verify(
    reference: MemoryCryptoRevisionReference,
  ): Promise<VerifiedMemoryCryptoRevision | null> {
    this.events.push("crypto:verify");
    this.lastReference = reference;
    return this.stored;
  }

}

function harness() {
  const events: string[] = [];
  const product = new FakeMemoryProductStore(events);
  const crypto = new FakeMemoryCryptoCompletion(events);
  const repository = createDormantMemoryShadowRepository({ product, crypto });
  return { events, product, crypto, repository };
}

describe("dormant Memory shadow repository", () => {
  test("completes the exact multi-Namespace object before publishing mapping", async () => {
    const testHarness = harness();

    const result = await testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    });

    expect(result).toEqual({
      status: "mapped",
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: lifecycle().cryptoObjectId,
    });
    expect(testHarness.events).toEqual([
      "product:get",
      "crypto:complete",
      "crypto:verify",
      "product:complete",
      "product:map",
    ]);
  });

  test("replays after both product response-loss boundaries", async () => {
    const testHarness = harness();
    testHarness.product.throwAfterMarkCommit = true;
    expect(testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).rejects.toThrow("lost completion response");

    testHarness.product.throwAfterMappingCommit = true;
    expect(testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).rejects.toThrow("lost mapping response");

    expect(await testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).toMatchObject({ status: "replayed" });
  });

  test("replays genesis completion after later access-set changes", async () => {
    const testHarness = harness();
    await testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    });
    const currentFingerprint = fingerprintRequiredMemoryNamespaces([
      NAMESPACE_B,
    ]);
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      product: Object.freeze({
        ...testHarness.product.state.product!,
        cryptoAccessRevision: 1,
        cryptoRequiredNamespaceFingerprint: currentFingerprint,
      }),
      requiredNamespaceIds: Object.freeze([NAMESPACE_B]),
    });
    expect(await testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).toMatchObject({ status: "replayed" });
  });

  test("reconciles after atomic crypto commit response loss", async () => {
    const testHarness = harness();
    testHarness.crypto.throwAfterCompleteCommit = true;
    expect(testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).rejects.toThrow("lost crypto completion response");

    const report = await testHarness.repository.reconcilePending({
      leaseToken: "30000000-0000-4000-8000-000000000001",
      limit: 1,
    });

    expect(report.outcomes).toEqual([{
      sequence: 1,
      memoryId: MEMORY_ID,
      contentRevision: 1,
      outcome: "mapped",
    }]);
    expect(testHarness.product.state.product?.cryptoObjectId).toBe(
      lifecycle().cryptoObjectId,
    );
  });

  test("rejects incomplete or widened access before product publication", async () => {
    const testHarness = harness();
    testHarness.crypto.incomplete = true;
    expect(testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    })).rejects.toThrow("Complete Memory crypto revision is not verified");
    expect(testHarness.events).not.toContain("product:complete");

    const widened = harness();
    expect(widened.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared({
        requiredNamespaceIds: [...REQUIRED_NAMESPACES,
          "20000000-0000-4000-8000-000000000003"],
      }),
    })).rejects.toThrow("required Namespace set mismatch");
    expect(widened.events).toEqual(["product:get"]);
  });

  test("reports an orphan without fabricating deletion authority after product CAS loss", async () => {
    const testHarness = harness();
    testHarness.product.nextMapping = "stale";

    const result = await testHarness.repository.completeRevision({
      memoryId: MEMORY_ID,
      expectedRevision: 1,
      prepared: prepared(),
    });

    expect(result).toMatchObject({
      status: "orphaned",
      reason: "stale_mapping",
    });
    expect(testHarness.events.at(-1)).toBe("product:map");
  });

  test("quarantines durable access-set drift instead of blessing it", async () => {
    const testHarness = harness();
    testHarness.crypto.stored = Object.freeze({
      ...prepared(),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      lifecycle: lifecycle({
        completion: "complete",
        cryptoCompletedAt: new Date(1),
      }),
    });

    const report = await testHarness.repository.reconcilePending({
      leaseToken: "30000000-0000-4000-8000-000000000001",
      limit: 1,
    });

    expect(report.outcomes).toEqual([{
      sequence: 1,
      memoryId: MEMORY_ID,
      contentRevision: 1,
      outcome: "quarantined",
    }]);
    expect(testHarness.events).toContain("product:quarantine");
    expect(testHarness.events).not.toContain("product:map");
  });

  test("bounds reconciliation and rejects adapter overflow", () => {
    const testHarness = harness();
    expect(testHarness.repository.reconcilePending({
      leaseToken: "not-a-uuid",
      limit: 1,
    })).rejects.toThrow("lease must be a UUID");
    expect(testHarness.repository.reconcilePending({
      leaseToken: "30000000-0000-4000-8000-000000000001",
      limit: 0,
    })).rejects.toThrow("limit is invalid");

    testHarness.product.tooManyCandidates = true;
    expect(testHarness.repository.reconcilePending({
      leaseToken: "30000000-0000-4000-8000-000000000001",
      limit: 1,
    })).rejects.toThrow("too many candidates");
  });
});
