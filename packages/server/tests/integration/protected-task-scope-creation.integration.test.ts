import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agentScopes, agents, getSharedDirectDb, __resetSharedDirectDbForTests, eq, sql, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { prepareProtectedTaskScope } from "../../src/routes/protected-task-scope-creation";

let db: ReturnType<typeof getSharedDirectDb>;
beforeAll(() => {
  bootstrapTestDbInstance();
  db = getSharedDirectDb();
});
afterAll(async () => { await __resetSharedDirectDbForTests(); });

test("protected Scope creation preserves ownership and rolls back with its Task transaction", async () => {
  const rollback = new Error("rollback isolated Scope fixture");
  let scopeId: string | undefined;
  try {
    await db.transaction(async transaction => {
      const identity = await transaction.execute(sql`SELECT current_user::text AS role`);
      expect(identity[0]?.["role"]).toBe("nautilo");
      const [owner] = await transaction.insert(users).values({
        name: "Scope fixture", email: `scope-${randomUUID()}@test.local`,
      }).returning();
      const [agent] = await transaction.insert(agents).values({
        handle: `scope-${randomUUID()}`,
      }).returning();
      const input = {
        taskId: randomUUID(), requesterUserId: owner!.id, agentId: agent!.id, scopeId: null,
      };
      scopeId = await prepareProtectedTaskScope(transaction, input);
      const [stored] = await transaction.select().from(agentScopes)
        .where(eq(agentScopes.id, scopeId));
      expect(stored).toMatchObject({
        parentAgentId: agent!.id, speakerUserId: owner!.id,
        name: `task:${input.taskId}`, purpose: null, lifecycleState: "open",
      });
      expect(await prepareProtectedTaskScope(transaction, { ...input, scopeId })).toBe(scopeId);
      expect(await prepareProtectedTaskScope(transaction, {
        ...input, scopeId, requesterUserId: randomUUID(),
      }).catch((error: unknown) => error)).toEqual(new TypeError("Protected Task Scope is unavailable"));
      expect(await prepareProtectedTaskScope(transaction, {
        ...input, scopeId, agentId: randomUUID(),
      }).catch((error: unknown) => error)).toEqual(new TypeError("Protected Task Scope is unavailable"));
      await transaction.update(agentScopes).set({
        lifecycleState: "closing", closeOperationId: `close:${randomUUID()}`,
      }).where(eq(agentScopes.id, scopeId));
      expect(await prepareProtectedTaskScope(transaction, { ...input, scopeId })
        .catch((error: unknown) => error)).toEqual(new TypeError("Protected Task Scope is unavailable"));
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(scopeId).toBeDefined();
  expect(await db.select({ id: agentScopes.id }).from(agentScopes)
    .where(eq(agentScopes.id, scopeId!))).toEqual([]);
});
