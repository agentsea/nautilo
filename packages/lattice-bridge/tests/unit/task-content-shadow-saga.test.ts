import { describe, expect, test } from "bun:test";
import {
  PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  classifyProtectedTaskMetadataV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";

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
const definitionCoordinate = Object.freeze({
  kind: "definition" as const,
  taskId: TASK_ID,
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
  claimedStates: readonly TaskContentRevisionStateV1[] | null = null;

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

  async getRevisionByOperation() {
    this.events.push("product:get-operation");
    return { status: "found" as const, state: this.state };
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
    if (this.claimedStates !== null) return this.claimedStates;
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

function definitionPrepared(): PreparedTaskContentCryptoRevisionV1 {
  return Object.freeze({
    coordinate: definitionCoordinate,
    objectId: deriveTaskContentCryptoObjectIdV1(definitionCoordinate),
    objectType: "nautilo-task-definition-v1",
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: authority.namespaceId,
    authorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
  });
}

function emptyOperationalMetadata(): ProtectedTaskOperationalMetadataProjectionV1 {
  const classified = classifyProtectedTaskMetadataV1({});
  if (classified.status !== "supported") {
    throw new Error("Expected empty Task metadata fixture");
  }
  return classified.operational;
}

function setDefinitionState(
  testHarness: ReturnType<typeof harness>,
  operationalMetadata: TaskContentRevisionLifecycleV1["operationalMetadata"],
): void {
  testHarness.product.state = Object.freeze({
    product: Object.freeze({
      coordinate: definitionCoordinate,
      namespaceId: authority.namespaceId,
      representation: "dual",
      cryptoObjectId: null,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: null,
      cryptoMappingState: "stale",
    }),
    lifecycle: lifecycle({
      coordinate: definitionCoordinate,
      operationId: "task-definition-operation.1",
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(definitionCoordinate),
      objectType: "nautilo-task-definition-v1",
      operationalMetadata,
    }),
    authority,
  });
}

function quarantinedReconciliationState(
  candidateCoordinate: typeof coordinate | typeof definitionCoordinate,
  sequence: number,
): TaskContentRevisionStateV1 {
  return Object.freeze({
    product: null,
    lifecycle: lifecycle({
      sequence,
      coordinate: candidateCoordinate,
      operationId: `reconcile-${candidateCoordinate.kind}-${sequence}`,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(candidateCoordinate),
      objectType: candidateCoordinate.kind === "definition"
        ? "nautilo-task-definition-v1"
        : "nautilo-task-run-result-v1",
      operationalMetadata: candidateCoordinate.kind === "definition"
        ? emptyOperationalMetadata()
        : null,
      disposition: "quarantined",
      failureCode: "crypto_mismatch",
      leaseToken: LEASE,
      leaseExpiresAt: new Date(60_000),
    }),
    authority,
  });
}

describe("dormant Task content shadow repository", () => {
  test("admits only an exact active prepared replay under current authority", async () => {
    const testHarness = harness();
    setDefinitionState(testHarness, emptyOperationalMetadata());
    const lookup = (overrides: Partial<Parameters<
      typeof testHarness.repository.lookupPreparedReplay
    >[0]> = {}) => testHarness.repository.lookupPreparedReplay({
      operationId: "task-definition-operation.1",
      requestDigest: new Uint8Array(32).fill(1),
      representation: "dual",
      coordinate: definitionCoordinate,
      requesterHumanId: authority.requesterHumanId,
      namespaceId: authority.namespaceId,
      ...overrides,
    });
    expect(await lookup()).toEqual({ status: "exact", authority });
    expect(await lookup({ requestDigest: new Uint8Array(32).fill(2) }))
      .toEqual({ status: "unavailable" });
    expect(await lookup({ requesterHumanId: TASK_ID }))
      .toEqual({ status: "unavailable" });

    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      lifecycle: lifecycle({
        ...testHarness.product.state.lifecycle,
        disposition: "quarantined",
        failureCode: "crypto_mismatch",
      }),
    });
    expect(await lookup()).toEqual({ status: "unavailable" });

    setDefinitionState(testHarness, emptyOperationalMetadata());
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      authority: Object.freeze({
        ...authority,
        expectedPolicyRevision: authority.expectedPolicyRevision + 1,
      }),
    });
    expect(await lookup()).toEqual({ status: "unavailable" });
    expect(testHarness.events.filter((event) => event === "product:get-operation"))
      .toHaveLength(5);
  });

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
    const advancedAuthority = Object.freeze({
      ...authority,
      expectedAccessRevision: authority.expectedAccessRevision + 1,
    });
    expect(testHarness.repository.reserveRevision({
      operationId: "task-result-operation.1",
      requestDigest: new Uint8Array(32).fill(1),
      representation: "dual",
      authority: advancedAuthority,
      prepared: prepared({
        authorityFingerprint:
          fingerprintTaskContentAuthorityV1(advancedAuthority),
      }),
      operationalMetadata: null,
    })).rejects.toThrow("not an exact replay");
    expect(testHarness.events).not.toContain("crypto:complete");
  });

  test("accepts only classifier-produced operational metadata before reserve", async () => {
    const rejectedMetadata = [
      { target: "/private/repository", instructions: "protected only" },
      { unknown: "plaintext escape" },
      { mode: 42 },
      { execution: { relayId: "x".repeat(
        PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 + 1,
      ) } },
    ];
    for (const operationalMetadata of rejectedMetadata) {
      const testHarness = harness();
      expect(() => testHarness.repository.reserveRevision({
        operationId: "task-definition-operation.1",
        requestDigest: new Uint8Array(32).fill(1),
        representation: "dual",
        authority,
        prepared: definitionPrepared(),
        operationalMetadata: operationalMetadata as unknown as
          ProtectedTaskOperationalMetadataProjectionV1,
      })).toThrow("canonical classifier output");
      expect(testHarness.events).not.toContain("product:reserve");
    }

    const classified = classifyProtectedTaskMetadataV1({
      target: "/private/repository",
      mode: "update",
      publish: "branch",
      instructions: "protected only",
    });
    if (classified.status !== "supported") {
      throw new Error("expected supported Task metadata fixture");
    }
    const accepted = harness();
    setDefinitionState(accepted, classified.operational);
    expect(await accepted.repository.reserveRevision({
      operationId: "task-definition-operation.1",
      requestDigest: new Uint8Array(32).fill(1),
      representation: "dual",
      authority,
      prepared: definitionPrepared(),
      operationalMetadata: classified.operational,
    })).toMatchObject({ status: "reserved", coordinate: definitionCoordinate });
    expect(accepted.events).toContain("product:reserve");
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

  test("replays a mapped revision after access and policy revisions advance", async () => {
    const testHarness = harness();
    await reserve(testHarness);
    await testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    });
    const mapped = testHarness.product.state.product!;
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      product: Object.freeze({ ...mapped, cryptoAccessRevision: 4 }),
      authority: Object.freeze({
        ...authority,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }),
    });

    expect(await testHarness.repository.completeRevision({
      coordinate,
      prepared: prepared(),
    })).toMatchObject({ status: "replayed", coordinate });
    expect(testHarness.crypto.lastReference).toMatchObject({
      expectedAccessRevision: 4,
    });
  });

  test("marks current identity drift stale without calling it crypto corruption", async () => {
    const testHarness = harness();
    await reserve(testHarness);
    testHarness.crypto.stored = prepared();
    testHarness.product.state = Object.freeze({
      ...testHarness.product.state,
      authority: Object.freeze({
        ...authority,
        requesterHumanId: "40000000-0000-4000-8000-000000000002",
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

  test("accepts producer ordering across equal-due independent ledgers", async () => {
    const testHarness = harness();
    testHarness.product.claimedStates = [
      quarantinedReconciliationState(definitionCoordinate, 10),
      quarantinedReconciliationState(coordinate, 1),
    ];

    const report = await testHarness.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 2,
    });

    expect(report.outcomes).toEqual([
      expect.objectContaining({ sequence: 10, outcome: "quarantined" }),
      expect.objectContaining({ sequence: 1, outcome: "quarantined" }),
    ]);
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
