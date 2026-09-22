import { describe, expect, test } from "bun:test";

import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  type AtomicTaskContentCryptoCompletionPort,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCryptoRevisionReferenceV1,
  type TaskContentProductMappingCasResult,
  type TaskContentProductStorePort,
  type TaskContentRevisionLifecycleV1,
  type TaskContentRevisionStateV1,
  type VerifiedTaskContentCryptoRevisionV1,
} from "../../src/task/task-content-repository.ts";
import {
  createDormantTaskContentShadowRepository,
} from "../../src/task/task-content-shadow-saga.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const LEASE = "30000000-0000-4000-8000-000000000001";
const coordinate = Object.freeze({
  kind: "run_result" as const,
  taskId: TASK_ID,
  taskRunId: RUN_ID,
  contentRevision: 1,
});
const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: "40000000-0000-4000-8000-000000000001",
  namespaceId: "50000000-0000-4000-8000-000000000001",
  domainId: "60000000-0000-4000-8000-000000000001",
  expectedAccessRevision: 2,
  expectedPolicyRevision: 3,
} satisfies TaskContentAuthorityV1);

function lifecycle(
  overrides: Partial<TaskContentRevisionLifecycleV1> = {},
): TaskContentRevisionLifecycleV1 {
  return Object.freeze({
    sequence: 1,
    coordinate,
    operationId: "task-result-operation.1",
    requestDigest: new Uint8Array(32).fill(1),
    requesterHumanId: authority.requesterHumanId,
    namespaceId: authority.namespaceId,
    cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    objectType: "nautilo-task-run-result-v1",
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    representation: "dual",
    authorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(
      authority.namespaceId,
    ),
    operationalMetadata: null,
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
  overrides: Partial<PreparedTaskContentCryptoRevisionV1> = {},
): PreparedTaskContentCryptoRevisionV1 {
  const state = lifecycle();
  return Object.freeze({
    coordinate,
    objectId: state.cryptoObjectId,
    objectType: state.objectType,
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: authority.namespaceId,
    authorityFingerprint: state.authorityFingerprint,
    ...overrides,
  });
}

class FakeProduct implements TaskContentProductStorePort {
  readonly events: string[];
  state: TaskContentRevisionStateV1;
  nextMapping: TaskContentProductMappingCasResult = "applied";
  throwAfterMark = false;
  throwAfterMap = false;
  tooMany = false;

  constructor(events: string[]) {
    this.events = events;
    this.state = Object.freeze({
      product: Object.freeze({
        coordinate,
        namespaceId: authority.namespaceId,
        representation: "dual",
        cryptoObjectId: null,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: null,
        cryptoMappingState: "stale",
      }),
      lifecycle: lifecycle(),
      authority,
    });
  }

  async reserveRevision(input: {
    operationId: string;
    requestDigest: Uint8Array;
  }) {
    this.events.push("product:reserve");
    if (
      input.operationId !== this.state.lifecycle.operationId
      || !input.requestDigest.every((value, index) =>
        value === this.state.lifecycle.requestDigest[index]
      )
    ) return { status: "conflict" as const };
    return { status: "reserved" as const, state: this.state };
  }

  async getRevision() {
    this.events.push("product:get");
    return this.state;
  }

  async markCryptoComplete() {
    this.events.push("product:complete");
    const duplicate = this.state.lifecycle.completion === "complete";
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        completion: "complete",
        cryptoCompletedAt: new Date(1),
      }),
    });
    if (this.throwAfterMark) {
      this.throwAfterMark = false;
      throw new Error("lost completion response");
    }
    return duplicate ? "duplicate" as const : "applied" as const;
  }

  async compareAndSwapCryptoMapping() {
    this.events.push("product:map");
    const result = this.nextMapping;
    if (result === "applied") {
      this.state = Object.freeze({
        ...this.state,
        product: Object.freeze({
          coordinate,
          namespaceId: authority.namespaceId,
          representation: this.state.lifecycle.representation,
          cryptoObjectId: this.state.lifecycle.cryptoObjectId,
          cryptoAccessRevision: 0,
          cryptoRequiredNamespaceFingerprint:
            this.state.lifecycle.requiredNamespaceFingerprint,
          cryptoMappingState: "verified",
        }),
        lifecycle: lifecycle({
          ...this.state.lifecycle,
          completion: "complete",
          disposition: "mapped",
          cryptoCompletedAt: new Date(1),
        }),
      });
      if (this.throwAfterMap) {
        this.throwAfterMap = false;
        throw new Error("lost mapping response");
      }
    } else if (result === "stale") {
      this.state = Object.freeze({
        ...this.state,
        lifecycle: lifecycle({
          ...this.state.lifecycle,
          completion: "complete",
          disposition: "stale_mapping",
          failureCode: "mapping_conflict",
          cryptoCompletedAt: new Date(1),
        }),
      });
    }
    return result;
  }

  async quarantineRevision(input: { failureCode: TaskContentRevisionLifecycleV1["failureCode"] }) {
    this.events.push("product:quarantine");
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        disposition: "quarantined",
        failureCode: input.failureCode,
      }),
    });
    return "applied" as const;
  }

  async markAuthorityStale() {
    this.events.push("product:authority-stale");
    const completed = this.state.lifecycle.completion === "complete";
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        disposition: completed ? "stale_mapping" : "quarantined",
        failureCode: "authority_stale",
      }),
    });
    return this.state.lifecycle;
  }

  async claimReconciliationCandidates(input: { leaseToken: string }) {
    this.events.push("product:claim");
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(60_000),
      }),
    });
    return this.tooMany ? [this.state, this.state] : [this.state];
  }

  async failReconciliationClaim() {
    this.events.push("product:fail");
    return this.state.lifecycle;
  }
}

class FakeCrypto implements AtomicTaskContentCryptoCompletionPort {
  readonly events: string[];
  stored: VerifiedTaskContentCryptoRevisionV1 | null = null;
  lastReference: TaskContentCryptoRevisionReferenceV1 | null = null;
  throwAfterComplete = false;

  constructor(events: string[]) {
    this.events = events;
  }

  async complete(revision: PreparedTaskContentCryptoRevisionV1) {
    this.events.push("crypto:complete");
    const duplicate = this.stored !== null;
    this.stored = Object.freeze({ ...revision });
    if (this.throwAfterComplete) {
      this.throwAfterComplete = false;
      throw new Error("lost crypto response");
    }
    return duplicate ? "duplicate" as const : "created" as const;
  }

  async verify(reference: TaskContentCryptoRevisionReferenceV1) {
    this.events.push("crypto:verify");
    this.lastReference = reference;
    return this.stored;
  }
}

function harness() {
  const events: string[] = [];
  const product = new FakeProduct(events);
  const crypto = new FakeCrypto(events);
  return {
    events,
    product,
    crypto,
    repository: createDormantTaskContentShadowRepository({ product, crypto }),
  };
}

async function reserve(testHarness: ReturnType<typeof harness>) {
  return testHarness.repository.reserveRevision({
    operationId: "task-result-operation.1",
    requestDigest: new Uint8Array(32).fill(1),
    representation: "dual",
    authority,
    prepared: prepared(),
    operationalMetadata: null,
  });
}

describe("dormant Task content shadow repository", () => {
  test("completes and verifies exact crypto before mapping a result", async () => {
    const testHarness = harness();
    expect(await reserve(testHarness)).toMatchObject({ status: "reserved" });
    expect(await testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).toMatchObject({ status: "mapped", coordinate });
    expect(testHarness.events).toEqual([
      "product:reserve",
      "product:get",
      "crypto:complete",
      "crypto:verify",
      "product:complete",
      "product:map",
    ]);
    expect(testHarness.crypto.lastReference).toMatchObject({
      coordinate,
      objectType: "nautilo-task-run-result-v1",
    });
  });

  test("accepts only an exact reservation replay", async () => {
    const testHarness = harness();
    expect(await reserve(testHarness)).toMatchObject({ status: "reserved" });
    expect(await testHarness.repository.reserveRevision({
      operationId: "task-result-operation.1",
      requestDigest: new Uint8Array(32).fill(2),
      representation: "dual",
      authority,
      prepared: prepared(),
      operationalMetadata: null,
    })).toEqual({ status: "conflict" });
    expect(testHarness.events).not.toContain("crypto:complete");
  });

  test("replays across crypto, receipt, and mapping response loss", async () => {
    const cryptoLoss = harness();
    await reserve(cryptoLoss);
    cryptoLoss.crypto.throwAfterComplete = true;
    expect(cryptoLoss.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).rejects.toThrow("lost crypto response");
    expect((await cryptoLoss.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 1,
    })).outcomes[0]?.outcome).toBe("mapped");

    const productLoss = harness();
    await reserve(productLoss);
    productLoss.product.throwAfterMark = true;
    expect(productLoss.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).rejects.toThrow("lost completion response");
    productLoss.product.throwAfterMap = true;
    expect(productLoss.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).rejects.toThrow("lost mapping response");
    expect(await productLoss.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).toMatchObject({ status: "replayed" });
  });

  test("orphan-stops stale CAS and quarantines authority drift", async () => {
    const stale = harness();
    await reserve(stale);
    stale.product.nextMapping = "stale";
    expect(await stale.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).toMatchObject({ status: "orphaned", reason: "stale_mapping" });

    const drift = harness();
    await reserve(drift);
    drift.crypto.stored = Object.freeze({
      ...prepared(),
      authorityFingerprint: new Uint8Array(32).fill(9),
    });
    drift.product.state = Object.freeze({
      ...drift.product.state,
      lifecycle: lifecycle({
        completion: "complete",
        cryptoCompletedAt: new Date(1),
      }),
    });
    expect((await drift.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 1,
    })).outcomes[0]?.outcome).toBe("quarantined");
    expect(drift.events).not.toContain("product:map");
  });

  test("refuses replay when the product mapping is stale or changes representation", async () => {
    const testHarness = harness();
    await reserve(testHarness);
    await testHarness.repository.completeRevision({ coordinate, prepared: prepared() });
    const mapped = testHarness.product.state.product!;
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      product: Object.freeze({ ...mapped, cryptoMappingState: "stale" as const }),
    });
    expect(testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).rejects.toThrow("product state is inconsistent");

    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      product: Object.freeze({
        ...mapped,
        representation: "protected" as const,
        cryptoMappingState: "verified" as const,
      }),
    });
    expect(testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).rejects.toThrow("product state is inconsistent");
  });

  test("marks current authority drift stale without calling it crypto corruption", async () => {
    const testHarness = harness();
    await reserve(testHarness);
    testHarness.crypto.stored = prepared();
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      authority: Object.freeze({
        ...authority,
        expectedPolicyRevision: authority.expectedPolicyRevision + 1,
      }),
    });

    const report = await testHarness.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 1,
    });

    expect(report.outcomes[0]?.outcome).toBe("quarantined");
    expect(testHarness.product.state.lifecycle).toMatchObject({
      disposition: "quarantined",
      failureCode: "authority_stale",
    });
    expect(testHarness.events).toContain("product:authority-stale");
    expect(testHarness.events).not.toContain("product:quarantine");
  });

  test("rejects cross-run prepared content and bounds leased batches", () => {
    const testHarness = harness();
    expect(testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared({
        coordinate: Object.freeze({
          ...coordinate,
          taskRunId: "20000000-0000-4000-8000-000000000002",
        }),
      }),
    })).rejects.toThrow("coordinates disagree");
    expect(testHarness.repository.reconcilePending({
      leaseToken: "invalid",
      limit: 1,
    })).rejects.toThrow("lease must be a UUID");
    testHarness.product.tooMany = true;
    expect(testHarness.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 1,
    })).rejects.toThrow("too many candidates");
  });
});
