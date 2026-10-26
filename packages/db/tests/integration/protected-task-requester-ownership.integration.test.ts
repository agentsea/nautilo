import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDirectDb, sql } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;
const migrationDirectory = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
const migrations = readdirSync(migrationDirectory)
  .filter(name => name.endsWith(".sql"))
  .map(name => readFileSync(`${migrationDirectory}/${name}`, "utf8"))
  .filter(text => text.includes('ADD CONSTRAINT "tasks_protected_requester_owns_content"'));
if (migrations.length !== 1) throw new Error("Expected one requester ownership migration");
const statements = migrations[0]!.split("--> statement-breakpoint").filter(text => text.trim());

beforeAll(() => {
  if (process.env["NAUTILO_INSTANCE_ID"] === "epsilon") {
    throw new Error("Ownership migration tests require a disposable instance");
  }
  bootstrapTestDbInstance();
  db = createDirectDb(1);
});
afterAll(async () => { await db.end(); });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Transaction-local old-schema fixtures shadow the public tables. Execute the
// actual generated migration without dropping production constraints or rows.
async function fixture(tx: Tx) {
  await tx.execute(sql`CREATE TEMP TABLE tasks (
    id text PRIMARY KEY, owner_id text NOT NULL, requestor_id text NOT NULL,
    content_representation text NOT NULL, content_namespace_id text,
    content_revision integer, crypto_object_id text,
    crypto_required_namespace_fingerprint bytea, status text, prompt text
  ) ON COMMIT DROP`);
  await tx.execute(sql`CREATE TEMP TABLE actors (
    id text PRIMARY KEY, kind text, owner_id text
  ) ON COMMIT DROP`);
  await tx.execute(sql`CREATE TEMP TABLE task_definition_crypto_revisions (
    task_id text, content_namespace_id text, content_revision integer,
    crypto_object_id text, required_namespace_fingerprint bytea,
    representation text, completion text, disposition text, requester_human_id text
  ) ON COMMIT DROP`);
  await tx.execute(sql`INSERT INTO actors VALUES
    ('alice-actor', 'user', 'alice'), ('bob-actor', 'user', 'bob')`);
}

async function seed(tx: Tx, id: string, representation: string, status = "cancelled") {
  await tx.execute(sql`INSERT INTO tasks VALUES (
    ${id}, 'bob', 'alice', ${representation}, 'alice-private', 1,
    ${`object:${id}`}, decode('aabb', 'hex'), ${status}, 'retained content'
  )`);
  await tx.execute(sql`INSERT INTO task_definition_crypto_revisions VALUES (
    ${id}, 'alice-private', 1, ${`object:${id}`}, decode('aabb', 'hex'),
    ${representation}, 'complete', 'mapped', 'alice-actor'
  )`);
}

async function migrate(tx: Tx) {
  for (const statement of statements) await tx.execute(sql.raw(statement));
}

test("repairs requester-bound protected owners while preserving Plain ownership and lifecycle", async () => {
  await db.transaction(async tx => {
    await fixture(tx);
    await seed(tx, "plain", "ordinary");
    await seed(tx, "shadow", "dual", "running");
    await seed(tx, "full", "protected");
    const before = await tx.execute(sql`SELECT * FROM tasks ORDER BY id`);
    await migrate(tx);
    const after = await tx.execute(sql`SELECT * FROM tasks ORDER BY id`);
    expect([...after]).toEqual(before.map(row => ({
      ...row, owner_id: row["content_representation"] === "ordinary" ? "bob" : "alice",
    })));
  });
});

test.each([
  "wrong_human", "wrong_namespace", "wrong_object", "wrong_fingerprint",
  "wrong_representation", "incomplete", "unmapped", "missing_revision",
] as const)("refuses an ownership rewrite without exact current requester custody: %s", async mismatch => {
  const error = await db.transaction(async tx => {
    await fixture(tx);
    await seed(tx, "candidate", "dual");
    if (mismatch === "wrong_human") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET requester_human_id = 'bob-actor'`);
    if (mismatch === "wrong_namespace") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET content_namespace_id = 'other'`);
    if (mismatch === "wrong_object") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET crypto_object_id = 'other'`);
    if (mismatch === "wrong_fingerprint") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET required_namespace_fingerprint = decode('ccdd', 'hex')`);
    if (mismatch === "wrong_representation") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET representation = 'protected'`);
    if (mismatch === "incomplete") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET completion = 'pending'`);
    if (mismatch === "unmapped") await tx.execute(sql`UPDATE task_definition_crypto_revisions SET disposition = 'active'`);
    if (mismatch === "missing_revision") await tx.execute(sql`DELETE FROM task_definition_crypto_revisions`);
    await migrate(tx);
  }).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Protected Task ownership repair requires verified requester-bound content");
});

test("the new constraint allows Plain divergence but rejects new protected divergence", async () => {
  await db.transaction(async tx => {
    await fixture(tx);
    await migrate(tx);
    await seed(tx, "plain", "ordinary");
  });
  const error = await db.transaction(async tx => {
    await fixture(tx);
    await migrate(tx);
    await seed(tx, "protected", "protected");
  }).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toMatchObject({
    code: "23514", constraint_name: "tasks_protected_requester_owns_content",
  });
});
