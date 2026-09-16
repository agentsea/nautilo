import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  claudeConnections,
  createDirectAgentDb,
  createDirectDb,
  eq,
  getOrCreateClaudeConnectionWith,
  saveClaudeConnectionObservationWith,
  selectClaudeConnectionModelWith,
  setClaudeConnectionEnabledWith,
  sql,
  users,
} from "@nautilo/db";
import { ensureDatabase } from "../../src/utils/ensure-database";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;
type AgentDb = ReturnType<typeof createDirectAgentDb>;
let db!: Db;
let agentDb!: AgentDb;
let agentRoleAvailable = false;
let ownerId!: string;
let otherId!: string;

const complete = {
  runtime: { state: "ready" as const, version: "2.1.235", executionQualified: true },
  account: { state: "connected" as const, credentialsAvailable: true as const },
  catalog: { state: "complete" as const, complete: true as const, models: [{ id: "provider-fable", resolvedModel: "claude-fable-5", displayName: "Fable", description: "Frontier" }] },
};

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  agentDb = createDirectAgentDb(2);
  try {
    await agentDb.execute(sql`SELECT 1`);
    agentRoleAvailable = true;
  } catch {
    // Some local test-cruft instances intentionally omit the runtime-role
    // password. The ownership test below remains live wherever that role is
    // provisioned; migration/unit checks still pin the policy otherwise.
  }
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = await db.insert(users).values([
    { name: "Claude owner", email: `claude-owner-${suffix}@test.local` },
    { name: "Claude other", email: `claude-other-${suffix}@test.local` },
  ]).returning({ id: users.id });
  if (!created[0] || !created[1]) throw new Error("Claude Connection fixture creation failed");
  ownerId = created[0].id;
  otherId = created[1].id;
});

afterAll(async () => {
  if (!db) return;
  await db.delete(claudeConnections).where(eq(claudeConnections.userId, ownerId));
  await db.delete(claudeConnections).where(eq(claudeConnections.userId, otherId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherId));
  await db.end();
  await agentDb.end();
});

describe("Claude Connection durable owner state", () => {
  test("retains preferences through incomplete observations, clears only on complete omission, and fences stale selections", async () => {
    const created = await getOrCreateClaudeConnectionWith(db, { userId: ownerId });
    const repeated = await getOrCreateClaudeConnectionWith(db, { userId: ownerId });
    expect(repeated.profileRef).toBe(created.profileRef);
    expect(created.enabled).toBe(false);

    const observed = await saveClaudeConnectionObservationWith(db, { userId: ownerId }, complete);
    expect(observed?.observationRevision).toBe(1);
    const selected = await selectClaudeConnectionModelWith(db, { userId: ownerId }, { model: "claude-fable-5", expectedObservationRevision: 1 });
    expect(selected?.selectedModel).toBe("claude-fable-5");
    expect((await setClaudeConnectionEnabledWith(db, { userId: ownerId }, true))?.enabled).toBe(true);

    const incomplete = await saveClaudeConnectionObservationWith(db, { userId: ownerId }, {
      ...complete,
      catalog: { state: "incomplete", complete: false, models: [] },
    });
    expect(incomplete?.selectedModel).toBe("claude-fable-5");
    expect(await selectClaudeConnectionModelWith(db, { userId: ownerId }, { model: "claude-fable-5", expectedObservationRevision: 1 })).toBeUndefined();

    const omitted = await saveClaudeConnectionObservationWith(db, { userId: ownerId }, {
      ...complete,
      catalog: { state: "complete", complete: true, models: [] },
    });
    expect(omitted?.selectedModel).toBeNull();
  });

  test("forced RLS admits only the current owner", async () => {
    if (!agentRoleAvailable) return;
    await getOrCreateClaudeConnectionWith(db, { userId: otherId });
    await agentDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${ownerId}, true)`);
      expect((await tx.select().from(claudeConnections)).map((row) => row.userId)).toEqual([ownerId]);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${otherId}, true)`);
      expect((await tx.select().from(claudeConnections)).map((row) => row.userId)).toEqual([otherId]);
    });
  });
});
