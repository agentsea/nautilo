import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { RunTaskApprovalResumeArgs } from "./resume-task-approval";

const transitions: Array<{ from: string; to: string }> = [];
const transitionTaskApprovalExecution = mock(async (_db: unknown, input: { from: string; to: string }) => {
  transitions.push(input);
  return true;
});
const pauseForAuthorizationDenial = mock(async () => ({ transitioned: true,
  task: { id: "task-1", ownerId: "owner-1" } }));
const findAwaitingTaskRunForApproval = mock(async (): Promise<{ task: Task; run: TaskRun } | undefined> => undefined);
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({ ...actualDb, transitionTaskApprovalExecution, findAwaitingTaskRunForApproval,
  pauseAwaitingTaskRunForAuthorizationDenial: pauseForAuthorizationDenial }));
const statusEvents: unknown[] = [];
const resumeGraphWithAskReply = mock<(...args: unknown[]) => Promise<void>>(async () => undefined);
const resumeGraphWithApproval = mock<(...args: unknown[]) => Promise<void>>(async () => undefined);
const inspectTaskResumeOutcome = mock(async () => ({ reparked: true }));
const reportBackTaskError = mock(async (_deps: unknown, _input: unknown) => undefined);
const safeBackgroundTaskFailureResult = "SAFE_BACKGROUND_TASK_FAILURE_RESULT";
const actualAgent = await import("@nautilo/agent");

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  createWorkspaceBinaryArtifact: mock(async () => { throw new Error("unexpected artifact write"); }),
  resumeGraphWithApproval,
  resumeGraphWithAskReply,
  resumeGraphWithIdentity: mock(async () => undefined),
  inspectTaskResumeOutcome,
}));
mock.module("@nautilo/trust", () => ({
  AgentInvocationDeniedError: class AgentInvocationDeniedError extends Error {},
  ServerProviderCredentialsDeniedError: class ServerProviderCredentialsDeniedError extends Error {},
  assertAcceptedInvocationAuthoritySubject: mock(() => undefined),
  assertCanInvokeAgent: mock(async () => undefined),
  assertCanUseServerProviderCredentials: mock(async () => undefined),
}));
mock.module("@nautilo/logger", () => ({
  setLogLevel: mock(() => undefined),
  setLogOutput: mock(() => undefined),
  debug: mock(() => undefined),
  log: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
  runWithTurn: mock((run: () => unknown) => run()),
  getCurrentTurnId: mock(() => undefined),
}));
mock.module("../job-manager", () => ({
  jobManager: { runResumeJobLifecycle: async (_scope: unknown, resume: (signal: AbortSignal) => Promise<void>) => resume(new AbortController().signal) },
  runWithAcceptedWorkAuthorities: async (_maintenance: unknown, _invocation: unknown, run: () => Promise<void>) => run(),
}));
mock.module("../executors/persisting-processor", () => ({
  createPersistingProcessor: () => ({ process: mock(() => undefined), flush: mock(() => undefined), emit: mock(() => undefined) }),
}));
mock.module("../event-bus", () => ({ eventBus: { emit: (event: unknown) => statusEvents.push(event) } }));
const { taskApprovalRecipient } = await import("./emit-task-interrupt");
const replayTaskInterruptEvents = mock(async () => [{
  type: "approval.ask",
  approvalId: "approval-current-b",
  threadId: "thread-1",
  laneKey,
  tools: [],
  reason: "Current approval",
  reasonCode: "destructive-tool",
  allowedVerbs: ["once", "deny"],
}]);
mock.module("./emit-task-interrupt", () => ({
  patchTaskApprovalEvent: (event: unknown) => event,
  taskApprovalRecipient,
  replayTaskInterruptEvents,
}));
mock.module("./report-back", () => ({
  reportBackTaskCompletion: mock(async () => undefined),
  reportBackTaskError,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT: safeBackgroundTaskFailureResult,
}));

let runTaskApprovalResume: typeof import("./resume-task-approval")["runTaskApprovalResume"];

const laneKey = "task:fixture-task";
const exact = {
  mediaGenerationApprovalId: "media-generation:approval-1",
  mediaGenerationDigest: "a".repeat(64),
  mediaGenerationQuoteDigest: "b".repeat(64),
  mediaGenerationLaneKey: laneKey,
  mediaGenerationRevision: 1,
};

const task = {
  id: "fixture-task",
  ownerId: "owner-1",
  requestorId: "requestor-1",
  agentId: "agent-1",
  prompt: "Resume the paid media approval.",
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
  status: "awaiting",
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
} satisfies Task;
const run = {
  id: "run-1",
  taskId: "fixture-task",
  jobId: null,
  graphThreadId: "thread-1",
  status: "awaiting",
  modelId: null,
  fundingBinding: null,
  fundingPredecessorRunId: null,
  resultText: null,
  startedAt: new Date(),
  completedAt: null,
  lastError: null,
  resultRepresentation: "ordinary",
  resultContentNamespaceId: null,
  resultRevision: 0,
  resultCryptoObjectId: null,
  resultCryptoAccessRevision: 0,
  resultCryptoRequiredNamespaceFingerprint: null,
  resultCryptoMappingState: "unmapped",
} satisfies TaskRun;
const { createMaintenanceAcceptanceAuthority } = await import("../maintenance-controller");
const authorities = {
  invocationAuthority: createAcceptedInvocationAuthority("requestor-1"),
  maintenanceAuthority: createMaintenanceAcceptanceAuthority(),
} satisfies Pick<RunTaskApprovalResumeArgs, "invocationAuthority" | "maintenanceAuthority">;

type EchoShape = "exact" | "absent" | "missing-digest" | "forged-quote" | "stale-revision" | "cross-lane";

function resumeArgs(echo: EchoShape = "exact"): RunTaskApprovalResumeArgs {
  const base = {
    task,
    run,
    ...authorities,
    kind: "ask",
    verb: "once",
  } satisfies Pick<RunTaskApprovalResumeArgs,
    "task" | "run" | "invocationAuthority" | "maintenanceAuthority" | "kind" | "verb">;
  if (echo === "exact") return { ...base, ...exact };
  if (echo === "absent") return base;
  if (echo === "missing-digest") {
    return {
      ...base,
      mediaGenerationApprovalId: exact.mediaGenerationApprovalId,
      mediaGenerationQuoteDigest: exact.mediaGenerationQuoteDigest,
      mediaGenerationLaneKey: exact.mediaGenerationLaneKey,
      mediaGenerationRevision: exact.mediaGenerationRevision,
    };
  }
  if (echo === "forged-quote") return { ...base, ...exact, mediaGenerationQuoteDigest: "forged" };
  if (echo === "stale-revision") return { ...base, ...exact, mediaGenerationRevision: 2 };
  return { ...base, ...exact, mediaGenerationLaneKey: "task:other" };
}

describe("Task paid media approval echo", () => {
  beforeAll(async () => {
    ({ runTaskApprovalResume } = await import("./resume-task-approval"));
  });

  beforeEach(() => {
    transitions.length = 0;
    statusEvents.length = 0;
    transitionTaskApprovalExecution.mockClear();
    pauseForAuthorizationDenial.mockClear();
    resumeGraphWithAskReply.mockClear();
    resumeGraphWithApproval.mockClear();
    inspectTaskResumeOutcome.mockClear();
    reportBackTaskError.mockClear();
    replayTaskInterruptEvents.mockClear();
  });

  test("revoked funding before a queued resume leaves the graph unrun and pauses the awaiting Task", async () => {
    const trust = await import("@nautilo/trust");
    const result = await runTaskApprovalResume(resumeArgs(), {
      assertServerFunding: async () => { throw new trust.ServerProviderCredentialsDeniedError("owner-1"); },
    });
    expect(result).toEqual({ reparked: false });
    expect(pauseForAuthorizationDenial).toHaveBeenCalledTimes(1);
    expect(transitionTaskApprovalExecution).not.toHaveBeenCalled();
    expect(resumeGraphWithAskReply).not.toHaveBeenCalled();
  });

  test("passes the exact five checkpoint-validation fields into the public task resume", async () => {
    expect(await runTaskApprovalResume(resumeArgs())).toEqual({ reparked: true });
    expect(transitions.map(({ from, to }) => [from, to])).toEqual([["awaiting", "running"], ["running", "awaiting"]]);
    expect(statusEvents).toEqual([
      { type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "running" },
      { type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "awaiting" },
    ]);
    expect(resumeGraphWithAskReply).toHaveBeenCalledWith(
      "thread-1",
      "once",
      expect.anything(),
      laneKey,
      undefined,
      expect.any(AbortSignal),
      undefined,
      undefined,
      laneKey,
      undefined,
      exact.mediaGenerationApprovalId,
      exact.mediaGenerationDigest,
      exact.mediaGenerationQuoteDigest,
      laneKey,
      1,
      undefined,
      undefined,
      undefined,
    );
  });

  test("allows no paid-media echo and forwards no checkpoint fields", async () => {
    expect(await runTaskApprovalResume(resumeArgs("absent"))).toEqual({ reparked: true });
    expect(resumeGraphWithAskReply).toHaveBeenCalledWith(
      "thread-1",
      "once",
      expect.anything(),
      laneKey,
      undefined,
      expect.any(AbortSignal),
      undefined,
      undefined,
      laneKey,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  test("forwards exact ask and prove-it identities to keyed graph resume", async () => {
    await runTaskApprovalResume({
      ...resumeArgs("absent"),
      approvalId: "approval-exact",
    });
    expect(resumeGraphWithAskReply.mock.calls.at(-1)?.at(-1)).toBe("approval-exact");

    await runTaskApprovalResume({
      task,
      run,
      ...authorities,
      kind: "prove_it",
      approved: false,
      challengeId: "challenge-exact",
    });
    expect(resumeGraphWithApproval.mock.calls.at(-1)?.at(-1)).toBe("challenge-exact");
  });

  test("stale A restores current B to awaiting without terminal failure", async () => {
    resumeGraphWithAskReply.mockRejectedValueOnce(Object.assign(
      new Error("stale approval"),
      { code: "approval_request_stale" },
    ));

    expect(await runTaskApprovalResume({
      ...resumeArgs("absent"),
      approvalId: "approval-stale-a",
    })).toEqual({ reparked: true, staleReply: true });
    expect(transitions.map(({ from, to }) => [from, to])).toEqual([
      ["awaiting", "running"],
      ["running", "awaiting"],
    ]);
    expect(reportBackTaskError).not.toHaveBeenCalled();
    expect(statusEvents).toContainEqual({
      type: "approval.ask",
      approvalId: "approval-current-b",
      threadId: "thread-1",
      laneKey,
      tools: [],
      reason: "Current approval",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "deny"],
    });
  });

  test("stale A remains classified when Pause wins the running-to-awaiting fence", async () => {
    transitionTaskApprovalExecution
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    resumeGraphWithAskReply.mockRejectedValueOnce(Object.assign(
      new Error("stale approval"),
      { code: "approval_request_stale" },
    ));

    expect(await runTaskApprovalResume({
      ...resumeArgs("absent"),
      approvalId: "approval-stale-a",
    })).toEqual({ reparked: false, staleReply: true });
    expect(reportBackTaskError).not.toHaveBeenCalled();
    expect(replayTaskInterruptEvents).not.toHaveBeenCalled();
  });

  test("does not execute a duplicate or stale resume that cannot claim awaiting state", async () => {
    transitionTaskApprovalExecution.mockResolvedValueOnce(false);
    expect(await runTaskApprovalResume(resumeArgs())).toEqual({ reparked: false });
    expect(resumeGraphWithAskReply).not.toHaveBeenCalled();
    expect(statusEvents).toEqual([]);
  });

  test("does not re-park a run stopped during execution", async () => {
    transitionTaskApprovalExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runTaskApprovalResume(resumeArgs())).toEqual({ reparked: false });
    expect(statusEvents).toHaveLength(1);
  });

  test("fails closed before resume for partial, forged, stale-revision, or cross-lane echoes", async () => {
    for (const echo of ["missing-digest", "forged-quote", "stale-revision", "cross-lane"] as const) {
      expect(await runTaskApprovalResume(resumeArgs(echo))).toEqual({ reparked: false });
    }
    expect(resumeGraphWithAskReply).not.toHaveBeenCalled();
    expect(reportBackTaskError).toHaveBeenCalledTimes(4);
    for (const call of reportBackTaskError.mock.calls) {
      expect(call[1]).toMatchObject({
        taskId: "fixture-task",
        runId: "run-1",
        error: "runTaskApprovalResume: paid media approval is incomplete or stale",
        failureResultText: safeBackgroundTaskFailureResult,
        requireRunningPair: true,
      });
    }
  });
});


test("offline approval preserves the exact pending interrupt and requires a fresh approval after reconnect", async () => {
  const { authorizeTaskApprovalResume } = await import("./resume-task-approval");
  const delegation = { version: 1 as const, humanUserId: task.requestorId, agentId: task.agentId,
    sourceRoomId: "source-room", sourceConversationId: "source-thread", rootTaskId: task.id,
    projectGrantId: "grant", ceiling: "basic" as const, profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" } };
  const current: Task = { ...task, localExecutionDelegation: delegation };
  findAwaitingTaskRunForApproval.mockImplementation(async () => ({ task: current, run }));
  let online = false;
  let sourceAllowed = true;
  const deps = { assertInvocation: async () => {}, assertServerFunding: async () => {},
    targetAvailable: () => online,
    resolveLocalExecution: async () => ({ taskId: task.id, taskRunId: run.id, signal: new AbortController().signal,
      withAdmission: async <T>(_operation: unknown, work: (source: import("@nautilo/agent").DelegatedLocalExecutionAdmission) => Promise<T>) => {
        if (!sourceAllowed) throw new Error("source lost");
        return work({ taskId: task.id, taskRunId: run.id, delegation, signal: new AbortController().signal });
      } }),
  };
  transitions.length = 0;
  const args = { taskId: task.id, threadId: run.graphThreadId, sessionUserId: task.requestorId };
  expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: false, status: 409, code: "task_original_mac_offline" });
  expect(transitions).toEqual([]);
  online = true;
  expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: true, task: { id: task.id }, run: { id: run.id } });
  sourceAllowed = false;
  expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: false, status: 403, code: "task_local_execution_authority_unavailable" });
  expect(transitions).toEqual([]);
});


test("delegated approval authorizes only its exact requesting Human, preserving ordinary owner replies", async () => {
  const { authorizeTaskApprovalResume } = await import("./resume-task-approval");
  const delegation = { version: 1 as const, humanUserId: task.requestorId, agentId: task.agentId,
    sourceRoomId: "source-room", sourceConversationId: "source-thread", rootTaskId: task.id,
    projectGrantId: "grant", ceiling: "basic" as const, profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" } };
  let current: Task = { ...task, localExecutionDelegation: delegation };
  findAwaitingTaskRunForApproval.mockImplementation(async () => ({ task: current, run }));
  const resolveLocalExecution = mock(async () => ({ taskId: task.id, taskRunId: run.id, signal: new AbortController().signal,
    withAdmission: async <T>(_operation: unknown, work: (source: import("@nautilo/agent").DelegatedLocalExecutionAdmission) => Promise<T>) =>
      work({ taskId: task.id, taskRunId: run.id, delegation, signal: new AbortController().signal }) }));
  const invocations: string[] = [];
  const deps = { assertInvocation: async (input: { humanUserId: string }) => { invocations.push(input.humanUserId); },
    assertServerFunding: async () => {}, resolveLocalExecution, targetAvailable: () => true };
  const args = { taskId: task.id, threadId: run.graphThreadId, sessionUserId: task.requestorId };
  expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: true, task: { ownerId: task.ownerId, requestorId: task.requestorId } });
  expect(invocations).toEqual([task.requestorId]);
  resolveLocalExecution.mockClear(); invocations.length = 0;
  for (const sessionUserId of [task.ownerId, "wrong-human"]) {
    expect(await authorizeTaskApprovalResume({ ...args, sessionUserId }, deps)).toEqual({ ok: false, status: 404, error: "task_approval_not_found" });
  }
  for (const descriptor of [{ ...delegation, humanUserId: task.ownerId }, { ...delegation, agentId: "other-agent" }, { ...delegation, untrusted: true }]) {
    current = { ...task, localExecutionDelegation: descriptor };
    expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: false, status: 404 });
  }
  expect(resolveLocalExecution).not.toHaveBeenCalled(); expect(invocations).toEqual([]);
  current = { ...task, localExecutionDelegation: null };
  expect(await authorizeTaskApprovalResume({ ...args, sessionUserId: task.ownerId }, deps)).toMatchObject({ ok: true });
  expect(invocations).toEqual([task.requestorId, task.ownerId]);
  expect(await authorizeTaskApprovalResume(args, deps)).toMatchObject({ ok: false, status: 404 });
});
