import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  archiveCodexProfileBindingsForRemovalWith,
  actors,
  agents,
  archiveCodexBindingWith,
  beginCodexProfileRemovalWith,
  claimCodexUserInputRequestDispatchWith,
  CodexProfileSelectionRejectedError,
  codexAccountProfiles,
  codexUserInputRequests,
  codexUserPreferences,
  codexThreadBindings,
  createCodexUserInputRequestWith,
  deleteExpiredCodexUserInputRequestFactsWith,
  createDirectAgentDb,
  createDirectDb,
  ensureDatabase,
  eq,
  finalizeCodexProfileRemovalWith,
  getActiveCodexBindingForTaskWith,
  getCodexProfileWith,
  getCodexUserPreferenceWith,
  insertCodexBindingWith,
  insertCodexProfileWith,
  jobs,
  listCodexProfileRemovalTaskBindingWorkWith,
  listCodexProfilesWith,
  listCodexUserInputRequestsForRoomWith,
  markCodexUserInputRequestSubmittedWith,
  markCodexUserInputRequestUnavailableWith,
  namespaces,
  rebindCodexBindingWith,
  registerCodexProfileFromOfficialAccountWith,
  renameCodexProfileWith,
  replaceCodexBindingWith,
  roomMembers,
  rooms,
  sql,
  settleCodexUserInputRequestWith,
  tasks,
  taskRuns,
  updateCodexBindingStateWith,
  updateCodexProfileUsageSnapshotWith,
  upsertCodexUserPreferenceWith,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type OwnerDb = ReturnType<typeof createDirectDb>;
type RuntimeDb = ReturnType<typeof createDirectAgentDb>;
type QueryDb = Parameters<typeof listCodexProfilesWith>[0];

let ownerDb: OwnerDb;
let runtimeDb: RuntimeDb;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  ownerDb = createDirectDb(4);
  runtimeDb = createDirectAgentDb(3);
});

afterAll(async () => {
  if (runtimeDb) await runtimeDb.end();
  if (ownerDb) await ownerDb.end();
});

function queryDb(): QueryDb {
  return runtimeDb as unknown as QueryDb;
}

async function asOwner<T>(
  userId: string,
  callback: (tx: OwnerDb) => Promise<T>,
): Promise<T> {
  return ownerDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_user_id', ${userId}, true)`,
    );
    return callback(tx as unknown as OwnerDb);
  });
}

async function expectRejected(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected database operation to reject");
}

async function expectProfileSelectionRejected(
  operation: () => Promise<unknown>,
) {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CodexProfileSelectionRejectedError);
    expect((error as CodexProfileSelectionRejectedError).code).toBe(
      "CODEX_PROFILE_SELECTION_REJECTED",
    );
    return;
  }
  throw new Error("expected stable Codex profile selection rejection");
}

async function seedFixture(tag: string) {
  const token = `${tag}-${crypto.randomUUID()}`;
  const [owner, other, agent] = await Promise.all([
    ownerDb
      .insert(users)
      .values({
        name: `query-owner-${tag}`,
        email: `${token}@query.test`,
      })
      .returning({ id: users.id })
      .then((rows) => rows[0]),
    ownerDb
      .insert(users)
      .values({
        name: `query-other-${tag}`,
        email: `other-${token}@query.test`,
      })
      .returning({ id: users.id })
      .then((rows) => rows[0]),
    ownerDb
      .insert(agents)
      .values({ handle: `query-agent-${token}` })
      .returning({ id: agents.id })
      .then((rows) => rows[0]),
  ]);
  if (!owner || !other || !agent) throw new Error("identity fixture failed");

  const [ownerActor, agentActor, namespace] = await Promise.all([
    ownerDb
      .insert(actors)
      .values({
        ownerId: owner.id,
        displayName: `query-owner-${tag}`,
        kind: "user",
      })
      .returning({ id: actors.id })
      .then((rows) => rows[0]),
    ownerDb
      .insert(actors)
      .values({
        ownerId: owner.id,
        displayName: `query-agent-${tag}`,
        kind: "agent",
        agentId: agent.id,
      })
      .returning({ id: actors.id })
      .then((rows) => rows[0]),
    ownerDb
      .insert(namespaces)
      .values({ scope: "test", label: `query-${token}` })
      .returning({ id: namespaces.id })
      .then((rows) => rows[0]),
  ]);
  if (!ownerActor || !agentActor || !namespace) {
    throw new Error("authority fixture failed");
  }

  const [room] = await ownerDb
    .insert(rooms)
    .values({
      ownerId: owner.id,
      type: "private",
      kind: "private",
      label: `query room ${tag}`,
      graphThreadId: `query:${token}`,
      namespaceId: namespace.id,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room fixture failed");
  await ownerDb.insert(roomMembers).values([
    { roomId: room.id, actorId: ownerActor.id },
    {
      roomId: room.id,
      actorId: agentActor.id,
      agentResponseMode: "active",
    },
  ]);

  const [task] = await ownerDb
    .insert(tasks)
    .values({
      ownerId: owner.id,
      requestorId: owner.id,
      agentId: agent.id,
      prompt: `query ${tag}`,
      callingRoomId: room.id,
      targetRoomId: room.id,
    })
    .returning({ id: tasks.id });
  const [job] = await ownerDb
    .insert(jobs)
    .values({
      ownerId: owner.id,
      requestorId: owner.id,
      laneKey: `room:${room.id}`,
      roomId: room.id,
      type: "foreground",
    })
    .returning({ id: jobs.id });
  if (!task || !job) throw new Error("task fixture failed");
  const [taskRun] = await ownerDb
    .insert(taskRuns)
    .values({
      taskId: task.id,
      jobId: job.id,
      graphThreadId: `query-run:${token}`,
    })
    .returning({ id: taskRuns.id });
  if (!taskRun) throw new Error("run fixture failed");

  const [profile] = await asOwner(owner.id, (tx) =>
    tx
      .insert(codexAccountProfiles)
      .values({
        userId: owner.id,
        relayId: `relay-${token}`,
        homeHandle: `home-${token}`,
        label: "Primary",
      })
      .returning(),
  );
  if (!profile) throw new Error("profile fixture failed");

  return {
    owner,
    other,
    agent,
    ownerActor,
    agentActor,
    namespace,
    room,
    task,
    job,
    taskRun,
    profile,
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function context(fixture: Fixture, userId = fixture.owner.id) {
  return { userId, agentId: fixture.agent.id };
}
function ownerContext(fixture: Fixture, userId = fixture.owner.id) {
  return { userId };
}

function bindingValues(
  fixture: Fixture,
  suffix: string = crypto.randomUUID(),
) {
  return {
    sourceAgentId: fixture.agent.id,
    taskId: fixture.task.id,
    taskRunId: fixture.taskRun.id,
    jobId: fixture.job.id,
    parentTaskId: null,
    roomId: fixture.room.id,
    laneKey: `room:${fixture.room.id}`,
    bindingKind: "task" as const,
    relayId: fixture.profile.relayId,
    relaySessionId: `session-${suffix}`,
    desktopSessionId: `desktop-${suffix}`,
    pairingGenerationRef: `pair-${suffix}`,
    capabilityRevision: 1,
    workspaceRef: `workspace-${suffix}`,
    workspaceRevision: 1,
    workspaceFingerprint: `fingerprint-${suffix}`,
    workspaceIssuedAt: new Date("2026-07-27T10:00:00.000Z"),
    workspaceExpiresAt: new Date("2026-07-27T10:05:00.000Z"),
    accountProfileId: fixture.profile.id,
    codexThreadId: `thread-${suffix}`,
    profileGeneration: fixture.profile.profileGeneration,
    accountGeneration: fixture.profile.accountGeneration,
    runtimeGeneration: 1,
    childGeneration: 1,
    bindingGeneration: 0,
    selectedModel: null,
    codexSandboxMode: "default" as const,
    codexApprovalPolicy: "default" as const,
    state: "opening" as const,
    revision: 0,
  };
}

function bindingLocator(fixture: Fixture, id: string) {
  return {
    id,
    taskId: fixture.task.id,
    taskRunId: fixture.taskRun.id,
    jobId: fixture.job.id,
    roomId: fixture.room.id,
    laneKey: `room:${fixture.room.id}`,
  };
}

function userInputRequestValues(
  fixture: Fixture,
  binding: NonNullable<Awaited<ReturnType<typeof insertCodexBindingWith>>>,
  options: { readonly requestRef?: string; readonly expiresAt?: Date } = {},
) {
  return {
    requestRef: options.requestRef ?? `input-${crypto.randomUUID()}`,
    bindingId: binding.id,
    bindingGeneration: binding.bindingGeneration,
    roomId: fixture.room.id,
    taskId: fixture.task.id,
    taskRunId: fixture.taskRun.id,
    jobId: fixture.job.id,
    codexThreadId: binding.codexThreadId,
    codexTurnId: `turn-${crypto.randomUUID()}`,
    codexItemId: `item-${crypto.randomUUID()}`,
    questions: [{
      id: "target",
      header: "Target",
      question: "Which target should Codex use?",
      isOther: false,
      isSecret: false,
      options: [{ id: "option:0", label: "Tests", description: "Run focused tests." }],
    }],
    autoResolutionMs: 300_000,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
  } as const;
}

function rebindExpectation(binding: NonNullable<
  Awaited<ReturnType<typeof insertCodexBindingWith>>
>) {
  return {
    parentTaskId: binding.parentTaskId,
    bindingKind: binding.bindingKind as "task",
    relayId: binding.relayId,
    pairingGenerationRef: binding.pairingGenerationRef,
    workspaceFingerprint: binding.workspaceFingerprint,
    accountProfileId: binding.accountProfileId,
    codexThreadId: binding.codexThreadId,
    profileGeneration: binding.profileGeneration,
    accountGeneration: binding.accountGeneration,
    runtimeGeneration: binding.runtimeGeneration,
    selectedModel: binding.selectedModel,
    codexSandboxMode: binding.codexSandboxMode as
      | "default"
      | "workspace-write"
      | "danger-full-access",
    codexApprovalPolicy: binding.codexApprovalPolicy as
      | "default"
      | "on-request"
      | "never",
  };
}

async function cleanFixture(fixture: Fixture) {
  await asOwner(fixture.owner.id, async (tx) => {
    await tx
      .delete(codexUserInputRequests)
      .where(eq(codexUserInputRequests.userId, fixture.owner.id));
    await tx
      .delete(codexThreadBindings)
      .where(eq(codexThreadBindings.userId, fixture.owner.id));
    await tx
      .delete(codexUserPreferences)
      .where(eq(codexUserPreferences.userId, fixture.owner.id));
    await tx
      .delete(codexAccountProfiles)
      .where(eq(codexAccountProfiles.userId, fixture.owner.id));
  });
  await ownerDb.delete(taskRuns).where(eq(taskRuns.id, fixture.taskRun.id));
  await ownerDb.delete(jobs).where(eq(jobs.id, fixture.job.id));
  await ownerDb.delete(tasks).where(eq(tasks.id, fixture.task.id));
  await ownerDb
    .delete(roomMembers)
    .where(eq(roomMembers.roomId, fixture.room.id));
  await ownerDb.delete(rooms).where(eq(rooms.id, fixture.room.id));
  await ownerDb
    .delete(namespaces)
    .where(eq(namespaces.id, fixture.namespace.id));
  await ownerDb
    .delete(actors)
    .where(eq(actors.id, fixture.ownerActor.id));
  await ownerDb.delete(agents).where(eq(agents.id, fixture.agent.id));
  await ownerDb.delete(users).where(eq(users.id, fixture.owner.id));
  await ownerDb.delete(users).where(eq(users.id, fixture.other.id));
}

describe("D453 Codex query boundary", () => {
  test("durable user-input facts are owner-scoped, generation-fenced, one-shot, and answer-free", async () => {
    const fixture = await seedFixture("user-input-request");
    try {
      const opening = await insertCodexBindingWith(
        queryDb(),
        context(fixture),
        bindingValues(fixture, "user-input"),
      );
      if (!opening) throw new Error("input binding failed");
      const binding = await updateCodexBindingStateWith(
        queryDb(),
        context(fixture),
        bindingLocator(fixture, opening.id),
        "active",
        0,
      );
      if (!binding) throw new Error("input binding did not activate");
      const createdAt = new Date();
      const input = userInputRequestValues(fixture, binding, {
        requestRef: `request-${crypto.randomUUID()}`,
        expiresAt: new Date(createdAt.getTime() + 60_000),
      });

      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), input, createdAt),
      ).toMatchObject({ status: "created", request: { state: "awaiting_human", revision: 0 } });
      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), input, createdAt),
      ).toMatchObject({ status: "existing" });
      expect(
        await createCodexUserInputRequestWith(
          queryDb(),
          context(fixture),
          { ...input, requestRef: `replayed-${crypto.randomUUID()}` },
          createdAt,
        ),
      ).toEqual({ status: "conflict" });
      expect(
        await createCodexUserInputRequestWith(
          queryDb(),
          context(fixture, fixture.other.id),
          input,
          createdAt,
        ),
      ).toEqual({ status: "stale_binding" });

      const claimed = await claimCodexUserInputRequestDispatchWith(
        queryDb(),
        context(fixture),
        { requestRef: input.requestRef, expectedRevision: 0, now: createdAt },
      );
      expect(claimed).toMatchObject({ status: "transitioned", request: { state: "dispatching", revision: 1 } });
      expect(
        await claimCodexUserInputRequestDispatchWith(
          queryDb(),
          context(fixture),
          { requestRef: input.requestRef, expectedRevision: 1, now: createdAt },
        ),
      ).toEqual({ status: "conflict" });
      const submitted = await markCodexUserInputRequestSubmittedWith(
        queryDb(),
        context(fixture),
        { requestRef: input.requestRef, expectedRevision: 1, now: new Date(createdAt.getTime() + 1) },
      );
      expect(submitted).toMatchObject({ status: "transitioned", request: { state: "submitted", revision: 2 } });
      const terminal = await settleCodexUserInputRequestWith(
        queryDb(),
        context(fixture),
        { requestRef: input.requestRef, expectedRevision: 2, state: "terminal", now: new Date(createdAt.getTime() + 2) },
      );
      expect(terminal).toMatchObject({ status: "transitioned", request: { state: "terminal", revision: 3 } });
      expect(
        await settleCodexUserInputRequestWith(
          queryDb(),
          context(fixture),
          { requestRef: input.requestRef, expectedRevision: 3, state: "terminal" },
        ),
      ).toMatchObject({ status: "already_terminal" });

      const expired = userInputRequestValues(fixture, binding, {
        requestRef: `expired-${crypto.randomUUID()}`,
        expiresAt: new Date(createdAt.getTime() + 10),
      });
      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), expired, createdAt),
      ).toMatchObject({ status: "created" });
      expect(
        await claimCodexUserInputRequestDispatchWith(
          queryDb(),
          context(fixture),
          { requestRef: expired.requestRef, expectedRevision: 0, now: new Date(createdAt.getTime() + 10) },
        ),
      ).toEqual({ status: "expired" });
      expect(
        await settleCodexUserInputRequestWith(
          queryDb(),
          context(fixture),
          { requestRef: expired.requestRef, expectedRevision: 0, state: "expired", now: new Date(createdAt.getTime() + 11) },
        ),
      ).toMatchObject({ status: "transitioned", request: { state: "expired" } });

      const stale = userInputRequestValues(fixture, binding, {
        requestRef: `stale-${crypto.randomUUID()}`,
        expiresAt: new Date(createdAt.getTime() + 60_000),
      });
      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), stale, createdAt),
      ).toMatchObject({ status: "created" });
      const needsRebind = await updateCodexBindingStateWith(
        queryDb(),
        context(fixture),
        bindingLocator(fixture, binding.id),
        "needs_rebind",
        1,
      );
      if (!needsRebind) throw new Error("binding did not enter rebind state");
      const rebound = await rebindCodexBindingWith(queryDb(), context(fixture), {
        binding: bindingLocator(fixture, binding.id),
        expectedRevision: 2,
        expectedBindingGeneration: 0,
        relaySessionId: "rebound-session",
        desktopSessionId: "rebound-desktop",
        capabilityRevision: 2,
        workspaceRef: "rebound-workspace",
        workspaceRevision: 2,
        workspaceIssuedAt: new Date("2026-08-01T10:00:00.000Z"),
        workspaceExpiresAt: new Date("2026-08-01T10:05:00.000Z"),
        childGeneration: 2,
        expected: rebindExpectation(binding),
      });
      expect(rebound).toMatchObject({ bindingGeneration: 1, state: "active" });
      expect(
        await claimCodexUserInputRequestDispatchWith(
          queryDb(),
          context(fixture),
          { requestRef: stale.requestRef, expectedRevision: 0, now: createdAt },
        ),
      ).toEqual({ status: "stale_binding" });
      expect(
        await markCodexUserInputRequestUnavailableWith(
          queryDb(),
          context(fixture),
          { requestRef: stale.requestRef, expectedRevision: 0, now: new Date(createdAt.getTime() + 3) },
        ),
      ).toMatchObject({ status: "transitioned", request: { state: "unavailable" } });

      const cancelled = userInputRequestValues(fixture, rebound!, {
        requestRef: `cancelled-${crypto.randomUUID()}`,
        expiresAt: new Date(createdAt.getTime() + 60_000),
      });
      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), cancelled, createdAt),
      ).toMatchObject({ status: "created" });
      expect(
        await settleCodexUserInputRequestWith(
          queryDb(),
          context(fixture),
          {
            requestRef: cancelled.requestRef,
            expectedRevision: 0,
            state: "cancelled",
            now: new Date(createdAt.getTime() + 4),
          },
        ),
      ).toMatchObject({
        status: "transitioned",
        request: { state: "cancelled", failureCode: "CODEX_REQUEST_CANCELLED" },
      });

      const cleanupCandidate = userInputRequestValues(fixture, rebound!, {
        requestRef: `cleanup-${crypto.randomUUID()}`,
        expiresAt: new Date(createdAt.getTime() + 60_000),
      });
      expect(
        await createCodexUserInputRequestWith(queryDb(), context(fixture), cleanupCandidate, createdAt),
      ).toMatchObject({ status: "created" });
      expect(
        await settleCodexUserInputRequestWith(
          queryDb(),
          context(fixture),
          {
            requestRef: cleanupCandidate.requestRef,
            expectedRevision: 0,
            state: "terminal",
            now: new Date(createdAt.getTime() + 5),
          },
        ),
      ).toMatchObject({ status: "transitioned", request: { state: "terminal" } });
      expect(
        await deleteExpiredCodexUserInputRequestFactsWith(
          queryDb(),
          ownerContext(fixture, fixture.other.id),
          { before: new Date(createdAt.getTime() + 10), limit: 1 },
        ),
      ).toEqual([]);
      const deleted = await deleteExpiredCodexUserInputRequestFactsWith(
        queryDb(),
        ownerContext(fixture),
        { before: new Date(createdAt.getTime() + 10), limit: 1 },
      );
      expect(deleted).toHaveLength(1);

      await expectRejected(() =>
        asOwner(fixture.owner.id, (tx) =>
          tx.insert(codexUserInputRequests).values({
            requestRef: `invalid-${crypto.randomUUID()}`,
            userId: fixture.owner.id,
            sourceAgentId: fixture.agent.id,
            roomId: fixture.room.id,
            taskId: fixture.task.id,
            taskRunId: fixture.taskRun.id,
            jobId: fixture.job.id,
            bindingId: binding.id,
            bindingGeneration: 1,
            codexThreadId: rebound!.codexThreadId,
            codexTurnId: "turn-invalid",
            codexItemId: "item-invalid",
            questions: [{ ...input.questions[0], rawAnswer: "never-persist" }],
            autoResolutionMs: 300_001,
            expiresAt: new Date(createdAt.getTime() + 60_000),
            createdAt,
            updatedAt: new Date(createdAt.getTime() - 1),
          } as never),
        ),
      );
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("Room input recovery read is owner-scoped, recovery-visible, newest-first, and bounded", async () => {
    const fixture = await seedFixture("user-input-room-list");
    try {
      const opening = await insertCodexBindingWith(
        queryDb(), context(fixture), bindingValues(fixture, "input-room-list"),
      );
      if (!opening) throw new Error("input binding failed");
      const binding = await updateCodexBindingStateWith(
        queryDb(), context(fixture), bindingLocator(fixture, opening.id), "active", 0,
      );
      if (!binding) throw new Error("input binding did not activate");
      const base = new Date("2026-08-01T10:00:00.000Z");
      const older = userInputRequestValues(fixture, binding, {
        requestRef: `older-${crypto.randomUUID()}`,
        expiresAt: new Date(base.getTime() + 60_000),
      });
      const middle = userInputRequestValues(fixture, binding, {
        requestRef: `middle-${crypto.randomUUID()}`,
        expiresAt: new Date(base.getTime() + 120_000),
      });
      const newest = userInputRequestValues(fixture, binding, {
        requestRef: `newest-${crypto.randomUUID()}`,
        expiresAt: new Date(base.getTime() + 180_000),
      });
      const submitted = userInputRequestValues(fixture, binding, {
        requestRef: `submitted-${crypto.randomUUID()}`,
        expiresAt: new Date(base.getTime() + 240_000),
      });
      const unavailable = userInputRequestValues(fixture, binding, {
        requestRef: `unavailable-${crypto.randomUUID()}`,
        expiresAt: new Date(base.getTime() + 300_000),
      });
      for (const [index, input] of [older, middle, newest, submitted, unavailable].entries()) {
        expect(await createCodexUserInputRequestWith(
          queryDb(), context(fixture), input, new Date(base.getTime() + index * 1_000),
        )).toMatchObject({ status: "created" });
      }
      expect(await settleCodexUserInputRequestWith(
        queryDb(), context(fixture), {
          requestRef: middle.requestRef,
          expectedRevision: 0,
          state: "terminal",
          now: new Date(base.getTime() + 3_500),
        },
      )).toMatchObject({ status: "transitioned" });
      expect(await claimCodexUserInputRequestDispatchWith(
        queryDb(), context(fixture), {
          requestRef: submitted.requestRef,
          expectedRevision: 0,
          now: new Date(base.getTime() + 4_000),
        },
      )).toMatchObject({ status: "transitioned" });
      expect(await markCodexUserInputRequestSubmittedWith(
        queryDb(), context(fixture), {
          requestRef: submitted.requestRef,
          expectedRevision: 1,
          now: new Date(base.getTime() + 4_100),
        },
      )).toMatchObject({ status: "transitioned" });
      expect(await settleCodexUserInputRequestWith(
        queryDb(), context(fixture), {
          requestRef: unavailable.requestRef,
          expectedRevision: 0,
          state: "unavailable",
          now: new Date(base.getTime() + 4_200),
        },
      )).toMatchObject({ status: "transitioned" });

      const rows = await listCodexUserInputRequestsForRoomWith(
        queryDb(), ownerContext(fixture), { roomId: fixture.room.id, limit: 16 },
      );
      expect(rows.map((row) => row.requestRef)).toEqual([
        unavailable.requestRef,
        newest.requestRef,
        older.requestRef,
      ]);
      expect(rows.map((row) => row.requestRef)).not.toContain(submitted.requestRef);
      expect(await listCodexUserInputRequestsForRoomWith(
        queryDb(), ownerContext(fixture, fixture.other.id), { roomId: fixture.room.id, limit: 16 },
      )).toEqual([]);
      expect((await listCodexUserInputRequestsForRoomWith(
        queryDb(), ownerContext(fixture), { roomId: fixture.room.id, limit: 1 },
      )).map((row) => row.requestRef)).toEqual([unavailable.requestRef]);
      expect(() => listCodexUserInputRequestsForRoomWith(
        queryDb(), ownerContext(fixture), { roomId: fixture.room.id, limit: 0 },
      )).toThrow("between 1 and 16");
      expect(() => listCodexUserInputRequestsForRoomWith(
        queryDb(), ownerContext(fixture), { roomId: fixture.room.id, limit: 17 },
      )).toThrow("between 1 and 16");
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("profile queries derive owner from context and enforce revisions", async () => {
    const fixture = await seedFixture("profiles");
    try {
      const inserted = await insertCodexProfileWith(
        queryDb(),
        ownerContext(fixture),
        { relayId: "relay-second", homeHandle: "home-second", label: "Second" },
      );
      expect(inserted?.userId).toBe(fixture.owner.id);
      expect(await listCodexProfilesWith(queryDb(), ownerContext(fixture))).toHaveLength(
        2,
      );
      expect(
        await listCodexProfilesWith(
          queryDb(),
          ownerContext(fixture, fixture.other.id),
        ),
      ).toHaveLength(0);

      const renamed = await renameCodexProfileWith(
        queryDb(),
        context(fixture),
        fixture.profile.id,
        "Renamed",
        0,
      );
      expect(renamed?.revision).toBe(1);
      expect(
        await renameCodexProfileWith(
          queryDb(),
          context(fixture),
          fixture.profile.id,
          "Lost update",
          0,
        ),
      ).toBeUndefined();
      expect(
        await renameCodexProfileWith(
          queryDb(),
          context(fixture, fixture.other.id),
          fixture.profile.id,
          "Wrong owner",
          1,
        ),
      ).toBeUndefined();
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("official account proof registers a provisional profile and creates only the first default", async () => {
    const fixture = await seedFixture("friendly-registration");
    try {
      await asOwner(fixture.owner.id, (tx) => tx.delete(codexAccountProfiles)
        .where(eq(codexAccountProfiles.id, fixture.profile.id)));
      const provisional = await insertCodexProfileWith(queryDb(), ownerContext(fixture), {
        relayId: "relay-friendly",
        homeHandle: "home-friendly",
        label: "Codex account",
        registrationState: "provisional",
        authState: "login_pending",
      });
      expect(provisional?.registrationState).toBe("provisional");
      await expectProfileSelectionRejected(() => upsertCodexUserPreferenceWith(
        queryDb(), ownerContext(fixture), {
          profileId: provisional!.id, posture: "codex_default", enabled: true, expectedRevision: 0,
        },
      ));
      expect(await registerCodexProfileFromOfficialAccountWith(
        queryDb(), ownerContext(fixture), {
          id: provisional!.id,
          profileGeneration: 0,
          accountGeneration: 1,
          accountEmail: "human@example.com",
          planType: "plus",
          expectedRevision: 0,
        },
      )).toMatchObject({ registrationState: "registered", authState: "signed_in", accountEmail: "human@example.com" });
      expect(await getCodexUserPreferenceWith(queryDb(), ownerContext(fixture))).toMatchObject({
        enabled: true,
        accountProfileId: provisional!.id,
      });
      expect(await registerCodexProfileFromOfficialAccountWith(
        queryDb(), ownerContext(fixture), {
          id: provisional!.id,
          profileGeneration: 0,
          accountGeneration: 0,
          accountEmail: "stale@example.com",
          expectedRevision: 1,
        },
      )).toBeUndefined();
      await asOwner(fixture.owner.id, (tx) => tx.update(codexAccountProfiles)
        .set({ authState: "signed_out" })
        .where(eq(codexAccountProfiles.id, provisional!.id)));
      await upsertCodexUserPreferenceWith(queryDb(), ownerContext(fixture), {
        profileId: null, posture: "codex_default", enabled: false, expectedRevision: 1,
      });
      const second = await insertCodexProfileWith(queryDb(), ownerContext(fixture), {
        relayId: "relay-friendly",
        homeHandle: "home-friendly-2",
        label: "Codex account",
        registrationState: "provisional",
        authState: "login_pending",
      });
      await registerCodexProfileFromOfficialAccountWith(queryDb(), ownerContext(fixture), {
        id: second!.id,
        profileGeneration: 0,
        accountGeneration: 1,
        accountEmail: "second@example.com",
        expectedRevision: 0,
      });
      expect(await getCodexUserPreferenceWith(queryDb(), ownerContext(fixture))).toMatchObject({
        enabled: false,
        accountProfileId: null,
      });
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("provisional registration constraints fail closed through cleanup and missing identity", async () => {
    const fixture = await seedFixture("provisional-constraints");
    try {
      const first = await insertCodexProfileWith(queryDb(), ownerContext(fixture), {
        relayId: "relay-one", homeHandle: "home-one", label: "Codex account",
        registrationState: "provisional", authState: "login_pending",
      });
      expect(await registerCodexProfileFromOfficialAccountWith(queryDb(), ownerContext(fixture), {
        id: first!.id, profileGeneration: 0, accountGeneration: 1, expectedRevision: 0,
      })).toBeUndefined();
      expect((await getCodexProfileWith(queryDb(), ownerContext(fixture), first!.id))?.registrationState).toBe("provisional");
      await expectRejected(() => asOwner(fixture.owner.id, (tx) => tx.update(codexAccountProfiles)
        .set({ authState: "signed_in" })
        .where(eq(codexAccountProfiles.id, first!.id))));
      expect(await beginCodexProfileRemovalWith(
        queryDb(), ownerContext(fixture), { id: first!.id, expectedRevision: 0 },
      )).toMatchObject({ status: "begun" });
      await expectRejected(() => insertCodexProfileWith(queryDb(), ownerContext(fixture), {
        relayId: "relay-one", homeHandle: "home-two", label: "Codex account",
        registrationState: "provisional", authState: "login_pending",
      }));
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("usage snapshot sparse-merges only the exact owner/profile/generation/revision", async () => {
    const fixture = await seedFixture("usage-snapshot");
    try {
      const firstObservedAt = new Date();
      const first = await updateCodexProfileUsageSnapshotWith(
        queryDb(),
        ownerContext(fixture),
        {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration,
          accountGeneration: fixture.profile.accountGeneration,
          expectedRevision: fixture.profile.revision,
          observedAt: firstObservedAt,
          patch: {
            rateLimits: {
              primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: null },
              secondary: null,
              plan: "pro",
              credits: null,
              spendControl: null,
              reached: null,
              observedAt: "2026-08-01T10:00:00.000Z",
              freshness: "live",
            },
          },
        },
      );
      expect(first).toMatchObject({ revision: 1, planType: "pro" });
      const secondObservedAt = new Date();
      const second = await updateCodexProfileUsageSnapshotWith(
        queryDb(),
        ownerContext(fixture),
        {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration,
          accountGeneration: fixture.profile.accountGeneration,
          expectedRevision: 1,
          observedAt: secondObservedAt,
          patch: {
            usage: {
              summary: { lifetimeTokens: "42", peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
              daily: [{ startDate: "2026-08-01", tokens: "42" }],
              observedAt: "2026-08-01T10:01:00.000Z",
              freshness: "live",
            },
          },
        },
      );
      expect(second?.usageSnapshot).toMatchObject({
        schemaVersion: 1,
        rateLimits: { plan: "pro", primary: { usedPercent: 20 } },
        usage: { summary: { lifetimeTokens: "42" } },
      });
      expect(second?.planType).toBe("pro");
      const staleGeneration = await updateCodexProfileUsageSnapshotWith(
        queryDb(), ownerContext(fixture), {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration + 1,
          accountGeneration: fixture.profile.accountGeneration,
          expectedRevision: 2,
          observedAt: new Date(),
          patch: { usage: second!.usageSnapshot!.usage! },
        },
      );
      expect(staleGeneration).toBeUndefined();
      const staleAccountGeneration = await updateCodexProfileUsageSnapshotWith(
        queryDb(), ownerContext(fixture), {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration,
          accountGeneration: fixture.profile.accountGeneration + 1,
          expectedRevision: 2,
          observedAt: new Date(),
          patch: { usage: second!.usageSnapshot!.usage! },
        },
      );
      expect(staleAccountGeneration).toBeUndefined();
      const lostRevision = await updateCodexProfileUsageSnapshotWith(
        queryDb(), ownerContext(fixture), {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration,
          accountGeneration: fixture.profile.accountGeneration,
          expectedRevision: 1,
          observedAt: new Date(),
          patch: { usage: second!.usageSnapshot!.usage! },
        },
      );
      expect(lostRevision).toBeUndefined();
      const wrongOwner = await updateCodexProfileUsageSnapshotWith(
        queryDb(), ownerContext(fixture, fixture.other.id), {
          id: fixture.profile.id,
          profileGeneration: fixture.profile.profileGeneration,
          accountGeneration: fixture.profile.accountGeneration,
          expectedRevision: 2,
          observedAt: new Date(),
          patch: { usage: second!.usageSnapshot!.usage! },
        },
      );
      expect(wrongOwner).toBeUndefined();
      const sibling = await insertCodexProfileWith(
        queryDb(),
        ownerContext(fixture),
        { relayId: fixture.profile.relayId, homeHandle: "usage-snapshot-sibling", label: "Sibling" },
      );
      if (!sibling) throw new Error("sibling profile insert failed");
      const siblingUpdated = await updateCodexProfileUsageSnapshotWith(
        queryDb(), ownerContext(fixture), {
          id: sibling.id,
          profileGeneration: sibling.profileGeneration,
          accountGeneration: sibling.accountGeneration,
          expectedRevision: sibling.revision,
          observedAt: new Date(),
          patch: {
            rateLimits: {
              primary: { usedPercent: 80, windowDurationMins: 60, resetsAt: null },
              secondary: null,
              plan: "plus",
              credits: null,
              spendControl: null,
              reached: null,
              observedAt: "2026-08-01T10:02:00.000Z",
              freshness: "live",
            },
          },
        },
      );
      expect(siblingUpdated?.usageSnapshot?.rateLimits?.primary?.usedPercent).toBe(80);
      const original = await getCodexProfileWith(queryDb(), ownerContext(fixture), fixture.profile.id);
      expect(original?.usageSnapshot?.rateLimits?.primary?.usedPercent).toBe(20);
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("beginning removal clears selections atomically and keeps only removing visible", async () => {
    const fixture = await seedFixture("soft-removal-begin");
    try {
      const preference = await upsertCodexUserPreferenceWith(queryDb(), ownerContext(fixture), {
        profileId: fixture.profile.id,
        posture: "codex_default",
        enabled: true,
        expectedRevision: 0,
      });
      expect(preference).toMatchObject({ enabled: true, revision: 1 });

      expect(
        await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
          id: fixture.profile.id,
          expectedRevision: 1,
        }),
      ).toEqual({ status: "conflict" });
      const begun = await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
        id: fixture.profile.id,
        expectedRevision: 0,
      });
      expect(begun.status).toBe("begun");
      if (begun.status !== "begun") throw new Error("removal did not begin");
      expect(begun.profile).toMatchObject({ removalState: "removing", revision: 1, removedAt: null });
      expect(
        await getCodexUserPreferenceWith(queryDb(), ownerContext(fixture)),
      ).toMatchObject({ enabled: false, accountProfileId: null, revision: 2 });
      expect(await listCodexProfilesWith(queryDb(), context(fixture))).toHaveLength(1);
      expect(
        await renameCodexProfileWith(queryDb(), context(fixture), fixture.profile.id, "nope", 1),
      ).toBeUndefined();
      await expectProfileSelectionRejected(() =>
        upsertCodexUserPreferenceWith(queryDb(), ownerContext(fixture), {
          profileId: fixture.profile.id,
          posture: "codex_default",
          enabled: true,
          expectedRevision: 2,
        }),
      );
      await expectRejected(() =>
        insertCodexBindingWith(queryDb(), context(fixture), bindingValues(fixture)),
      );
      expect(
        await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
          id: fixture.profile.id,
          expectedRevision: 0,
        }),
      ).toMatchObject({ status: "already_removing" });
      expect(
        await beginCodexProfileRemovalWith(queryDb(), context(fixture, fixture.other.id), {
          id: fixture.profile.id,
          expectedRevision: 0,
        }),
      ).toEqual({ status: "conflict" });
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("finalization retains archived binding history and has an exact removed retry", async () => {
    const fixture = await seedFixture("soft-removal-finalize");
    try {
      const binding = await insertCodexBindingWith(queryDb(), context(fixture), bindingValues(fixture));
      if (!binding) throw new Error("binding seed failed");
      const begun = await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
        id: fixture.profile.id,
        expectedRevision: 0,
      });
      expect(begun.status).toBe("begun");

      const finalizeInput = {
        id: fixture.profile.id,
        expectedRevision: 1,
        relayId: fixture.profile.relayId,
        homeHandle: fixture.profile.homeHandle,
        profileGeneration: fixture.profile.profileGeneration,
        accountGeneration: fixture.profile.accountGeneration,
      };
      expect(
        await finalizeCodexProfileRemovalWith(queryDb(), context(fixture), finalizeInput),
      ).toMatchObject({ status: "blocked", selectingPreferenceCount: 0, unarchivedBindingCount: 1 });
      const archived = await archiveCodexBindingWith(
        queryDb(), context(fixture), bindingLocator(fixture, binding.id), 0,
      );
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      const finalized = await finalizeCodexProfileRemovalWith(queryDb(), context(fixture), finalizeInput);
      expect(finalized.status).toBe("finalized");
      if (finalized.status !== "finalized") throw new Error("removal did not finalize");
      expect(finalized.profile).toMatchObject({ removalState: "removed", authState: "signed_out", revision: 2 });
      expect(await listCodexProfilesWith(queryDb(), context(fixture))).toHaveLength(0);
      expect(await getCodexProfileWith(queryDb(), context(fixture), fixture.profile.id)).toBeUndefined();
      expect(
        await finalizeCodexProfileRemovalWith(queryDb(), context(fixture), finalizeInput),
      ).toMatchObject({ status: "already_removed" });
      const [retained] = await asOwner(fixture.owner.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.id, binding.id)),
      );
      expect(retained?.accountProfileId).toBe(fixture.profile.id);
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("archives all retained live bindings only for the exact removing profile identity", async () => {
    const fixture = await seedFixture("soft-removal-archive-profile-bindings");
    try {
      const first = await insertCodexBindingWith(queryDb(), context(fixture), bindingValues(fixture));
      if (!first) throw new Error("first binding seed failed");
      const begun = await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
        id: fixture.profile.id,
        expectedRevision: 0,
      });
      expect(begun.status).toBe("begun");
      if (begun.status !== "begun") throw new Error("removal did not begin");
      const identity = {
        id: begun.profile.id,
        relayId: begun.profile.relayId,
        homeHandle: begun.profile.homeHandle,
        profileGeneration: begun.profile.profileGeneration,
        accountGeneration: begun.profile.accountGeneration,
        expectedRevision: begun.profile.revision,
      };

      expect(
        await archiveCodexProfileBindingsForRemovalWith(ownerDb, ownerContext(fixture), {
          ...identity,
          homeHandle: "wrong-home",
        }),
      ).toEqual({ status: "conflict" });
      const archived = await archiveCodexProfileBindingsForRemovalWith(ownerDb, ownerContext(fixture), identity);
      expect(archived).toEqual({ status: "archived", count: 1 });
      const retained = await asOwner(fixture.owner.id, (tx) =>
        tx.select().from(codexThreadBindings).where(eq(codexThreadBindings.accountProfileId, fixture.profile.id)),
      );
      expect(retained).toHaveLength(1);
      for (const binding of retained) {
        expect(binding).toMatchObject({ state: "archived" });
        expect(binding.archivedAt).toBeInstanceOf(Date);
        expect(binding.revision).toBe(1);
      }
      expect(
        await finalizeCodexProfileRemovalWith(queryDb(), context(fixture), identity),
      ).toMatchObject({ status: "finalized" });
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("profile-removal worklist is owner/profile exact and never includes a sibling profile", async () => {
    const fixture = await seedFixture("soft-removal-worklist");
    let siblingBindingId: string | undefined;
    let siblingRunId: string | undefined;
    let siblingJobId: string | undefined;
    let siblingTaskId: string | undefined;
    try {
      const targetBinding = await insertCodexBindingWith(
        queryDb(), context(fixture), bindingValues(fixture, "target"),
      );
      if (!targetBinding) throw new Error("target binding seed failed");
      const siblingProfile = await insertCodexProfileWith(queryDb(), ownerContext(fixture), {
        relayId: "relay-sibling",
        homeHandle: "home-sibling",
        label: "Sibling",
      });
      if (!siblingProfile) throw new Error("sibling profile seed failed");
      const [siblingTask] = await ownerDb
        .insert(tasks)
        .values({
          ownerId: fixture.owner.id,
          requestorId: fixture.owner.id,
          agentId: fixture.agent.id,
          prompt: "sibling retained binding",
          callingRoomId: fixture.room.id,
          targetRoomId: fixture.room.id,
        })
        .returning({ id: tasks.id });
      siblingTaskId = siblingTask?.id;
      const [siblingJob] = await ownerDb
        .insert(jobs)
        .values({
          ownerId: fixture.owner.id,
          requestorId: fixture.owner.id,
          laneKey: `room:${fixture.room.id}`,
          roomId: fixture.room.id,
          type: "foreground",
        })
        .returning({ id: jobs.id });
      siblingJobId = siblingJob?.id;
      if (!siblingTask || !siblingJob) throw new Error("sibling task seed failed");
      const [siblingRun] = await ownerDb
        .insert(taskRuns)
        .values({
          taskId: siblingTask.id,
          jobId: siblingJob.id,
          graphThreadId: `query-sibling:${crypto.randomUUID()}`,
        })
        .returning({ id: taskRuns.id });
      siblingRunId = siblingRun?.id;
      if (!siblingRun) throw new Error("sibling run seed failed");
      const siblingFixture = {
        ...fixture,
        profile: siblingProfile,
        task: siblingTask,
        job: siblingJob,
        taskRun: siblingRun,
      };
      const siblingBinding = await insertCodexBindingWith(
        queryDb(), context(fixture), {
          ...bindingValues(siblingFixture, "sibling"),
          bindingKind: "task",
        },
      );
      if (!siblingBinding) throw new Error("sibling binding seed failed");
      siblingBindingId = siblingBinding.id;
      const begun = await beginCodexProfileRemovalWith(queryDb(), context(fixture), {
        id: fixture.profile.id,
        expectedRevision: 0,
      });
      expect(begun).toMatchObject({ status: "begun" });

      expect(
        await listCodexProfileRemovalTaskBindingWorkWith(
          ownerDb, ownerContext(fixture), fixture.profile.id,
        ),
      ).toEqual([{
        taskId: fixture.task.id,
        jobId: fixture.job.id,
      }]);
      expect(
        await listCodexProfileRemovalTaskBindingWorkWith(
          ownerDb, ownerContext(fixture), siblingProfile.id,
        ),
      ).toEqual([]);
      await expectRejected(() =>
        runtimeDb.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner.id}, true)`);
          await tx.execute(sql`SELECT set_config('app.current_agent_id', ${fixture.agent.id}, true)`);
          return tx.execute(sql`
            SELECT task_id, job_id
            FROM public.app_list_codex_profile_removal_work(
              ${fixture.owner.id}::uuid,
              ${fixture.profile.id}::uuid
            )
          `);
        }),
      );
      await expectRejected(() =>
        asOwner(fixture.other.id, (tx) => tx.execute(sql`
          SELECT task_id, job_id
          FROM public.app_list_codex_profile_removal_work(
            ${fixture.owner.id}::uuid,
            ${fixture.profile.id}::uuid
          )
        `)),
      );
    } finally {
      // The common fixture has one task/job/run. This test intentionally adds
      // a sibling profile's retained work, so remove its FK chain explicitly
      // before the common Room cleanup.
      if (siblingBindingId) {
        await asOwner(fixture.owner.id, (tx) =>
          tx.delete(codexThreadBindings).where(eq(codexThreadBindings.id, siblingBindingId!)),
        );
      }
      if (siblingRunId) await ownerDb.delete(taskRuns).where(eq(taskRuns.id, siblingRunId));
      if (siblingJobId) await ownerDb.delete(jobs).where(eq(jobs.id, siblingJobId));
      if (siblingTaskId) await ownerDb.delete(tasks).where(eq(tasks.id, siblingTaskId));
      await cleanFixture(fixture);
    }
  });

  test("owner default starts disabled until explicitly authored", async () => {
    const fixture = await seedFixture("owner-preference");
    try {
      expect(
        await getCodexUserPreferenceWith(queryDb(), { userId: fixture.owner.id }),
      ).toMatchObject({
        userId: fixture.owner.id,
        enabled: false,
        accountProfileId: null,
        defaultPosture: "codex_default",
        revision: 0,
      });

      const created = await upsertCodexUserPreferenceWith(
        queryDb(),
        { userId: fixture.owner.id },
        {
          profileId: fixture.profile.id,
          posture: "full_access_headless",
          enabled: true,
          expectedRevision: 0,
        },
      );
      expect(created).toMatchObject({ enabled: true, revision: 1 });
      expect(
        await upsertCodexUserPreferenceWith(
          queryDb(),
          { userId: fixture.owner.id },
          {
            profileId: fixture.profile.id,
            posture: "codex_default",
            enabled: true,
            expectedRevision: 0,
          },
        ),
      ).toBeUndefined();
      await expectProfileSelectionRejected(() =>
        upsertCodexUserPreferenceWith(
          queryDb(),
          { userId: fixture.other.id },
          {
            profileId: fixture.profile.id,
            posture: "codex_default",
            enabled: true,
            expectedRevision: 0,
          },
        ),
      );
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("operational updates, exact rebind, and archive are revision checked", async () => {
    const fixture = await seedFixture("lifecycle");
    try {
      const binding = await insertCodexBindingWith(
        queryDb(),
        context(fixture),
        bindingValues(fixture),
      );
      if (!binding) throw new Error("binding insert failed");

      expect(
        await updateCodexBindingStateWith(
          queryDb(),
          context(fixture),
          {
            ...bindingLocator(fixture, binding.id),
            taskId: crypto.randomUUID(),
          },
          "active",
          0,
        ),
      ).toBeUndefined();

      const needsRebind = await updateCodexBindingStateWith(
        queryDb(),
        context(fixture),
        bindingLocator(fixture, binding.id),
        "needs_rebind",
        0,
        { lastTurnId: "turn-1", lastItemCursor: "item-1" },
      );
      expect(needsRebind).toMatchObject({
        state: "needs_rebind",
        revision: 1,
      });
      expect(
        await rebindCodexBindingWith(queryDb(), context(fixture), {
          binding: bindingLocator(fixture, binding.id),
          expectedRevision: 0,
          expectedBindingGeneration: 0,
          relaySessionId: "stale",
          desktopSessionId: "stale",
          capabilityRevision: 2,
          workspaceRef: "stale",
          workspaceRevision: 2,
          workspaceIssuedAt: new Date("2026-07-27T10:01:00.000Z"),
          workspaceExpiresAt: new Date("2026-07-27T10:06:00.000Z"),
          childGeneration: 2,
          expected: rebindExpectation(binding),
        }),
      ).toBeUndefined();

      const exactExpectation = rebindExpectation(binding);
      const mismatches: Array<
        [string, typeof exactExpectation]
      > = [
        [
          "pairing generation",
          { ...exactExpectation, pairingGenerationRef: "wrong-pairing" },
        ],
        [
          "workspace fingerprint",
          { ...exactExpectation, workspaceFingerprint: "wrong-fingerprint" },
        ],
        [
          "account profile",
          { ...exactExpectation, accountProfileId: crypto.randomUUID() },
        ],
        [
          "profile generation",
          {
            ...exactExpectation,
            profileGeneration: exactExpectation.profileGeneration + 1,
          },
        ],
        [
          "runtime generation",
          {
            ...exactExpectation,
            runtimeGeneration: exactExpectation.runtimeGeneration + 1,
          },
        ],
        [
          "sandbox posture",
          {
            ...exactExpectation,
            codexSandboxMode: "danger-full-access",
          },
        ],
        [
          "approval posture",
          { ...exactExpectation, codexApprovalPolicy: "never" },
        ],
        [
          "selected model",
          { ...exactExpectation, selectedModel: "different-model" },
        ],
      ];
      for (const [dimension, expected] of mismatches) {
        expect(
          await rebindCodexBindingWith(queryDb(), context(fixture), {
            binding: bindingLocator(fixture, binding.id),
            expectedRevision: 1,
            expectedBindingGeneration: 0,
            relaySessionId: "new-session",
            desktopSessionId: "new-desktop",
            capabilityRevision: 2,
            workspaceRef: "new-workspace",
            workspaceRevision: 2,
            workspaceIssuedAt: new Date("2026-07-27T10:01:00.000Z"),
            workspaceExpiresAt: new Date("2026-07-27T10:06:00.000Z"),
            childGeneration: 2,
            expected,
          }),
          dimension,
        ).toBeUndefined();
        expect(
          await getActiveCodexBindingForTaskWith(
            queryDb(),
            context(fixture),
            fixture.task.id,
          ),
          dimension,
        ).toMatchObject({
          id: binding.id,
          state: "needs_rebind",
          revision: 1,
          bindingGeneration: 0,
        });
      }

      const rebound = await rebindCodexBindingWith(
        queryDb(),
        context(fixture),
        {
          binding: bindingLocator(fixture, binding.id),
          expectedRevision: 1,
          expectedBindingGeneration: 0,
          relaySessionId: "new-session",
          desktopSessionId: "new-desktop",
          capabilityRevision: 2,
          workspaceRef: "new-workspace",
          workspaceRevision: 2,
          workspaceIssuedAt: new Date("2026-07-27T10:01:00.000Z"),
          workspaceExpiresAt: new Date("2026-07-27T10:06:00.000Z"),
          childGeneration: 2,
          expected: exactExpectation,
        },
      );
      expect(rebound).toMatchObject({
        state: "active",
        revision: 2,
        bindingGeneration: 1,
      });

      expect(
        await archiveCodexBindingWith(
          queryDb(),
          context(fixture),
          bindingLocator(fixture, binding.id),
          1,
        ),
      ).toBeUndefined();
      const archived = await archiveCodexBindingWith(
        queryDb(),
        context(fixture),
        bindingLocator(fixture, binding.id),
        2,
      );
      expect(archived?.state).toBe("archived");
      expect(
        await getActiveCodexBindingForTaskWith(
          queryDb(),
          context(fixture),
          fixture.task.id,
        ),
      ).toBeUndefined();
    } finally {
      await cleanFixture(fixture);
    }
  });

  test("material replacement is atomic and rolls archive back on insert failure", async () => {
    const fixture = await seedFixture("replace");
    try {
      const original = await insertCodexBindingWith(
        queryDb(),
        context(fixture),
        bindingValues(fixture, "original"),
      );
      if (!original) throw new Error("original binding failed");

      await expectRejected(() =>
        replaceCodexBindingWith(queryDb(), context(fixture), {
          current: bindingLocator(fixture, original.id),
          expectedRevision: 0,
          replacement: {
            ...bindingValues(fixture, "invalid"),
            workspaceExpiresAt: new Date("2026-07-27T09:00:00.000Z"),
          },
        }),
      );
      const stillLive = await getActiveCodexBindingForTaskWith(
        queryDb(),
        context(fixture),
        fixture.task.id,
      );
      expect(stillLive).toMatchObject({
        id: original.id,
        state: "opening",
        revision: 0,
        archivedAt: null,
      });

      const replaced = await replaceCodexBindingWith(
        queryDb(),
        context(fixture),
        {
          current: bindingLocator(fixture, original.id),
          expectedRevision: 0,
          replacement: bindingValues(fixture, "successor"),
        },
      );
      expect(replaced?.archived).toMatchObject({
        id: original.id,
        state: "archived",
        revision: 1,
      });
      expect(replaced?.replacement.id).not.toBe(original.id);
      expect(
        await replaceCodexBindingWith(queryDb(), context(fixture), {
          current: bindingLocator(fixture, original.id),
          expectedRevision: 0,
          replacement: bindingValues(fixture, "lost-update"),
        }),
      ).toBeUndefined();
    } finally {
      await cleanFixture(fixture);
    }
  });
});
