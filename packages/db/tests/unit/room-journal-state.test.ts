import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createRoomJournalStateInTx,
  reconcileRoomJournalMembershipInTx,
  type RoomJournalMutationTransaction,
} from "../../src/queries/room-journal-state";
import { roomJournalState } from "../../src/schema/room-journal";

function recordingTx() {
  const queries: SQL[] = [];
  const inserts: unknown[] = [];
  const mockDb = drizzle.mock();
  const tx: RoomJournalMutationTransaction = {
    execute: async (query) => {
      queries.push(query);
      return [];
    },
    insert: ((() => ({
      values: (values: unknown) => ({
        onConflictDoNothing: async () => {
          inserts.push(values);
        },
      }),
      select: (query: { getSQL(): SQL }) => ({
        onConflictDoNothing: async () => {
          // Exercise Drizzle's runtime insert-select shape validation. This
          // catches schema additions that TypeScript cannot see through the
          // transaction interface before the startup seed reaches production.
          mockDb.insert(roomJournalState).select(query as never).toSQL();
          queries.push(query.getSQL());
        },
      }),
    })) as unknown) as RoomJournalMutationTransaction["insert"],
    select: mockDb.select.bind(mockDb),
  };
  return { tx, queries, inserts };
}

function render(query: SQL) {
  return new PgDialect().sqlToQuery(query);
}

describe("Room journal mutation transaction ordering", () => {
  test("new Room state locks the Room before inserting empty state", async () => {
    const { tx, queries, inserts } = recordingTx();
    const now = new Date("2026-07-27T12:00:00.000Z");

    await createRoomJournalStateInTx(
      tx,
      "11111111-1111-4111-8111-111111111111",
      now,
    );

    expect(queries).toHaveLength(1);
    expect(render(queries[0]!).sql).toContain("SELECT id");
    expect(render(queries[0]!).sql).toContain("FOR UPDATE");
    expect(inserts).toEqual([{
      roomId: "11111111-1111-4111-8111-111111111111",
      lastProcessedMessageId: 0,
      extractorVersion: "m219-v1",
      suspendedAt: now,
      historicalBackfillStatus: "not_needed",
      createdAt: now,
      updatedAt: now,
    }]);
  });

  test("membership reconciliation deduplicates and locks Rooms in stable id order", async () => {
    const { tx, queries } = recordingTx();
    const laterRoom = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const earlierRoom = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await reconcileRoomJournalMembershipInTx(
      tx,
      [laterRoom, earlierRoom, laterRoom],
      new Date("2026-07-27T12:00:00.000Z"),
    );

    expect(queries).toHaveLength(8);
    const roomLockQueries = [queries[0]!, queries[4]!].map(render);
    expect(roomLockQueries.map((query) => query.params[0])).toEqual([
      earlierRoom,
      laterRoom,
    ]);
    for (const query of roomLockQueries) {
      expect(query.sql).toContain("FROM rooms");
      expect(query.sql).toContain("FOR UPDATE");
    }

    const seedSql = render(queries[1]!).sql.replaceAll(/\s+/g, " ");
    const authorizationWaitColumns = [
      "extraction_authorization_wait_lane",
      "extraction_authorization_waiting_since",
      "compaction_authorization_waiting_since",
    ];
    let priorColumn = -1;
    for (const column of authorizationWaitColumns) {
      const columnIndex = seedSql.indexOf(`null as "${column}"`);
      expect(columnIndex).toBeGreaterThan(priorColumn);
      priorColumn = columnIndex;
    }

    const updateSql = render(queries[3]!).sql.replaceAll(/\s+/g, " ");
    expect(updateSql).toContain("UPDATE room_journal_state");
    expect(updateSql).toContain("rs.kind IN ('task', 'access')");
    expect(updateSql).toContain("lease_token = CASE");
    const renderedQueries = queries.map(render);
    for (const query of renderedQueries) {
      expect(query.params.some((param) => param instanceof Date)).toBe(false);
    }
    expect(
      renderedQueries.some((query) =>
        query.params.includes("2026-07-27T12:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
