import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type {
  BackgroundAuthorizationRecord,
} from "../../src/protected-execution/background-authorization/repository";
import type {
  ProtectedJournalPublicationRecord,
} from "../../src/stenographer/protected-publication-repository";
import {
  encodeProtectedJournalAttachmentPlanV1,
} from "../../src/stenographer/protected-journal-output-planner";
import {
  createProtectedStenographerBackgroundExecutionPort,
  createProtectedStenographerPublicationReconciler,
  type ProtectedStenographerPublicationReconciliationRepository,
} from "../../src/stenographer/protected-stenographer-publication-reconciliation";
import type {
  ProtectedStenographerRecoveredExecutionWork,
} from "../../src/stenographer/protected-stenographer-work-composition";

const NOW = new Date("2026-08-05T01:00:00.000Z");
const REQUEST_ID = "request-publication-restart";
const WORK_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_LEASE = "40000000-0000-4000-8000-000000000001";
const PUBLICATION_LEASE = "50000000-0000-4000-8000-000000000001";
const EVENT_ID = "60000000-0000-4000-8000-000000000001";
const OUTPUT_OBJECT_ID = `journal/event/${WORK_ID}/slot-000`;
const DESCRIPTOR_HASH = new Uint8Array(32).fill(0x31);
const WORK_HASH = new Uint8Array(32).fill(0x33);
const PLAN_BYTES = encodeProtectedJournalAttachmentPlanV1({
  kind: "extraction",
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  rebuildGeneration: 2,
  sourceBatchId: WORK_ID,
  statusUpdates: [],
  events: [{
    eventId: EVENT_ID,
    objectId: OUTPUT_OBJECT_ID,
    sequence: 1,
    kind: "fact",
    status: "active",
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [41],
    sourceBatchId: WORK_ID,
    batchLocalOrdinal: 0,
    extractorVersion: "m241-v1",
    createdAt: NOW.toISOString(),
  }],
  foldedBatchLocalOrdinals: [],
  rollup: null,
});
const PLAN_HASH = Uint8Array.from(
  createHash("sha256").update(PLAN_BYTES).digest(),
);
const EMPTY_PLAN_BYTES = encodeProtectedJournalAttachmentPlanV1({
  kind: "extraction",
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  rebuildGeneration: 2,
  sourceBatchId: WORK_ID,
  statusUpdates: [],
  events: [],
  foldedBatchLocalOrdinals: [],
  rollup: null,
});
const EMPTY_PLAN_HASH = Uint8Array.from(
  createHash("sha256").update(EMPTY_PLAN_BYTES).digest(),
);

function record(
  state: "publication_reconciliation" | "running" =
    "publication_reconciliation",
): BackgroundAuthorizationRecord {
  return {
    snapshot: {
      requestId: REQUEST_ID,
      workId: WORK_ID,
      namespaceId: NAMESPACE_ID,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 9,
      },
      state,
      recipientGeneration: 0,
      recipient: null,
      descriptorDigest: Buffer.from(DESCRIPTOR_HASH).toString("hex"),
      claimedAt: null,
      claimId: null,
      useStartedAt: null,
      completedAt: null,
      cancelledAt: null,
      terminalFailureAt: null,
      terminalReason: null,
      retryReason: null,
      nextAttemptAt: NOW.getTime(),
      requestRevision: 4,
      publicationRetryCount: 0,
      createdAt: NOW.getTime() - 10_000,
      updatedAt: NOW.getTime(),
    },
    workIdentityHash: WORK_HASH,
    idempotencyKey: "idempotency-publication-restart",
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: "domain-room-1",
    processorAuthorizationRevision: 9,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 5,
    expectedPolicyRevision: 7,
    descriptorBytes: new Uint8Array([1, 2, 3]),
    acceptedMaterial: null,
    finishedAt: null,
  } as unknown as BackgroundAuthorizationRecord;
}

function recovered(): ProtectedStenographerRecoveredExecutionWork {
  const claim = {
    kind: "extraction",
    workKind: "stenographer.extraction",
    workId: WORK_ID,
    sourceBatchId: WORK_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "70000000-0000-4000-8000-000000000001",
    rebuildGeneration: 2,
    lane: "live",
    leaseToken: SOURCE_LEASE,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    attemptCount: 1,
    fromMessageIdExclusive: 40,
    throughMessageIdInclusive: 41,
    trigger: "count",
    requiresContentRecheck: false,
    bindings: [],
    inputObjectIds: [],
    coveredRangeFingerprint: new Uint8Array(32).fill(0x41),
    sourceBindingFingerprint: new Uint8Array(32).fill(0x42),
    participantIds: [],
    outputSlots: [{ eventId: EVENT_ID, objectId: OUTPUT_OBJECT_ID }],
    extractorVersion: "m241-v1",
    createdAt: NOW.toISOString(),
  } as const;
  return {
    status: "recovered",
    claim,
    work: {
      requestId: REQUEST_ID,
      workId: WORK_ID,
      workIdentityHash: WORK_HASH,
      descriptorHash: DESCRIPTOR_HASH,
      sourceBindingFingerprint: claim.sourceBindingFingerprint,
      requiresContentRecheck: false,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: WORK_ID,
      rebuildGeneration: 2,
      fromMessageIdExclusive: 40,
      throughMessageIdInclusive: 41,
      extractorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
      bindings: [],
      outputSlots: claim.outputSlots,
    },
  };
}

function publication(
  state: ProtectedJournalPublicationRecord["state"],
  outputCount: 0 | 1 = 1,
): ProtectedJournalPublicationRecord {
  return {
    publicationId: REQUEST_ID,
    requestId: REQUEST_ID,
    roomId: ROOM_ID,
    namespaceIdAtAllocation: NAMESPACE_ID,
    workId: WORK_ID,
    sourceBatchId: WORK_ID,
    rebuildGeneration: 2,
    workIdentityHash: WORK_HASH,
    descriptorHash: DESCRIPTOR_HASH,
    attachmentPlanVersion: 1,
    attachmentPlanHash: outputCount === 0 ? EMPTY_PLAN_HASH : PLAN_HASH,
    attachmentPlanBytes: outputCount === 0 ? EMPTY_PLAN_BYTES : PLAN_BYTES,
    outputObjectCount: outputCount,
    state,
    leaseToken: PUBLICATION_LEASE,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    retryCount: 0,
    maximumAttempts: 8,
    failureCode: null,
    lastFailureAt: null,
    cryptoCommittedAt: state === "reserved" ? null : NOW,
    attachedAt: state === "attached" ? NOW : null,
    tombstoneRequestedAt: null,
    tombstonedAt: null,
    lastAuditedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function repository(
  state: ProtectedJournalPublicationRecord["state"],
  calls: string[],
  outputCount: 0 | 1 = 1,
): ProtectedStenographerPublicationReconciliationRepository {
  const receipt = publication(state, outputCount);
  return {
    get: async () => receipt,
    listReconciliation: async () => [receipt],
    claim: async () => {
      calls.push("claim");
      return { status: "claimed", record: receipt };
    },
    markCryptoCommitted: async () => {
      calls.push("mark");
      return {
        status: "committed",
        record: publication("crypto_committed"),
      };
    },
    attach: async () => {
      calls.push("attach");
      return { status: "attached", record: publication("attached") };
    },
    fail: async ({ failureCode }) => {
      calls.push(`fail:${failureCode}`);
      return { status: "retry", record: receipt };
    },
    requestTombstone: async () => {
      calls.push("tombstone");
      return {
        status: "requested",
        record: publication("tombstone_pending"),
      };
    },
    abandonReserved: async () => {
      calls.push("abandon");
      return {
        status: "abandoned",
        record: publication("superseded", outputCount),
      };
    },
  };
}

function reconciler(input: Readonly<{
  state: ProtectedJournalPublicationRecord["state"];
  calls: string[];
  object?: "exact" | "missing" | "substituted";
  recovery?: ProtectedStenographerRecoveredExecutionWork;
  authority?: "current" | "stale";
  outputCount?: 0 | 1;
  commitProof?: "exact" | "missing" | "substituted";
  fence?: "fenced" | "pending" | "not_started";
}>) {
  return createProtectedStenographerPublicationReconciler({
    repository: repository(
      input.state,
      input.calls,
      input.outputCount ?? 1,
    ),
    recoverWork: async () =>
      input.recovery ?? recovered(),
    resolveCurrentAuthority: async () =>
      input.authority === "stale"
        ? null
        : {
          domainId: "domain-room-1",
          processorAuthorizationRevision: 9,
          expectedDomainEpoch: 3,
          expectedNamespaceAccessRevision: 5,
          expectedPolicyRevision: 7,
        },
    committedTransforms: {
      verifyCommit: async () => {
        input.calls.push("proof");
        if (input.commitProof === "missing") return null;
        const outputObjectIds =
          (input.outputCount ?? 1) === 0 ? [] : [OUTPUT_OBJECT_ID];
        return {
          requestId: REQUEST_ID,
          workId: WORK_ID,
          namespaceId: NAMESPACE_ID,
          descriptorHash: input.commitProof === "substituted"
            ? new Uint8Array(32).fill(0x7f)
            : DESCRIPTOR_HASH.slice(),
          recipientGeneration: 0,
          claimId: "claim-publication-restart",
          outputObjectCount: outputObjectIds.length,
          outputObjectIds,
          authorizedOutputObjectIds: [OUTPUT_OBJECT_ID],
        };
      },
    },
    publicationFence: {
      fence: async () => {
        input.calls.push("fence");
        return input.fence ?? "fenced";
      },
    },
    verifiedObjects: {
      verify: async () => {
        input.calls.push("verify");
        if (input.object === "missing") return null;
        return {
          objectId: input.object === "substituted"
            ? "journal/event/foreign"
            : OUTPUT_OBJECT_ID,
          namespaceId: NAMESPACE_ID,
          domainId: "domain-room-1",
          workId: WORK_ID,
          rebuildGeneration: 2,
          outputOrdinal: 0,
          authorizedOutputObjectIds: [OUTPUT_OBJECT_ID],
          publisherNamespaceAccessRevision: 5,
          payloadBytes: new Uint8Array([1]),
          namespaceEnvelopeBytes: new Uint8Array([2]),
        };
      },
    },
    now: () => new Date(NOW),
    leaseToken: () => PUBLICATION_LEASE,
  });
}

describe("protected Stenographer publication reconciliation", () => {
  for (const state of ["reserved", "crypto_committed"] as const) {
    test(`keeps current ${state} work pending without fresh plaintext verification`, async () => {
      const calls: string[] = [];
      const old = record();
      const current: BackgroundAuthorizationRecord = {...old,
        expectedDomainEpoch: null, processorAuthorizationRevision: null,
        snapshot: {...old.snapshot, formatVersion: 2,
          credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}},
      };
      expect(await reconciler({state, calls}).reconcilePublication(current)).toBe("pending");
      expect(calls).toEqual([]);
    });
  }

  test("recovers a crash after crypto commit but before the product receipt mark", async () => {
    const calls: string[] = [];
    expect(await reconciler({ state: "reserved", calls })
      .reconcilePublication(record())).toBe("completed");
    expect(calls).toEqual(["claim", "proof", "verify", "mark", "attach"]);
  });

  test("recovers a crash after the product receipt mark but before attachment", async () => {
    const calls: string[] = [];
    expect(await reconciler({ state: "crypto_committed", calls })
      .reconcilePublication(record())).toBe("completed");
    expect(calls).toEqual(["claim", "proof", "verify", "attach"]);
  });

  test("abandons a provably finished nonempty reservation so the next generation can reuse the work identity", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "reserved",
      calls,
      commitProof: "missing",
    }).reconcilePublication(record())).toBe("not_started");
    expect(calls).toEqual(["claim", "proof", "abandon"]);
  });

  test("does not abandon while an old running transform could still race", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "reserved",
      calls,
      commitProof: "missing",
      fence: "pending",
    }).reconcilePublication(record("running"))).toBe("pending");
    expect(calls).toEqual(["fence"]);
  });

  test("accepts an empty output prefix only with an exact durable crypto commit proof", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "reserved",
      calls,
      outputCount: 0,
    }).reconcilePublication(record())).toBe("completed");
    expect(calls).toEqual(["claim", "proof", "mark", "attach"]);
  });

  test("does not infer an empty commit when its durable crypto proof is absent", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "reserved",
      calls,
      outputCount: 0,
      commitProof: "missing",
      fence: "pending",
    }).reconcilePublication(record())).toBe("not_started");
    expect(calls).toEqual(["claim", "proof", "abandon"]);
  });

  test("treats a crypto-committed receipt without its crypto proof as an integrity failure", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "crypto_committed",
      calls,
      commitProof: "missing",
    }).reconcilePublication(record())).toBe("pending");
    expect(calls).toEqual(["claim", "proof", "fail:integrity_failure"]);
  });

  test("never attaches substituted output evidence", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "crypto_committed",
      calls,
      object: "substituted",
    }).reconcilePublication(record())).toBe("pending");
    expect(calls).toEqual([
      "claim",
      "proof",
      "verify",
      "fail:integrity_failure",
    ]);
  });

  test("rejects a substituted transform commit proof before object verification", async () => {
    const calls: string[] = [];
    expect(await reconciler({
      state: "crypto_committed",
      calls,
      commitProof: "substituted",
    }).reconcilePublication(record())).toBe("pending");
    expect(calls).toEqual(["claim", "proof", "fail:integrity_failure"]);
  });

  test("requests crypto cleanup when source or authority went stale", async () => {
    const staleWorkCalls: string[] = [];
    expect(await reconciler({
      state: "crypto_committed",
      calls: staleWorkCalls,
      recovery: { status: "stale" },
    }).reconcilePublication(record())).toBe("stale");
    expect(staleWorkCalls).toEqual(["claim", "tombstone"]);

    const staleAuthorityCalls: string[] = [];
    expect(await reconciler({
      state: "crypto_committed",
      calls: staleAuthorityCalls,
      authority: "stale",
    }).reconcilePublication(record())).toBe("stale");
    expect(staleAuthorityCalls).toEqual(["claim", "tombstone"]);
  });

  test("surfaces the same reconciler through the background execution port", async () => {
    const calls: string[] = [];
    const reconciliation = reconciler({
      state: "crypto_committed",
      calls,
    });
    const execution = createProtectedStenographerBackgroundExecutionPort({
      executeWork: async () => ({ status: "completed", outputCount: 0 }),
      reconciliation,
    });

    expect(await execution.reconcilePublication(record())).toBe("completed");
    expect(calls).toEqual(["claim", "proof", "verify", "attach"]);
  });
});
