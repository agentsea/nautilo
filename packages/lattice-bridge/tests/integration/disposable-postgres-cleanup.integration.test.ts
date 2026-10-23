import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { agentCryptoRuntimeStates, agents, cryptoObjects, namespaces, rooms, tasks, users } from "@nautilo/db";
import { readDisposableCleanupUrls, withDisposableFixtureCleanup } from "../../scripts/disposable-postgres-cleanup";
import { verifyDisposablePostgresAuthority } from "../../scripts/disposable-postgres-reset";

const urls = readDisposableCleanupUrls();
let admin: postgres.Sql;

beforeAll(() => {
  verifyDisposablePostgresAuthority(urls);
  admin = postgres(urls.admin, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (admin) await admin.end(); });

async function aclSnapshot() {
  return await admin`
    SELECT relation.relname, relation.relacl::text, relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
     WHERE relation.oid IN ('public.agent_crypto_runtime_signers'::regclass,
       'public.protected_task_wake_continuation_receipts'::regclass,
       'public.task_cancellation_crypto_staging_receipts'::regclass,
       'public.task_terminal_message_crypto_staging_receipts'::regclass,
       'public.task_historical_content_crypto_staging_receipts'::regclass,
       'public.foreground_memory_crypto_publication_receipts'::regclass)
     ORDER BY relation.relname
  `;
}

test("administrative fixture cleanup preserves restricted receipt ACLs and RLS", async () => {
  const db = drizzle(admin);
  const [user] = await db.insert(users).values({ name: "Cleanup regression" }).returning();
  const [namespace] = await db.insert(namespaces).values({ scope: "room", label: "Cleanup regression" }).returning();
  const [room] = await db.insert(rooms).values({ ownerId: user!.id, namespaceId: namespace!.id,
    type: "private", label: "Cleanup regression", graphThreadId: `cleanup:${randomUUID()}` }).returning();
  const objectId = `cleanup:${randomUUID()}`;
  await db.insert(cryptoObjects).values({ objectId, payloadHash: Buffer.alloc(32), payloadBytes: Buffer.from([1]) });
  const [agent] = await db.insert(agents).values({ handle: `cleanup-${randomUUID()}` }).returning();
  const [task] = await db.insert(tasks).values({ ownerId: user!.id, requestorId: user!.id,
    agentId: agent!.id, prompt: "Cleanup regression" }).returning();
  await db.insert(agentCryptoRuntimeStates).values({ agentId: agent!.id,
    authorizationRevision: 1, runtimeGeneration: 0, configObjectCount: 1,
    configInventoryDigest: Buffer.alloc(32) });
  const before = await aclSnapshot();
  const runtimeFailure = await db.delete(agentCryptoRuntimeStates)
    .where(eq(agentCryptoRuntimeStates.agentId, agent!.id)).catch((error: unknown) => error);
  expect(runtimeFailure).toBeInstanceOf(Error);
  const taskFailure = await db.delete(tasks).where(eq(tasks.id, task!.id)).catch((error: unknown) => error);
  expect(taskFailure).toBeInstanceOf(Error);
  const originalFailure = await db.delete(rooms).where(eq(rooms.id, room!.id)).catch((error: unknown) => error);
  expect(originalFailure).toBeInstanceOf(Error);
  const cryptoFailure = await db.delete(cryptoObjects).where(eq(cryptoObjects.objectId, objectId)).catch((error: unknown) => error);
  expect(cryptoFailure).toBeInstanceOf(Error);
  await withDisposableFixtureCleanup(admin, async transaction => {
    const observer = postgres(urls.app, { max: 1 });
    try {
      const [visible] = await observer<{ allowed: boolean }[]>`
        SELECT has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'UPDATE') AS allowed
      `;
      expect(visible?.allowed).toBe(false);
    } finally {
      await observer.end();
    }
    const cleanup = drizzle(transaction);
    await cleanup.delete(tasks).where(eq(tasks.id, task!.id));
    await cleanup.delete(agentCryptoRuntimeStates).where(eq(agentCryptoRuntimeStates.agentId, agent!.id));
    await cleanup.delete(agents).where(eq(agents.id, agent!.id));
    await cleanup.delete(rooms).where(eq(rooms.id, room!.id));
    await cleanup.delete(namespaces).where(eq(namespaces.id, namespace!.id));
    await cleanup.delete(users).where(eq(users.id, user!.id));
    await cleanup.delete(cryptoObjects).where(eq(cryptoObjects.objectId, objectId));
  });
  expect(await aclSnapshot()).toEqual(before);
  expect(await db.select().from(tasks).where(eq(tasks.id, task!.id))).toHaveLength(0);
  expect(await db.select().from(rooms).where(eq(rooms.id, room!.id))).toHaveLength(0);
  expect(await db.select().from(cryptoObjects).where(eq(cryptoObjects.objectId, objectId))).toHaveLength(0);
});

test("cleanup failure rolls back both ACL changes and fixture deletion", async () => {
  const db = drizzle(admin);
  const [user] = await db.insert(users).values({ name: "Cleanup rollback" }).returning();
  const before = await aclSnapshot();
  const failure = new Error("injected cleanup failure");
  const error = await withDisposableFixtureCleanup(admin, async transaction => {
    await drizzle(transaction).delete(users).where(eq(users.id, user!.id));
    throw failure;
  }).catch((caught: unknown) => caught);
  expect(error).toBe(failure);
  expect(await aclSnapshot()).toEqual(before);
  expect(await db.select().from(users).where(eq(users.id, user!.id))).toHaveLength(1);
  await db.delete(users).where(eq(users.id, user!.id));
});
