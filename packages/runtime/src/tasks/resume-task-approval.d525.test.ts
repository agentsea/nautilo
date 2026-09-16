import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { RunTaskApprovalResumeArgs } from "./resume-task-approval";

const transitions: Array<{ from: string; to: string }> = [];
const transitionTaskApprovalExecution = mock(async (_db: unknown, input: { from: string; to: string }) => {
  transitions.push(input);
  return true;
});
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({ ...actualDb, transitionTaskApprovalExecution }));
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
  assertAcceptedInvocationAuthoritySubject: mock(() => undefined),
  assertCanInvokeAgent: mock(async () => undefined),
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
  replayTaskInterruptEvents,
}));
mock.module("./report-back", () => ({
  reportBackTaskCompletion: mock(async () => undefined),
  reportBackTaskError,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT: safeBackgroundTaskFailureResult,
}));

let runTaskApprovalResume: typeof import("./resume-task-approval")["runTaskApprovalResume"];

const laneKey = "task:d525-task";
const exact = {
  mediaGenerationApprovalId: "media-generation:approval-1",
  mediaGenerationDigest: "a".repeat(64),
  mediaGenerationQuoteDigest: "b".repeat(64),
  mediaGenerationLaneKey: laneKey,
  mediaGenerationRevision: 1,
};

const task = {
  id: "d525-task",
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
  createdAt: new Date(),
  updatedAt: new Date(),
  cancelledAt: null,
} satisfies Task;
const run = {
  id: "run-1",
  taskId: "d525-task",
  jobId: null,
  graphThreadId: "thread-1",
  status: "awaiting",
  modelId: null,
  resultText: null,
  startedAt: new Date(),
  completedAt: null,
  lastError: null,
} satisfies TaskRun;
const authorities = {
  invocationAuthority: createAcceptedInvocationAuthority("requestor-1"),
  maintenanceAuthority: { __brand: "D420-accepted-before-drain" },
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

describe("D525 Task paid media approval echo", () => {
  beforeAll(async () => {
    ({ runTaskApprovalResume } = await import("./resume-task-approval"));
  });

  beforeEach(() => {
    transitions.length = 0;
    statusEvents.length = 0;
    transitionTaskApprovalExecution.mockClear();
    resumeGraphWithAskReply.mockClear();
    resumeGraphWithApproval.mockClear();
    inspectTaskResumeOutcome.mockClear();
    reportBackTaskError.mockClear();
    replayTaskInterruptEvents.mockClear();
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
        taskId: "d525-task",
        runId: "run-1",
        error: "runTaskApprovalResume: paid media approval is incomplete or stale",
        failureResultText: safeBackgroundTaskFailureResult,
        requireRunningPair: true,
      });
    }
  });
});
