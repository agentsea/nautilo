import { assertSecurityReportTaskActive, finalizeSecurityReportDelivery } from "./security-report-artifact";
import { parkTaskContentAccessRecovery } from "./ordinary-content-access-recovery";
import { recordSecurityResearchFailure, parkSecurityResearchInterruption, parkSecurityReportDelivery, SecurityReportDeliveryPendingError } from "./security-report-recovery";
import {
  getSharedDirectDb,
  findAwaitingTaskRunForApproval,
  transitionTaskApprovalExecution,
  pauseAwaitingTaskRunForAuthorizationDenial,
  rooms,
  eq,
  type DirectDatabase,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import {
  resumeGraphWithApproval,
  resumeGraphWithAskReply,
  resumeGraphWithIdentity,
  inspectTaskResumeOutcome,
  extractTaskProgressFromStreamEvent,
  retainTaskWorkProgress,
  runWithTaskCausalHuman,
  type ObservedTaskProgress,
  type StreamEventProcessor,
  resumeOrdinaryContentAccessRecovery,
  readOrdinaryContentAccessRecovery,
  OrdinaryContentAccessRetryRequiredError,
  OrdinaryContentAccessRecoveryUnavailableError,
  type OrdinaryContentAccessRecoveryCoordinate,
  type OrdinaryContentAccessRecoveryDeps,
} from "@nautilo/agent";
import { taskPreparationText, readTaskPreparation, type ApprovalReplyVerb, type ServerEvent } from "@nautilo/types";
import type { RuntimePolicyContext } from "@nautilo/trust";
import {
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  assertAcceptedInvocationAuthoritySubject,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { log, warn } from "@nautilo/logger";
import { eventBus } from "../event-bus";
import { jobManager, runWithAcceptedWorkAuthorities, type JobManager } from "../job-manager";
import type { MaintenanceAcceptanceAuthority } from "../maintenance-controller";
import { createPersistingProcessor } from "../executors/persisting-processor";
import {
  patchTaskApprovalEvent,
  replayTaskInterruptEvents,
} from "./emit-task-interrupt";
import {
  reportBackTaskCompletion,
  reportBackTaskError,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT,
} from "./report-back";

/**
 * M164 — owner-only resume + finalization for a Task/subagent approval.
 *
 * Mirror of M151's `maybeResumeAwaitingTask` (the await_human_reply path), but
 * for the approval trio. Two functions:
 *   - `authorizeTaskApprovalResume` — fast, synchronous owner-auth + checkpoint
 *     binding for the HTTP route's status code (404 fail-closed).
 *   - `runTaskApprovalResume` — the fire-and-forget resume + finalization,
 *     analogous to the main-thread auth routes' async resume.
 *
 * The resume reuses the existing graph resume helpers
 * (`resumeGraphWith{AskReply,Approval,Identity}`) with a Task-aware processor
 * whose `emit` patches any chained interrupt with Task context before fanout
 * (R11). After the resume drains, `inspectTaskResumeOutcome` decides
 * reparked-vs-terminal and `reportBackTaskCompletion` finalizes — keeping
 * status, report-back, and cron rescheduling consistent with ordinary Task
 * completion (R10).
 */

export interface TaskApprovalAuthSuccess {
  ok: true;
  task: Task;
  run: TaskRun;
}
export interface TaskApprovalAuthFailure {
  ok: false;
  status: number;
  error: string;
  code?: string;
  capability?: string;
}
export type TaskApprovalAuthResult =
  | TaskApprovalAuthSuccess
  | TaskApprovalAuthFailure;

/**
 * Resolve + owner-authorize a Task approval resume. Returns the parked task+run
 * when (a) both are still `awaiting`, (b) the run's `graph_thread_id` matches
 * `threadId`, and (c) the caller owns the task. Otherwise 404 fail-closed (we
 * do NOT distinguish "not found" from "not yours" — same posture as Task
 * read/lifecycle routes, R12).
 */
export async function authorizeTaskApprovalResume(
  args: { taskId: string; threadId: string; sessionUserId: string },
  deps: {
    db?: DirectDatabase;
    assertInvocation?: typeof assertCanInvokeAgent;
    assertServerFunding?: typeof assertCanUseServerProviderCredentials;
    pauseForAuthorizationDenial?: typeof pauseAwaitingTaskRunForAuthorizationDenial;
  } = {},
): Promise<TaskApprovalAuthResult> {
  const db = deps.db ?? getSharedDirectDb();
  const found = await findAwaitingTaskRunForApproval(db, args.taskId, args.threadId);
  if (!found) return { ok: false, status: 404, error: "task_approval_not_found" };
  if (found.task.ownerId !== args.sessionUserId) {
    return { ok: false, status: 404, error: "task_approval_not_found" };
  }

  const assertInvocation = deps.assertInvocation ?? assertCanInvokeAgent;
  const assertServerFunding = deps.assertServerFunding ?? assertCanUseServerProviderCredentials;
  try {
    await assertInvocation({
      humanUserId: found.task.requestorId,
      origin: "foreground_resume",
      agentId: found.task.agentId,
      ...(found.task.targetRoomId ? { roomId: found.task.targetRoomId } : {}),
    });
    await assertServerFunding(found.task.requestorId, "task_approval_resume");
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)
      && !(error instanceof ServerProviderCredentialsDeniedError)) throw error;
    const transition = await (deps.pauseForAuthorizationDenial ?? pauseAwaitingTaskRunForAuthorizationDenial)(db, {
      taskId: found.task.id,
      taskRunId: found.run.id,
      graphThreadId: found.run.graphThreadId,
    });
    if (transition.transitioned && transition.task) {
      eventBus.emit({
        type: "task.status",
        taskId: transition.task.id,
        ownerId: transition.task.ownerId,
        status: "paused",
      });
    }
    return {
      ok: false,
      status: 403,
      error: error.code,
      code: error.code,
      capability: error.capability,
    };
  }
  return { ok: true, task: found.task, run: found.run };
}

export type TaskApprovalResumeKind = "ask" | "prove_it" | "identity" | "ordinary_recovery";

export interface RunTaskApprovalResumeArgs {
  task: Task;
  run: TaskRun;
  invocationAuthority: AcceptedInvocationAuthority;
  maintenanceAuthority: MaintenanceAcceptanceAuthority;
  kind: TaskApprovalResumeKind;
  ordinaryRecovery?: { expected: OrdinaryContentAccessRecoveryCoordinate; deps: OrdinaryContentAccessRecoveryDeps };
  /** kind === "ask": the four-verb reply. */
  verb?: ApprovalReplyVerb;
  /** Exact durable approval.ask identity; absent for legacy clients. */
  approvalId?: string;
  /** D503 exact local MCP install binding echoed by the approval client. */
  localMcpInstallApprovalId?: string;
  /** D503 exact local MCP install binding echoed by the approval client. */
  localMcpInstallDigest?: string;
  /** D500 exact SSH preparation approval id echoed by the approval client. */
  structuredSshApprovalId?: string;
  /** D525 exact paid media approval echoed after authenticated review. */
  mediaGenerationApprovalId?: string;
  mediaGenerationDigest?: string;
  mediaGenerationQuoteDigest?: string;
  mediaGenerationLaneKey?: string;
  mediaGenerationRevision?: number;
  /** kind === "prove_it": PIN approved (true) or denied (false). */
  approved?: boolean;
  /** Exact LangGraph prove-it interrupt identity; absent for legacy clients. */
  challengeId?: string;
  /** kind === "identity": the owner's policy context for envelope rebuild. */
  policyContext?: RuntimePolicyContext;
}

export interface RunTaskApprovalResumeResult {
  reparked: boolean;
  /** The submitted identity was stale; the current prompt remains canonical. */
  staleReply?: true;
  recoveryOutcome?: "completed" | "unavailable" | "retry_required";
}

/** D525: task callers must carry the paid approval receipt completely or not at all. */
function exactTaskMediaGenerationResumeEcho(
  args: Pick<RunTaskApprovalResumeArgs,
    "mediaGenerationApprovalId" | "mediaGenerationDigest" |
    "mediaGenerationQuoteDigest" | "mediaGenerationLaneKey" | "mediaGenerationRevision">,
  expectedLaneKey: string,
): readonly [string, string, string, string, number] | undefined {
  const values = [
    args.mediaGenerationApprovalId,
    args.mediaGenerationDigest,
    args.mediaGenerationQuoteDigest,
    args.mediaGenerationLaneKey,
    args.mediaGenerationRevision,
  ] as const;
  if (values.every((value) => value === undefined)) return undefined;
  if (
    typeof values[0] !== "string" || values[0].length === 0 ||
    typeof values[1] !== "string" || !/^[a-f0-9]{64}$/.test(values[1]) ||
    typeof values[2] !== "string" || !/^[a-f0-9]{64}$/.test(values[2]) ||
    typeof values[3] !== "string" || values[3] !== expectedLaneKey ||
    values[4] !== 1
  ) {
    throw new Error("runTaskApprovalResume: paid media approval is incomplete or stale");
  }
  return values as readonly [string, string, string, string, number];
}

/**
 * Resume the Task run's exact checkpoint and finalize. Owner-auth is the
 * caller's responsibility (call `authorizeTaskApprovalResume` first). Errors are
 * caught and converted into a terminal Task error report-back; this never
 * throws.
 */
export async function runTaskApprovalResume(
  args: RunTaskApprovalResumeArgs,
  deps: { db?: DirectDatabase; jobManager?: Pick<JobManager, "runResumeJobLifecycle">;
    assertInvocation?: typeof assertCanInvokeAgent;
    assertServerFunding?: typeof assertCanUseServerProviderCredentials } = {},
): Promise<RunTaskApprovalResumeResult> {
  let result: RunTaskApprovalResumeResult = { reparked: false };
  await (deps.jobManager ?? jobManager).runResumeJobLifecycle({
    laneKey: `task:${args.task.id}`,
    roomId: args.task.targetChat === "orphan" ? "" : args.task.targetRoomId ?? "",
    graphThreadId: args.run.graphThreadId,
    humanUserId: args.task.requestorId,
    taskRun: { taskId: args.task.id, taskRunId: args.run.id },
  }, async (signal) => {
    result = await runTaskApprovalResumeWorker(args, deps.db ?? getSharedDirectDb(), signal, deps);
  }, args.invocationAuthority, args.maintenanceAuthority);
  return result;
}

async function runTaskApprovalResumeWorker(
  args: RunTaskApprovalResumeArgs, db: DirectDatabase, signal: AbortSignal,
  deps: { assertInvocation?: typeof assertCanInvokeAgent;
    assertServerFunding?: typeof assertCanUseServerProviderCredentials },
): Promise<RunTaskApprovalResumeResult> {
  const { task, run } = args;
  assertAcceptedInvocationAuthoritySubject(
    args.invocationAuthority,
    task.requestorId,
  );
  const laneKey = `task:${task.id}`;
  if (signal.aborted) return { reparked: false };
  try {
    // Re-read the persisted requestor immediately before the parked graph
    // can spend again. The approving owner is a responder, not the payer.
    await (deps.assertInvocation ?? assertCanInvokeAgent)({ humanUserId: task.requestorId,
      agentId: task.agentId, ...(task.targetRoomId ? { roomId: task.targetRoomId } : {}),
      origin: "foreground_resume" });
    await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(task.requestorId, "task_approval_resume");
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)
      && !(error instanceof ServerProviderCredentialsDeniedError)) throw error;
    const transition = await pauseAwaitingTaskRunForAuthorizationDenial(db, {
      taskId: task.id, taskRunId: run.id, graphThreadId: run.graphThreadId,
    });
    if (transition.transitioned && transition.task) eventBus.emit({
      type: "task.status", taskId: transition.task.id,
      ownerId: transition.task.ownerId, status: "paused",
    });
    return { reparked: false };
  }
  const transition = (from: "awaiting" | "running", to: "awaiting" | "running") =>
    transitionTaskApprovalExecution(db, {
      taskId: task.id, runId: run.id, graphThreadId: run.graphThreadId,
      ownerId: task.ownerId, from, to,
      ...(args.kind === "ordinary_recovery" ? { requireLatestRun: true } : {}),
    });
  if (!await transition("awaiting", "running")) return { reparked: false,
    ...(args.kind === "ordinary_recovery" ? { recoveryOutcome: "unavailable" as const } : {}) };
  if (signal.aborted) return { reparked: false };
  eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "running" });

  // Chained requests become visible only after the run is durably parked.
  const pendingRequests: ServerEvent[] = [];
  // `state.roomId` the run actually carried (orphan target_chat runs persist
  // with a NULL session room → no room → no `room` verb on chained prompts).
  const sessionRoomId =
    task.targetChat === "orphan" ? "" : task.targetRoomId ?? "";
  const hasRoom = sessionRoomId.length > 0;

  try {
    // Validate only after claiming the exact running pair. A stale reply must
    // never error a Task that Pause already fenced. Invalid echoes still stop
    // before any graph/provider execution through the guarded failure path.
    const mediaGenerationEcho = exactTaskMediaGenerationResumeEcho(args, laneKey);
    // Mirror M151: persist resumed turns under a room MEMBER (the room owner)
    // for room-backed targets, else the task owner.
    let transcriptOwnerId = task.ownerId;
    let sessionRoomKind: string | null = null;
    if (sessionRoomId) {
      const [rm] = await db
        .select({ ownerId: rooms.ownerId, kind: rooms.kind })
        .from(rooms)
        .where(eq(rooms.id, sessionRoomId))
        .limit(1);
      if (rm?.ownerId) transcriptOwnerId = rm.ownerId;
      sessionRoomKind = rm?.kind ?? null;
    }

    const base = createPersistingProcessor({
      threadId: run.graphThreadId,
      ownerId: transcriptOwnerId,
      agentId: task.agentId,
      ...(sessionRoomId ? { roomId: sessionRoomId } : {}),
      ...(sessionRoomKind === "subthread" && sessionRoomId
        ? { subthreadRoomId: sessionRoomId }
        : {}),
      laneKey,
      eventBus,
    });
    // R11 — any chained interrupt emitted by `emitChainedInterrupts` during the
    // resume must be patched with Task context before fanout, else it lands as a
    // generic room-gated event the workbench would drop.
    const savedPreparation = readTaskPreparation(task.metadata["preparation"]);
    let latestProgress: ObservedTaskProgress | null = savedPreparation?.taskRunId === run.id
      ? { preparation: savedPreparation, detail: taskPreparationText(savedPreparation) } : null;
    const processor: StreamEventProcessor = {
      process: (ev) => {
        if (signal.aborted) return;
        const observed = extractTaskProgressFromStreamEvent(ev);
        if (observed) {
          const progress = retainTaskWorkProgress(latestProgress, observed);
          if (JSON.stringify(progress) !== JSON.stringify(latestProgress)) {
            latestProgress = progress;
            eventBus.emit({ type: "task.progress", taskId: task.id, taskRunId: run.id,
              ownerId: task.ownerId, detail: progress.detail, preparation: progress.preparation });
          }
        }
        return base.process(ev);
      },
      flush: () => base.flush(),
      emit: (event: ServerEvent) => {
        if (signal.aborted) return;
        const patched = patchTaskApprovalEvent(event, {
            taskId: task.id,
            taskRunId: run.id,
            ownerId: task.ownerId,
            hasRoom,
          });
        if (event.type === "approval.ask" || event.type === "prove_it.challenge" || event.type === "identity.challenge") {
          pendingRequests.push(patched);
        } else {
          base.emit(patched);
        }
      },
    };

    await runWithAcceptedWorkAuthorities(
      args.maintenanceAuthority,
      args.invocationAuthority,
      () => runWithTaskCausalHuman(task.requestorId, async () => {
        if (args.kind === "ordinary_recovery") {
          if (!args.ordinaryRecovery) throw new OrdinaryContentAccessRecoveryUnavailableError();
          await resumeOrdinaryContentAccessRecovery(args.ordinaryRecovery.expected, args.ordinaryRecovery.deps, processor, signal);
        } else if (args.kind === "ask") {
          if (!args.verb) {
            throw new Error("runTaskApprovalResume: kind=ask requires verb");
          }
          await resumeGraphWithAskReply(
            run.graphThreadId,
            args.verb,
            processor,
            laneKey,
            undefined,
            signal,
            args.localMcpInstallApprovalId,
            args.localMcpInstallDigest,
            laneKey,
            args.structuredSshApprovalId,
            mediaGenerationEcho?.[0],
            mediaGenerationEcho?.[1],
            mediaGenerationEcho?.[2],
            mediaGenerationEcho?.[3],
            mediaGenerationEcho?.[4],
            undefined,
            undefined,
            args.approvalId,
          );
        } else if (args.kind === "prove_it") {
          if (args.approved === undefined) {
            throw new Error("runTaskApprovalResume: kind=prove_it requires approved");
          }
          await resumeGraphWithApproval(
            run.graphThreadId,
            args.approved,
            processor,
            laneKey,
            undefined,
            signal,
            undefined,
            undefined,
            args.challengeId,
          );
        } else {
          if (!args.policyContext) {
            throw new Error("runTaskApprovalResume: kind=identity requires policyContext");
          }
          await resumeGraphWithIdentity(
            run.graphThreadId,
            args.policyContext,
            task.agentId,
            processor,
            laneKey,
            "workbench",
            undefined,
            signal,
          );
        }
      }),
    );
    // R10 / R11 — finalize via the Task finalizer, or stay awaiting if the
    // resume re-parked on a chained approval/PIN/identity interrupt (the patched
    // chained events are buffered until the durable transition succeeds).
    if (signal.aborted) return { reparked: false };
    const outcome = await inspectTaskResumeOutcome(run.graphThreadId, laneKey);
    if (signal.aborted) return { reparked: false };
    if (outcome.reparked) {
      if (!await transition("running", "awaiting")) return { reparked: false };
      eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "awaiting" });
      for (const request of pendingRequests) base.emit(request);
      log(`[task-approval-resume] task=${task.id} run=${run.id} re-parked (awaiting)`);
      return { reparked: true, ...(args.kind === "ordinary_recovery" ? { recoveryOutcome: "completed" as const } : {}) };
    }

    const resultText = outcome.securityResearch
      ? await finalizeSecurityReportDelivery({ taskId: task.id, taskRunId: run.id,
          modelId: run.modelId ?? "", report: outcome.finalText, ...outcome.securityResearch,
          threadId: run.graphThreadId, userId: task.ownerId,
          assertActive: () => assertSecurityReportTaskActive(db, task.id, run.id, task.ownerId) })
      : outcome.finalText;
    await reportBackTaskCompletion({ db }, { taskId: task.id, runId: run.id,
      scheduleKind: task.scheduleKind, resultText,
      requireRunningPair: true });
    log(`[task-approval-resume] task=${task.id} run=${run.id} resumed to completion`);
    return { reparked: false, ...(args.kind === "ordinary_recovery" ? { recoveryOutcome: "completed" as const } : {}) };
  } catch (err) {
    if (err instanceof OrdinaryContentAccessRecoveryUnavailableError) {
      const parked = await transition("running", "awaiting");
      if (parked) eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "awaiting" });
      return { reparked: parked, recoveryOutcome: "unavailable" };
    }
    if (err instanceof OrdinaryContentAccessRetryRequiredError) {
      const recovery = await parkTaskContentAccessRecovery(db, { taskId: task.id, taskRunId: run.id,
        graphThreadId: run.graphThreadId, ownerId: task.ownerId, error: err });
      return { reparked: recovery.parked, recoveryOutcome: recovery.parked ? "retry_required" : "unavailable" };
    }
    if (args.kind === "ordinary_recovery" && args.ordinaryRecovery && !signal.aborted) {
      // A transport/checkpoint read failure is not evidence the original
      // uncertain operation failed. Only a readable, superseding checkpoint
      // permits the ordinary Task failure owner to terminalize this run.
      let stillUncertain = true;
      try {
        stillUncertain = await readOrdinaryContentAccessRecovery(args.ordinaryRecovery.expected, args.ordinaryRecovery.deps) !== null;
      } catch { /* Keep the exact checkpoint available for explicit retry. */ }
      if (stillUncertain) {
        const parked = await transition("running", "awaiting");
        if (parked) eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "awaiting" });
        return { reparked: parked, recoveryOutcome: parked ? "retry_required" : "unavailable" };
      }
    }
    const staleReply =
      err instanceof Error && "code" in err &&
      err.code === "approval_request_stale";
    if (signal.aborted) {
      return staleReply
        ? { reparked: false, staleReply: true }
        : { reparked: false };
    }
    if (staleReply) {
      if (!await transition("running", "awaiting")) {
        return { reparked: false, staleReply: true };
      }
      eventBus.emit({
        type: "task.status",
        taskId: task.id,
        ownerId: task.ownerId,
        status: "awaiting",
      });
      try {
        const currentRequests = await replayTaskInterruptEvents({
          taskId: task.id,
          taskRunId: run.id,
          ownerId: task.ownerId,
          graphThreadId: run.graphThreadId,
          laneKey,
          hasRoom,
        });
        for (const request of currentRequests) eventBus.emit(request);
      } catch {
        // The running pair is already restored to awaiting. Recovery can
        // replay the canonical prompt when checkpoint authority returns.
        warn(`[task-approval-resume] canonical stale recovery unavailable task=${task.id} run=${run.id}`);
      }
      return { reparked: true, staleReply: true };
    }
    if (await parkSecurityResearchInterruption(db, { taskId: task.id, taskRunId: run.id, ownerId: task.ownerId, error: err })) {
      return { reparked: false };
    }
    if (err instanceof SecurityReportDeliveryPendingError) {
      await parkSecurityReportDelivery(db, { taskId: task.id, taskRunId: run.id, ownerId: task.ownerId });
      return { reparked: false };
    }
    await recordSecurityResearchFailure(db, { taskId: task.id, taskRunId: run.id, ownerId: task.ownerId, error: err });
    const message = err instanceof Error ? err.message : String(err);
    warn(`[task-approval-resume] resume threw task=${task.id} run=${run.id}: ${message}`);
    await reportBackTaskError(
      { db },
      {
        taskId: task.id,
        runId: run.id,
        scheduleKind: task.scheduleKind,
        error: message,
        failureResultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
        requireRunningPair: true,
      },
    );
    return { reparked: false };
  }

}
