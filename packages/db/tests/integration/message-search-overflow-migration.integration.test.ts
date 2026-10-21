import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";

// Explicit disposable PostgreSQL cluster; never resolves the operator's instance.
const adminUrl = process.env["NAUTILO_MESSAGE_SEARCH_TEST_ADMIN_URL"];
const suite = adminUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "");
const database = `search_overflow_${suffix}`;
const role = `search_writer_${suffix}`;
let admin: Sql;
let db: Sql;
let writer: Sql;
let databaseCreated = false;
let roleCreated = false;
const body = "startneedle " + Array.from({ length: 65_000 }, (_, i) =>
  createHash("md5").update(String(i)).digest("hex")).join(" ") + " endneedle";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const migration = readFileSync(new URL("../../src/migrations/0361_melodic_gamma_corps.sql", import.meta.url), "utf8");

async function expectFailure(operation: PromiseLike<unknown>, expected: { code?: string; message?: string }): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toMatchObject(expected);
}

suite("complete message saves across search-vector overflow", () => {
  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    await admin.unsafe(`CREATE ROLE ${role} LOGIN`);
    roleCreated = true;
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    db = postgres(url.toString(), { max: 1 });
    // Minimal predecessor table exercises the actual generated migration.
    await db`CREATE TABLE session_messages (
      id serial PRIMARY KEY, session_id uuid, content text,
      content_search tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
      CHECK (content IS DISTINCT FROM 'rejected by unrelated constraint')
    )`;
    await db`CREATE INDEX ordinary_search ON session_messages USING gin(content_search)`;
    await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON session_messages TO ${role}`);
    await db.unsafe(`GRANT USAGE ON SEQUENCE session_messages_id_seq TO ${role}`);
    // SET ROLE works without assuming a password/authentication policy for the test cluster.
    writer = postgres(url.toString(), { max: 1 });
    await writer.unsafe(`SET ROLE ${role}`);
  });

  afterAll(async () => {
    await writer?.end();
    await db?.end();
    if (databaseCreated) await admin.unsafe(`DROP DATABASE ${database}`);
    if (roleCreated) await admin.unsafe(`DROP ROLE ${role}`);
    await admin?.end();
  });

  test("reproduces the error, preserves existing index values, and survives rollback/reapply", async () => {
    await expectFailure(db`INSERT INTO session_messages(content) VALUES (${body})`, { code: "54000" });
    await writer`INSERT INTO session_messages(content) VALUES ('running ordinary history')`;
    const [before] = await db<{ vector: string }[]>`SELECT content_search::text AS vector FROM session_messages`;
    await expectFailure(db.begin(async (tx) => {
      await tx.unsafe(migration);
      throw new Error("rollback rehearsal");
    }), { message: "rollback rehearsal" });
    const [generation] = await db<{ attgenerated: string }[]>`SELECT attgenerated FROM pg_attribute
      WHERE attrelid = 'session_messages'::regclass AND attname = 'content_search'`;
    expect(generation!.attgenerated).toBe("s");
    await db.begin(async (tx) => { await tx.unsafe(migration); });
    const [after] = await db<{ vector: string }[]>`SELECT content_search::text AS vector FROM session_messages`;
    expect(after!.vector).toBe(before!.vector);
  });

  test("a runtime-role transaction saves before, overflow, and after with exact source bytes", async () => {
    await writer.begin(async (tx) => {
      await tx`INSERT INTO session_messages(content) VALUES ('before ordinary')`;
      await tx`INSERT INTO session_messages(content) VALUES (${body})`;
      await tx`INSERT INTO session_messages(content) VALUES ('after ordinary')`;
    });
    const rows = await db<{ content: string; vector: string | null }[]>`SELECT content, content_search::text AS vector FROM session_messages ORDER BY id`;
    expect(rows).toHaveLength(4);
    expect(digest(rows[2]!.content)).toBe(digest(body));
    expect(rows[2]!.vector).toBeNull();
    expect(rows[3]!.vector).not.toBeNull();
    const hits = await db`SELECT id FROM session_messages WHERE content_search @@ plainto_tsquery('english', 'runs')`;
    expect(hits).toHaveLength(1);
  });

  test("updates, vector tampering, null content, delete and unrelated failures remain correct", async () => {
    await writer`UPDATE session_messages SET content = 'small edited text' WHERE content_search IS NULL`;
    expect((await db`SELECT id FROM session_messages WHERE content_search IS NULL`)).toHaveLength(0);
    await writer`UPDATE session_messages SET content = ${body} WHERE content = 'small edited text'`;
    await writer`UPDATE session_messages SET content_search = to_tsvector('english', 'forged') WHERE content_search IS NULL`;
    expect((await db`SELECT id FROM session_messages WHERE content_search IS NULL`)).toHaveLength(1);
    await writer`UPDATE session_messages SET content = NULL WHERE content_search IS NULL`;
    const [hidden] = await db<{ content: null; content_search: null }[]>`SELECT content, content_search FROM session_messages WHERE content IS NULL`;
    expect(hidden!.content_search).toBeNull();
    await writer`DELETE FROM session_messages WHERE content IS NULL`;
    await expectFailure(writer`INSERT INTO session_messages(content) VALUES ('rejected by unrelated constraint')`, { code: "23514" });
  });
});
