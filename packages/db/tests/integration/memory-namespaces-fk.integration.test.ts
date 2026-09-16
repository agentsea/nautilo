/**
 * M076 — memory_namespaces FK behavior on live Postgres.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  sql,
  users,
  namespaces,
  agents,
  memories,
  memoryNamespaces,
  count,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
});

afterAll(async () => {
  await db.end();
});

describe("memory_namespaces foreign keys (integration)", () => {
  test("deleting a memory row cascades to junction rows", async () => {
    const ts = Date.now().toString(36);
    const [user] = await db
      .insert(users)
      .values({ name: "m076-fk", email: `m076fk-${ts}@test.local` })
      .returning({ id: users.id });
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "test", label: "fk" })
      .returning({ id: namespaces.id });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `m076fk-${ts}` })
      .returning({ id: agents.id });
    if (!user || !ns || !agent) throw new Error("seed");

    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: "fk-cascade",
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");

    await db.insert(memoryNamespaces).values({
      memoryId: mem.id,
      namespaceId: ns.id,
    });

    await db.delete(memories).where(eq(memories.id, mem.id));

    const [row] = await db
      .select({ c: count() })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, mem.id));
    expect(row?.c ?? 0).toBe(0);

    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(users).where(eq(users.id, user.id));
  });

  test("deleting a referenced namespace is rejected (RESTRICT)", async () => {
    const ts = Date.now().toString(36);
    const [user] = await db
      .insert(users)
      .values({ name: "m076-rest", email: `m076rest-${ts}@test.local` })
      .returning({ id: users.id });
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "test", label: "restrict" })
      .returning({ id: namespaces.id });
    const [agent] = await db
      .insert(agents)
      .values({ handle: `m076rest-${ts}` })
      .returning({ id: agents.id });
    if (!user || !ns || !agent) throw new Error("seed");

    const [mem] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: "fk-restrict",
      })
      .returning({ id: memories.id });
    if (!mem) throw new Error("mem");

    await db.insert(memoryNamespaces).values({
      memoryId: mem.id,
      namespaceId: ns.id,
    });

    let threw = false;
    try {
      await db.execute(sql`DELETE FROM namespaces WHERE id = ${ns.id}`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    await db.delete(memories).where(eq(memories.id, mem.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(users).where(eq(users.id, user.id));
  });
});
