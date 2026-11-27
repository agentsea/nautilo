import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  previewRoomJournalRecovery,
  previewRoomJournalServiceModelRebind,
  queueRoomJournalRecovery,
  readRoomJournalRecoveryMetadata,
} from "../../src/queries/room-journal-recovery";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-27T08:00:00.000Z");

function state(overrides: Record<string, unknown> = {}) {
  return {
    roomId: ROOM_ID, roomKind: "private", archivedAt: null, suspendedAt: null,
    historicalBackfillStatus: "not_needed", historicalBackfillCursorMessageId: null,
    hasAgent: true, rebuildGeneration: 7, lastProcessedMessageId: 91,
    rebuildRequestedAt: null, rebuildTargetMessageId: null,
    lastExtractionCompletedAt: new Date("2026-11-26T10:00:00.000Z"),
    lastExtractionErrorCode: "provider",
    lastExtractionErrorAt: new Date("2026-11-27T07:00:00.000Z"),
    lastCompactionCompletedAt: new Date("2026-11-25T10:00:00.000Z"),
    lastCompactionErrorCode: null, lastCompactionErrorAt: null,
    lastCompactionErrorAttempt: null, lastCompactionErrorModelId: null,
    extractionLeased: false, compactionLeased: false, conversionLeased: false,
    providerOutcomeUnknown: false, extractionAttemptRunning: false,
    protectedPublicationExists: false,
    ...overrides,
  };
}

function failedBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID, lane: "live", modelId: "old-model", status: "failed",
    errorCode: "provider", attemptCount: 2,
    lastErrorAt: new Date("2026-11-27T07:00:00.000Z"), lastErrorAttempt: 2,
    lastErrorModelId: "old-model", ...overrides,
  };
}

function thenableBuilder(rows: () => unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) {
    builder[method] = () => builder;
  }
  builder["then"] = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows()).then(resolve, reject);
  return builder;
}

function recoveryDb(current: Record<string, unknown>, latestFailed: Record<string, unknown> | null = null) {
  let insertCount = 0;
  const select = (selection: Record<string, unknown>) => {
    if ("roomKind" in selection) return thenableBuilder(() => [current]);
    if ("lastErrorAt" in selection && "lane" in selection) {
      return thenableBuilder(() => latestFailed ? [latestFailed] : []);
    }
    return thenableBuilder(() => []);
  };
  const insert = () => ({ values: () => ({
    onConflictDoUpdate: async () => {
      insertCount += 1;
      current["rebuildGeneration"] = Number(current["rebuildGeneration"]) + 1;
      current["rebuildRequestedAt"] = NOW;
    },
  }) });
  const db = { select, insert, execute: async () => [],
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db) } as unknown as DirectDatabase;
  return { db, insertCount: () => insertCount };
}

describe("Room Journal recovery", () => {
  test("returns content-free exact recovery metadata and the relevant failed batch", async () => {
    const result = await readRoomJournalRecoveryMetadata(
      recoveryDb(state(), failedBatch()).db,
      ROOM_ID,
    );
    expect(result).toMatchObject({
      roomId: ROOM_ID, rebuildGeneration: 7, lastProcessedMessageId: 91,
      latestUnfinishedFailedExtractionBatch: failedBatch(),
    });
    expect(result).not.toHaveProperty("label");
    expect(result).not.toHaveProperty("content");
  });

  test("preview and execution share conservative provider and lease blocks", async () => {
    expect(await previewRoomJournalRecovery(
      recoveryDb(state({ providerOutcomeUnknown: true })).db,
      { roomId: ROOM_ID, expectedRebuildGeneration: 7, now: NOW },
    )).toEqual({ status: "blocked", reason: "provider_outcome_unknown", rebuildGeneration: 7 });
    expect(await queueRoomJournalRecovery(
      recoveryDb(state({ conversionLeased: true })).db,
      { roomId: ROOM_ID, expectedRebuildGeneration: 7, now: NOW },
    )).toEqual({ status: "blocked", reason: "conversion_leased", rebuildGeneration: 7 });
  });

  test("queues the canonical transition once and leaves dispatch to the scheduler", async () => {
    const fixture = recoveryDb(state());
    expect(await queueRoomJournalRecovery(fixture.db,
      { roomId: ROOM_ID, expectedRebuildGeneration: 7, now: NOW }))
      .toEqual({ status: "queued", rebuildGeneration: 8 });
    expect(await queueRoomJournalRecovery(fixture.db,
      { roomId: ROOM_ID, expectedRebuildGeneration: 8, now: NOW }))
      .toEqual({ status: "already_queued", rebuildGeneration: 8 });
    expect(fixture.insertCount()).toBe(1);
  });

  test("stales a request after another generation wins", async () => {
    const fixture = recoveryDb(state({ rebuildGeneration: 9 }));
    expect(await queueRoomJournalRecovery(fixture.db,
      { roomId: ROOM_ID, expectedRebuildGeneration: 8, now: NOW }))
      .toEqual({ status: "stale", rebuildGeneration: 9 });
    expect(fixture.insertCount()).toBe(0);
  });

  test("stales a same-generation request after its previewed cursor drifts", async () => {
    const fixture = recoveryDb(state({ lastProcessedMessageId: 92 }));
    expect(await previewRoomJournalRecovery(fixture.db, {
      roomId: ROOM_ID, expectedRebuildGeneration: 7, expectedCursor: 91,
      now: NOW,
    })).toEqual({
      status: "blocked", reason: "stale_cursor", rebuildGeneration: 7,
    });
    expect(await queueRoomJournalRecovery(fixture.db, {
      roomId: ROOM_ID, expectedRebuildGeneration: 7, expectedCursor: 91,
      now: NOW,
    })).toEqual({ status: "stale", rebuildGeneration: 7 });
    expect(fixture.insertCount()).toBe(0);
  });
});

describe("Room Journal refused-service model rebind", () => {
  test("rejects a malformed optional replacement before reading durable state", async () => {
    const db = { select: () => { throw new Error("must not read"); } } as unknown as DirectDatabase;
    expect(await previewRoomJournalServiceModelRebind(db, {
      roomId: ROOM_ID, batchId: BATCH_ID, expectedAttemptCount: 2,
      expectedRebuildGeneration: 7,
      modelId: " model-with-whitespace ", now: NOW,
    })).toEqual({ status: "blocked", reason: "binding_not_service", rebuildGeneration: null });
  });

  test("can preview an exact refused service batch before choosing its replacement", async () => {
    const rebindState = {
      roomKind: "private", archivedAt: null, suspendedAt: null, hasAgent: true,
      rebuildGeneration: 7, rebuildRequestedAt: null, lastProcessedMessageId: 91,
      historicalBackfillStatus: "not_needed", historicalBackfillCursorMessageId: null,
      extractionLeaseActive: false, compactionLeaseActive: false,
      conversionLeaseActive: false, extractionAttemptRunning: false,
    };
    const batch = {
      roomId: ROOM_ID, lane: "live", status: "failed", attemptCount: 2,
      acceptedModelBinding: {
        version: 1, kind: "service", role: "memorySummarization",
        modelId: "old-model", inputCommitment: `hmac-sha256:${"A".repeat(43)}`,
      },
      modelId: "old-model", errorCode: "provider", lastErrorAttempt: 2,
      lastErrorModelId: "old-model", fromMessageIdExclusive: 91,
      startedAt: new Date("2026-11-27T06:59:00.000Z"),
    };
    const select = (selection: Record<string, unknown>) => {
      if ("extractionLeaseActive" in selection) return thenableBuilder(() => [rebindState]);
      if ("acceptedModelBinding" in selection) return thenableBuilder(() => [batch]);
      if ("proven" in selection) return thenableBuilder(() => [{ proven: true }]);
      return thenableBuilder(() => []);
    };
    const db = { select } as unknown as DirectDatabase;
    expect(await previewRoomJournalServiceModelRebind(db, {
      roomId: ROOM_ID, batchId: BATCH_ID, expectedRebuildGeneration: 7,
      expectedAttemptCount: 2, now: NOW,
    })).toEqual({ status: "allowed", rebuildGeneration: 7, currentModelId: "old-model" });
  });

  test("blocks a replacement when refusal proof exists only before the current attempt", async () => {
    const rebindState = {
      roomKind: "private", archivedAt: null, suspendedAt: null, hasAgent: true,
      rebuildGeneration: 7, rebuildRequestedAt: null, lastProcessedMessageId: 91,
      historicalBackfillStatus: "not_needed", historicalBackfillCursorMessageId: null,
      extractionLeaseActive: false, compactionLeaseActive: false,
      conversionLeaseActive: false, extractionAttemptRunning: false,
    };
    const batch = {
      roomId: ROOM_ID, lane: "live", status: "failed", attemptCount: 2,
      acceptedModelBinding: {
        version: 1, kind: "service", role: "memorySummarization",
        modelId: "old-model", inputCommitment: `hmac-sha256:${"A".repeat(43)}`,
      },
      modelId: "old-model", errorCode: "provider", lastErrorAttempt: 2,
      lastErrorModelId: "old-model", fromMessageIdExclusive: 91,
      startedAt: new Date("2026-11-27T06:59:00.000Z"),
    };
    const select = (selection: Record<string, unknown>) => {
      if ("extractionLeaseActive" in selection) return thenableBuilder(() => [rebindState]);
      if ("acceptedModelBinding" in selection) return thenableBuilder(() => [batch]);
      if ("proven" in selection) return thenableBuilder(() => [{ proven: false }]);
      return thenableBuilder(() => []);
    };
    expect(await previewRoomJournalServiceModelRebind(
      { select } as unknown as DirectDatabase,
      {
        roomId: ROOM_ID, batchId: BATCH_ID, expectedRebuildGeneration: 7,
        expectedAttemptCount: 2, now: NOW,
      },
    )).toEqual({
      status: "blocked",
      reason: "attempt_outcome_not_refused",
      rebuildGeneration: 7,
    });
  });
});
