import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createTask, getTaskById, getTaskRuns, insertTaskRun, markTaskRunStatus, updateTask, jobs, eq, taskRuns, tasks } from "@nautilo/db";
import { createNautiloGraph, createCheckpointSaver, defaultPostModelDeps, setRelayRegistry, getRelayRegistry,
  NoProgressError, RelayUnavailableError, ProviderTimeoutError, assertSecurityResearchResumeBinding, type ToolRelayRegistry } from "@nautilo/agent";
import { getPolicyResolver } from "@nautilo/trust";
import { SECURITY_SCAN_INITIAL_LANES, securityScanToolResultSchema } from "@nautilo/types";
import { cleanupTestUser, closeDirectDb, getDirectDb, setupTestDb } from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { dispatchTaskRun, type TaskJobManager } from "../../src/tasks/dispatch-task-run";
import { pauseTask, unpauseTask } from "../../src/tasks/lifecycle";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import { taskRunExecutor, _setTaskRunExecutorRunnerForTests } from "../../src/tasks/task-run-executor";
import { _setSecurityReportArtifactWriterForTests, _setSecurityReportExporterForTests } from "../../src/tasks/security-report-artifact";
import { recordSecurityResearchFailure, parkSecurityResearchInterruption, resumeReconnectedSecurityResearch, SECURITY_RESEARCH_DESKTOP_WAIT, SECURITY_RESEARCH_PROVIDER_WAIT, parkSecurityReportDelivery, resumeSecurityResearchRun, SECURITY_REPORT_DELIVERY_PENDING, canResumeSecurityResearchContextFailure, recoverSecurityResearchContextFailure } from "../../src/tasks/security-report-recovery";
import { reportBackTaskCompletion, reportBackTaskError } from "../../src/tasks/report-back";
import { taskReturnBindingRegistryForTests } from "../../src/tasks/task-return-binding";

const modelId = "anthropic:claude-sonnet-4-6";
const savedKey = process.env["ANTHROPIC_API_KEY"];
const savedMode = process.env["NAUTILO_TEST_MODE"];
let userId: string;
let agentId: string;
let capturedInput: Record<string, unknown> | undefined;
const manager: TaskJobManager & { abortJob: () => boolean } = {
  createForegroundJob: async (_owner, _requestor, _lane, input) => {
    capturedInput = input;
    const id = randomUUID();
    return { id, virtualJobId: id };
  },
  abortJob: () => false,
};
beforeAll(async () => {
  process.env["ANTHROPIC_API_KEY"] = "test-only";
  process.env["NAUTILO_TEST_MODE"] = "stub";
  await setupTestDb();
  ({ userId, agentId } = await setupAgentTestEnv("security-delivery-recovery"));
  setTaskRunDb(getDirectDb());
});
afterEach(() => {
  _setTaskRunExecutorRunnerForTests(null);
  _setSecurityReportArtifactWriterForTests(null);
  _setSecurityReportExporterForTests(null);
  setRelayRegistry(null);
  taskReturnBindingRegistryForTests.clear();
  capturedInput = undefined;
});
afterAll(async () => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = savedKey;
  if (savedMode === undefined) delete process.env["NAUTILO_TEST_MODE"]; else process.env["NAUTILO_TEST_MODE"] = savedMode;
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

async function fixture(security = true, contextFailure = false) {
  const db = getDirectDb();
  const task = await createTask(db, { ownerId: userId, requestorId: userId, agentId,
    prompt: "Inspect the authorized code and preserve the report.", preset: "in_background", scheduleKind: "now", targetChat: "orphan",
    targetUserIds: [userId], toolsMode: security ? "whitelist" : "none", toolsWhitelist: security ? ["security_scan", "file"] : [],
    requestedModelId: modelId, status: "running" });
  const threadId = `subagent:security-retry:${randomUUID()}`;
  const run = await insertTaskRun(db, { taskId: task.id, graphThreadId: threadId, modelId, status: "running" });
  const continuation = { status: "available" as const, relayId: "research-relay", relaySessionId: "original-session",
    desktopSessionId: "same-desktop", pairingGeneration: "pairing", currentFolder: "/authorized", workspacePath: "/workspace",
    bindingCapturedAt: Date.now() };
  setRelayRegistry({ findByCapabilityForUser: () => ["research-relay"], getUserId: () => userId, getRelaySessionId: () => "reconnected-session",
    getDesktopSessionId: () => "same-desktop", getPairingGeneration: () => "pairing", isRelayHeartbeatFresh: () => true,
    getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/authorized", workspaceRoot: "/workspace" }),
  } as unknown as ToolRelayRegistry);
  const status = { version: "security-scan-v1", scanId: "scan_test", state: contextFailure ? "active" : "completed", phase: contextFailure ? "researching" : null, terminalState: contextFailure ? null : "completed",
    mode: "deep_research", modelId, modelState: contextFailure ? "running" : "completed", completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
    coverage: [{ surfaceKey: "auth", label: "Auth", state: "reviewed", rationale: "Checked the relevant paths." }], hypotheses: [],
    researchProgress: { inventoryState: "complete", inventoryFingerprint: "d".repeat(64), filesTotal: 1, filesAssigned: 1, filesUnassigned: 0,
      unitsTotal: 1, unitsCompleted: 1, unitsPending: 0, excludedEntriesTotal: 0, coverageTotal: 1, hypothesesTotal: 1,
      coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null } };
  const narrative = "## Findings\n\nExact saved investigation, with all qualifications.\n";
  const graph = createNautiloGraph(createCheckpointSaver(), getPolicyResolver(), defaultPostModelDeps);
  const config = { configurable: { thread_id: threadId } };
  await graph.updateState(config, { messages: [new AIMessage({ content: "Seal accepted research.", tool_calls: [{ id: "seal",
    name: "security_scan", args: contextFailure ? { version: "security-scan-v1", operation: "start" } : { version: "security-scan-v1", operation: "results", category: "all", finalize: true } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "seal", content: JSON.stringify(securityScanToolResultSchema.parse(contextFailure ? { ok: true, operation: "start", result: status } : { ok: true, operation: "results",
      result: { version: "security-scan-v1", status, observations: [], codeEvidence: [], records: [], inventory: [],
        nextCursor: null, reportReady: false, exportSnapshot: { sha256: createHash("sha256").digest("hex"), itemCount: 0 } } })) }),
    new AIMessage(narrative)], subagentRun: true, taskRun: true, trustedExecutionEntrypoint: "background.task",
    toolWhitelist: security ? ["security_scan", "file"] : [], userId, agentId, model: modelId,
    currentTaskId: task.id, currentTaskRunId: run.id, langgraphThreadId: threadId, taskReportBackContinuation: continuation,
    ...(contextFailure ? { noProgressPendingStop: { toolName: "security_scan", operationDiscriminator: "context",
      normalizedError: JSON.stringify({ code: "context_budget_unavailable", message: "Local framing cannot fit.", retryable: false }) } } : {}) });
  return { db, task, run, threadId, graph, config, narrative };
}

async function dispatchPaused(taskId: string) {
  const db = getDirectDb();
  expect((await unpauseTask({ db, jobManager: manager }, taskId)).ok).toBe(true);
  const task = await getTaskById(db, taskId);
  if (!task) throw new Error("fixture Task missing");
  return dispatchTaskRun(task, { db, jobManager: manager });
}
async function executeCaptured(taskId: string) {
  const input = capturedInput;
  if (!input) throw new Error("no accepted Job input");
  const id = randomUUID();
  await getDirectDb().insert(jobs).values({ id, ownerId: userId, requestorId: userId,
    type: "task", status: "queued", laneKey: `task:${taskId}`, input });
  for await (const _event of taskRunExecutor(input, id, `task:${taskId}`, new AbortController().signal)) { /* drain */ }
}

test("ordinary Resume retries saved report delivery on the same run without invoking a model", async () => {
  const f = await fixture();
  expect(await parkSecurityReportDelivery(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId })).toBe(true);
  await dispatchPaused(f.task.id);
  expect(capturedInput?.["taskRunId"]).toBe(f.run.id);
  expect(capturedInput?.["securityReportDeliveryOnly"]).toBe(true);
  let modelCalls = 0;
  _setTaskRunExecutorRunnerForTests(async () => { modelCalls++; throw new Error("must not run model"); });
  let exports = 0;
  _setSecurityReportExporterForTests(async (input) => {
    exports++;
    expect(input.taskRunId).toBe(f.run.id);
    expect(input.continuation?.relaySessionId).toBe("reconnected-session");
    return { researchAppendix: "Complete retained evidence", reportState: "completed" };
  });
  _setSecurityReportArtifactWriterForTests(async () => ({ ok: false, code: "WRITE_FAILED", message: "temporary storage failure" }));
  await executeCaptured(f.task.id);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await getTaskRuns(f.db, f.task.id))[0]?.lastError).toBe(SECURITY_REPORT_DELIVERY_PENDING);
  const savedMessages = (await f.graph.getState(f.config))?.values["messages"] as BaseMessage[];
  expect(savedMessages.at(-1)?.content).toBe(f.narrative);
  await dispatchPaused(f.task.id);
  _setSecurityReportArtifactWriterForTests(async (input) => {
    expect(Buffer.from(input.bytes).toString("utf8")).toContain(f.narrative);
    return { ok: true, artifactId: "report", artifactInternalId: "report-internal", displayPath: input.logicalPath,
      revision: 1, size: input.bytes.byteLength, sha256: "fixture" };
  });
  await executeCaptured(f.task.id);
  expect(modelCalls).toBe(0);
  expect(exports).toBe(2);
  const runs = await getTaskRuns(f.db, f.task.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: f.run.id, status: "completed", lastError: null, modelId });
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("completed");
});

test("ordinary paused native audit preserves the exact run while nonsecurity Resume retains its existing new-run behavior", async () => {
  for (const security of [true, false]) {
    const f = await fixture(security);
    await markTaskRunStatus(f.db, f.run.id, "paused");
    await updateTask(f.db, f.task.id, { status: "paused" });
    await dispatchPaused(f.task.id);
    expect(capturedInput?.["resumeFromCheckpoint"]).toBe(true);
    expect(capturedInput?.["securityReportDeliveryOnly"]).toBeUndefined();
    expect((await getTaskRuns(f.db, f.task.id)).length).toBe(security ? 1 : 2);
    expect(capturedInput?.["taskRunId"] === f.run.id).toBe(security);
    await updateTask(f.db, f.task.id, { status: "cancelled" });
  }
});

test("post-export Pause wins the final completion transaction and retains the checkpoint", async () => {
  const f = await fixture();
  await markTaskRunStatus(f.db, f.run.id, "paused");
  await updateTask(f.db, f.task.id, { status: "paused" });
  expect(await reportBackTaskCompletion({ db: f.db }, { taskId: f.task.id, runId: f.run.id,
    scheduleKind: "now", resultText: "already saved artifact", requireRunningPair: true })).toBe(false);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await getTaskRuns(f.db, f.task.id))[0]?.status).toBe("paused");
  expect((await f.graph.getState(f.config))?.values["messages"]).toHaveLength(3);
});

test("disconnected Resume preserves the saved grant and paused run until the same Desktop reconnects", async () => {
  const f = await fixture();
  const relay = getRelayRegistry();
  expect(await parkSecurityReportDelivery(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId })).toBe(true);
  const before = (await f.graph.getState(f.config))?.values["taskReportBackContinuation"];
  setRelayRegistry(null);
  expect((await dispatchPaused(f.task.id)).kind).toBe("authorization_paused");
  expect(capturedInput).toBeUndefined();
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await getTaskRuns(f.db, f.task.id))[0]).toMatchObject({ id: f.run.id, status: "paused", lastError: SECURITY_REPORT_DELIVERY_PENDING });
  expect((await f.graph.getState(f.config))?.values["taskReportBackContinuation"]).toEqual(before);
  setRelayRegistry(relay);
  expect((await dispatchPaused(f.task.id)).kind).toBe("dispatched");
  expect(capturedInput?.["taskRunId"]).toBe(f.run.id);
  expect((await getTaskRuns(f.db, f.task.id))).toHaveLength(1);
});

test("owner, run, thread, model and terminal-state mismatches cannot reactivate research", async () => {
  const f = await fixture();
  const identity = { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId, threadId: f.threadId, modelId, deliveryOnly: false };
  await markTaskRunStatus(f.db, f.run.id, "paused");
  await updateTask(f.db, f.task.id, { status: "pending" });
  for (const key of ["ownerId", "taskRunId", "threadId", "modelId"] as const) {
    expect(await resumeSecurityResearchRun(f.db, { ...identity, [key]: randomUUID() })).toBeUndefined();
  }
  const wrong = await assertSecurityResearchResumeBinding({ taskId: f.task.id, taskRunId: randomUUID(), userId, threadId: f.threadId, modelId }).catch((error: unknown) => error);
  expect(wrong).toBeInstanceOf(Error);
  expect((wrong as Error).message).toBe("SECURITY_RESEARCH_RESUME_SCOPE_MISMATCH");
  for (const status of ["cancelled", "errored"] as const) {
    await markTaskRunStatus(f.db, f.run.id, status);
    expect(await resumeSecurityResearchRun(f.db, identity)).toBeUndefined();
    expect(await parkSecurityReportDelivery(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId })).toBe(false);
  }
});

test("Pause or Stop while an accepted security Job is queued cannot be overwritten at executor attachment", async () => {
  for (const status of ["paused", "cancelled"] as const) {
    const f = await fixture();
    await parkSecurityReportDelivery(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId });
    await dispatchPaused(f.task.id);
    await markTaskRunStatus(f.db, f.run.id, status);
    await updateTask(f.db, f.task.id, { status });
    let modelCalls = 0;
    let exports = 0;
    _setTaskRunExecutorRunnerForTests(async () => { modelCalls++; throw new Error("must not run"); });
    _setSecurityReportExporterForTests(async () => { exports++; throw new Error("must not export"); });
    await executeCaptured(f.task.id);
    expect(modelCalls).toBe(0);
    expect(exports).toBe(0);
    expect((await getTaskById(f.db, f.task.id))?.status).toBe(status);
    expect((await getTaskRuns(f.db, f.task.id))[0]?.status).toBe(status);
    expect((await f.graph.getState(f.config))?.values["messages"]).toHaveLength(3);
  }
});


async function failedContextFixture() {
  const f = await fixture(true, true);
  await reportBackTaskError({ db: f.db }, { taskId: f.task.id, runId: f.run.id, scheduleKind: "now", error: "no_progress" });
  return { ...f, task: (await getTaskById(f.db, f.task.id))! };
}

test("errored context recovery preserves exact Run/history and revalidates the original Desktop", async () => {
  const f = await failedContextFixture();
  const before = JSON.stringify((await f.graph.getState(f.config))?.values);
  expect(await canResumeSecurityResearchContextFailure(f.db, f.task)).toBe(true);
  const relay = getRelayRegistry(); setRelayRegistry(null); let kicks = 0;
  expect((await unpauseTask({ db: f.db, jobManager: manager, observer: { kick: () => { kicks++; } } }, f.task.id)).ok).toBe(true);
  expect(kicks).toBe(1);
  expect((await getTaskRuns(f.db, f.task.id))[0]).toMatchObject({ id: f.run.id, status: "paused", modelId, graphThreadId: f.threadId, completedAt: null });
  expect(JSON.stringify((await f.graph.getState(f.config))?.values)).toBe(before);
  expect((await dispatchTaskRun((await getTaskById(f.db, f.task.id))!, { db: f.db, jobManager: manager })).kind).toBe("authorization_paused");
  expect(capturedInput).toBeUndefined(); setRelayRegistry(relay);
  await dispatchPaused(f.task.id);
  expect(capturedInput).toMatchObject({ taskRunId: f.run.id, resumeFromCheckpoint: true, modelId });
  expect(await getTaskRuns(f.db, f.task.id)).toHaveLength(1);
});

test("context recovery rejects different failures, foreign/finalized checkpoints and a newer Run", async () => {
  for (const mode of ["other_error", "other_stop", "foreign", "finalized", "newer_run"] as const) {
    const f = mode === "finalized" ? await fixture() : await failedContextFixture();
    if (mode === "finalized") await reportBackTaskError({ db: f.db }, { taskId: f.task.id, runId: f.run.id, scheduleKind: "now", error: "no_progress" });
    if (mode === "other_error") await f.db.update(taskRuns).set({ lastError: "other_failure" }).where(eq(taskRuns.id, f.run.id));
    if (mode === "other_stop") await f.graph.updateState(f.config, { noProgressPendingStop: { toolName: "security_scan", operationDiscriminator: "record", normalizedError: JSON.stringify({ code: "context_budget_unavailable" }) } });
    if (mode === "foreign") await f.graph.updateState(f.config, { currentTaskRunId: randomUUID() });
    if (mode === "newer_run") await insertTaskRun(f.db, { taskId: f.task.id, graphThreadId: "newer-terminal", modelId, status: "completed" });
    const current = (await getTaskById(f.db, f.task.id))!;
    expect(await canResumeSecurityResearchContextFailure(f.db, current)).toBe(false);
    expect((await unpauseTask({ db: f.db, jobManager: manager }, f.task.id)).ok).toBe(false);
    expect((await getTaskById(f.db, f.task.id))?.status).toBe("errored");
    expect((await getTaskRuns(f.db, f.task.id)).find((run) => run.id === f.run.id)?.status).toBe("errored");
  }
});

test("context recovery CAS has one winner and respects a terminal transition under the Task lock", async () => {
  const f = await failedContextFixture();
  const outcomes = await Promise.all([recoverSecurityResearchContextFailure(f.db, f.task), recoverSecurityResearchContextFailure(f.db, f.task)]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const blocked = await failedContextFixture();
  let unlock!: () => void; let locked!: () => void;
  const lockReady = new Promise<void>((resolve) => { locked = resolve; });
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const terminal = blocked.db.transaction(async (tx) => {
    await tx.select().from(tasks).where(eq(tasks.id, blocked.task.id)).for("update");
    locked(); await release;
    await tx.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, blocked.task.id));
    await tx.update(taskRuns).set({ status: "cancelled" }).where(eq(taskRuns.id, blocked.run.id));
  });
  await lockReady;
  const recovery = recoverSecurityResearchContextFailure(blocked.db, blocked.task);
  unlock(); await terminal;
  expect(await recovery).toBe(false);
  expect((await getTaskById(blocked.db, blocked.task.id))?.status).toBe("cancelled");
  expect((await getTaskRuns(blocked.db, blocked.task.id))[0]?.status).toBe("cancelled");
});


test("Desktop loss preserves the checkpoint and cause, then reconnect resumes the same research run", async () => {
  const f = await fixture();
  const saved = await f.graph.getState(f.config);
  const relay = getRelayRegistry();
  setRelayRegistry(null);
  expect(await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: new RelayUnavailableError("Desktop disconnected", "desktop_disconnected") })).toBe(true);
  const paused = await getTaskById(f.db, f.task.id);
  expect(paused?.status).toBe("paused");
  expect(paused?.lastError).toContain("Waiting for Desktop");
  expect(paused?.metadata["lastInterruption"]).toMatchObject({ code: "relay_unavailable", outcome: "paused",
    stoppedBy: "task_runtime", graphThreadId: f.threadId, taskRunId: f.run.id, desktopExitCause: "unknown" });
  expect((await getTaskRuns(f.db, f.task.id))[0]?.lastError).toBe(SECURITY_RESEARCH_DESKTOP_WAIT);
  await resumeReconnectedSecurityResearch(f.db, 20);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await f.graph.getState(f.config))?.values["messages"]).toEqual(saved?.values["messages"]);
  setRelayRegistry(relay);
  await resumeReconnectedSecurityResearch(f.db, 20);
  const pending = await getTaskById(f.db, f.task.id);
  expect(pending?.status).toBe("pending");
  await dispatchTaskRun(pending!, { db: f.db, jobManager: manager });
  expect(capturedInput).toMatchObject({ taskRunId: f.run.id, graphThreadId: f.threadId, resumeFromCheckpoint: true, modelId });
  expect((await getTaskById(f.db, f.task.id))?.metadata["lastInterruption"]).toEqual(paused?.metadata["lastInterruption"]);
});

test("reconnection cannot revive stopped research or grant a different folder", async () => {
  const f = await fixture();
  expect(await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: new RelayUnavailableError("Desktop disconnected", "desktop_disconnected") })).toBe(true);
  const relay = getRelayRegistry()!;
  setRelayRegistry({ ...relay, getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/different", workspaceRoot: "/workspace" }) } as unknown as ToolRelayRegistry);
  await resumeReconnectedSecurityResearch(f.db, 20);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  await updateTask(f.db, f.task.id, { status: "cancelled" });
  setRelayRegistry(relay);
  await resumeReconnectedSecurityResearch(f.db, 20);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("cancelled");
});


test("an explicit pause disables reconnect auto-resume without losing the interruption record", async () => {
  const f = await fixture();
  await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: new RelayUnavailableError("Desktop disconnected", "desktop_disconnected") });
  await pauseTask({ db: f.db, jobManager: manager }, f.task.id);
  await resumeReconnectedSecurityResearch(f.db, 20);
  const task = await getTaskById(f.db, f.task.id);
  expect(task?.status).toBe("paused");
  expect(task?.lastError).toContain("Paused by you");
  expect(task?.metadata["lastInterruption"]).toMatchObject({ code: "relay_unavailable" });
});


test("a real no-progress termination preserves the stopping mechanism and exact checkpoint", async () => {
  const f = await fixture();
  await recordSecurityResearchFailure(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: new NoProgressError({ toolName: "security_scan", operationDiscriminator: "record", normalizedError: "private tool error" }) });
  const saved = (await getTaskById(f.db, f.task.id))?.metadata["lastInterruption"];
  expect(saved).toMatchObject({ code: "no_progress", cause: "repeated_tool_failure", stoppedBy: "no_progress_guard",
    outcome: "errored", toolName: "security_scan", operation: "record", graphThreadId: f.threadId });
  expect(JSON.stringify(saved)).not.toContain("private tool error");
  expect((saved as Record<string, unknown>)["checkpointId"]).toBeString();
});


test("offline candidates do not hide a later reconnectable task behind the observer page", async () => {
  const pair = [await fixture(), await fixture()].sort((a, b) => a.task.id.localeCompare(b.task.id));
  const blocked = pair[0]!; const ready = pair[1]!;
  const saved = await blocked.graph.getState(blocked.config);
  await blocked.graph.updateState(blocked.config, { taskReportBackContinuation: {
    ...(saved?.values["taskReportBackContinuation"] as Record<string, unknown>), currentFolder: "/not-the-connected-folder",
  } });
  for (const f of pair) await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: new RelayUnavailableError("Desktop disconnected", "desktop_disconnected") });
  await resumeReconnectedSecurityResearch(ready.db, 1);
  expect((await getTaskById(ready.db, blocked.task.id))?.status).toBe("paused");
  expect((await getTaskById(ready.db, ready.task.id))?.status).toBe("pending");
});


test("the real task executor parks a Desktop interruption instead of reporting no_progress", async () => {
  const f = await fixture(true, true);
  await markTaskRunStatus(f.db, f.run.id, "paused");
  await updateTask(f.db, f.task.id, { status: "paused" });
  await dispatchPaused(f.task.id);
  _setTaskRunExecutorRunnerForTests(async () => { throw new RelayUnavailableError("Desktop disconnected", "desktop_disconnected"); });
  await executeCaptured(f.task.id);
  const task = await getTaskById(f.db, f.task.id);
  expect(task?.status).toBe("paused");
  expect(task?.metadata["lastInterruption"]).toMatchObject({ code: "relay_unavailable", outcome: "paused" });
  expect((await getTaskRuns(f.db, f.task.id))[0]?.status).toBe("paused");
});


function safeProviderTimeout() {
  return new ProviderTimeoutError(modelId, 180_000, { kind: "progress_idle_timeout", attemptId: "exhausted-attempt",
    policyProvenance: {}, elapsedMs: 185_030, visibleOutput: false, partialState: true,
    abortRequested: true, safeToFallback: true });
}

test("provider exhaustion preserves the checkpoint and only explicit Resume reuses its run and model", async () => {
  const f = await fixture(true, true);
  const saved = await f.graph.getState(f.config);
  expect(await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId,
    error: safeProviderTimeout() })).toBe(true);
  const paused = await getTaskById(f.db, f.task.id);
  expect(paused?.status).toBe("paused");
  expect(paused?.lastError).toContain("Model request timed out");
  expect(paused?.metadata["lastInterruption"]).toMatchObject({ code: "NAUTILO_PROVIDER_TIMEOUT", outcome: "paused",
    cause: "progress_idle_timeout", attemptId: "exhausted-attempt", modelId, elapsedMs: 185_030,
    taskRunId: f.run.id, graphThreadId: f.threadId, resumable: true });
  expect((paused?.metadata["lastInterruption"] as Record<string, unknown>)["checkpointId"]).toBeString();
  expect((await getTaskRuns(f.db, f.task.id))[0]?.lastError).toBe(SECURITY_RESEARCH_PROVIDER_WAIT);
  await resumeReconnectedSecurityResearch(f.db, 20);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await f.graph.getState(f.config))?.values).toEqual(saved?.values);
  await dispatchPaused(f.task.id);
  expect(capturedInput).toMatchObject({ taskRunId: f.run.id, graphThreadId: f.threadId, resumeFromCheckpoint: true, modelId });
});

test("the real task executor parks safe provider exhaustion instead of failing the audit", async () => {
  const f = await fixture(true, true);
  await markTaskRunStatus(f.db, f.run.id, "paused");
  await updateTask(f.db, f.task.id, { status: "paused" });
  await dispatchPaused(f.task.id);
  _setTaskRunExecutorRunnerForTests(async () => { throw safeProviderTimeout(); });
  await executeCaptured(f.task.id);
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("paused");
  expect((await getTaskRuns(f.db, f.task.id))[0]?.lastError).toBe(SECURITY_RESEARCH_PROVIDER_WAIT);
});

test("unknown timeout outcomes and unrelated errors do not advertise safe research recovery", async () => {
  const f = await fixture();
  for (const error of [new ProviderTimeoutError(modelId, 180_000), new Error("timeout"),
    new ProviderTimeoutError(modelId, 180_000, { ...safeProviderTimeout().details!, visibleOutput: true })]) {
    expect(await parkSecurityResearchInterruption(f.db, { taskId: f.task.id, taskRunId: f.run.id, ownerId: userId, error })).toBe(false);
  }
  expect((await getTaskById(f.db, f.task.id))?.status).toBe("running");
});
