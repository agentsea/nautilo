import { describe, expect, test } from "bun:test";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";

import {
  PostgresProtectedJournalRebuildRepository,
  PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH,
} from "../../src/stenographer/protected-journal-rebuild-repository";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-04T12:00:00.000Z");

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: ConversationProductPostgresScalar[][] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: Array<readonly unknown[] | Error>;

  constructor(results: readonly (readonly unknown[] | Error)[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.parameters.push([...parameters]);
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result as readonly Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

async function setup(results: readonly (readonly unknown[] | Error)[]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...results,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresProtectedJournalRebuildRepository(handle),
  };
}

describe("protected journal rebuild repository", () => {
  test("invalidates one bounded page and returns exact objects still needing crypto tombstones", async () => {
    const { connection, repository } = await setup([
      [{
        rebuild_generation: 4,
        rebuild_requested_at: NOW,
      }],
      [
        { publication_id: "publication-precrypto", state: "superseded" },
        { publication_id: "publication-crypto", state: "tombstone_pending" },
      ],
      [{ publication_id: "publication-crypto" }],
      [{ publication_id: "publication-more" }],
    ]);

    const prepared = await repository.prepare({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    });
    expect(prepared).toEqual({
      status: "cleanup_pending",
      publicationIdsNeedingTombstone: ["publication-crypto"],
      hasMoreInvalidationWork: true,
    });

    expect(connection.isolationLevels).toEqual(["serializable"]);
    const invalidation = connection.statements.find((statement) =>
      statement.includes("WITH targets AS")
    );
    expect(invalidation).toContain("LIMIT $3");
    expect(invalidation).toContain(
      "WHEN publication.crypto_committed_at IS NULL",
    );
    expect(invalidation).toContain("THEN 'superseded'");
    expect(invalidation).toContain("ELSE 'tombstone_pending'");
    expect(normalizedSql(invalidation ?? ""))
      .not.toContain("delete from room_journal_batches");
    expect(connection.parameters.some((parameters) =>
      parameters.includes(PROTECTED_JOURNAL_REBUILD_CLEANUP_BATCH)
    )).toBe(true);
  });

  test("does not clean product rows until every old crypto publication is terminal", async () => {
    const { connection, repository } = await setup([
      [{
        rebuild_generation: 4,
        rebuild_requested_at: NOW,
      }],
      [{ publication_id: "publication-pending" }],
    ]);

    const finalized = await repository.finalize({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    });
    expect(finalized).toEqual({ status: "cleanup_pending" });

    expect(connection.statements.some((statement) =>
      normalizedSql(statement).includes("delete from room_events")
    )).toBe(false);
    expect(connection.statements.some((statement) =>
      normalizedSql(statement).includes("delete from room_journal_batches")
    )).toBe(false);
  });

  test("refuses broad cleanup when current-generation publications already exist", async () => {
    const currentReceipt = await setup([
      [{
        rebuild_generation: 4,
        rebuild_requested_at: NOW,
      }],
      [],
      [{ publication_id: "publication-current" }],
    ]);

    expect(await currentReceipt.repository.finalize({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    })).toEqual({ status: "cleanup_pending" });
    expect(currentReceipt.connection.statements.some((statement) =>
      normalizedSql(statement).includes("delete from room_events")
    )).toBe(false);
  });

  test("deletes mappings then terminal receipts then batches and resets the rebuild cursor atomically", async () => {
    const { connection, repository } = await setup([
      [{
        rebuild_generation: 4,
        rebuild_requested_at: NOW,
      }],
      [],
      [],
      [{ joined_at: NOW }],
      [{ start_cursor: 12, target_cursor: 44 }],
      [],
      [],
      [],
      [],
      [{ room_id: ROOM_ID }],
    ]);

    const finalized = await repository.finalize({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    });
    expect(finalized).toEqual({
      status: "prepared",
      startCursor: 12,
      targetCursor: 44,
    });

    expect(connection.isolationLevels).toEqual(["serializable"]);
    const bounds = connection.statements.find((statement) =>
      normalizedSql(statement).includes("start_cursor")
    );
    expect(normalizedSql(bounds ?? ""))
      .toContain("max(case when session_messages.created_at");
    expect(normalizedSql(bounds ?? ""))
      .toContain("then session_messages.id");
    const rollups = connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("delete from room_event_rollups")
    );
    const events = connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("delete from room_events")
    );
    const receipts = connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("delete from room_journal_crypto_publications")
    );
    const batches = connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("delete from room_journal_batches")
    );
    const state = connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("update room_journal_state")
    );
    expect(rollups).toBeGreaterThan(-1);
    expect(events).toBeGreaterThan(rollups);
    expect(receipts).toBeGreaterThan(events);
    expect(batches).toBeGreaterThan(receipts);
    expect(state).toBeGreaterThan(batches);
    expect(normalizedSql(connection.statements[state] ?? ""))
      .toContain("rebuild_target_message_id");
    expect(connection.parameters[state]).toContain(44);
  });

  test("clears a rebuild with no replay range and fails closed on stale generation", async () => {
    const completed = await setup([
      [{
        rebuild_generation: 4,
        rebuild_requested_at: NOW,
      }],
      [],
      [],
      [{ joined_at: NOW }],
      [{ start_cursor: 12, target_cursor: 12 }],
      [],
      [],
      [],
      [],
      [{ room_id: ROOM_ID }],
    ]);
    const completedResult = await completed.repository.finalize({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    });
    expect(completedResult).toEqual({
      status: "completed",
      startCursor: 12,
      targetCursor: 12,
    });

    const stale = await setup([
      [{
        rebuild_generation: 5,
        rebuild_requested_at: NOW,
      }],
    ]);
    const staleResult = await stale.repository.prepare({
      roomId: ROOM_ID,
      rebuildGeneration: 4,
      now: NOW,
    });
    expect(staleResult).toEqual({ status: "stale" });
    expect(stale.connection.statements).toHaveLength(2);
  });
});
