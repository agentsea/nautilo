/**
 * D453 task 2.1 — live Postgres contract for the safe Codex persistence
 * substrate.  These tests deliberately use the direct DB owner: FORCE ROW
 * LEVEL SECURITY means the policies still apply once the transaction's
 * `app.current_user_id` is set, which lets the test prove the same fail-closed
 * behavior the runtime role receives without assuming that role is present in
 * every developer database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  codexAccountProfiles,
  codexThreadBindings,
  createDirectAgentDb,
  createDirectDb,
  ensureDatabase,
  eq,
  jobs,
  namespaces,
  roomMembers,
  rooms,
  sql,
  tasks,
  taskRuns,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;
type RuntimeDb = ReturnType<typeof createDirectAgentDb>;

let db: Db;
let runtimeDb: RuntimeDb;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
  runtimeDb = createDirectAgentDb(3);
});

afterAll(async () => {
  if (db) await db.end();
  if (runtimeDb) await runtimeDb.end();
});

async function asUser<T>(
  userId: string,
  callback: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return callback(tx as unknown as Db);
  });
}

async function asRuntimeContext<T>(
  userId: string,
  agentId: string | undefined,
  callback: (tx: RuntimeDb) => Promise<T>,
): Promise<T> {
  return runtimeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    if (agentId) {
      await tx.execute(sql`SELECT set_config('app.current_agent_id', ${agentId}, true)`);
    }
    return callback(tx as unknown as RuntimeDb);
  });
}

async function expectRejected(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected database operation to reject");
}

async function seedBindingFixture(tag: string) {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [owner] = await db
    .insert(users)
    .values({ name: `d453-owner-${tag}`, email: `d453-${tag}-${token}@test.local` })
    .returning({ id: users.id });
  const [other] = await db
    .insert(users)
    .values({ name: `d453-other-${tag}`, email: `d453-other-${tag}-${token}@test.local` })
    .returning({ id: users.id });
  const [agent] = await db
    .insert(agents)
    .values({ handle: `d453-agent-${tag}-${token}` })
    .returning({ id: agents.id });
  if (!owner || !other || !agent) throw new Error("D453 fixture identities failed");

  const [ownerActor] = await db
    .insert(actors)
    .values({ ownerId: owner.id, displayName: `owner-${tag}`, kind: "user" })
    .returning({ id: actors.id });
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: owner.id,
      displayName: `agent-${tag}`,
      kind: "agent",
      agentId: agent.id,
    })
    .returning({ id: actors.id });
  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "test", label: `d453-${tag}-${token}` })
    .returning({ id: namespaces.id });
  if (!ownerActor || !agentActor || !namespace) throw new Error("D453 fixture trust failed");

  const [room] = await db
    .insert(rooms)
    .values({
      ownerId: owner.id,
      type: "private",
      kind: "private",
      label: `d453 room ${tag}`,
      graphThreadId: `d453:${tag}:${token}`,
      namespaceId: namespace.id,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("D453 fixture room failed");
  // room_members is not FORCE RLS; this bootstrap insert mirrors the trusted
  // room seed path and makes the later forced binding policy meaningful.
  await db.insert(roomMembers).values([
    { roomId: room.id, actorId: ownerActor.id },
    { roomId: room.id, actorId: agentActor.id, agentResponseMode: "active" },
  ]);

  const [task] = await db
    .insert(tasks)
    .values({
      ownerId: owner.id,
      requestorId: owner.id,
      agentId: agent.id,
      prompt: `D453 ${tag}`,
      callingRoomId: room.id,
      targetRoomId: room.id,
    })
    .returning({ id: tasks.id });
  if (!task) throw new Error("D453 fixture task failed");
  const [job] = await db
    .insert(jobs)
    .values({
      ownerId: owner.id,
      requestorId: owner.id,
      laneKey: `room:${room.id}`,
      roomId: room.id,
      type: "foreground",
    })
    .returning({ id: jobs.id });
  if (!job) throw new Error("D453 fixture job failed");
  const [taskRun] = await db
    .insert(taskRuns)
    .values({ taskId: task.id, jobId: job.id, graphThreadId: `d453-run:${token}` })
    .returning({ id: taskRuns.id });
  if (!taskRun) throw new Error("D453 fixture task run failed");

  const [profile] = await asUser(owner.id, (tx) =>
    tx
      .insert(codexAccountProfiles)
      .values({
        userId: owner.id,
        relayId: `relay-${token}`,
        homeHandle: `profile-${token}`,
        label: "Primary Codex",
      })
      .returning(),
  );
  if (!profile) throw new Error("D453 fixture profile failed");

  return { owner, other, agent, ownerActor, agentActor, namespace, room, task, job, taskRun, profile };
}

function bindingValues(fixture: Awaited<ReturnType<typeof seedBindingFixture>>) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    userId: fixture.owner.id,
    sourceAgentId: fixture.agent.id,
    taskId: fixture.task.id,
    taskRunId: fixture.taskRun.id,
    jobId: fixture.job.id,
    roomId: fixture.room.id,
    laneKey: `room:${fixture.room.id}`,
    bindingKind: "task",
    relayId: fixture.profile.relayId,
    relaySessionId: `relay-session-${suffix}`,
    desktopSessionId: `desktop-session-${suffix}`,
    pairingGenerationRef: `pairing-${suffix}`,
    capabilityRevision: 1,
    workspaceRef: `workspace-${suffix}`,
    workspaceRevision: 1,
    workspaceFingerprint: `workspace-fingerprint-${suffix}`,
    workspaceIssuedAt: new Date("2026-07-27T10:00:00.000Z"),
    workspaceExpiresAt: new Date("2026-07-27T10:05:00.000Z"),
    accountProfileId: fixture.profile.id,
    codexThreadId: `thread-${suffix}`,
    profileGeneration: fixture.profile.profileGeneration,
    accountGeneration: 1,
    runtimeGeneration: 1,
    childGeneration: 1,
    codexSandboxMode: "default",
    codexApprovalPolicy: "default",
  } as const;
}

async function cleanFixture(fixture: Awaited<ReturnType<typeof seedBindingFixture>>) {
  await asUser(fixture.owner.id, async (tx) => {
    await tx.delete(codexThreadBindings).where(eq(codexThreadBindings.userId, fixture.owner.id));
    await tx.delete(codexAccountProfiles).where(eq(codexAccountProfiles.userId, fixture.owner.id));
  });
  await db.delete(taskRuns).where(eq(taskRuns.id, fixture.taskRun.id));
  await db.delete(jobs).where(eq(jobs.id, fixture.job.id));
  await db.delete(tasks).where(eq(tasks.id, fixture.task.id));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.room.id));
  await db.delete(rooms).where(eq(rooms.id, fixture.room.id));
  await db.delete(namespaces).where(eq(namespaces.id, fixture.namespace.id));
  await db.delete(actors).where(eq(actors.id, fixture.ownerActor.id));
  await db.delete(agents).where(eq(agents.id, fixture.agent.id));
  await db.delete(users).where(eq(users.id, fixture.owner.id));
  await db.delete(users).where(eq(users.id, fixture.other.id));
}

async function seedSiblingTaskRun(fixture: Awaited<ReturnType<typeof seedBindingFixture>>) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [task] = await db
    .insert(tasks)
    .values({
      ownerId: fixture.owner.id,
      requestorId: fixture.owner.id,
      agentId: fixture.agent.id,
      prompt: `D453 sibling ${suffix}`,
      callingRoomId: fixture.room.id,
      targetRoomId: fixture.room.id,
    })
    .returning({ id: tasks.id });
  const [job] = await db
    .insert(jobs)
    .values({
      ownerId: fixture.owner.id,
      requestorId: fixture.owner.id,
      laneKey: `room:${fixture.room.id}`,
      roomId: fixture.room.id,
      type: "foreground",
    })
    .returning({ id: jobs.id });
  if (!task || !job) throw new Error("D453 sibling Task/Job failed");
  const [taskRun] = await db
    .insert(taskRuns)
    .values({ taskId: task.id, jobId: job.id, graphThreadId: `d453-sibling:${suffix}` })
    .returning({ id: taskRuns.id });
  if (!taskRun) throw new Error("D453 sibling task run failed");
  return { task, job, taskRun };
}

describe("D453 Codex schema", () => {
  test("safe columns, checks, defaults, and forced RLS are present", async () => {
    const columns = (await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name IN (
        'codex_account_profiles',
        'codex_thread_bindings'
      )
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const byTable = new Map<string, Set<string>>();
    for (const row of columns) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(row.table_name, set);
    }
    for (const column of ["user_id", "relay_id", "home_handle", "revision", "removal_state", "removed_at"]) {
      expect(byTable.get("codex_account_profiles")?.has(column)).toBe(true);
    }
    for (const column of [
      "source_agent_id", "task_id", "parent_task_id", "room_id", "lane_key",
      "task_run_id", "job_id", "binding_kind", "relay_session_id", "desktop_session_id",
      "workspace_ref", "workspace_revision", "workspace_fingerprint", "workspace_issued_at",
      "workspace_expires_at", "account_profile_id", "codex_thread_id", "profile_generation",
      "runtime_generation", "child_generation", "archived_at",
    ]) {
      expect(byTable.get("codex_thread_bindings")?.has(column)).toBe(true);
    }

    const forbidden = new Set([
      "codex_home",
      "home_path",
      "workspace_path",
      "cwd",
      "auth_token",
      "access_token",
      "refresh_token",
      "password",
      "cookie",
      "email",
      "url",
    ]);
    for (const row of columns) expect(forbidden.has(row.column_name)).toBe(false);

    const rls = (await db.execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'codex_account_profiles',
        'codex_thread_bindings'
      )
    `)) as unknown as Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rls).toHaveLength(2);
    for (const row of rls) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("profile removal only permits active → removing → removed and retains the audit path", async () => {
    const fixture = await seedBindingFixture("soft-removal-lifecycle");
    try {
      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.update(codexAccountProfiles).set({
            removalState: "removed",
            removedAt: new Date(),
            revision: 1,
          }).where(eq(codexAccountProfiles.id, fixture.profile.id)),
        ),
      );
      const [removing] = await asUser(fixture.owner.id, (tx) =>
        tx.update(codexAccountProfiles).set({
          removalState: "removing",
          revision: 1,
        }).where(eq(codexAccountProfiles.id, fixture.profile.id)).returning(),
      );
      expect(removing).toMatchObject({ removalState: "removing", removedAt: null, revision: 1 });
      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.update(codexAccountProfiles).set({ label: "mutated", revision: 2 })
            .where(eq(codexAccountProfiles.id, fixture.profile.id)),
        ),
      );
      const [removed] = await asUser(fixture.owner.id, (tx) =>
        tx.update(codexAccountProfiles).set({
          removalState: "removed",
          removedAt: new Date(),
          authState: "signed_out",
          revision: 2,
        }).where(eq(codexAccountProfiles.id, fixture.profile.id)).returning(),
      );
      expect(removed?.removedAt).toBeInstanceOf(Date);
      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.update(codexAccountProfiles).set({ label: "after removal", revision: 3 })
            .where(eq(codexAccountProfiles.id, fixture.profile.id)),
        ),
      );
      const indexes = await db.execute(sql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'codex_account_profiles'
          AND indexname IN ('idx_codex_account_profiles_user', 'idx_codex_account_profiles_owner_visible')
      `) as unknown as Array<{ indexname: string; indexdef: string }>;
      expect(indexes.map((index) => index.indexname).sort()).toEqual([
        "idx_codex_account_profiles_owner_visible",
        "idx_codex_account_profiles_user",
      ]);
      expect(indexes.find((index) => index.indexname === "idx_codex_account_profiles_owner_visible")?.indexdef)
        .toContain("removal_state");
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("opaque home handles reject path-shaped input", async () => {
    const fixture = await seedBindingFixture("home-handle");
    try {
      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.insert(codexAccountProfiles).values({
            userId: fixture.owner.id,
            relayId: "relay-path-check",
            homeHandle: "../not-an-opaque-handle",
            label: "Invalid home",
          }),
        ),
      );
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("usage snapshots retain only the bounded relay-safe projection", async () => {
    const fixture = await seedBindingFixture("usage-snapshot");
    try {
      const observedAt = new Date(Date.now() + 60_000);
      const updatedAt = new Date(Date.now() + 120_000);
      const safeSnapshot = {
        schemaVersion: 1,
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: "2026-07-27T12:00:00.000Z" },
          secondary: null,
          plan: "pro",
          // 21 three-byte euro signs plus one ASCII byte is exactly 64 UTF-8 bytes.
          credits: { hasCredits: true, unlimited: false, balance: `${"€".repeat(21)}a` },
          spendControl: null,
          reached: null,
          observedAt: "2026-07-27T10:00:00.000Z",
          freshness: "live",
        },
        usage: {
          summary: {
            lifetimeTokens: "1000", peakDailyTokens: "100", longestRunningTurnSec: "30",
            currentStreakDays: "2", longestStreakDays: "4",
          },
          daily: [{ startDate: "2026-07-27", tokens: "100" }],
          observedAt: "2026-07-27T10:00:00.000Z",
          freshness: "live",
        },
      } as const;
      const [accepted] = await asUser(fixture.owner.id, (tx) =>
        tx.update(codexAccountProfiles).set({
          planType: "pro", usageSnapshot: safeSnapshot, usageObservedAt: observedAt, updatedAt,
        }).where(eq(codexAccountProfiles.id, fixture.profile.id)).returning(),
      );
      expect(accepted?.usageSnapshot).toEqual(safeSnapshot);
      const invalidSnapshots: unknown[] = [
        { ...safeSnapshot, accessToken: "never-store-this" },
        { rateLimits: safeSnapshot.rateLimits },
        { ...safeSnapshot, schemaVersion: null },
        { ...safeSnapshot, schemaVersion: "1" },
        { ...safeSnapshot, schemaVersion: 2 },
        { ...safeSnapshot, rateLimits: { ...safeSnapshot.rateLimits, freshness: null } },
        { ...safeSnapshot, rateLimits: { ...safeSnapshot.rateLimits, observedAt: "2026-02-30T10:00:00.000Z" } },
        { ...safeSnapshot, usage: { ...safeSnapshot.usage, observedAt: "2026-07-27T10:00:00Z" } },
        { ...safeSnapshot, rateLimits: { ...safeSnapshot.rateLimits, primary: { ...safeSnapshot.rateLimits.primary, usedPercent: 101 } } },
        { ...safeSnapshot, rateLimits: { ...safeSnapshot.rateLimits, nestedRaw: "nope" } },
        { ...safeSnapshot, usage: { ...safeSnapshot.usage, daily: [...safeSnapshot.usage.daily, ...Array.from({ length: 31 }, () => ({ startDate: "2026-07-27", tokens: "1" }))] } },
        { ...safeSnapshot, usage: { ...safeSnapshot.usage, summary: { ...safeSnapshot.usage.summary, lifetimeTokens: "12.5" } } },
        { ...safeSnapshot, usage: { ...safeSnapshot.usage, daily: [{ startDate: "2026-02-30", tokens: "1" }] } },
        { ...safeSnapshot, rateLimits: { ...safeSnapshot.rateLimits, credits: { hasCredits: true, unlimited: false, balance: "€".repeat(22) } } },
        { ...safeSnapshot, usage: { ...safeSnapshot.usage, daily: Array.from({ length: 31 }, () => ({ startDate: "2026-07-27", tokens: "9".repeat(32) })) }, padding: "x".repeat(16_384) },
      ];
      for (const invalidSnapshot of invalidSnapshots) {
        await expectRejected(() => asUser(fixture.owner.id, (tx) =>
          tx.update(codexAccountProfiles).set({
            usageSnapshot: invalidSnapshot as never, usageObservedAt: observedAt, updatedAt,
          }).where(eq(codexAccountProfiles.id, fixture.profile.id)),
        ));
      }
      await expectRejected(() => asUser(fixture.owner.id, (tx) =>
        tx.update(codexAccountProfiles).set({ planType: "not-a-safe-plan" }).where(eq(codexAccountProfiles.id, fixture.profile.id)),
      ));
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("one active binding per owner Task; archived history frees it", async () => {
    const fixture = await seedBindingFixture("binding-history");
    try {
      const [first] = await asUser(fixture.owner.id, (tx) =>
        tx.insert(codexThreadBindings).values(bindingValues(fixture)).returning(),
      );
      if (!first) throw new Error("first binding failed");

      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.insert(codexThreadBindings).values(bindingValues(fixture)).returning(),
        ),
      );

      await asUser(fixture.owner.id, async (tx) => {
        await tx
          .update(codexThreadBindings)
          .set({ state: "archived", archivedAt: new Date(), revision: 1 })
          .where(eq(codexThreadBindings.id, first.id));
      });
      const [replacement] = await asUser(fixture.owner.id, (tx) =>
        tx.insert(codexThreadBindings).values(bindingValues(fixture)).returning(),
      );
      expect(replacement?.id).toBeDefined();
      expect(replacement?.workspaceRef).toContain("workspace-");
      expect(replacement?.workspaceFingerprint).toContain("workspace-fingerprint-");
      expect(replacement?.workspaceIssuedAt?.toISOString()).toBe("2026-07-27T10:00:00.000Z");
      expect(replacement?.workspaceExpiresAt?.toISOString()).toBe("2026-07-27T10:05:00.000Z");

      const sibling = await seedSiblingTaskRun(fixture);
      const [delegated] = await asUser(fixture.owner.id, (tx) =>
        tx
          .insert(codexThreadBindings)
          .values({
            ...bindingValues(fixture),
            taskId: sibling.task.id,
            taskRunId: sibling.taskRun.id,
            jobId: sibling.job.id,
          })
          .returning(),
      );
      expect(delegated?.id).toBeDefined();
      // A delegated Task binding may share the same Room lane; identity is
      // keyed by its canonical Task.
      expect(delegated?.laneKey).toBe(replacement?.laneKey);

      if (delegated) {
        await asUser(fixture.owner.id, async (tx) => {
          await tx.delete(codexThreadBindings).where(eq(codexThreadBindings.id, delegated.id));
        });
      }
      await db.delete(taskRuns).where(eq(taskRuns.id, sibling.taskRun.id));
      await db.delete(jobs).where(eq(jobs.id, sibling.job.id));
      await db.delete(tasks).where(eq(tasks.id, sibling.task.id));
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("same-owner composite profile references reject a learned foreign profile id", async () => {
    const fixture = await seedBindingFixture("profile-owner-fk");
    try {
      const [foreignProfile] = await asUser(fixture.other.id, (tx) =>
        tx
          .insert(codexAccountProfiles)
          .values({
            userId: fixture.other.id,
            relayId: "foreign-owner-relay",
            homeHandle: "foreign-owner-profile",
            label: "Foreign profile",
          })
          .returning(),
      );
      if (!foreignProfile) throw new Error("foreign profile failed");

      await expectRejected(() =>
        asUser(fixture.owner.id, (tx) =>
          tx.insert(codexThreadBindings).values({
            ...bindingValues(fixture),
            accountProfileId: foreignProfile.id,
          }),
        ),
      );

      await asUser(fixture.other.id, async (tx) => {
        await tx.delete(codexAccountProfiles).where(eq(codexAccountProfiles.id, foreignProfile.id));
      });
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("binding RLS requires the exact current user, Agent, Task-run/Job, and lane tuple", async () => {
    const fixture = await seedBindingFixture("binding-rls");
    try {
      const [binding] = await asUser(fixture.owner.id, (tx) =>
        tx.insert(codexThreadBindings).values(bindingValues(fixture)).returning(),
      );
      if (!binding) throw new Error("binding fixture insert failed");

      const noAgent = await asRuntimeContext(fixture.owner.id, undefined, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(noAgent).toHaveLength(0);
      const exact = await asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(exact).toHaveLength(1);

      const wrongUser = await asRuntimeContext(fixture.other.id, fixture.agent.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(wrongUser).toHaveLength(0);
      const wrongAgent = await asRuntimeContext(fixture.owner.id, crypto.randomUUID(), (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(wrongAgent).toHaveLength(0);

      await db.delete(roomMembers).where(eq(roomMembers.actorId, fixture.ownerActor.id));
      const withoutHuman = await asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(withoutHuman).toHaveLength(0);
      await db.insert(roomMembers).values({ roomId: fixture.room.id, actorId: fixture.ownerActor.id });
      await db.delete(roomMembers).where(eq(roomMembers.actorId, fixture.agentActor.id));
      const withoutAgent = await asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(withoutAgent).toHaveLength(0);
      await db.insert(roomMembers).values({ roomId: fixture.room.id, actorId: fixture.agentActor.id, agentResponseMode: "active" });

      await expectRejected(() =>
        asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
          tx.insert(codexThreadBindings).values({
            ...bindingValues(fixture),
            laneKey: `room:${fixture.room.id}:wrong-lane`,
          }),
        ),
      );
      const sibling = await seedSiblingTaskRun(fixture);
      const taskBinding = { ...bindingValues(fixture), bindingKind: "task" as const };
      for (const values of [
        { ...taskBinding, taskRunId: sibling.taskRun.id }, // Task↔Run mismatch
        { ...taskBinding, jobId: sibling.job.id }, // Run↔Job mismatch
        { ...taskBinding, taskId: sibling.task.id, jobId: fixture.job.id, taskRunId: sibling.taskRun.id }, // Job mismatch
      ]) {
        await expectRejected(() =>
          asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
            tx.insert(codexThreadBindings).values(values),
          ),
        );
      }
      const [wrongTaskAgent] = await db.insert(agents).values({ handle: `d453-wrong-agent-${crypto.randomUUID()}` }).returning({ id: agents.id });
      const [wrongAgentTask] = await db.insert(tasks).values({
        ownerId: fixture.owner.id, requestorId: fixture.owner.id, agentId: wrongTaskAgent!.id,
        prompt: "D453 wrong Task Agent", callingRoomId: fixture.room.id, targetRoomId: fixture.room.id,
      }).returning({ id: tasks.id });
      const [wrongAgentRun] = await db.insert(taskRuns).values({
        taskId: wrongAgentTask!.id, jobId: fixture.job.id, graphThreadId: `d453-wrong-agent:${crypto.randomUUID()}`,
      }).returning({ id: taskRuns.id });
      await expectRejected(() => asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
        tx.insert(codexThreadBindings).values({ ...taskBinding, taskId: wrongAgentTask!.id, taskRunId: wrongAgentRun!.id }),
      ));
      const [foreignOwnerJob] = await db.insert(jobs).values({
        ownerId: fixture.other.id, requestorId: fixture.other.id, laneKey: `room:${fixture.room.id}`, roomId: fixture.room.id, type: "foreground",
      }).returning({ id: jobs.id });
      const [foreignOwnerRun] = await db.insert(taskRuns).values({
        taskId: fixture.task.id, jobId: foreignOwnerJob!.id, graphThreadId: `d453-wrong-job-owner:${crypto.randomUUID()}`,
      }).returning({ id: taskRuns.id });
      await expectRejected(() => asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
        tx.insert(codexThreadBindings).values({ ...taskBinding, taskRunId: foreignOwnerRun!.id, jobId: foreignOwnerJob!.id }),
      ));
      await db.delete(taskRuns).where(eq(taskRuns.id, foreignOwnerRun!.id));
      await db.delete(jobs).where(eq(jobs.id, foreignOwnerJob!.id));
      await db.delete(taskRuns).where(eq(taskRuns.id, wrongAgentRun!.id));
      await db.delete(tasks).where(eq(tasks.id, wrongAgentTask!.id));
      await db.delete(agents).where(eq(agents.id, wrongTaskAgent!.id));
      await db.delete(taskRuns).where(eq(taskRuns.id, sibling.taskRun.id));
      await db.delete(jobs).where(eq(jobs.id, sibling.job.id));
      await db.delete(tasks).where(eq(tasks.id, sibling.task.id));
      await expectRejected(() =>
        asRuntimeContext(fixture.owner.id, fixture.agent.id, (tx) =>
          tx.insert(codexThreadBindings).values({
            ...bindingValues(fixture),
            parentTaskId: fixture.task.id,
          }),
        ),
      );
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("binding lifecycle permits an exact rebind but preserves identity and terminal history", async () => {
    const fixture = await seedBindingFixture("binding-immutable");
    try {
      const [binding] = await asUser(fixture.owner.id, (tx) =>
        tx.insert(codexThreadBindings).values(bindingValues(fixture)).returning(),
      );
      if (!binding) throw new Error("binding fixture insert failed");
      for (const values of [
        { id: crypto.randomUUID() },
        { createdAt: new Date(binding.createdAt.getTime() + 1_000) },
        { relayId: "another-relay" },
      ]) {
        await expectRejected(() => asUser(fixture.owner.id, (tx) =>
          tx.update(codexThreadBindings).set(values).where(eq(codexThreadBindings.id, binding.id)),
        ));
      }
      const [needsRebind] = await asUser(fixture.owner.id, (tx) =>
        tx
          .update(codexThreadBindings)
          .set({ state: "needs_rebind", lastTurnId: "turn-1", lastItemCursor: "item-1", revision: 1 })
          .where(eq(codexThreadBindings.id, binding.id))
          .returning(),
      );
      expect(needsRebind?.state).toBe("needs_rebind");
      expect(needsRebind?.lastItemCursor).toBe("item-1");
      for (const values of [
        { relaySessionId: "wrong-session" }, { desktopSessionId: "wrong-desktop" },
        { capabilityRevision: 2 }, { workspaceRef: "wrong-workspace" }, { workspaceRevision: 2 },
        { workspaceIssuedAt: new Date("2026-07-27T10:01:00.000Z") },
        { workspaceExpiresAt: new Date("2026-07-27T10:06:00.000Z") },
        { childGeneration: 2 }, { bindingGeneration: 1 },
      ]) {
        await expectRejected(() => asUser(fixture.owner.id, (tx) =>
          tx.update(codexThreadBindings).set(values).where(eq(codexThreadBindings.id, binding.id)),
        ));
      }
      await expectRejected(() => asUser(fixture.owner.id, (tx) =>
        tx.update(codexThreadBindings).set({ state: "active" }).where(eq(codexThreadBindings.id, binding.id)),
      ));
      const [rebound] = await asUser(fixture.owner.id, (tx) =>
        tx.update(codexThreadBindings).set({
          state: "active", relaySessionId: "rebound-session", desktopSessionId: "rebound-desktop",
          capabilityRevision: 2, workspaceRef: "rebound-workspace", workspaceRevision: 2,
          workspaceIssuedAt: new Date("2026-07-27T10:01:00.000Z"),
          workspaceExpiresAt: new Date("2026-07-27T10:06:00.000Z"), childGeneration: 2,
          bindingGeneration: 1, revision: 2,
        }).where(eq(codexThreadBindings.id, binding.id)).returning(),
      );
      expect(rebound?.state).toBe("active");
      expect(rebound?.bindingGeneration).toBe(1);
      const [archived] = await asUser(fixture.owner.id, (tx) =>
        tx.update(codexThreadBindings).set({ state: "archived", archivedAt: new Date(), revision: 3 })
          .where(eq(codexThreadBindings.id, binding.id)).returning(),
      );
      expect(archived?.archivedAt).not.toBeNull();
      await expectRejected(() => asUser(fixture.owner.id, (tx) =>
        tx.update(codexThreadBindings).set({ state: "active", archivedAt: null }).where(eq(codexThreadBindings.id, binding.id)),
      ));
      await expectRejected(() => asUser(fixture.owner.id, (tx) =>
        tx.update(codexThreadBindings).set({ lastItemCursor: "mutated-after-archive" }).where(eq(codexThreadBindings.id, binding.id)),
      ));
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("runtime-role forced RLS hides and rejects another Human's profiles and bindings", async () => {
    const fixture = await seedBindingFixture("rls");
    try {
      await asUser(fixture.owner.id, async (tx) => {
        await tx.insert(codexThreadBindings).values(bindingValues(fixture));
      });

      const [profiles, bindings] = await asRuntimeContext(fixture.other.id, undefined, async (tx) =>
        Promise.all([
          tx.select().from(codexAccountProfiles).where(eq(codexAccountProfiles.userId, fixture.owner.id)),
          tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.userId, fixture.owner.id)),
        ]),
      );
      expect(profiles).toHaveLength(0);
      expect(bindings).toHaveLength(0);

      await expectRejected(() =>
        asRuntimeContext(fixture.other.id, undefined, (tx) =>
          tx.insert(codexAccountProfiles).values({
            userId: fixture.owner.id,
            relayId: "wrong-owner-relay",
            homeHandle: "wrong-owner-profile",
            label: "Wrong owner",
          }),
        ),
      );
    } finally {
      await cleanFixture(fixture);
    }
  });
});
