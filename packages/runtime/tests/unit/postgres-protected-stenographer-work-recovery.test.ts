import { describe, expect, test } from "bun:test";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";

import type {
  BackgroundAuthorizationRecord,
} from "../../src/protected-execution/background-authorization/repository";
import {
  PostgresProtectedStenographerWorkRecovery,
  type ProtectedStenographerRecoveryWorkRepository,
} from "../../src/stenographer/postgres-protected-stenographer-work-recovery";
import {
  fingerprintProtectedStenographerSourceBindings,
} from "../../src/stenographer/protected-source-loader";
import type {
  ProtectedStenographerCompactionWorkClaim,
  ProtectedStenographerExtractionWorkClaim,
} from "../../src/stenographer/protected-stenographer-work-repository";

const NOW = new Date("2026-08-05T01:00:00.000Z");
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";

class VerificationConnection implements ConversationProductPostgresConnection {
  query<Row extends ConversationProductDatabaseRow>(
    _statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    return Promise.resolve([{
      current_user: "nautilo",
      session_user: "nautilo",
    }] as unknown as readonly Row[]);
  }

  transaction<Result>(
    _callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    return Promise.reject(new Error("not used"));
  }
}

function record(
  workKind:
    | "stenographer.extraction"
    | "stenographer.historical"
    | "stenographer.compaction",
  workId: string,
): BackgroundAuthorizationRecord {
  return {
    snapshot: {
      formatVersion: 1,
      requestId: "request-recovery",
      workId,
      namespaceId: NAMESPACE_ID,
      descriptorDigest: null,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 19,
      },
      recipientGeneration: 0,
      recipient: null,
      acceptedResponse: null,
      state: "awaiting_recipient",
      claimId: null,
      claimExpiresAt: null,
      requestRevision: 0,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      retryCount: 0,
      lastRetryReason: null,
      nextAttemptAt: null,
      terminalReason: null,
    },
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey: "idempotency-recovery",
    workKind,
    purpose: workKind === "stenographer.compaction"
      ? "journal.compact"
      : "journal.extract",
    domainId: "domain-room-1",
    processorAuthorizationRevision: 19,
    expectedDomainEpoch: 7,
    expectedNamespaceAccessRevision: 11,
    expectedPolicyRevision: 13,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
}

function extractionClaim(): ProtectedStenographerExtractionWorkClaim {
  const bindings = Object.freeze([Object.freeze({
    kind: "message" as const,
    objectId: "conversation/message/41",
    source: "current" as const,
    messageId: 41,
    editRevision: 0,
    createdAt: new Date(NOW.getTime() - 1_000),
    participantId: "33333333-3333-4333-8333-333333333333",
    role: "user" as const,
    conversationalBoundary: true,
  })]);
  return Object.freeze({
    kind: "extraction",
    workKind: "stenographer.extraction",
    workId: BATCH_ID,
    sourceBatchId: BATCH_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "44444444-4444-4444-8444-444444444444",
    rebuildGeneration: 3,
    lane: "live",
    leaseToken: "66666666-6666-4666-8666-666666666666",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    attemptCount: 1,
    fromMessageIdExclusive: 40,
    throughMessageIdInclusive: 41,
    trigger: "count",
    requiresContentRecheck: false,
    bindings,
    inputObjectIds: ["conversation/message/41"],
    coveredRangeFingerprint: new Uint8Array(32).fill(7),
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings(bindings),
    participantIds: ["33333333-3333-4333-8333-333333333333"],
    outputSlots: Array.from({ length: 5 }, (_, index) => ({
      eventId:
        `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
      objectId: `journal/event/${BATCH_ID}/slot-00${index}`,
    })),
    extractorVersion: "m241-v1",
    createdAt: NOW.toISOString(),
  });
}

function compactionClaim(): ProtectedStenographerCompactionWorkClaim {
  const binding = Object.freeze({
    kind: "event" as const,
    objectId: "journal/event/7",
    status: "active" as const,
    binding: Object.freeze({
      eventId: "77777777-7777-4777-8777-777777777777",
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence: 7,
      kind: "fact" as const,
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [41],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 0,
      extractorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
    }),
  });
  const workId = `stenographer-compaction/${ROOM_ID}/3/7`;
  return Object.freeze({
    kind: "compaction",
    workKind: "stenographer.compaction",
    workId,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "44444444-4444-4444-8444-444444444444",
    rebuildGeneration: 3,
    leaseToken: "66666666-6666-4666-8666-666666666666",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    attemptCount: 1,
    bindings: [binding],
    inputObjectIds: [binding.objectId],
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings([binding]),
    activeEventCount: 1,
    selectedEventCount: 1,
    hasDeferredMiddle: false,
    outputSlot: {
      rollupId: "88888888-8888-4888-8888-888888888888",
      objectId:
        "journal/rollup/88888888-8888-4888-8888-888888888888/slot-000",
    },
    compactorVersion: "m241-v1",
    createdAt: NOW.toISOString(),
  });
}

async function verifiedHandle() {
  return verifyConversationProductPostgresHandle(
    new VerificationConnection(),
  );
}

describe("PostgreSQL protected Stenographer exact recovery", () => {
  test("recovers exact extraction from the durable product repository", async () => {
    const claim = extractionClaim();
    const calls: unknown[] = [];
    const repository: ProtectedStenographerRecoveryWorkRepository = {
      recoverExtraction: (input) => {
        calls.push(input);
        return Promise.resolve({ status: "claimed", claim });
      },
      recoverCompaction: () => Promise.reject(new Error("not used")),
    };
    const recovery = new PostgresProtectedStenographerWorkRecovery(
      await verifiedHandle(),
      {
        repository,
        resolveCompactionModelId: () => Promise.reject(new Error("not used")),
      },
    );

    expect(await recovery.recoverExact({
      record: record("stenographer.extraction", BATCH_ID),
      descriptor: null,
      now: NOW,
    })).toEqual({
      status: "recovered",
      work: { claim, compactionModelId: null },
    });
    expect(calls).toEqual([{ workId: BATCH_ID, now: NOW }]);
  });

  test("maps missing, leased, and stale product outcomes without widening them", async () => {
    const handle = await verifiedHandle();
    for (const reason of ["missing", "leased", "stale"] as const) {
      const repository: ProtectedStenographerRecoveryWorkRepository = {
        recoverExtraction: () =>
          Promise.resolve({ status: "unavailable", reason }),
        recoverCompaction: () => Promise.reject(new Error("not used")),
      };
      const recovery = new PostgresProtectedStenographerWorkRecovery(handle, {
        repository,
        resolveCompactionModelId: () => Promise.reject(new Error("not used")),
      });
      expect(await recovery.recoverExact({
        record: record("stenographer.extraction", BATCH_ID),
        descriptor: null,
        now: NOW,
      })).toEqual({ status: reason });
    }
  });

  test("recovers compaction and binds the current content-free model policy", async () => {
    const claim = compactionClaim();
    const repository: ProtectedStenographerRecoveryWorkRepository = {
      recoverExtraction: () => Promise.reject(new Error("not used")),
      recoverCompaction: (input) => {
        expect(input).toEqual({
          workId: claim.workId,
          createdAt: NOW.toISOString(),
          now: NOW,
        });
        return Promise.resolve({ status: "claimed", claim });
      },
    };
    const recovery = new PostgresProtectedStenographerWorkRecovery(
      await verifiedHandle(),
      {
        repository,
        resolveCompactionModelId: ({ claim: exactClaim }) => {
          expect(exactClaim).toBe(claim);
          return Promise.resolve("compaction-model-v1");
        },
      },
    );
    expect(await recovery.recoverExact({
      record: record("stenographer.compaction", claim.workId),
      descriptor: null,
      now: NOW,
    })).toEqual({
      status: "recovered",
      work: { claim, compactionModelId: "compaction-model-v1" },
    });
  });

  test("rejects descriptor coordinate and ordered-input substitution", async () => {
    const claim = extractionClaim();
    let called = false;
    const repository: ProtectedStenographerRecoveryWorkRepository = {
      recoverExtraction: () => {
        called = true;
        return Promise.resolve({ status: "claimed", claim });
      },
      recoverCompaction: () => Promise.reject(new Error("not used")),
    };
    const recovery = new PostgresProtectedStenographerWorkRecovery(
      await verifiedHandle(),
      {
        repository,
        resolveCompactionModelId: () => Promise.reject(new Error("not used")),
      },
    );
    const descriptor = {
      requestId: "request-recovery",
      workId: BATCH_ID,
      workKind: "stenographer.extraction",
      namespaceId: NAMESPACE_ID,
      source: {
        kind: "journal_range",
        startSequence: 41,
        endSequence: 41,
        rebuildGeneration: 3,
        fingerprint: claim.coveredRangeFingerprint,
      },
      inputObjectIds: ["conversation/message/substituted"],
    } as unknown as BackgroundWorkDescriptorV1;

    expect(await recovery.recoverExact({
      record: record("stenographer.extraction", BATCH_ID),
      descriptor,
      now: NOW,
    })).toEqual({ status: "stale" });
    expect(called).toBe(true);
  });
});
