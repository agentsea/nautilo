import { resolveTaskLocalExecutionPort, isTaskLocalExecutionTargetAvailable } from "./local-execution-delegation";
import type { ServerEvent } from "@nautilo/types";
import { parkTaskContentAccessRecovery } from "./ordinary-content-access-recovery";
import { recordSecurityResearchFailure, parkSecurityResearchInterruption, attachSecurityResearchJob, parkSecurityReportDelivery, readSecurityReportDeliveryResult, SecurityReportDeliveryPendingError } from "./security-report-recovery";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  parseTaskReportBackContinuation,
  type NautiloState,
  type RunScopeSubagentOpts,
  type DelegatedLocalExecutionPort,
} from "@nautilo/agent";
import { parkTaskLocalExecutionOffline, taskLocalExecutionOfflineMarker, TASK_LOCAL_EXECUTION_OFFLINE_TEXT, type DirectDatabase, type Task, type TaskRun, markTaskAwaitingIfCurrentRun, markTaskRunStatus, getTaskById, getTaskRunForTask, pauseTaskRunForFundingDenial, claimCallerTaskRunJob } from "@nautilo/db";
import {
  buildRuntimeCapabilityTokens,
  createCheckpointSaver,
  deleteEphemeralCheckpointThread,
  getRelayRegistry,
  isEphemeralCheckpointThread,
  readDeepResearchTaskMetadata,
  runScopeSubagentUntilPause,
} from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";
import { eventBus } from "../event-bus";
import { getCurrentAcceptedInvocationAuthority } from "../job-manager";
import { openTaskFundingSession, taskFundingFailureCode, TaskFundingError } from "../task-funding-port";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";
import { classifyTurnKind, type TurnKind } from "../executors/turn-kind";
import type { JobExecutor } from "../job";
import { getTaskRunDb } from "./task-runtime-context";
import {
  reportBackTaskCompletion,
  reportBackTaskError,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT,
  SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT,
  SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
  SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT,
} from "./report-back";
import {
  beginTaskWriterReviewVerification,
  resolveTaskLiveMiniAppBinding,
  taskWriterReviewVerificationCoverageState,
} from "./task-return-binding";
import { replayTaskInterruptEvents, taskApprovalRecipient } from "./emit-task-interrupt";
import { prepareRepoDocsWorkspace, type RepoDocsWorkspace } from "./repo-docs-task";
import { settleTaskWriterReviewAfterModel } from "./writer-review-task-lifecycle";
import { streamDeepResearchReport } from "../executors/deep-research-executor";
import {
  finalizeSecurityReportDelivery,
  assertSecurityReportTaskActive,
  isSecurityResearchTask,
} from "./security-report-artifact";

/**
 * Test seam for the strict-mode threading contract. Allows
 * integration tests to capture the `RunScopeSubagentOpts` passed to
 * `runScopeSubagentUntilPause` (and short-circuit the run) WITHOUT running
 * the full subagent graph, so the `exactModelSelection → modelFallbackMode:
 * "none"` mapping can be asserted deterministically against real Postgres
 * task_run rows. Production always uses the real runner; the override is
 * `null` unless a test explicitly installs one and MUST be cleared afterwards
 * (it is module-level state shared by every runtime integration test in the
 * same Bun process; approval-resume tests drive the real executor).
 */
type TaskRunExecutorRunner = typeof runScopeSubagentUntilPause;
let _runnerOverrideForTests: TaskRunExecutorRunner | null = null;
export function _setTaskRunExecutorRunnerForTests(fn: TaskRunExecutorRunner | null): void {
  _runnerOverrideForTests = fn;
}

/**
 * Test seam for terminal thread cleanup. The default invokes
 * the real best-effort `deleteEphemeralCheckpointThread` over the cached
 * `PostgresSaver`; tests
 * override it to capture the cleanup call without touching Postgres (mirrors
 * `_setTaskRunExecutorRunnerForTests` above). MUST be cleared after use —
 * module-level state shared by every runtime test in the same bun process.
 */
type TaskRunCleanupFn = (graphThreadId: string) => Promise<void>;
let _cleanupThreadFnForTests: TaskRunCleanupFn | null = null;
export function _setTaskRunCleanupFnForTests(fn: TaskRunCleanupFn | null): void {
  _cleanupThreadFnForTests = fn;
}

/** Default cleanup: best-effort terminal delete over the cached saver. */
function defaultCleanupThread(graphThreadId: string): Promise<void> {
  return deleteEphemeralCheckpointThread(createCheckpointSaver(), graphThreadId);
}

function runTaskRunCleanup(graphThreadId: string): Promise<void> {
  return (_cleanupThreadFnForTests ?? defaultCleanupThread)(graphThreadId);
}

/** Pull a string field from the (coalescer-roundtripped) job input. */
function str(input: Record<string, unknown>, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : fallback;
}

function num(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * presence-gated relay capabilities for a Task run.
 *
 * Computes the same flat capability-token dict the foreground executors build
 * (`langgraph-executor.ts` / `fork-langgraph-executor.ts`), keyed on the task
 * **owner** (the relay-owning user) — NOT the requestor — so a peer-dispatched
 * task uses the owner's relay. The job is already off the queue and executing,
 * so "live now" is the correct presence semantics for "live at dispatch" (D1).
 *
 * Returns `undefined` when the owner has no live relay at run start, which makes
 * `ToolCatalog.getFiltered` exclude every relay-executor tool — the run proceeds
 * cloud-only with no error and no park (R2). No second definition of "live
 * relay" is introduced (R8): this reuses `buildRuntimeCapabilityTokens` +
 * `getRelayRegistry` exactly like foreground.
 */
export function computeTaskRelayCapabilities(
  ownerId: string,
): NautiloState["relayCapabilities"] {
  return buildRuntimeCapabilityTokens(getRelayRegistry(), ownerId);
}

export class TaskLocalExecutionAuthorityUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Saved Mac, project, or source access could not be confirmed. Review access, then recreate this Task from its original chat on the intended Mac.", { cause });
    this.name = "TaskLocalExecutionAuthorityUnavailableError";
  }
}

/** Pre-model readiness uses the same run-local source owner as dispatch. It
 * never sends a command or interprets a transport failure as a retry. */
export async function prepareTaskLocalExecutionTarget(input: {
  db: DirectDatabase; task: Task; run: TaskRun; jobId: string; signal: AbortSignal; phase: "cold" | "checkpoint";
}, deps: {
  resolvePort?: typeof resolveTaskLocalExecutionPort;
  targetAvailable?: typeof isTaskLocalExecutionTargetAvailable;
  park?: typeof parkTaskLocalExecutionOffline;
  readTask?: typeof getTaskById;
} = {}): Promise<{ kind: "ready"; port?: DelegatedLocalExecutionPort } | { kind: "parked" | "superseded" }> {
  // The observed definition must survive all awaited source checks unchanged.
  const task = structuredClone(input.task);
  const run = structuredClone(input.run);
  input.signal.throwIfAborted();
  let port: DelegatedLocalExecutionPort | undefined;
  let available: boolean;
  try {
    port = await (deps.resolvePort ?? resolveTaskLocalExecutionPort)({ db: input.db,
      taskId: task.id, taskRunId: run.id, signal: input.signal });
    if (!port) {
      if (task.localExecutionDelegation) throw new Error("Saved Task delegation was removed");
      return { kind: "ready" };
    }
    available = await port.withAdmission("start", source => {
      if (JSON.stringify(source.delegation) !== JSON.stringify(task.localExecutionDelegation)) {
        throw new Error("Saved Task delegation changed");
      }
      return Promise.resolve((deps.targetAvailable ?? isTaskLocalExecutionTargetAvailable)(source.delegation));
    });
    const current = await (deps.readTask ?? getTaskById)(input.db, task.id);
    if (!current || taskLocalExecutionOfflineMarker(current) !== taskLocalExecutionOfflineMarker(task)) {
      throw new Error("Saved Task definition changed");
    }
  } catch (error) {
    input.signal.throwIfAborted();
    throw new TaskLocalExecutionAuthorityUnavailableError(error);
  }
  input.signal.throwIfAborted();
  if (available) return { kind: "ready", port };
  const parked = await (deps.park ?? parkTaskLocalExecutionOffline)(input.db, { task, run, jobId: input.jobId, phase: input.phase });
  if (parked) {
    eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "paused" });
    eventBus.emit({ type: "task.progress", taskId: task.id, taskRunId: run.id, ownerId: task.ownerId,
      detail: TASK_LOCAL_EXECUTION_OFFLINE_TEXT });
  }
  // A simultaneous Stop/edit owns the outcome; generic failure handling must
  // not overwrite it or report that any local command ran.
  return { kind: parked ? "parked" : "superseded" };
}

/** The persisted pair wins before any approval/PIN presentation is replayed. */
export async function parkTaskRunInterrupt(db: DirectDatabase, input: { taskId: string; taskRunId: string }): Promise<boolean> {
  const parked = await markTaskAwaitingIfCurrentRun(db, input);
  if (!parked.transitioned || !parked.task) return false;
  eventBus.emit({ type: "task.status", taskId: input.taskId, ownerId: parked.task.ownerId, status: "awaiting" });
  return true;
}

/**
 * the executor that runs a dispatched task as its own job.
 *
 * Invoked by `JobManager` for a task-only lane (`task:<taskId>`) on the run's
 * own graph thread, so it never holds a human room's lane. It reuses the
 * existing `runScopeSubagentUntilPause` runner — there is no second subagent
 * runner. On terminal state it sets the 2a interim task / task_run status.
 *
 * The report-back finalizer owns terminal-status transitions and delivery
 * back to the requesting Human.
 */
export const taskRunExecutor: JobExecutor = async function* taskRunExecutor(
  input: Record<string, unknown>,
  jobId: string,
  _laneKey: string | null,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const db = getTaskRunDb();
  const taskId = str(input, "taskId");
  const taskRunId = str(input, "taskRunId");
  const scheduleKind = str(input, "scheduleKind", "now");
  const subEnvelope = input["memoryAccessEnvelope"] as MemoryAccessEnvelope | undefined;

  if (!taskId || !taskRunId || !subEnvelope) {
    throw new Error("taskRunExecutor: missing taskId / taskRunId / envelope in job input");
  }

  // an unpause dispatch reuses the prior run's `graphThreadId`
  // (set by `dispatchTaskRun`) and continues the preserved checkpoint via a
  // `null`-input stream rather than cold-starting a fresh brief.
  const continueFromCheckpoint = input["resumeFromCheckpoint"] === true;

  // explicit turn-kind: an unpause continues the parked
  // checkpoint (resume); a scheduled/now dispatch is a fresh cold-start. Branches
  // This classification is for observability.
  const turnKind: TurnKind = classifyTurnKind({ continueFromCheckpoint });
  log(`[task-run] task=${taskId} run=${taskRunId} turnKind=${turnKind}`);

  // thread presence-gated relay capabilities so a background/async Task
  // run may use relay-executor tools (`run_shell`, fs writes, desktop tools)
  // when the owner has a live relay at run start. `undefined` ⇒ cloud-only
  // (R2). `taskRun: true` (below) routes a mid-run relay drop to a clean
  // `relay_unavailable` error instead of a swallowed tool message (R6). The
  // resulting approval/identity interrupts use the ordinary resume path.
  const ownerId = str(input, "ownerId");
  const relayCapabilities = computeTaskRelayCapabilities(ownerId);

  // convert the Phase-3 `exactModelSelection` job flag into the
  // explicit fallback mode threaded into the subagent graph. An exact Task
  // `model_id` pin is strict: `"none"` suppresses every cross-model hop inside
  // `invokeChatModelWithFallback` (provider error, context preflight, vision
  // incompatibility, capability error) while preserving bounded same-model
  // short retries. Non-exact / foreground callers stay on `"agent_chain"`.
  // The literal is structurally assignable to `ModelFallbackMode` on
  // `RunScopeSubagentOpts`; the single source of truth for the mapping is
  // `modelFallbackModeFromExactSelection` in `@nautilo/agent` (kept in sync
  // here by the matching union `"agent_chain" | "none"`).
  const exactModelSelection = input["exactModelSelection"] === true;
  const modelFallbackMode: "agent_chain" | "none" = exactModelSelection ? "none" : "agent_chain";
  // only dispatch may supply an already-revalidated live Task return
  // binding. The parser is deliberately strict: a malformed or stale job
  // value becomes unavailable and cannot create host authority.
  const taskReportBackContinuation = parseTaskReportBackContinuation(
    input["taskReportBackContinuation"],
  );

  // the `repo_docs` preset runs the OpenWiki doc agent in an ISOLATED
  // git worktree. The orchestrator wrapper (repo-docs-task.ts) prepares the
  // worktree + composed brief and, on success, commits/publishes; the agent
  // itself only writes via the `file` tool (toolsWhitelist ["file"]). Declared
  // out here so the abort/catch paths can tear the worktree down.
  let repoDocs: RepoDocsWorkspace | null = null;

  try {
    const task = await getTaskById(db, taskId);
    if (!task) throw new TaskFundingError("funding_source_changed");
    const run = await getTaskRunForTask(db, taskId, taskRunId);
    if (!run) throw new TaskFundingError("funding_source_changed");
    if (task.fundingMode === "caller" && (
      continueFromCheckpoint !== Boolean(run.fundingPredecessorRunId)
      || ownerId !== task.ownerId || str(input, "agentId") !== task.agentId
      || str(input, "callingRoomId") !== task.callingRoomId
      || str(input, "currentTaskId") !== task.id
      || str(input, "roomId") !== (task.targetChat === "orphan" ? "" : task.targetRoomId ?? "")
      || !Array.isArray(input["toolWhitelist"]) || input["toolWhitelist"].length !== 0
      || input["awaitResponse"] === true || input["requiresLiveMiniApp"] === true
      || (Array.isArray(input["artifactRefs"]) && input["artifactRefs"].length > 0)
      || (Array.isArray(input["focusedResources"]) && input["focusedResources"].length > 0)
    )) throw new TaskFundingError("funding_source_changed");
    const fundingSession = await openTaskFundingSession({
      task, run, authority: getCurrentAcceptedInvocationAuthority(),
      requestorId: str(input, "requestorId"), modelId: str(input, "modelId"),
      graphThreadId: str(input, "graphThreadId"),
    });
    if (task.fundingMode === "caller") {
      // Identity and funding are verified before an old queued job may touch
      // the run. A stopped, replaced, or already claimed run cannot be revived.
      if (!await claimCallerTaskRunJob(db, { taskId, taskRunId,
        requestorId: task.requestorId, graphThreadId: run.graphThreadId, jobId })) return;
    } else {
      if (!fundingSession) await assertCanUseServerProviderCredentials(task.requestorId, "task_execute");
      if (isSecurityResearchTask(input)) {
        if (!await attachSecurityResearchJob(db, { taskId, taskRunId, ownerId: str(input, "ownerId"), jobId })) return;
      } else {
        await markTaskRunStatus(db, taskRunId, "running", { jobId });
      }
    }
    // Claim and funding admission precede this source check; the model and
    // workspace effects follow it. Reconnect always targets the saved pairing.
    const claimedRun = await getTaskRunForTask(db, taskId, taskRunId);
    if (!claimedRun) return;
    const localPreparation = await prepareTaskLocalExecutionTarget({ db, task, run: claimedRun, jobId, signal, phase: continueFromCheckpoint ? "checkpoint" : "cold" });
    if (localPreparation.kind !== "ready") {
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    const delegatedLocalExecutionPort = localPreparation.port;
    eventBus.emit({ type: "task.progress", taskId, taskRunId, ownerId,
      ...(input["securityReportDeliveryOnly"] === true
        ? { detail: "Delivering saved research report" }
        : { detail: "Preparing task context and model", preparation: { stage: "preparing_model" as const } }) });
    const deepResearch = readDeepResearchTaskMetadata(input["metadata"]);
    if (deepResearch) {
      const stream = streamDeepResearchReport(
        {
          research_brief: str(input, "message"),
          report_language: deepResearch.reportLanguage,
          deep_research_model_plan: deepResearch.modelPlan,
        },
        taskRunId,
        signal,
        str(input, "requestorId"),
      );
      let resultText = "";
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          resultText = next.value;
          break;
        }
        yield {
          type: "task.progress",
          taskId,
          taskRunId,
          ownerId,
          detail: next.value.detail ?? next.value.phase,
        };
      }
      if (signal.aborted) {
        log(`[task-run] deep-research task=${taskId} run=${taskRunId} aborted — skipping report-back`);
        return;
      }
      await reportBackTaskCompletion(
        { db },
        { taskId, runId: taskRunId, scheduleKind, resultText },
      );
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }

    if (str(input, "preset") === "repo_docs") {
      repoDocs = await prepareRepoDocsWorkspace(input, str(input, "modelId"));
      input["currentFolder"] = repoDocs.workDir;
      input["workspacePath"] = repoDocs.workDir;
      input["message"] = repoDocs.brief;
    }
    // A Task explicitly marked by server composition as depending on a live
    // mini-app must re-resolve that exact app after the Job starts and before
    // any graph/provider work. The durable marker carries only the app id;
    // checkpoint state and tool names never recreate a live session.
    const requiredLiveMiniAppAppId = str(input, "liveMiniAppAppId");
    const requiresMarkedLiveMiniApp = input["requiresLiveMiniApp"] === true;
    const requiresLiveMiniApp = requiresMarkedLiveMiniApp;
    const liveMiniAppBinding = requiresLiveMiniApp
      ? resolveTaskLiveMiniAppBinding(taskId, ownerId)
      : null;
    const hasExactRequiredApp =
      liveMiniAppBinding?.status === "available"
      && (!requiresMarkedLiveMiniApp
        || (requiredLiveMiniAppAppId.length > 0
          && liveMiniAppBinding.context.activeMiniApp.appId === requiredLiveMiniAppAppId
          && liveMiniAppBinding.context.liveMiniAppSession.appId === requiredLiveMiniAppAppId));
    if (requiresLiveMiniApp && !hasExactRequiredApp) {
      await reportBackTaskError(
        { db },
        {
          taskId,
          runId: taskRunId,
          scheduleKind,
          error: "LIVE_MINI_APP_SESSION_UNAVAILABLE",
          failureResultText: SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT,
        },
      );
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    // Every server-admitted live review run receives an empty, process-local
    // coverage record. A proposal still parks normally below; the record only
    // matters if this exact run attempts the ordinary no-review success path.
    // The accepted-save continuation is one such run, not the only one that
    // must prove it read the canonical document before claiming completion.
    if (
      requiresLiveMiniApp &&
      (!hasExactRequiredApp || !beginTaskWriterReviewVerification({ taskId, taskRunId, ownerId }))
    ) {
      await reportBackTaskError(
        { db },
        {
          taskId,
          runId: taskRunId,
          scheduleKind,
          error: "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
          failureResultText: SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT,
        },
      );
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    // production uses the real runner; a test may install a
    // capturing override via `_setTaskRunExecutorRunnerForTests` to assert the
    // strict-mode opts without running the full subagent graph.
    const runner = _runnerOverrideForTests ?? runScopeSubagentUntilPause;
    const result = input["securityReportDeliveryOnly"] === true && continueFromCheckpoint && isSecurityResearchTask(input)
      ? await readSecurityReportDeliveryResult(db, { taskId, taskRunId, ownerId, threadId: str(input, "graphThreadId"), modelId: str(input, "modelId") })
      : await runner({
      ...(fundingSession ? { foregroundChatFundingSession: fundingSession } : {}),
      ...(continueFromCheckpoint ? { continueFromCheckpoint: true } : {}),
      parentThreadId: str(input, "parentThreadId"),
      parentTurnId: str(input, "turnId"),
      parentOwnerId: str(input, "ownerId"),
      ...(str(input, "transcriptOwnerId")
        ? { transcriptOwnerId: str(input, "transcriptOwnerId") }
        : {}),
      brief: str(input, "message"),
      ...(str(input, "expectedOutput")
        ? { expectedOutput: str(input, "expectedOutput") }
        : {}),
      // `toolWhitelist` is omitted for `auto`, selecting the graph's
      // progressive core + activation default. `[]` remains tool-free; an
      // explicit list remains a hard ceiling through every graph step.
      ...(Array.isArray(input["toolWhitelist"])
        ? { toolWhitelist: input["toolWhitelist"] as string[] }
        : {}),
      // Auto mode deliberately has no whitelist ceiling. The server may still
      // seed exact extension-admitted live tools for this first model step;
      // that process-local seed is distinct from durable Task intent.
      ...(hasExactRequiredApp
        && liveMiniAppBinding?.status === "available"
        && liveMiniAppBinding.initialActivatedToolNames
        ? { initialActivatedToolNames: liveMiniAppBinding.initialActivatedToolNames }
        : {}),
      subEnvelope,
      actorRole: str(input, "actorRole", "owner"),
      assistantName: str(input, "assistantName", "Genie"),
      soulFile: str(input, "soulFile"),
      modelId: str(input, "modelId"),
      currentFolder: str(input, "currentFolder"),
      workspacePath: str(input, "workspacePath"),
      taskReportBackContinuation,
      activeMiniApp: hasExactRequiredApp && liveMiniAppBinding?.status === "available"
        ? liveMiniAppBinding.context.activeMiniApp
        : null,
      liveMiniAppSession: hasExactRequiredApp && liveMiniAppBinding?.status === "available"
        ? liveMiniAppBinding.context.liveMiniAppSession
        : null,
      subagentDepth: num(input, "subagentDepth", 1),
      subagentMaxDepth: num(input, "subagentMaxDepth", 5),
      securityAuditClientMeta: null,
      roomRoster: (Array.isArray(input["roomRoster"])
        ? input["roomRoster"]
        : []) as RunScopeSubagentOpts["roomRoster"],
      roomId: str(input, "roomId"),
      callingRoomId: str(input, "callingRoomId"),
      currentTaskId: str(input, "currentTaskId"),
      // The executor read this exact TaskRun id from the server-authored job
      // input before graph construction. No model-visible tool argument can
      // provide or replace it.
      currentTaskRunId: taskRunId,
      ...(Array.isArray(input["artifactRefs"])
        ? { artifactRefs: input["artifactRefs"] as NonNullable<RunScopeSubagentOpts["artifactRefs"]> }
        : {}),
      ...(Array.isArray(input["focusedResources"])
        ? { focusedResources: input["focusedResources"] as NonNullable<RunScopeSubagentOpts["focusedResources"]> }
        : {}),
      ...(Array.isArray(input["assistantArtifactExternalIds"])
        ? {
            assistantArtifactExternalIds: input["assistantArtifactExternalIds"]
              .filter((value): value is string => typeof value === "string" && value.length > 0),
          }
        : {}),
      subagentThreadId: str(input, "graphThreadId"),
      causalHumanUserId: str(input, "requestorId"),
      // presence-gated relay tools + Task-run relay-drop semantics.
      relayCapabilities,
      taskRun: true,
      ...(delegatedLocalExecutionPort ? { delegatedLocalExecutionPort } : {}),
      // The scheduled wake is the visible delivery. Keep the execution
      // transcript internal even when it shares the calling Room.
      deferAssistantOutputToReportBack:
        str(input, "preset") === "schedule" && str(input, "resultDelivery") === "wake",
      // task runs carry an explicit non-foreground provenance stamp.
      trustedExecutionEntrypoint: "background.task",
      // strict / no-chain mode for an exact Task `model_id` pin.
      modelFallbackMode,
      progressTaskId: taskId,
      approvalLaneKey: `task:${taskId}`,
      progressTaskRunId: taskRunId,
      progressOwnerId: str(input, "ownerId"),
      // await-response context forwarded from dispatch.
      ...(input["awaitResponse"] === true
        ? {
            awaitResponse: true,
            awaitRoomId: str(input, "awaitRoomId"),
            awaitFromUserIds: Array.isArray(input["awaitFromUserIds"])
              ? (input["awaitFromUserIds"] as string[])
              : [],
            awaitTaskId: str(input, "awaitTaskId", taskId),
            awaitTaskRunId: str(input, "awaitTaskRunId", taskRunId),
            awaitOwnerId: str(input, "awaitOwnerId"),
          }
        : {}),
      signal,
    });

    // a pause/stop abort is NOT a failure. `runScopeSubagentUntilPause`
    // breaks its stream loop on `signal.aborted` and returns normally; the
    // lifecycle fn (`pauseTask`/`stopTask`) has already written the
    // `paused`/`cancelled` status on both the task and the run. Do not run a
    // second finalizer here: Stop already delivered the cancellation outcome,
    // while Pause remains non-terminal and silent.
    if (signal.aborted) {
      await repoDocs?.cleanup();
      log(`[task-run] task=${taskId} run=${taskRunId} aborted (pause/stop) — skipping report-back`);
      return;
    }

    if (result.status === "interrupted") {
      const parked = await parkTaskRunInterrupt(db, { taskId, taskRunId });
      if (!parked) {
        yield { type: "worker.complete", jobId, result: "success" };
        return;
      }
      // surface an approval / PIN / identity challenge raised inside the
      // run to the Task owner. Owner-scoped + Task-tagged so the workbench dock
      // /modal opens regardless of the active room and the resume route can
      // find the parked run. Non-approval interrupts (e.g. await_human_reply)
      // map to null and stay silent here.
      const taskInterruptContext = {
        taskId,
        taskRunId,
        ownerId: task.ownerId,
        approvalRecipientId: taskApprovalRecipient(task),
        graphThreadId: result.threadId,
        laneKey: `task:${taskId}`,
        hasRoom: str(input, "roomId").length > 0,
      };
      try {
        if (!taskApprovalRecipient(task)) throw new Error("Task approval recipient unavailable");
        const canonicalEvents = await replayTaskInterruptEvents(taskInterruptContext);
        for (const event of canonicalEvents) eventBus.emit(event);
      } catch {
        // The Task remains durably awaiting. Never downgrade a current prompt
        // to an unkeyed event when its canonical checkpoint cannot be read;
        // recovery can replay it once checkpoint authority is available.
        warn(`[task-run] canonical interrupt replay unavailable task=${taskId} run=${taskRunId}`);
      }
    } else {
      const writerReview = await settleTaskWriterReviewAfterModel(db, {
        taskId,
        taskRunId,
        ownerId,
      });
      if (writerReview !== "no_review") {
        if (isEphemeralCheckpointThread(result.threadId)) {
          await runTaskRunCleanup(result.threadId);
        }
        yield { type: "worker.complete", jobId, result: "success" };
        return;
      }
      if (
        requiresLiveMiniApp &&
        taskWriterReviewVerificationCoverageState({ taskId, taskRunId, ownerId }) !== "complete"
      ) {
        const acceptedWriterSaveNeedsVerification = input["writerReviewVerification"] === true;
        await reportBackTaskError(
          { db },
          {
            taskId,
            runId: taskRunId,
            scheduleKind,
            error: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
            failureResultText: acceptedWriterSaveNeedsVerification
              ? SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT
              : SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
          },
        );
        if (isEphemeralCheckpointThread(result.threadId)) {
          await runTaskRunCleanup(result.threadId);
        }
        yield { type: "worker.complete", jobId, result: "success" };
        return;
      }
      // for repo_docs, commit + publish the generated wiki on its
      // isolated branch and report the branch/worktree summary rather than the
      // agent's closing chatter.
      // The scope-subagent runner keeps a rich transcript for synchronous
      // parent composition, but Task raw delivery is a user-visible message.
      // Publish only the subagent's final assistant answer here; otherwise
      // `raw_and_wake` exposes the internal "full transcript for parent"
      // wrapper in the Room.
      let resultText = result.finalResponseText;
      if (repoDocs) {
        try {
          resultText = await repoDocs.commitAndPublish();
        } catch (e) {
          resultText = `Docs run finished but commit/publish failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (isSecurityResearchTask(input)) {
        resultText = await finalizeSecurityReportDelivery({
          envelope: subEnvelope, taskId, taskRunId, modelId: str(input, "modelId"),
          report: resultText, reportState: result.securityReportState,
          researchAppendix: result.securityResearchAppendix,
          threadId: result.threadId, userId: ownerId, signal,
          continuation: taskReportBackContinuation,
          assertActive: () => assertSecurityReportTaskActive(db, taskId, taskRunId, ownerId),
        });
      }
      // the report-back finalizer owns BOTH the terminal status
      // transition AND delivery (wake / raw / silent) of the result back to
      // the requesting Human.
      const completed = await reportBackTaskCompletion(
        { db },
        { taskId, runId: taskRunId, scheduleKind, resultText,
          ...(isSecurityResearchTask(input) ? { requireRunningPair: true } : {}) },
      );
      // the run's `subagent:` checkpoint thread is terminal and
      // ephemeral AFTER the report-back finalizer has durably committed the
      // terminal status + delivery. We delete it best-effort only on the
      // completed branch (this `else`), never on the `interrupted` branch
      // (awaiting / approval / PIN / identity), never on abort (the
      // `signal.aborted` early-return above), and never on the error/catch
      // path. Recurring / scheduled next runs are unaffected: a fresh
      // dispatch mints a fresh `subagent:…:<uuid>` thread (only a `paused` run
      // reuses the prior `graphThreadId`, and a paused run does not reach
      // here), so the next cron occurrence cold-starts cleanly.
      // `deleteEphemeralCheckpointThread` guards the ephemeral-thread predicate
      // and swallows failures, so this can never turn the successful task into
      // a failure. The runner's result is authoritative: it may have generated
      // or selected a different thread than the job input fallback.
      const completedGraphThreadId = result.threadId;
      if (completed && isEphemeralCheckpointThread(completedGraphThreadId)) {
        await runTaskRunCleanup(completedGraphThreadId);
      }
    }

    yield { type: "worker.complete", jobId, result: "success" };
  } catch (err) {
    // tear down the incomplete repo_docs worktree on any failure/abort.
    await repoDocs?.cleanup();
    // if the failure is the pause/stop abort surfacing as a thrown
    // AbortError, it is NOT a real runtime error: the lifecycle function owns
    // the paused/cancelled status and any cancellation delivery. Only a
    // non-abort error reports back from this catch path.
    if (signal.aborted) {
      log(`[task-run] task=${taskId} run=${taskRunId} aborted (pause/stop, thrown) — skipping report-back`);
      return;
    }
    const fundingFailure = taskFundingFailureCode(err);
    if (fundingFailure) {
      const transition = await pauseTaskRunForFundingDenial(db, {
        taskId, taskRunId, requestorId: str(input, "requestorId"), reason: fundingFailure,
      });
      if (transition.transitioned && transition.task) {
        eventBus.emit({ type: "task.status", taskId, ownerId, status: "paused" });
      }
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    const accessRecovery = await parkTaskContentAccessRecovery(db, { taskId, taskRunId, ownerId,
      graphThreadId: str(input, "graphThreadId"), error: err });
    if (accessRecovery.handled) {
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    if (await parkSecurityResearchInterruption(db, { taskId, taskRunId, ownerId, error: err })) {
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    if (err instanceof SecurityReportDeliveryPendingError) {
      await parkSecurityReportDelivery(db, { taskId, taskRunId, ownerId });
      yield { type: "worker.complete", jobId, result: "success" };
      return;
    }
    await recordSecurityResearchFailure(db, { taskId, taskRunId, ownerId, error: err });
    const message = err instanceof Error ? err.message : String(err);
    log(`[task-run] task=${taskId} run=${taskRunId} failed: ${message}`);
    // finalizer owns the error transition + `task.errored` emit.
    await reportBackTaskError(
      { db },
      {
        taskId,
        runId: taskRunId,
        scheduleKind,
        error: message,
        failureResultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
      },
    );
    throw err;
  }
};
