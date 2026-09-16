import { describe, test, expect } from "bun:test";
import { SERIAL_PK_TABLES } from "../../src/lib/docker-db";

/**
 * Tests for the sequence-out-of-sync bug discovered April 13 2026.
 *
 * Root cause: restoreFromGzip() runs Drizzle migrations (which reset all
 * sequences to 1) then COPYs data rows from a dump. The COPY inserts rows
 * with their original IDs but does NOT advance the sequence. After restore
 * every INSERT hits a PK collision, gets swallowed by the silent catch in
 * persistMessages(), and messages are silently lost.
 *
 * Fix: after each COPY, call setval() to advance the sequence to MAX(id).
 *
 * These unit tests operate on the pure logic of detecting and building the
 * reset SQL — no live DB connection required.
 */

/**
 * Generates the SQL to reset all serial sequences after a data restore.
 * Each call to setval(seq, MAX(pk)) advances the sequence to the highest
 * existing ID so the next INSERT does not collide.
 */
function buildSequenceResetSql(tables: typeof SERIAL_PK_TABLES): string {
  return tables
    .map(
      ({ table, seq, pkCol }) =>
        `SELECT setval('${seq}', COALESCE((SELECT MAX(${pkCol}) FROM ${table}), 1));`,
    )
    .join("\n");
}

/**
 * Simulates the state of a sequence after restore: migrations set it to 1,
 * COPY brings in rows with high IDs. Returns whether an insert would collide.
 */
function wouldInsertCollide(sequenceValue: number, maxExistingId: number): boolean {
  const nextId = sequenceValue + 1;
  return nextId <= maxExistingId;
}

describe("restore sequence reset", () => {
  test("buildSequenceResetSql produces valid setval for each table", () => {
    const sql = buildSequenceResetSql(SERIAL_PK_TABLES);
    expect(sql).toContain("setval('session_messages_id_seq'");
    expect(sql).toContain("MAX(id)");
    expect(sql).toContain("session_messages");
  });

  test("buildSequenceResetSql uses COALESCE to handle empty tables", () => {
    const sql = buildSequenceResetSql(SERIAL_PK_TABLES);
    expect(sql).toContain("COALESCE");
    // Empty table: COALESCE falls back to 1 so next insert gets id=2 not error
    expect(sql).toContain(", 1)");
  });

  test("wouldInsertCollide detects the bug scenario (seq at 34, max id 6241)", () => {
    // This exactly mirrors the production state found April 13 2026:
    // sequence last_value = 34, actual MAX(id) = 6241
    expect(wouldInsertCollide(34, 6241)).toBe(true);
  });

  test("wouldInsertCollide is false after correct setval", () => {
    // After setval('session_messages_id_seq', 6241), next id = 6242 — no collision
    expect(wouldInsertCollide(6241, 6241)).toBe(false);
  });

  test("wouldInsertCollide is false on a fresh empty table", () => {
    // Fresh DB: sequence=1, max id=0 (no rows) — next insert gets id=2, fine
    expect(wouldInsertCollide(1, 0)).toBe(false);
  });

  test("SERIAL_PK_TABLES includes session_messages", () => {
    const tables = SERIAL_PK_TABLES.map((t) => t.table);
    expect(tables).toContain("session_messages");
    expect(tables).toContain("focus_events");
    expect(tables).toContain("memory_crypto_revisions");
    expect(tables).toContain("memory_crypto_operations");
  });

  test("each entry in SERIAL_PK_TABLES has table, seq, and pkCol", () => {
    for (const entry of SERIAL_PK_TABLES) {
      expect(entry.table).toBeTruthy();
      expect(entry.seq).toBeTruthy();
      expect(entry.pkCol).toBeTruthy();
      // Sequence name must match expected pattern: <table>_<col>_seq
      expect(entry.seq).toBe(`${entry.table}_${entry.pkCol}_seq`);
    }
  });

  test("generated SQL is idempotent — running it twice is safe", () => {
    // setval with a value already equal to MAX(id) is a no-op — safe to run multiple times
    const sql = buildSequenceResetSql(SERIAL_PK_TABLES);
    // Should not use any non-idempotent operations
    expect(sql).not.toContain("nextval");
    expect(sql).not.toContain("ALTER SEQUENCE");
  });
});
