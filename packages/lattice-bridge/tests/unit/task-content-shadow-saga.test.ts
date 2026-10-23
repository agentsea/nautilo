import { deriveTaskHistoricalContentCryptoObjectIdV1 } from "../../src/task/task-historical-content-identity.ts";
import { describe, expect, test } from "bun:test";
import {
  PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  classifyProtectedTaskMetadataV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";

import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TaskCancellationPublicationPolicyUnavailableError,
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
  lastCoordinateClaim: Parameters<NonNullable<
    TaskContentProductStorePort["claimReconciliationCoordinate"]
  >>[0] | null = null;
  quarantineFailedClaim = false;

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

  async claimReconciliationCoordinate(input: Parameters<NonNullable<
    TaskContentProductStorePort["claimReconciliationCoordinate"]
  >>[0]) {
    this.events.push("product:claim-coordinate");
    this.lastCoordinateClaim = input;
    if (
      input.operationId !== this.state.lifecycle.operationId
      || input.coordinate.kind !== this.state.lifecycle.coordinate.kind
      || input.coordinate.taskId !== this.state.lifecycle.coordinate.taskId
      || input.coordinate.contentRevision
        !== this.state.lifecycle.coordinate.contentRevision
      || (input.coordinate.kind === "run_result"
        && (this.state.lifecycle.coordinate.kind !== "run_result"
          || input.coordinate.taskRunId
            !== this.state.lifecycle.coordinate.taskRunId))
    ) return null;
    if (this.state.lifecycle.disposition === "mapped") return this.state;
    if (this.state.lifecycle.leaseToken !== null) return null;
    this.state = Object.freeze({
      ...this.state,
      lifecycle: lifecycle({
        ...this.state.lifecycle,
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(60_000),
      }),
    });
    return this.state;
  }

  async failReconciliationClaim() {
    this.events.push("product:fail");
    if (this.quarantineFailedClaim) {
      this.state = Object.freeze({
        ...this.state,
        lifecycle: lifecycle({
          ...this.state.lifecycle,
          attemptCount: 8,
          disposition: "quarantined",
          failureCode: "retry_exhausted",
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      });
    }
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

test.each(["claim", "verify", "publication", "mapping", "mapped_verify"])(
  "cancellation policy wait at %s never consumes retry attempts or changes disposition", async step => {
    const h = harness();
    const stopped = { ...coordinate, contentRevision: 2 };
    const operationId = `task-run-cancelled-result:${RUN_ID}`;
    h.product.state = { product: step === "mapped_verify" ? {
      coordinate: stopped, namespaceId: authority.namespaceId, representation: "dual",
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(stopped), cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(authority.namespaceId),
      cryptoMappingState: "verified",
    } : null, authority, lifecycle: lifecycle({
      coordinate: stopped, operationId, cryptoObjectId: deriveTaskContentCryptoObjectIdV1(stopped),
      ...(step === "mapped_verify" ? { completion: "complete", disposition: "mapped", cryptoCompletedAt: new Date(1), nextAttemptAt: null } : {}),
    }) };
    h.crypto.stored = prepared({ coordinate: stopped, objectId: deriveTaskContentCryptoObjectIdV1(stopped) });
    const wait = () => Promise.reject(new TaskCancellationPublicationPolicyUnavailableError());
    if (step === "claim") h.product.claimReconciliationCoordinate = wait;
    if (step === "verify" || step === "mapped_verify") h.crypto.verify = wait;
    if (step === "mapping") h.product.compareAndSwapCryptoMapping = wait;
    expect(await h.repository.reconcileCoordinate({ coordinate: stopped, operationId, leaseToken: LEASE,
      ...(step === "publication" ? { publishProduct: wait } : {}),
    })).toBe("pending");
    expect(h.events).not.toContain("product:fail");
    expect(h.events).not.toContain("product:authority-stale");
    expect(h.events).not.toContain("product:quarantine");
    expect(h.product.state.lifecycle.attemptCount).toBe(0);
    expect(h.product.state.lifecycle.disposition).toBe(step === "mapped_verify" ? "mapped" : "active");
  },
);

test("ordinary writer does not gain cancellation policy-wait semantics", async () => {
  const h = harness();
  h.product.claimReconciliationCoordinate = () => Promise.reject(new TaskCancellationPublicationPolicyUnavailableError());
  expect(await h.repository.reconcileCoordinate({ coordinate, operationId: h.product.state.lifecycle.operationId,
    leaseToken: LEASE }).catch((error: unknown) => error)).toBeInstanceOf(TaskCancellationPublicationPolicyUnavailableError);
});

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

  test("reconciles only the exact coordinate and operation without a global claim", async () => {
    const testHarness = harness();
    testHarness.crypto.stored = prepared();
    const mutableCoordinate: {
      kind: "run_result";
      taskId: string;
      taskRunId: string;
      contentRevision: number;
    } = { ...coordinate };

    expect(await testHarness.repository.reconcileCoordinate({
      coordinate: mutableCoordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
      async publishProduct() {
        testHarness.events.push("product:publish-callback");
      },
    })).toBe("mapped");
    mutableCoordinate.taskRunId = "20000000-0000-4000-8000-000000000002";

    expect(testHarness.events).toContain("product:claim-coordinate");
    expect(testHarness.events).not.toContain("product:claim");
    expect(testHarness.events.indexOf("crypto:verify")).toBeLessThan(
      testHarness.events.indexOf("product:publish-callback"),
    );
    expect(testHarness.events.indexOf("product:publish-callback")).toBeLessThan(
      testHarness.events.indexOf("product:complete"),
    );
    expect(testHarness.product.lastCoordinateClaim?.coordinate).toEqual(coordinate);
    expect(Object.isFrozen(
      testHarness.product.lastCoordinateClaim?.coordinate,
    )).toBe(true);

    const wrongOperation = harness();
    expect(await wrongOperation.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.2",
      leaseToken: LEASE,
    })).toBe("pending");
    expect(wrongOperation.events).not.toContain("crypto:verify");

    const alreadyLeased = harness();
    alreadyLeased.product.state = Object.freeze({
      ...alreadyLeased.product.state,
      lifecycle: lifecycle({
        leaseToken: "30000000-0000-4000-8000-000000000002",
        leaseExpiresAt: new Date(60_000),
      }),
    });
    expect(await alreadyLeased.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
    })).toBe("pending");
    expect(alreadyLeased.events).not.toContain("crypto:verify");
  });

  test("retries missing coordinate crypto, quarantines exhaustion, and replays mapping", async () => {
    const missing = harness();
    expect(await missing.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
    })).toBe("pending");
    expect(missing.events).toContain("product:fail");

    const exhausted = harness();
    exhausted.product.quarantineFailedClaim = true;
    expect(await exhausted.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
    })).toBe("quarantined");
    expect(exhausted.product.state.lifecycle.failureCode).toBe("retry_exhausted");

    const callbackFailure = harness();
    callbackFailure.crypto.stored = prepared();
    expect(await callbackFailure.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
      async publishProduct() {
        callbackFailure.events.push("product:publish-callback");
        throw new Error("lost product publication response");
      },
    })).toBe("pending");
    expect(callbackFailure.events).toContain("crypto:verify");
    expect(callbackFailure.events).toContain("product:publish-callback");
    expect(callbackFailure.events).toContain("product:fail");
    expect(callbackFailure.events).not.toContain("product:complete");
    expect(callbackFailure.events).not.toContain("product:map");

    const mapped = harness();
    await reserve(mapped);
    await mapped.repository.completeRevision({ coordinate, prepared: prepared() });
    const globalClaims = mapped.events.filter((event) => event === "product:claim").length;
    expect(await mapped.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
      async publishProduct() {
        mapped.events.push("product:unexpected-callback");
      },
    })).toBe("mapped");
    expect(mapped.events.filter((event) => event === "product:claim")).toHaveLength(
      globalClaims,
    );
    expect(mapped.events).not.toContain("product:unexpected-callback");
  });

  test("binds only the closed cancellation reference to its genesis manifest hash", async () => {
    const cancellation = harness();
    const cancellationCoordinate = Object.freeze({
      kind: "run_result" as const,
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 2,
    });
    const requestDigest = new Uint8Array(32).fill(0x5a);
    cancellation.product.state = Object.freeze({
      product: null,
      lifecycle: lifecycle({
        coordinate: cancellationCoordinate,
        operationId: `task-run-cancelled-result:${RUN_ID}`,
        requestDigest,
        cryptoObjectId: deriveTaskContentCryptoObjectIdV1(
          cancellationCoordinate,
        ),
      }),
      authority,
    });

    expect(await cancellation.repository.reconcileCoordinate({
      coordinate: cancellationCoordinate,
      operationId: `task-run-cancelled-result:${RUN_ID}`,
      leaseToken: LEASE,
    })).toBe("pending");
    expect(cancellation.crypto.lastReference?.expectedGenesisManifestHash)
      .toEqual(requestDigest);
    expect(cancellation.crypto.lastReference?.expectedGenesisManifestHash)
      .not.toBe(requestDigest);

    const normal = harness();
    normal.crypto.stored = prepared();
    await normal.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
    });
    expect(normal.crypto.lastReference?.expectedGenesisManifestHash)
      .toBeUndefined();
  });

  test("fails explicitly when exact coordinate claiming is unsupported", () => {
    const testHarness = harness();
    Object.defineProperty(testHarness.product, "claimReconciliationCoordinate", {
      value: undefined,
    });
    expect(testHarness.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: LEASE,
    })).rejects.toThrow("does not support coordinate reconciliation");
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
    expect(testHarness.repository.reconcileCoordinate({
      coordinate,
      operationId: "task-result-operation.1",
      leaseToken: "invalid",
    })).rejects.toThrow("lease must be a UUID");
    expect(testHarness.repository.reconcileCoordinate({
      coordinate,
      operationId: "invalid operation",
      leaseToken: LEASE,
    })).rejects.toThrow("operation ID is invalid");
    testHarness.product.tooMany = true;
    expect(testHarness.repository.reconcilePending({
      leaseToken: LEASE,
      limit: 1,
    })).rejects.toThrow("too many candidates");
  });
});

test("historical recovery carries its closed source identity and exact signed genesis to crypto verification", async () => {
  const h = harness();
  const historicalRepair = { version: 2 as const, claimId: "70000000-0000-4000-8000-000000000001",
    publisherDeviceId: "historical-device", signedRequestDigest: "0a".repeat(32), sourceDigest: "04".repeat(32),
    sourcePayloadHash: "05".repeat(32), sourceRevision: 0 as const, genesisManifestHash: "06".repeat(32) };
  const cryptoObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({ coordinate,
    namespaceId: authority.namespaceId, sourceDigest: new Uint8Array(32).fill(4) });
  h.product.state = Object.freeze({ product: null, authority, lifecycle: lifecycle({
    historicalRepair, representation: "dual", requestDigest: new Uint8Array(32).fill(10), cryptoObjectId,
  }) });
  h.crypto.stored = { ...prepared(), objectId: cryptoObjectId };
  expect(await h.repository.reconcileCoordinate({ coordinate,
    operationId: h.product.state.lifecycle.operationId, leaseToken: LEASE })).toBe("mapped");
  expect(h.crypto.lastReference?.historicalRepair).toEqual({ provenance: historicalRepair,
    namespaceId: authority.namespaceId });
  expect(h.crypto.lastReference?.expectedGenesisManifestHash).toEqual(new Uint8Array(32).fill(6));
});
