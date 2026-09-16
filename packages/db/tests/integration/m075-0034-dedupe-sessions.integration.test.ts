/**
 * M075 migration 0034 — session dedupe before `uq_sessions_owner_thread`.
 * Runs the extracted SQL block inside a rolled-back transaction so the
 * shared dev DB keeps its index and concurrent tests stay isolated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { ensureDatabase, resolveDirectDatabaseConnectionString } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const START = "-- @m075-dedupe-sessions-block-start";
const END = "-- @m075-dedupe-sessions-block-end";

function extractDedupeBlock(migrationSql: string): string {
  const i0 = migrationSql.indexOf(START);
  const i1 = migrationSql.indexOf(END);
  if (i0 === -1 || i1 === -1 || i1 <= i0) {
    throw new Error("migration 0034 missing dedupe block markers");
  }
  return migrationSql.slice(i0 + START.length, i1).trim();
}

let sql: ReturnType<typeof postgres>;
let dedupeBlock: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  const path = resolve(
    import.meta.dirname,
    "../../src/migrations/0034_m075_per_room_graph_thread.sql",
  );
  dedupeBlock = extractDedupeBlock(readFileSync(path, "utf8"));
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe("M075 / 0034 — dedupe (owner_id, thread_id) before unique index", () => {
  test("merges session_messages into canonical session and removes duplicate rows", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `m075dedupe-${suffix}@test.local`;
    const threadId = `room:m075-dedupe-${suffix}`;
    const fp = `fp-${suffix}`;

    let assertionsOk = false;
    try {
      await sql.begin(async (tx) => {
        await tx`DROP INDEX IF EXISTS uq_sessions_owner_thread`;

        const [u] = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${"m075-dedupe"}, ${email}, ${`m075d${suffix.slice(-8)}`})
          RETURNING id
        `;
        if (!u) throw new Error("user insert");

        const [s1, s2] = await tx<{ id: string }[]>`
          INSERT INTO sessions (thread_id, owner_id, persona_id)
          VALUES
            (${threadId}, ${u.id}, 'owner'),
            (${threadId}, ${u.id}, 'owner')
          RETURNING id
        `;
        if (!s1 || !s2) throw new Error("session insert");

        await tx`
          INSERT INTO session_messages (session_id, role, content, fingerprint)
          VALUES
            (${s1.id}, 'user', 'a', ${fp}),
            (${s2.id}, 'user', 'b', ${fp})
        `;

        await tx.unsafe(dedupeBlock);

        await tx`CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_owner_thread ON sessions (owner_id, thread_id)`;

        const sessionCountRow = await tx<{ c: string }[]>`
          SELECT count(*)::text AS c FROM sessions
          WHERE owner_id = ${u.id} AND thread_id = ${threadId}
        `;
        expect(Number(sessionCountRow[0]?.c)).toBe(1);

        const msgCountRow = await tx<{ c: string }[]>`
          SELECT count(*)::text AS c FROM session_messages sm
          JOIN sessions s ON s.id = sm.session_id
          WHERE s.owner_id = ${u.id} AND s.thread_id = ${threadId}
        `;
        expect(Number(msgCountRow[0]?.c)).toBe(2);

        const fpRows = await tx<{ fp: string | null }[]>`
          SELECT sm.fingerprint AS fp FROM session_messages sm
          JOIN sessions s ON s.id = sm.session_id
          WHERE s.owner_id = ${u.id} AND s.thread_id = ${threadId}
          ORDER BY sm.id
        `;
        expect(fpRows.filter((r) => r.fp === fp).length).toBe(1);
        expect(fpRows.filter((r) => r.fp === null).length).toBe(1);

        assertionsOk = true;
        throw new Error("__m075_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__m075_rollback__");
    }
    expect(assertionsOk).toBe(true);
  });
});
