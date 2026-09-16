import { describe, expect, test } from "bun:test";
import {
  roomJournalBatches,
  roomJournalState,
  type SQL,
} from "@nautilo/db";
import {
  failCompaction,
  failExtraction,
} from "../../src/stenographer/repository";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";

function failureDb(lockedState: Record<string, unknown>) {
  const updates: Array<{
    table: unknown;
    values: Record<string, unknown>;
  }> = [];
  let executeCount = 0;
  const tx = {
    execute: async (_query: SQL) => {
      executeCount += 1;
      return executeCount === 2 ? [lockedState] : [];
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
          return [];
        },
      }),
    }),
  };
  return {
    db: {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    },
    updates,
  };
}

describe("Stenographer failure transitions", () => {
  test("fails an extraction batch and schedules the next typed retry atomically", async () => {
    const state = failureDb({ extraction_failure_count: 1 });

    await failExtraction({
      claim: {
        batchId: BATCH_ID,
        roomId: ROOM_ID,
        leaseToken: LEASE_TOKEN,
      } as never,
      errorCode: "provider",
      modelId: "model-a",
      now: NOW,
      db: state.db as never,
    });

    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]?.table).toBe(roomJournalBatches);
    expect(state.updates[0]?.values["status"]).toBe("failed");
    expect(state.updates[0]?.values["errorCode"]).toBe("provider");
    expect(state.updates[0]?.values["lastErrorAt"]).toBe(NOW);
    expect(state.updates[1]?.table).toBe(roomJournalState);
    expect(state.updates[1]?.values["extractionFailureCount"]).toBe(2);
    expect(state.updates[1]?.values["extractionRetryAfter"]).toEqual(
      new Date("2026-08-17T12:00:30.000Z"),
    );
  });

  test("fails a compaction claim and preserves its typed attempt metadata", async () => {
    const state = failureDb({ compaction_failure_count: 0 });

    await failCompaction({
      claim: {
        roomId: ROOM_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 4,
      } as never,
      errorCode: "timeout",
      modelId: "model-b",
      now: NOW,
      db: state.db as never,
    });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.table).toBe(roomJournalState);
    expect(state.updates[0]?.values["compactionFailureCount"]).toBe(1);
    expect(state.updates[0]?.values["compactionRetryAfter"]).toEqual(
      new Date("2026-08-17T12:00:15.000Z"),
    );
    expect(state.updates[0]?.values["lastCompactionErrorAttempt"]).toBe(4);
    expect(state.updates[0]?.values["lastCompactionErrorModelId"]).toBe(
      "model-b",
    );
  });
});
