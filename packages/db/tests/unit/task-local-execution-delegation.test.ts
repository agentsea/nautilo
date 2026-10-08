import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import type { DirectDatabase } from "../../src/config/direct-database";
import { updateTask, updateTaskIfCurrent, memoizeTaskExecutionCoordinates, taskLocalExecutionOfflineMarker, taskLocalExecutionOfflinePhase, isTaskLocalExecutionOfflineWait,
  parkTaskLocalExecutionOffline, rearmTaskLocalExecutionOffline, claimTaskLocalExecutionOfflineRun,
  transitionTaskLifecyclePaused, transitionTaskLifecycleTerminal, markTaskAwaitingIfCurrentRun, listTaskLocalExecutionOfflineWaits, TASK_LOCAL_EXECUTION_OFFLINE_TEXT,
  taskRequiresLocalExecutionRecapture, TASK_LOCAL_EXECUTION_RECREATE_TEXT, markTaskAwaiting, rescheduleCron, listAwaitingTaskRunsForOwner } from "../../src/queries/tasks";
import type { TaskRun } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";
import type { NewTask, Task } from "../../src/schema/tasks";
function fixture() {
  let patch: unknown;
  let predicate: SQL | undefined;
  const chain = { set(value: unknown) { patch = value; return chain; }, where(value: SQL) { predicate = value; return chain; }, returning: async () => [] };
  return { db: { update: () => chain } as unknown as DirectDatabase, patch: () => patch, predicate: () => predicate };
}
test("ordinary definition edits clear delegation in the same database update", async () => {
  for (const patch of [{ prompt: "changed" }, { toolsMode: "auto" as const }, { cron: "0 * * * *" },
    { targetRoomId: "room" }, { metadata: {} }, { awaitResponse: true }, { cryptoObjectId: "new-definition-object" }]) {
    const f = fixture(); await updateTask(f.db, "task", patch);
    expect(f.patch()).toMatchObject({ ...patch, localExecutionDelegation: null });
  }
});
test("optimistic definition updates clear consent while lifecycle bookkeeping preserves it", async () => {
  const f = fixture(); await updateTaskIfCurrent(f.db, { id: "task", ownerId: "human", expectedStatus: "paused",
    expectedMutationVersion: "1", expectedContentRevision: 0 }, { prompt: "new" });
  expect(f.patch()).toMatchObject({ localExecutionDelegation: null });
  await updateTask(f.db, "task", { status: "running", lastFiredAt: new Date() });
  expect(f.patch()).not.toHaveProperty("localExecutionDelegation");
});
test("generic Task updates cannot inject a delegation", async () => {
  const f = fixture();
  await rejects(updateTask(f.db, "task", { localExecutionDelegation: {} } as Partial<NewTask>), /cannot author/);
  expect(f.patch()).toBeUndefined();
});

test("closed execution cache writes preserve consent and fail on lost definition CAS", async () => {
  const f = fixture();
  const observed = makeTask();
  await rejects(memoizeTaskExecutionCoordinates(f.db, observed, { targetRoomId: "room" }), /definition changed/);
  expect(f.patch()).toMatchObject({ targetRoomId: "room" });
  expect(f.patch()).not.toHaveProperty("localExecutionDelegation");
  const query = new PgDialect().sqlToQuery(f.predicate()!);
  expect(query.sql).toContain('"local_execution_delegation" is null');
  expect(query.sql).toContain('"target_room_id" is null or');
  expect(query.sql).toContain('"tools_whitelist" =');
  expect(query.params).toContain("fixture-version-unrelated");
  await rejects(memoizeTaskExecutionCoordinates(f.db, observed, { prompt: "spoof" } as never), /Invalid/);

  const protectedObserved: Task = { ...observed, runAt: new Date("2026-10-08T12:00:00.000Z"),
    targetUserIds: ["requestor-1", "peer-1"], toolsWhitelist: ["exec_command", "write_stdin"],
    selectionSpec: { objective: "smart" }, contentRepresentation: "protected", contentNamespaceId: "namespace-1",
    contentRevision: 1, cryptoObjectId: "definition-object", cryptoAccessRevision: 2,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x42), cryptoMappingState: "verified" };
  await rejects(memoizeTaskExecutionCoordinates(f.db, protectedObserved, { scopeId: "scope-1" }), /definition changed/);
  const protectedQuery = new PgDialect().sqlToQuery(f.predicate()!);
  for (const column of ["await_response", "crypto_object_id", "crypto_access_revision", "crypto_required_namespace_fingerprint", "crypto_mapping_state"]) {
    expect(protectedQuery.sql).toContain(`"${column}" =`);
  }
  expect(protectedQuery.params).toContain("2026-10-08T12:00:00.000Z");
  expect(protectedQuery.params).toContain('{"objective":"smart"}');
  expect(protectedQuery.params).toContain('{"requestor-1","peer-1"}');
  expect(protectedQuery.params).toContain('{"exec_command","write_stdin"}');
});

function makeTask(): Task { return {
    id: "task",
    ownerId: "owner-1",
    requestorId: "requestor-1",
    agentId: "agent-1",
    prompt: "fixture-version-unrelated",
    expectedOutput: null,
    preset: "task",
    scheduleKind: "now",
    runAt: null,
    cron: null,
    timezone: "UTC",
    catchup: "run_once",
    callingRoomId: null,
    targetChat: "orphan",
    targetChatHandle: null,
    targetRoomId: null,
    resultDelivery: "wake",
    targetUserIds: [],
    useScope: false,
    scopeId: null,
    toolsMode: "auto",
    toolsWhitelist: [],
    awaitResponse: false,
    selectionProfile: "balanced",
    selectionSpec: null,
    requestedModelId: null,
    fundingMode: "legacy_server",
    timeLimitSeconds: null,
    parentTaskId: null,
    depth: 0,
    status: "running",
    nextFireAt: null,
    lastFiredAt: null,
    fireLockId: null,
    fireLockedAt: null,
    lastError: null,
    metadata: {},
    localExecutionDelegation: null,
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
    createdAt: new Date(),
    updatedAt: new Date(),
    cancelledAt: null,
  }; }

function offlineFixture() {
  let task = { ...makeTask(), localExecutionDelegation: { version: 1, humanUserId: "requestor-1", agentId: "agent-1", sourceRoomId: "source-room",
    sourceConversationId: "source-thread", rootTaskId: "task", projectGrantId: "grant", ceiling: "basic", profile: null,
    target: { instanceId: "", relayId: "original-mac", pairingGeneration: "original-pairing", serverOrigin: "https://server.example",
      serverFingerprint: "server-fingerprint" } } as Task["localExecutionDelegation"] };
  let run = { id: "run", taskId: task.id, jobId: "job", graphThreadId: "thread", status: "running",
    modelId: "model", fundingBinding: null, fundingPredecessorRunId: null, resultText: null,
    startedAt: new Date(), completedAt: null, lastError: null, resultRepresentation: "ordinary",
    resultContentNamespaceId: null, resultRevision: 0, resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null, resultCryptoMappingState: "unmapped" } as TaskRun;
  const predicates: SQL[] = [];
  const writes: Record<string, unknown>[] = [];
  let latest = run.id;
  let missTask = false;
  let missRun = false;
  let selection = 0;
  const db = { transaction: async (work: (tx: DirectDatabase) => Promise<unknown>) => { selection = 0; return work(db as unknown as DirectDatabase); },
    select: () => { let table: unknown; let ordered = false; const chain = {
      from(value: unknown) { table = value; return chain; },
      where(value: SQL) { predicates.push(value); return chain; }, orderBy() { ordered = true; return chain; }, limit() { return chain; },
      for: async () => { selection++;
        if (table === tasks) return missTask ? [] : [structuredClone(task)];
        if (ordered) return [{ ...run, id: latest }];
        return missRun ? [] : [structuredClone(run)];
      },
    }; return chain; },
    update: (table: unknown) => { let patch: Record<string, unknown>; const chain = {
      set(value: Record<string, unknown>) { patch = value; return chain; },
      where() { writes.push(patch); if (table === tasks) task = { ...task, ...patch } as Task;
        else run = { ...run, ...patch } as TaskRun; return chain; },
      returning: async () => [structuredClone(table === tasks ? task : run)],
      then(resolve: (value: unknown[]) => unknown) { return Promise.resolve([]).then(resolve); },
    }; return chain; },
  };
  return { db: db as unknown as DirectDatabase, task: () => structuredClone(task), run: () => structuredClone(run),
    setTask: (patch: Partial<Task>) => { task = { ...task, ...patch }; },
    setRun: (patch: Partial<TaskRun>) => { run = { ...run, ...patch }; }, predicates, writes,
    replaceLatest: () => { latest = "newer-run"; }, loseTaskCAS: () => { missTask = true; }, loseRunCAS: () => { missRun = true; } };
}

test("offline wait parks and reclaims one untouched Run without changing consent or thread", async () => {
  const f = offlineFixture(); const original = f.run();
  expect(await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: original, jobId: "job", phase: "cold" })).toBe(true);
  expect(f.task().status).toBe("paused"); expect(f.task().lastError).toBe(TASK_LOCAL_EXECUTION_OFFLINE_TEXT);
  expect(isTaskLocalExecutionOfflineWait(f.task(), f.run())).toBe(true);
  expect(await rearmTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run() })).toBe(true);
  f.setTask({ fireLockId: "claim" });
  expect(await claimTaskLocalExecutionOfflineRun(f.db, { task: f.task(), run: f.run(), fireLockId: "claim" }))
    .toMatchObject({ id: original.id, graphThreadId: original.graphThreadId, modelId: original.modelId, status: "running", jobId: null });
  expect(f.task().localExecutionDelegation).toEqual(offlineFixture().task().localExecutionDelegation);
});
test("offline identity is stable across JSON ordering but invalidated by definition and target edits", () => {
  const f = offlineFixture(); const task = f.task(); task.metadata = { b: 2, a: 1 };
  const marker = taskLocalExecutionOfflineMarker(task);
  expect(taskLocalExecutionOfflineMarker({ ...task, metadata: { a: 1, b: 2 } })).toBe(marker);
  for (const patch of [{ prompt: "edited" }, { agentId: "other" }, { requestorId: "other" },
    { localExecutionDelegation: { version: 1, target: { pairingGeneration: "replacement" } } }, { contentRevision: 1 }]) {
    expect(taskLocalExecutionOfflineMarker({ ...task, ...patch } as Task)).not.toBe(marker);
  }
});
test("exact definition, Run and latest-occurrence fences refuse stale parking without writes", async () => {
  for (const kind of ["task", "run", "latest"] as const) {
    const f = offlineFixture();
    if (kind === "task") f.loseTaskCAS(); else if (kind === "run") f.loseRunCAS(); else f.replaceLatest();
    expect(await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "cold" })).toBe(false);
    expect(f.writes).toHaveLength(0);
  }
  const f = offlineFixture(); await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "cold" });
  const queries = f.predicates.map(value => new PgDialect().sqlToQuery(value));
  for (const field of ["prompt", "metadata", "local_execution_delegation", "crypto_access_revision", "fire_lock_id", "status", "last_error"]) {
    expect(queries[0]!.sql).toContain(`"${field}"`);
  }
  expect(queries[2]!.sql).toContain('"job_id" ='); expect(queries[2]!.params).toContain("job");
});
test("output, completed runs, unknown outcomes and foreign Jobs are never offline replay candidates", async () => {
  for (const patch of [{ resultText: "already executed" }, { completedAt: new Date() }, { lastError: "outcome_unknown" },
    { resultRepresentation: "protected" as const }, { jobId: "other" }]) {
    const f = offlineFixture(); f.setRun(patch);
    expect(await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "cold" })).toBe(false);
    expect(f.writes).toHaveLength(0);
  }
});
test("explicit Pause disables auto reconnect but preserves the original Run for explicit Resume", async () => {
  const f = offlineFixture(); await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "cold" });
  expect((await transitionTaskLifecyclePaused(f.db, f.task().id)).outcome).toBe("already_paused");
  expect(f.task().lastError).toContain("Paused by you");
  expect(await rearmTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run() })).toBe(false);
  f.setTask({ status: "pending", fireLockId: "explicit-resume" });
  expect(await claimTaskLocalExecutionOfflineRun(f.db, { task: f.task(), run: f.run(), fireLockId: "explicit-resume" }))
    .toMatchObject({ id: "run", status: "running" });
});
test("definition edits and newer occurrences cannot rearm or reclaim the old Run", async () => {
  for (const kind of ["edit", "newer"] as const) {
    const f = offlineFixture(); await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "cold" });
    if (kind === "edit") f.setTask({ prompt: "new brief" }); else f.replaceLatest();
    expect(await rearmTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run() })).toBe(false);
    f.setTask({ status: "pending", fireLockId: "claim" });
    expect(await claimTaskLocalExecutionOfflineRun(f.db, { task: f.task(), run: f.run(), fireLockId: "claim" })).toBeUndefined();
  }
});


test("checkpoint waits retain explicit phase and original Run instead of gaining cold replay", async () => {
  const f = offlineFixture();
  expect(await parkTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run(), jobId: "job", phase: "checkpoint" })).toBe(true);
  expect(taskLocalExecutionOfflinePhase(f.task(), f.run())).toBe("checkpoint");
  expect(f.run().lastError).not.toBe(taskLocalExecutionOfflineMarker(f.task(), "cold"));
  expect(await rearmTaskLocalExecutionOffline(f.db, { task: f.task(), run: f.run() })).toBe(true);
  f.setTask({ fireLockId: "claim" });
  expect(await claimTaskLocalExecutionOfflineRun(f.db, { task: f.task(), run: f.run(), fireLockId: "claim" }))
    .toMatchObject({ id: "run", graphThreadId: "thread", status: "running" });
});


test("offline keyset page excludes every older occurrence before applying the batch limit", async () => {
  let predicate: SQL | undefined;
  let limit: number | undefined;
  let selections = 0;
  const db = { select: () => {
    const outer = selections++ === 0;
    let table: unknown;
    let localPredicate: SQL | undefined;
    const chain = { from(value: unknown) { table = value; return chain; }, innerJoin() { return chain; },
      where(value: SQL) { localPredicate = value; if (outer) predicate = value; return chain; }, orderBy() { return chain; },
      limit(value: number) { limit = value; return Promise.resolve([]); },
      getSQL() { return sql`select 1 from ${table} where ${localPredicate}`; } };
    return chain;
  } } as unknown as DirectDatabase;
  await listTaskLocalExecutionOfflineWaits(db, { limit: 1, afterTaskId: "previous-task" });
  const query = new PgDialect().sqlToQuery(predicate!);
  expect(limit).toBe(1);
  expect(query.sql).toContain('not exists');
  expect(query.sql).toContain('"task_run_order_reference"."task_id" = "task_runs"."task_id"');
  expect(query.sql).toContain('"task_run_order_reference"."started_at" > "task_runs"."started_at"');
  expect(query.sql).toContain('"task_run_order_reference"."started_at" = "task_runs"."started_at"');
  expect(query.sql).toContain('"task_run_order_reference"."id" > "task_runs"."id"');
  // The newer-occurrence exclusion has no paused-only predicate: a newer
  // running/completed Run also prevents revival of any historical wait.
  expect(query.sql).not.toContain('"task_run_order_reference"."status"');
  expect(query.params).toContain("previous-task");
});


test("definition removal pauses old delegated nonterminal rows and retains repair across later edits", async () => {
  const f = fixture(); await updateTask(f.db, "task", { prompt: "edited", status: "pending", lastError: null });
  const patch = f.patch() as Record<string, SQL>;
  for (const key of ["status", "lastError", "fireLockId", "fireLockedAt"]) {
    const query = new PgDialect().sqlToQuery(patch[key]!);
    expect(query.sql).toContain('"tasks"."local_execution_delegation" IS NOT NULL');
    expect(query.sql).toContain('"tasks"."last_error" IS NOT DISTINCT FROM');
    expect(query.sql).toContain("NOT IN ('completed', 'cancelled', 'errored')");
    expect(query.params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  }
  expect(new PgDialect().sqlToQuery(patch["status"]!).sql).toContain("THEN 'paused'");
  expect(new PgDialect().sqlToQuery(patch["lastError"]!).params.filter(value => value === TASK_LOCAL_EXECUTION_RECREATE_TEXT)).toHaveLength(2);
  await updateTask(f.db, "task", { localExecutionDelegation: null }); expect(f.patch()).toHaveProperty("status");
  await updateTask(f.db, "task", { lastFiredAt: new Date() }); expect(f.patch()).not.toHaveProperty("status");
});

test("bookkeeping and queued Resume cannot erase repair while cancellation stays possible", async () => {
  const f = fixture(); await updateTask(f.db, "task", { status: "pending", lastError: null });
  let query = new PgDialect().sqlToQuery(f.predicate()!);
  expect(query.sql).toContain('"tasks"."local_execution_delegation" IS NULL'); expect(query.params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  await updateTaskIfCurrent(f.db, { id: "task", ownerId: "owner", expectedStatus: "paused", expectedMutationVersion: "1", expectedContentRevision: 0 }, { status: "pending", lastError: null });
  query = new PgDialect().sqlToQuery(f.predicate()!); expect(query.sql).toContain('xmin::text'); expect(query.params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  await markTaskAwaiting(f.db, "task"); expect(new PgDialect().sqlToQuery(f.predicate()!).params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  await rescheduleCron(f.db, "task", new Date()); expect(new PgDialect().sqlToQuery(f.predicate()!).params).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
  await updateTask(f.db, "task", { status: "cancelled" }); expect(new PgDialect().sqlToQuery(f.predicate()!).params).not.toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
});

test("old running finalizers cannot overwrite edited Task repair state but Stop can", async () => {
  for (const status of ["completed", "errored"] as const) {
    const f = offlineFixture(); f.setTask({ status: "paused", localExecutionDelegation: null, lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
    expect(taskRequiresLocalExecutionRecapture(f.task())).toBe(true);
    expect(await transitionTaskLifecycleTerminal(f.db, { taskId: "task", runId: "run", runStatus: status, taskStatus: status }))
      .toMatchObject({ transitioned: false, outcome: "authority_changed", task: { status: "paused", lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT } });
    expect(f.run()).toMatchObject({ status: "cancelled", lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT, resultText: null });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).not.toHaveProperty("resultText");
  }
  const f = offlineFixture(); f.setTask({ status: "paused", localExecutionDelegation: null, lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
  expect(await transitionTaskLifecycleTerminal(f.db, { taskId: "task", taskStatus: "cancelled", runStatus: "cancelled" }))
    .toMatchObject({ transitioned: true, task: { status: "cancelled" }, run: { status: "cancelled" } });
  expect(taskRequiresLocalExecutionRecapture({ localExecutionDelegation: null, lastError: null })).toBe(false);
});


test("interrupted old workers settle only their Run after a definition edit, never reopen approval", async () => {
  const f = offlineFixture(); f.setTask({ status: "paused", localExecutionDelegation: null, lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT });
  expect(await markTaskAwaitingIfCurrentRun(f.db, { taskId: "task", taskRunId: "run" }))
    .toMatchObject({ transitioned: false, task: { status: "paused", lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT }, run: { status: "cancelled" } });
  expect(f.run().resultText).toBeNull(); expect(f.writes).toHaveLength(1);
});

test("interrupt parking requires the current live Task and latest exact Run", async () => {
  for (const change of ["pause", "stop", "new_run"] as const) {
    const f = offlineFixture();
    if (change === "new_run") f.replaceLatest(); else f.setTask({ status: change === "pause" ? "paused" : "cancelled" });
    expect((await markTaskAwaitingIfCurrentRun(f.db, { taskId: "task", taskRunId: "run" })).transitioned).toBe(false);
    expect(f.writes).toHaveLength(0);
  }
  const f = offlineFixture();
  expect(await markTaskAwaitingIfCurrentRun(f.db, { taskId: "task", taskRunId: "run" })).toMatchObject({ transitioned: true, task: { status: "awaiting" }, run: { status: "awaiting" } });
});


test("approval attention candidates do not broaden ordinary Task management listings", async () => {
  let predicate: SQL | undefined;
  const chain = { from: () => chain, innerJoin: () => chain, where(value: SQL) { predicate = value; return chain; }, orderBy: async () => [] };
  const db = { selectDistinctOn: () => chain } as unknown as DirectDatabase;
  await listAwaitingTaskRunsForOwner(db, "viewer");
  const management = new PgDialect().sqlToQuery(predicate!);
  expect(management.sql).toContain('"tasks"."owner_id" =');
  expect(management.sql).not.toContain('"tasks"."requestor_id" =');
  await listAwaitingTaskRunsForOwner(db, "viewer", { approvalRecipient: true });
  const attention = new PgDialect().sqlToQuery(predicate!);
  expect(attention.sql).toContain('"tasks"."local_execution_delegation" is null');
  expect(attention.sql).toContain('"tasks"."local_execution_delegation" is not null');
  expect(attention.sql).toContain('"tasks"."requestor_id" =');
  expect(attention.params).toContain("viewer");
  expect(attention.params).toContain("awaiting");
});
