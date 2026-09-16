/**
 * M077 — migration 0034 rewrites `rooms` / `sessions` / `jobs` off `app:default`
 * when a legacy room row exists (ISSUE-M077 §1.5). Runs inside a rolled-back
 * transaction so CI/dev DB state is unchanged.
 *
 * TODO(M077 §1.5 follow-up): extend this harness with `jobs` / `langchain.*`
 * `thread_id` rewrites and `to_regclass` guard coverage (ISSUE-M077-followups).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { ensureDatabase, resolveDirectDatabaseConnectionString } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";


function stripTransactionWrapper(sqlText: string): string {
  let s = sqlText.trim();
  if (s.startsWith("BEGIN;")) s = s.slice("BEGIN;".length).trim();
  if (s.endsWith("COMMIT;")) s = s.slice(0, -"COMMIT;".length).trim();
  return s;
}

let sql: ReturnType<typeof postgres>;
let migrationBody: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  const path = resolve(
    import.meta.dirname,
    "../../src/migrations/0034_m075_per_room_graph_thread.sql",
  );
  migrationBody = stripTransactionWrapper(readFileSync(path, "utf8"));
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe("M075 / migration 0034 — room + session thread rewrite (rollback)", () => {
  test("rewrites graph_thread_id and session thread_id; dedupes colliding sessions", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const email1 = `m34a-${suffix}@test.local`;
    const email2 = `m34b-${suffix}@test.local`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        await tx`DROP INDEX IF EXISTS uq_sessions_owner_thread`;

        const [u1] = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${"m34-u1"}, ${email1}, ${`m34a${suffix.slice(-8)}`})
          RETURNING id
        `;
        const [u2] = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${"m34-u2"}, ${email2}, ${`m34b${suffix.slice(-8)}`})
          RETURNING id
        `;
        if (!u1 || !u2) throw new Error("users");

        const [ns] = await tx<{ id: string }[]>`
          INSERT INTO namespaces (scope, label) VALUES ('private', ${"m34-ns"})
          RETURNING id
        `;
        if (!ns) throw new Error("ns");

        const [room] = await tx<{ id: string }[]>`
          INSERT INTO rooms (owner_id, type, label, graph_thread_id, namespace_id, human_actor_ids)
          VALUES (${u1.id}, 'private', 'legacy', 'app:default', ${ns.id}, ARRAY[]::uuid[])
          RETURNING id
        `;
        if (!room) throw new Error("room");

        await tx`
          INSERT INTO sessions (thread_id, owner_id, persona_id, room_id)
          VALUES
            ('app:default', ${u1.id}, 'owner', ${room.id}),
            ('app:default', ${u2.id}, 'owner', ${room.id})
        `;

        await tx.unsafe(migrationBody);

        await tx`CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_owner_thread ON sessions (owner_id, thread_id)`;

        const [rrow] = await tx<{ graph_thread_id: string }[]>`
          SELECT graph_thread_id FROM rooms WHERE id = ${room.id}
        `;
        expect(rrow?.graph_thread_id).toBe(`room:${room.id}`);

        const srows = await tx<{ owner_id: string; thread_id: string }[]>`
          SELECT owner_id, thread_id FROM sessions
          WHERE room_id = ${room.id}::uuid
          ORDER BY owner_id
        `;
        const expectedThread = `room:${room.id}`;
        expect(srows.length).toBe(2);
        expect(srows.every((r) => r.thread_id === expectedThread)).toBe(true);

        ok = true;
        throw new Error("__m34_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__m34_rollback__");
    }
    expect(ok).toBe(true);
  });
});
