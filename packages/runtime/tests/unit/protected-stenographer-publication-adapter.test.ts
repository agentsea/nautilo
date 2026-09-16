import { describe, expect, test } from "bun:test";

import {
  createProtectedStenographerCompactionPublicationAdapter,
  createProtectedStenographerExtractionPublicationAdapter,
} from "../../src/stenographer/protected-stenographer-publication-adapter";
import type {
  ProtectedStenographerCompactionWorkClaim,
  ProtectedStenographerExtractionWorkClaim,
} from "../../src/stenographer/protected-stenographer-work-repository";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_LEASE = "44444444-4444-4444-8444-444444444444";
const RECEIPT_LEASE = "55555555-5555-4555-8555-555555555555";

type ExtractionOptions = Parameters<
  typeof createProtectedStenographerExtractionPublicationAdapter
>[0];

function extractionWork(): ProtectedStenographerExtractionWorkClaim {
  return {
    kind: "extraction",
    workKind: "stenographer.extraction",
    workId: BATCH_ID,
    sourceBatchId: BATCH_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "66666666-6666-4666-8666-666666666666",
    rebuildGeneration: 3,
    lane: "live",
    leaseToken: SOURCE_LEASE,
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    attemptCount: 1,
    fromMessageIdExclusive: 40,
    throughMessageIdInclusive: 41,
    trigger: "silence",
    requiresContentRecheck: false,
    bindings: [{
      kind: "message",
      objectId: "message-object-41",
      source: "current",
      messageId: 41,
      editRevision: 0,
      createdAt: NOW,
      participantId: "77777777-7777-4777-8777-777777777777",
      role: "user",
      conversationalBoundary: true,
    }],
    inputObjectIds: ["message-object-41"],
    coveredRangeFingerprint: new Uint8Array(32).fill(6),
    sourceBindingFingerprint: new Uint8Array(32).fill(1),
    participantIds: ["77777777-7777-4777-8777-777777777777"],
    outputSlots: [{
      eventId: "88888888-8888-4888-8888-888888888888",
      objectId: "journal/event/output-1",
    }],
    extractorVersion: "m241-v1",
    createdAt: NOW.toISOString(),
  };
}

function fakeRepository(
  calls: string[],
  reserveStatus: "claimed" | "existing" | "busy" | "stale" = "claimed",
): ExtractionOptions["repository"] {
  return {
    reserveCurrentSourceAndClaim: (input) => {
      calls.push(`reserve:${input.source.kind}:${input.sourceLeaseToken}`);
      return Promise.resolve(
        reserveStatus === "claimed" || reserveStatus === "existing"
          ? {
            status: reserveStatus,
            record: {} as never,
          }
          : { status: reserveStatus },
      );
    },
    markCryptoCommitted: (input) => {
      calls.push(`mark:${input.leaseToken}`);
      return Promise.resolve({
        status: "committed",
        record: {} as never,
      });
    },
    attach: (input) => {
      calls.push(`attach:${input.sourceLeaseToken}`);
      return Promise.resolve({
        status: "attached",
        record: {} as never,
      });
    },
  };
}

function reservation(workId = BATCH_ID) {
  return {
    publicationId: "publication-1",
    requestId: "request-1",
    workId,
    workIdentityHash: new Uint8Array(32).fill(2),
    descriptorHash: new Uint8Array(32).fill(3),
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    sourceBatchId: BATCH_ID,
    rebuildGeneration: 3,
    attachmentPlanVersion: 1 as const,
    attachmentPlanHash: new Uint8Array(32).fill(4),
    attachmentPlanBytes: new Uint8Array([1]),
    outputObjectCount: 1,
  };
}

describe("protected Stenographer publication adapters", () => {
  test("closes over exact source and receipt leases across the extraction saga", async () => {
    const calls: string[] = [];
    const adapter = createProtectedStenographerExtractionPublicationAdapter({
      repository: fakeRepository(calls),
      work: extractionWork(),
      publicationLeaseToken: RECEIPT_LEASE,
      now: () => NOW,
    });

    expect(await adapter.reserve(reservation())).toBe("reserved");
    expect(await adapter.markCryptoCommitted({
      publicationId: "publication-1",
      requestId: "request-1",
      workId: BATCH_ID,
      descriptorHash: new Uint8Array(32).fill(3),
      attachmentPlanHash: new Uint8Array(32).fill(4),
      outputObjectIds: ["journal/event/output-1"],
    })).toBe("marked");
    expect(await adapter.attach({
      publicationId: "publication-1",
      requestId: "request-1",
      workId: BATCH_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: BATCH_ID,
      rebuildGeneration: 3,
      attachmentPlan: {} as never,
      attachmentPlanHash: new Uint8Array(32).fill(4),
      outputObjectIds: ["journal/event/output-1"],
    })).toBe("attached");
    expect(calls).toEqual([
      `reserve:extraction:${SOURCE_LEASE}`,
      `mark:${RECEIPT_LEASE}`,
      `attach:${SOURCE_LEASE}`,
    ]);
  });

  test("fails before repository mutation on identity substitution and maps stale/busy reservations", async () => {
    const calls: string[] = [];
    const adapter = createProtectedStenographerExtractionPublicationAdapter({
      repository: fakeRepository(calls),
      work: extractionWork(),
      publicationLeaseToken: RECEIPT_LEASE,
      now: () => NOW,
    });
    expect(await adapter.reserve(reservation("substituted-work")))
      .toBe("conflict");
    expect(calls).toEqual([]);

    for (const status of ["stale", "busy"] as const) {
      const stale = createProtectedStenographerExtractionPublicationAdapter({
        repository: fakeRepository([], status),
        work: extractionWork(),
        publicationLeaseToken: RECEIPT_LEASE,
        now: () => NOW,
      });
      expect(await stale.reserve(reservation())).toBe("stale");
    }
  });

  test("uses the compaction lease and source kind for rollup publication", async () => {
    const calls: string[] = [];
    const extraction = extractionWork();
    const work: ProtectedStenographerCompactionWorkClaim = {
      kind: "compaction",
      workKind: "stenographer.compaction",
      workId: "stenographer-compaction/work-1",
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      ownerId: extraction.ownerId,
      rebuildGeneration: 3,
      leaseToken: SOURCE_LEASE,
      leaseExpiresAt: extraction.leaseExpiresAt,
      attemptCount: 1,
      bindings: extraction.bindings,
      inputObjectIds: extraction.inputObjectIds,
      sourceBindingFingerprint: extraction.sourceBindingFingerprint,
      activeEventCount: 1,
      selectedEventCount: 1,
      hasDeferredMiddle: false,
      outputSlot: {
        rollupId: "99999999-9999-4999-8999-999999999999",
        objectId: "journal/rollup/output-1",
      },
      compactorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
    };
    const adapter = createProtectedStenographerCompactionPublicationAdapter({
      repository: fakeRepository(calls),
      work,
      publicationLeaseToken: RECEIPT_LEASE,
      now: () => NOW,
    });
    expect(await adapter.reserve({
      ...reservation(work.workId),
      sourceBatchId: null,
      outputObjectCount: 1,
    })).toBe("reserved");
    expect(calls).toEqual([`reserve:compaction:${SOURCE_LEASE}`]);
  });
});
