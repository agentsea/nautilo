import { describe, expect, test } from "bun:test";

import {
  coordinateProtectedJournalRebuild,
  type ProtectedJournalRebuildCoordinatorPorts,
} from "../../src/stenographer/protected-journal-rebuild-coordinator";
import {
  encodeProtectedJournalAttachmentPlanV1,
} from "../../src/stenographer/protected-journal-output-planner";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-04T20:00:00.000Z");
const LEASE = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const BATCH_ID = "40000000-0000-4000-8000-000000000001";
const EVENT_ID = "50000000-0000-4000-8000-000000000001";

const ATTACHMENT_PLAN_BYTES = encodeProtectedJournalAttachmentPlanV1({
  kind: "extraction",
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  rebuildGeneration: 0,
  sourceBatchId: BATCH_ID,
  statusUpdates: [],
  events: [{
    eventId: EVENT_ID,
    objectId: "journal-event-1",
    sequence: 1,
    kind: "fact",
    status: "active",
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [1],
    sourceBatchId: BATCH_ID,
    batchLocalOrdinal: 0,
    extractorVersion: "m241-v1",
    createdAt: "2026-08-04T20:00:00.000Z",
  }],
  foldedBatchLocalOrdinals: [],
  rollup: null,
});

function ports(
  calls: string[],
): ProtectedJournalRebuildCoordinatorPorts {
  return {
    rebuilds: {
      prepare: async () => ({
        status: "cleanup_pending",
        publicationIdsNeedingTombstone: ["publication-1"],
        hasMoreInvalidationWork: false,
      }),
      finalize: async () => ({
        status: "completed",
        startCursor: 4,
        targetCursor: 4,
      }),
    },
    publications: {
      claim: async () => {
        calls.push("claim");
        return {
          status: "claimed",
          record: {
            state: "tombstone_pending",
            attachmentPlanBytes: ATTACHMENT_PLAN_BYTES,
            outputObjectCount: 1,
          },
        };
      },
      markTombstoned: async () => {
        calls.push("mark");
        return { status: "tombstoned" };
      },
      fail: async () => {
        calls.push("fail");
        return { status: "retry" };
      },
    },
    crypto: {
      tombstoneObjects: async ({ objectIds }) => {
        calls.push(`crypto:${objectIds.join(",")}`);
        return {
          status: "tombstoned",
          advancedCount: 1,
          alreadyTombstonedCount: 0,
        };
      },
    },
    now: () => NOW,
    leaseToken: () => LEASE,
  };
}

describe("protected journal rebuild coordinator", () => {
  test("advances the signed crypto tombstone before acknowledging product cleanup", async () => {
    const calls: string[] = [];
    const result = await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 1,
      ports: ports(calls),
    });

    expect(result).toEqual({
      status: "cleanup_progress",
      processedPublications: 1,
      hasMoreInvalidationWork: false,
    });
    expect(calls).toEqual([
      "claim",
      "crypto:journal-event-1",
      "mark",
    ]);
  });

  test("refreshes the lease clock before the product acknowledgement", async () => {
    const calls: string[] = [];
    const base = ports(calls);
    const instants = [
      new Date("2026-08-04T20:00:00.000Z"),
      new Date("2026-08-04T20:00:01.000Z"),
      new Date("2026-08-04T20:00:08.000Z"),
    ];
    const seen: Date[] = [];
    const input: ProtectedJournalRebuildCoordinatorPorts = {
      ...base,
      now: () => instants.shift()!,
      publications: {
        ...base.publications,
        claim: async ({ now }) => {
          seen.push(now);
          return {
            status: "claimed",
            record: {
              state: "tombstone_pending",
              attachmentPlanBytes: ATTACHMENT_PLAN_BYTES,
              outputObjectCount: 1,
            },
          };
        },
        markTombstoned: async ({ now }) => {
          seen.push(now);
          return { status: "tombstoned" };
        },
      },
    };

    await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 1,
      ports: input,
    });

    expect(seen.map((value) => value.toISOString())).toEqual([
      "2026-08-04T20:00:01.000Z",
      "2026-08-04T20:00:08.000Z",
    ]);
  });

  test("retries product acknowledgement after crypto commit without resurrecting access", async () => {
    const calls: string[] = [];
    const base = ports(calls);
    let markAttempts = 0;
    let tombstoneAttempts = 0;
    const input: ProtectedJournalRebuildCoordinatorPorts = {
      ...base,
      publications: {
        ...base.publications,
        markTombstoned: async () => {
          calls.push("mark");
          markAttempts += 1;
          return markAttempts === 1
            ? { status: "lease_lost" }
            : { status: "tombstoned" };
        },
      },
      crypto: {
        tombstoneObjects: async () => {
          calls.push("crypto");
          tombstoneAttempts += 1;
          return {
            status: "tombstoned",
            advancedCount: tombstoneAttempts === 1 ? 1 : 0,
            alreadyTombstonedCount: tombstoneAttempts === 1 ? 0 : 1,
          };
        },
      },
    };

    expect(await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 1,
      ports: input,
    })).toEqual({
      status: "retry",
      reason: "product_acknowledgement_lost",
    });
    expect(await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 1,
      ports: input,
    })).toMatchObject({
      status: "cleanup_progress",
      processedPublications: 1,
    });
    expect(calls).toEqual([
      "claim",
      "crypto",
      "mark",
      "claim",
      "crypto",
      "mark",
    ]);
  });

  test("records a bounded typed failure and never acknowledges a failed crypto tombstone", async () => {
    const calls: string[] = [];
    const base = ports(calls);
    const input: ProtectedJournalRebuildCoordinatorPorts = {
      ...base,
      crypto: {
        tombstoneObjects: async () => {
          calls.push("crypto");
          throw new Error("synthetic crypto failure");
        },
      },
    };

    expect(await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 1,
      ports: input,
    })).toEqual({
      status: "retry",
      reason: "crypto_tombstone_failed",
    });
    expect(calls).toEqual(["claim", "crypto", "fail"]);
  });

  test("finalizes only after the product repository proves cleanup is ready", async () => {
    const calls: string[] = [];
    const base = ports(calls);
    const input: ProtectedJournalRebuildCoordinatorPorts = {
      ...base,
      rebuilds: {
        prepare: async () => ({ status: "ready_to_finalize" }),
        finalize: async () => {
          calls.push("finalize");
          return {
            status: "prepared",
            startCursor: 10,
            targetCursor: 14,
          };
        },
      },
    };

    expect(await coordinateProtectedJournalRebuild({
      roomId: ROOM_ID,
      rebuildGeneration: 2,
      ports: input,
    })).toEqual({
      status: "prepared",
      startCursor: 10,
      targetCursor: 14,
    });
    expect(calls).toEqual(["finalize"]);
  });
});
