import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase, SQL } from "@nautilo/db";
import {
  reconcileMemoryReviewTurnCheckpoint,
  recoveredMemoryReviewTurnState,
  type MemoryReviewCheckpointReconciliationRow,
} from "../../src/memory-review/startup-recovery";

const row: MemoryReviewCheckpointReconciliationRow = {
  id: "review-turn",
  checkpointThreadId: "mainline-checkpoint",
  turnId: "reviewed-turn",
  updatedAt: new Date("2026-11-26T08:00:00.000Z"),
};
const interrupt = (turnId: string) => ({
  checkpoint: { channel_values: { turnId } },
  pendingWrites: [["task", "__interrupt__", [{ value: "approval" }]]],
});

function database(returned: readonly { id: string }[] = [{ id: row.id }]) {
  const writes: Array<{ values: Record<string, unknown>; predicate: SQL }> = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: SQL) => ({
          returning: async () => {
            writes.push({ values, predicate });
            return returned;
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as DirectDatabase, writes };
}

describe("Memory Review checkpoint reconciliation", () => {
  test("only the exact turn's non-empty interrupt remains awaiting", () => {
    expect(recoveredMemoryReviewTurnState(row.turnId, interrupt(row.turnId)))
      .toBe("awaiting");
    expect(recoveredMemoryReviewTurnState(row.turnId, interrupt("newer-mainline-turn")))
      .toBe("interrupted");
    expect(recoveredMemoryReviewTurnState(row.turnId, {
      checkpoint: { channel_values: { turnId: row.turnId } },
      pendingWrites: [],
    })).toBe("interrupted");
  });

  test("active execution is fenced both before and after the checkpoint read", async () => {
    for (const activeChecks of [[true], [false, true]]) {
      const { db, writes } = database();
      let reads = 0;
      let checks = 0;
      expect(await reconcileMemoryReviewTurnCheckpoint({
        db,
        row,
        isTurnActive: () => activeChecks[checks++] ?? false,
        readCheckpoint: async () => {
          reads++;
          return interrupt(row.turnId);
        },
      })).toBe("active");
      expect(reads).toBe(activeChecks[0] ? 0 : 1);
      expect(writes).toHaveLength(0);
    }
  });

  test("a matching interrupt is preserved through the exact row-version CAS", async () => {
    const { db, writes } = database();
    const now = new Date("2026-11-26T09:00:00.000Z");
    expect(await reconcileMemoryReviewTurnCheckpoint({
      db,
      row,
      isTurnActive: () => false,
      readCheckpoint: async () => interrupt(row.turnId),
      now,
    })).toBe("changed");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.values).toMatchObject({ state: "awaiting", updatedAt: now });
    const query = new PgDialect().sqlToQuery(writes[0]!.predicate);
    expect(query.sql).toContain('"updated_at" =');
    expect(query.sql).toContain('"receipt_id" is null');
    expect(query.params).toContain(row.updatedAt.toISOString());
  });

  test("a changed row loses the CAS without reporting a recovery", async () => {
    const { db, writes } = database([]);
    expect(await reconcileMemoryReviewTurnCheckpoint({
      db,
      row,
      isTurnActive: () => false,
      readCheckpoint: async () => interrupt("newer-mainline-turn"),
    })).toBe("unchanged");
    expect(writes[0]?.values).toMatchObject({ state: "interrupted" });
  });

  test("checkpoint failure propagates without touching the durable row", async () => {
    const { db, writes } = database();
    const failure = new Error("checkpoint unavailable");
    let caught: unknown;
    try {
      await reconcileMemoryReviewTurnCheckpoint({
        db,
        row,
        isTurnActive: () => false,
        readCheckpoint: async () => { throw failure; },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(writes).toHaveLength(0);
  });
});
