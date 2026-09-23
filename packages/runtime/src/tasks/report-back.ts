import { randomUUID } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import {
  terminalizeTaskWriterReviewVerificationLost,
  transitionTaskLifecycleTerminal,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import {
  appendTranscriptMessages,
  getRelayRegistry,
  type TaskReportBackContinuation,
} from "@nautilo/agent";
import {
  createAcceptedInvocationAuthority,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  findActorByOwnerId,
  getRoomDetailForMember,
  getPolicyResolver,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { log, warn } from "@nautilo/logger";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "../event-bus";
import { botThreadId } from "../conductor/thread-id";
import { getTaskRunJobManager } from "./task-runtime-context";
import {
  createMaintenanceAcceptanceAuthority,
  type MaintenanceAcceptanceAuthority,
} from "../maintenance-controller";
import {
  removeTaskReturnBinding,
  removeTaskReturnBindingPreservingResolvedWriterReview,
  resolveTaskReturnBinding,
} from "./task-return-binding";

/**
 * M143 (spec §5.8) — the report-back finalizer. Owns BOTH the terminal task /
 * task_run status transitions AND delivery of terminal Task outcomes back to
 * the user. Completion and failure enter here from executors/finalizers;
 * cancellation enters after the lifecycle transition has won.
 *
 * Delivery (only when `tasks.calling_room_id` is non-null):
 *  - `result_delivery = "wake"`: enqueue a fresh foreground turn in
 *    the calling room with a synthetic `[TASK RESULT …]` human input row tagged
 *    `metadata.originatedBy="task"` (hidden from chat render). The woken agent
 *    composes a natural reply.
 *  - `result_delivery = "raw"`: persist `resultText` directly as the agent's
 *    assistant message in the calling room (no extra LLM turn).
 *  - `result_delivery = "raw_and_wake"`: persist and emit the result first,
 *    then enqueue a fresh foreground turn whose transcript contains that
 *    visible result exactly once.
 *  - `calling_room_id` null → silent task: terminal status only, no room I/O.
 *
 * Plumbing note (M142 constraint): the executor has no `JobManager` and no full
 * `Task` row in scope, so the finalizer atomically locks and loads it through
 * `transitionTaskLifecycleTerminal`, then reaches a live `JobManager` via
 * `getTaskRunJobManager()` (published by
 * server wiring). The wake reuses the existing foreground-job path
 * (`createForegroundJob`), which routes through the coalescer — a wake fired on
 * a lane a human is mid-typing could merge into their coalesced burst. A
 * dedicated non-coalesced system-turn seam is deferred (no `createSystemForegroundJob`
 * exists today); flagged for follow-up.
 */

const MAX_PROMPT_SNIPPET = 60;
/**
 * The only error text that an ACP-backed task may opt in to deliver.  The
 * durable error remains the caller-supplied stable code; this is deliberately
 * not a channel for an upstream exception, prompt, or harness detail.
 */
export const SAFE_DELEGATED_TASK_FAILURE_RESULT =
  "The delegated task could not be completed. Please try again." as const;

/**
 * Fixed failure receipt for Nautilo's own background agent Tasks. The raw
 * exception remains durable in TaskRun.lastError but never becomes Room text.
 * This closes the UX gap where a Room could say a Task was running after its
 * worker had already terminalized with no user-visible correction.
 */
export const SAFE_BACKGROUND_TASK_FAILURE_RESULT =
  "The background task failed before it produced a verified final result. Review its failed activity before retrying. A lost Desktop receipt does not prove that local processes stopped." as const;

/** Fixed cancellation receipt used for every Task delivery mode. */
export const SAFE_TASK_CANCELLED_RESULT =
  "The background task was cancelled. Nothing from this Task is still running." as const;

/** Fixed safe receipt for any Task whose server-authored live-app intent cannot revalidate. */
export const SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT =
  "The live app session is no longer active. Reopen it and start the task again." as const;

export const SAFE_WRITER_REVIEW_ACCEPTED_RESULT =
  "The reviewed Writer changes were accepted and saved to the document." as const;

export const SAFE_WRITER_REVIEW_REJECTED_RESULT =
  "The Writer changes were rejected. The document was not changed by this task." as const;

export const SAFE_WRITER_REVIEW_FAILED_RESULT =
  "The Writer review could not be completed. Reopen the document and start the task again." as const;

/** Fixed truth for an accepted save whose required fresh reread was incomplete. */
export const SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT =
  "The accepted Writer changes were saved, but the verification run did not reread the complete current document." as const;

/** Fixed truth when an initial live Writer run made no proposal and did not reread the document. */
export const SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT =
  "The background task did not reread the complete current Writer document, so it could not verify the requested work. No Writer changes were saved by this task." as const;

export const SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT =
  "The reviewed Writer changes were saved, but the background task could not safely resume verification after the live session ended. Reopen the document and start the task again to check the remaining work." as const;

type SafeTaskFailureResult =
  | typeof SAFE_DELEGATED_TASK_FAILURE_RESULT
  | typeof SAFE_BACKGROUND_TASK_FAILURE_RESULT
  | typeof SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT
  | typeof SAFE_WRITER_REVIEW_FAILED_RESULT
  | typeof SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT
  | typeof SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT
  | typeof SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT;

export const DELEGATED_TASK_FAILURE_REASONS = [
  "desktop_disconnected",
  "harness_not_ready",
  "session_start_failed",
  "harness_unresponsive",
  "ended_without_result",
  "invalid_response",
  "internal_failure",
] as const;
export type DelegatedTaskFailureReason =
  (typeof DELEGATED_TASK_FAILURE_REASONS)[number];
export type DelegatedTaskFailureReceipt = Readonly<{
  provider: "OpenCode";
  reason: DelegatedTaskFailureReason;
  phase: "setup" | "starting" | "running";
  processStarted: boolean;
  commandActivityCount: number;
  outputObserved: boolean;
  containmentRequested: boolean;
}>;

/** Converts fixed execution facts—not an upstream exception—into the durable
 * Room/TaskRun outcome. Invalid combinations fail closed instead of opening a
 * new free-text channel. */
export function renderDelegatedTaskFailureReceipt(
  receipt: DelegatedTaskFailureReceipt,
): string {
  if (
    receipt.provider !== "OpenCode" ||
    !DELEGATED_TASK_FAILURE_REASONS.includes(receipt.reason) ||
    !(["setup", "starting", "running"] as const).includes(receipt.phase) ||
    typeof receipt.processStarted !== "boolean" ||
    typeof receipt.outputObserved !== "boolean" ||
    typeof receipt.containmentRequested !== "boolean" ||
    !Number.isSafeInteger(receipt.commandActivityCount) ||
    receipt.commandActivityCount < 0 ||
    receipt.commandActivityCount > 1_000_000 ||
    (receipt.phase === "running") !== receipt.processStarted ||
    (!receipt.processStarted &&
      (receipt.commandActivityCount > 0 ||
        receipt.outputObserved ||
        receipt.containmentRequested))
  )
    throw new TypeError("DELEGATED_TASK_FAILURE_RECEIPT_INVALID");
  const reason =
    receipt.reason === "desktop_disconnected"
      ? "the paired desktop connection closed"
      : receipt.reason === "harness_not_ready"
        ? "OpenCode was not ready to begin"
        : receipt.reason === "session_start_failed"
          ? "OpenCode could not establish an execution session"
          : receipt.reason === "harness_unresponsive"
            ? "OpenCode stopped responding during startup"
            : receipt.reason === "ended_without_result"
              ? "OpenCode ended without a usable final answer"
              : receipt.reason === "invalid_response"
                ? "OpenCode returned an invalid execution response"
                : `an internal failure occurred during ${receipt.phase}`;
  const activity =
    receipt.commandActivityCount > 0
      ? `${receipt.commandActivityCount} command activity ${receipt.commandActivityCount === 1 ? "item was" : "items were"} observed${receipt.outputObserved ? ", with streamed output" : ""}`
      : receipt.outputObserved
        ? "Streamed output was observed, but no command activity summary was received"
        : "No command activity or output was observed";
  const workMayHaveChanged =
    receipt.processStarted ||
    receipt.commandActivityCount > 0 ||
    receipt.outputObserved;
  const recovery = workMayHaveChanged
    ? "The workspace may contain partial changes; review it before retrying as a new task."
    : receipt.reason === "desktop_disconnected" ||
        receipt.reason === "harness_not_ready"
      ? "Open Connections, confirm OpenCode and Current Folder are ready, then retry."
      : "Retry after confirming OpenCode is ready in Connections.";
  const processState = receipt.processStarted
    ? "OpenCode reported that its task process started."
    : "OpenCode did not report a started task process.";
  const containment = receipt.containmentRequested
    ? "Nautilo requested containment of the task process."
    : receipt.reason === "ended_without_result"
      ? "OpenCode reported the turn ended, so no additional containment request was needed."
      : receipt.processStarted
        ? "Nautilo could not confirm that a containment request was accepted."
        : "No task process was available for containment.";
  return `OpenCode failed because ${reason}. ${processState} ${containment} ${activity}, and no final answer was produced. ${recovery}`;
}

/**
 * D420 — authority retained for an accepted Task run until its report-back
 * terminalizes. The task-run row is durable evidence of acceptance; after a
 * process restart we reconstitute the opaque in-memory token only from this
 * internal finalizer, never from an HTTP caller.
 */
const taskRunMaintenanceAuthorities = new Map<
  string,
  MaintenanceAcceptanceAuthority
>();
const taskRunInvocationAuthorities = new Map<
  string,
  AcceptedInvocationAuthority
>();

// A same-terminal callback may retry only when this process observed the
// canonical wake enqueue reject. This preserves transient retry without
// turning an ordinary duplicate callback—or a callback after restart—into a
// second accepted foreground turn. The map contains no result or prompt text.
const MAX_WAKE_RETRY_MARKERS = 1_000;
type WakeRetryKind = "completion" | "error" | "cancellation";
const wakeRetryMarkers = new Map<string, WakeRetryKind>();

function markWakeRetry(deliveryId: string, kind: WakeRetryKind): void {
  if (
    !wakeRetryMarkers.has(deliveryId) &&
    wakeRetryMarkers.size >= MAX_WAKE_RETRY_MARKERS
  ) {
    const oldest = wakeRetryMarkers.keys().next().value;
    if (oldest !== undefined) wakeRetryMarkers.delete(oldest);
  }
  wakeRetryMarkers.set(deliveryId, kind);
}

async function enqueueWakeWithRetryFence(
  deliveryId: string,
  kind: WakeRetryKind,
  enqueue: () => Promise<void>,
): Promise<void> {
  try {
    await enqueue();
    wakeRetryMarkers.delete(deliveryId);
  } catch (error) {
    markWakeRetry(deliveryId, kind);
    throw error;
  }
}

export function registerTaskRunAcceptance(
  runId: string,
  maintenanceAuthority: MaintenanceAcceptanceAuthority,
  invocationAuthority?: AcceptedInvocationAuthority,
): void {
  taskRunMaintenanceAuthorities.set(runId, maintenanceAuthority);
  if (invocationAuthority) {
    taskRunInvocationAuthorities.set(runId, invocationAuthority);
  }
}

/** Release process-local authority retained for a terminal Task run. */
function releaseTaskRunReportBackState(
  taskId: string,
  ...deliveryIds: Array<string | undefined>
): void {
  removeTaskReturnBinding(taskId);
  for (const deliveryId of deliveryIds) {
    if (!deliveryId) continue;
    taskRunMaintenanceAuthorities.delete(deliveryId);
    taskRunInvocationAuthorities.delete(deliveryId);
  }
}

function releaseTaskRunReportBackStatePreservingResolvedWriterReview(
  taskId: string,
  ...deliveryIds: Array<string | undefined>
): void {
  removeTaskReturnBindingPreservingResolvedWriterReview(taskId);
  for (const deliveryId of deliveryIds) {
    if (!deliveryId) continue;
    taskRunMaintenanceAuthorities.delete(deliveryId);
    taskRunInvocationAuthorities.delete(deliveryId);
  }
}

function maintenanceAuthorityForAcceptedTaskRun(
  runId: string,
): MaintenanceAcceptanceAuthority {
  const existing = taskRunMaintenanceAuthorities.get(runId);
  if (existing) return existing;
  const restored = createMaintenanceAcceptanceAuthority();
  taskRunMaintenanceAuthorities.set(runId, restored);
  return restored;
}

function invocationAuthorityForAcceptedTaskRun(
  runId: string,
  humanUserId: string,
): AcceptedInvocationAuthority {
  const existing = taskRunInvocationAuthorities.get(runId);
  if (existing) return existing;
  // The finalizer is trusted runtime code and has just locked/loaded the exact
  // accepted TaskRun. This is the only restart/retry restoration seam; no
  // serialized bearer is read from Task metadata or Job input.
  const restored = createAcceptedInvocationAuthority(humanUserId);
  taskRunInvocationAuthorities.set(runId, restored);
  return restored;
}

function shortPrompt(prompt: string): string {
  const s = prompt.trim().replace(/\s+/g, " ");
  return s.length > MAX_PROMPT_SNIPPET
    ? `${s.slice(0, MAX_PROMPT_SNIPPET - 1)}…`
    : s;
}

function taskHarnessId(task: Task): string | undefined {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const execution = (metadata)["execution"];
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return undefined;
  const harnessId = (execution as Record<string, unknown>)["harnessId"];
  return typeof harnessId === "string" && harnessId.length > 0 && harnessId.length <= 64
    ? harnessId
    : undefined;
}

export interface ReportBackDeps {
  db: DirectDatabase;
  /** Event sink (defaults to the runtime `eventBus`). Injectable for tests. */
  emit?: (event: ServerEvent) => void;
  /** Canonical transcript append seam. Injectable for focused delivery tests. */
  append?: typeof appendTranscriptMessages;
  /** Canonical Room checkpoint resolver. Injectable for DB-free unit tests. */
  resolveCallingRoomGraphThreadId?: (task: Task) => Promise<string>;
  /** Canonical wake seam. Injectable only for focused delivery tests. */
  wake?: typeof wakeCallingRoom;
}

function emitter(deps: ReportBackDeps): (event: ServerEvent) => void {
  return deps.emit ?? ((event) => eventBus.emit(event));
}

/** Resolve the exact graph checkpoint used by an ordinary turn for this
 * Room/Agent pair. Strict 1-human/1-agent Rooms use rooms.graph_thread_id;
 * group and multi-agent Rooms use the per-bot partition. Report-back must not
 * blindly choose the latter: doing so wakes a different, stale checkpoint in
 * DMs and can inherit its task-only tool whitelist. */
async function callingRoomGraphThreadId(task: Task): Promise<string> {
  const callingRoomId = task.callingRoomId;
  if (!callingRoomId) {
    throw new Error(`TASK_REPORT_BACK_CALLING_ROOM_MISSING:${task.id}`);
  }
  const requestorActor = await findActorByOwnerId(task.requestorId);
  if (!requestorActor) {
    throw new Error(`TASK_REPORT_BACK_REQUESTOR_ACTOR_MISSING:${task.id}`);
  }
  const room = await getRoomDetailForMember(callingRoomId, requestorActor.id);
  if (!room) {
    throw new Error(`TASK_REPORT_BACK_CALLING_ROOM_UNAVAILABLE:${task.id}`);
  }
  const humanCount = room.members.filter(
    (member) => member.kind === "user",
  ).length;
  const agentIds = room.members
    .filter((member) => member.kind === "agent")
    .map((member) => member.agentId)
    .filter((agentId): agentId is string => typeof agentId === "string");
  const strictDm =
    humanCount === 1 && agentIds.length === 1 && agentIds[0] === task.agentId;
  return strictDm
    ? room.graphThreadId
    : botThreadId(callingRoomId, task.agentId);
}

/** Persist `resultText` directly as the agent's assistant message in the
 *  calling room and emit a `message.new` so live clients render it. */
async function postRawAssistantMessage(
  task: Task,
  emit: (event: ServerEvent) => void,
  resultText: string,
  append: typeof appendTranscriptMessages,
  deliveryId: string,
  threadId: string,
  taskRunId?: string,
): Promise<boolean> {
  const callingRoomId = task.callingRoomId;
  if (!callingRoomId) return false;
  const authorHarnessId = taskHarnessId(task);
  const result = await append(
    threadId,
    task.ownerId,
    "owner",
    [new AIMessage({ content: resultText, id: `task-result:${deliveryId}` })],
    {
      agentId: task.agentId,
      roomId: callingRoomId,
      ...(authorHarnessId
        ? {
            metadata: {
              originatedBy: "harness_task_result",
              taskId: task.id,
              ...(taskRunId ? { taskRunId } : {}),
              authorHarnessId,
              delegatedByAgentId: task.agentId,
            },
          }
        : {}),
    },
  );
  const row = result.insertedRows[0];
  if (!row) return false;
  emit({
    type: "message.new",
    laneKey: `room:${callingRoomId}`,
    messageId: row.id,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    role: "ai",
    content: resultText,
    authorAgentId: task.agentId,
    ...(authorHarnessId ? { authorHarnessId } : {}),
  });
  return true;
}

/**
 * Only a peer conversation is eligible for delayed TTS. The server tags that
 * audio with the immutable calling Room; each client decides whether its
 * exact active Room and local voice switch admit playback. Generic delayed
 * background work remains text-only.
 */
export function shouldSpeakTaskReportBack(
  task: Pick<Task, "preset">,
): boolean {
  return task.preset === "ask_peer";
}

/** Enqueue a fresh foreground turn in the calling room with a hidden
 *  synthetic input row that wakes the agent to compose a reply. */
async function wakeCallingRoom(
  task: Task,
  deliveryId: string,
  resultText: string,
  graphThreadId: string,
  kind: "result" | "failure" | "cancellation" = "result",
  continuation: TaskReportBackContinuation = { status: "not_captured" },
  resultIsVisible = false,
  taskRunId?: string,
): Promise<void> {
  const callingRoomId = task.callingRoomId;
  if (!callingRoomId) return;

  // A completed Task may be delivered after a grant is revoked or a process
  // restarts. Its durable result remains readable, but a fresh model-backed
  // Room continuation needs the requestor's current exact-target authority.
  try {
    await assertCanInvokeAgent({
      humanUserId: task.requestorId,
      origin: "foreground_resume",
      roomId: callingRoomId,
      agentId: task.agentId,
    });
    await assertCanUseServerProviderCredentials(task.requestorId, "task_report_back");
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)
      && !(error instanceof ServerProviderCredentialsDeniedError)) throw error;
    log(`[task-report-back] skipped model wake after current authorization denial task=${task.id}`);
    return;
  }

  const jobManager = getTaskRunJobManager();
  if (!jobManager) {
    throw new Error(`TASK_REPORT_BACK_JOB_MANAGER_UNAVAILABLE:${task.id}`);
  }

  const resolver = getPolicyResolver();
  if (!resolver) {
    throw new Error(`TASK_REPORT_BACK_POLICY_RESOLVER_UNAVAILABLE:${task.id}`);
  }

  const laneKey = `room:${callingRoomId}`;
  // `tasks.requestor_id` stores the human owner (`users.id`), while policy
  // envelopes are actor-scoped. Resolve the canonical human actor just as the
  // task dispatch path does; passing the user id here silently produced a guest
  // envelope and stripped the resumed turn of its owner tools.
  const requestorActor = await findActorByOwnerId(task.requestorId);
  const envelope = await resolver.buildEnvelope(
    requestorActor?.id ?? task.requestorId,
    laneKey,
    task.agentId,
    callingRoomId,
  );

  const browserStatus =
    continuation.browserStatus === undefined
      ? ""
      : `; browser continuation: ${continuation.browserStatus}`;
  const authorHarnessId = taskHarnessId(task);
  const outcomeLabel = kind === "result"
    ? "RESULT"
    : kind === "failure"
      ? "FAILURE"
      : "CANCELLED";
  const note = resultIsVisible
    ? authorHarnessId
      ? `[TASK ${outcomeLabel} — task ${task.id} "${shortPrompt(task.prompt)}"; local continuation: ${continuation.status}${browserStatus}] The immediately preceding visible assistant-shaped message was authored by external harness "${authorHarnessId}", not by you. Continue from that harness outcome and respond in your own voice.`
      : `[TASK ${outcomeLabel} — task ${task.id} "${shortPrompt(task.prompt)}"; local continuation: ${continuation.status}${browserStatus}] The task outcome was posted as the immediately preceding assistant message. Continue from that outcome.`
    : `[TASK ${outcomeLabel} — task ${task.id} "${shortPrompt(task.prompt)}"; local continuation: ${continuation.status}${browserStatus}] ${resultText}`;

  // A terminal receipt describes lifecycle, not how much work was saved.
  // Keep inspection on the ordinary owner-authorized Task tool; local Desktop
  // continuation authority is a separate concern from reading durable history.
  const inspection = kind !== "result" && !authorHarnessId
    ? `\nThis receipt establishes this execution outcome, not whether it read source, saved notes, or produced partial findings. Before explaining its work, coverage, or failure cause, inspect the saved Task with ${JSON.stringify({ command: "read", taskId: task.id, ...(taskRunId ? { runId: taskRunId, readSection: "transcript" } : {}) })}; discover the task tool first if needed. Follow its section and continuation receipts to inspect relevant evidence. If inspection is unavailable, say the saved work is unverified rather than absent. The local continuation status concerns resuming local execution; it does not establish whether durable Task history is readable. Inspection does not authorize restarting the Task.`
    : "";

  await jobManager.createSystemForegroundJob(
    task.ownerId,
    task.requestorId,
    laneKey,
    {
      message: note + inspection,
      ownerId: task.ownerId,
      requestorId: task.requestorId,
      causalHumanUserId: task.requestorId,
      agentId: task.agentId,
      roomId: callingRoomId,
      roomRoster: [],
      graphThreadId,
      threadId: graphThreadId,
      // Only ask_peer is synthesized. The room-tagged audio is played or
      // discarded independently by each client's exact active-Room gate.
      voiceMode: shouldSpeakTaskReportBack(task),
      memoryAccessEnvelope: envelope,
      actorRole: "owner",
      turnId: randomUUID(),
      currentFolder:
        continuation.status === "available"
          ? (continuation.currentFolder ?? "")
          : "",
      currentFolderRelayId:
        continuation.status === "available" ? (continuation.relayId ?? "") : "",
      workspacePath:
        continuation.status === "available"
          ? (continuation.workspacePath ?? "")
          : "",
      taskReportBackContinuation: continuation,
      // M143 — tags ONLY the synthetic human input row (langgraph-executor applies
      // it to the human persist alone and suppresses its message.new); the agent's
      // composed reply renders normally.
      metadata: {
        originatedBy: "task",
        taskId: task.id,
        ...(taskRunId ? { taskRunId } : {}),
      },
    },
    undefined,
    maintenanceAuthorityForAcceptedTaskRun(deliveryId),
    undefined,
    invocationAuthorityForAcceptedTaskRun(deliveryId, task.requestorId),
  );
}

interface DeliverTaskTerminalOutcomeArgs {
  task: Task;
  deliveryId: string;
  taskRunId?: string;
  resultText: string;
  kind: "result" | "failure" | "cancellation";
  retryKind: WakeRetryKind;
  attemptWake: boolean;
}

/** Apply the persisted Task delivery policy to one already-decided outcome. */
async function deliverTaskTerminalOutcome(
  deps: ReportBackDeps,
  args: DeliverTaskTerminalOutcomeArgs,
): Promise<boolean | undefined> {
  const { task, deliveryId, taskRunId, resultText, kind, retryKind, attemptWake } = args;
  if (!task.callingRoomId) return undefined;
  const graphThreadId = await (
    deps.resolveCallingRoomGraphThreadId ?? callingRoomGraphThreadId
  )(task);
  if (task.resultDelivery === "raw") {
    return postRawAssistantMessage(
      task,
      emitter(deps),
      resultText,
      deps.append ?? appendTranscriptMessages,
      deliveryId,
      graphThreadId,
      taskRunId,
    );
  }
  if (!attemptWake) return undefined;
  const continuation = resolveTaskReturnBinding(
    task.id,
    task.ownerId,
    getRelayRegistry() as Parameters<typeof resolveTaskReturnBinding>[2],
  );
  await enqueueWakeWithRetryFence(deliveryId, retryKind, async () => {
    const combined = task.resultDelivery === "raw_and_wake";
    if (combined) {
      await postRawAssistantMessage(
        task,
        emitter(deps),
        resultText,
        deps.append ?? appendTranscriptMessages,
        deliveryId,
        graphThreadId,
        taskRunId,
      );
    }
    await (deps.wake ?? wakeCallingRoom)(
      task,
      deliveryId,
      resultText,
      graphThreadId,
      kind,
      continuation,
      combined,
      taskRunId,
    );
  });
  return undefined;
}

/**
 * Completion path. Replaces the executor's interim
 * terminal lifecycle transition writes.
 */
export async function reportBackTaskCompletion(
  deps: ReportBackDeps,
  args: {
    taskId: string;
    runId: string;
    scheduleKind: string;
    resultText: string;
    /** Security export is publishable only while this exact Task/run remains running. */
    requireRunningPair?: boolean;
  },
): Promise<boolean> {
  const { db } = deps;
  const emit = emitter(deps);
  const { taskId, runId, scheduleKind, resultText } = args;

  try {
    const runTransition = await transitionTaskLifecycleTerminal(db, {
      taskId,
      ...(scheduleKind === "cron" ? {} : { taskStatus: "completed" as const }),
      runId,
      runStatus: "completed",
      runPatch: { resultText, completedAt: new Date(), ...(args.requireRunningPair ? { lastError: null } : {}) },
      ...(args.requireRunningPair ? { requireRunningPair: true, taskPatch: { lastError: null } } : {}),
    });
    const task = runTransition.task;
    // A same-terminal Task + run pair can be retried after a delivery failure.
    // Any conflicting Stop/error terminal outcome is authoritative and
    // suppresses stale delivery without being overwritten.
    if (
      !runTransition.transitioned &&
      runTransition.outcome !== "same_terminal"
    ) {
      log(
        `[task-report-back] ignored stale completion task=${taskId} run=${runId}`,
      );
      return false;
    }
    if (
      runTransition.outcome === "same_terminal" &&
      runTransition.run?.resultText !== resultText
    ) {
      warn(
        `[task-report-back] rejected conflicting completion retry task=${taskId} run=${runId}`,
      );
      return false;
    }
    let emitCompletion = runTransition.transitioned;
    if (task?.callingRoomId) {
      const rawInserted = await deliverTaskTerminalOutcome(deps, {
        task,
        deliveryId: runId,
        taskRunId: runId,
        resultText,
        kind: "result",
        retryKind: "completion",
        attemptWake:
          runTransition.transitioned ||
          wakeRetryMarkers.get(runId) === "completion",
      });
      if (task.resultDelivery === "raw") emitCompletion = rawInserted === true;
    }

    log(
      `[task-report-back] task=${taskId} run=${runId} delivered (${task?.resultDelivery ?? "n/a"})`,
    );

    if (task && emitCompletion) {
      emit({
        type: "task.completed",
        taskId,
        taskRunId: runId,
        status: scheduleKind === "cron" ? "pending" : "completed",
        ownerId: task.ownerId,
      });
    }
    return true;
  } finally {
    releaseTaskRunReportBackState(taskId, runId);
  }
}

/** Error path. Replaces the executor's interim error writes. */
export async function reportBackTaskError(
  deps: ReportBackDeps,
  args: {
    taskId: string;
    runId: string;
    scheduleKind: string;
    error: string;
    /** Opt-in only: a fixed public sentence, never an upstream error detail. */
    failureResultText?: SafeTaskFailureResult;
    /** Structured closed facts rendered here; never accepts provider text. */
    failureReceipt?: DelegatedTaskFailureReceipt;
    /** A cancellable resumed worker may fail only while its exact pair is active. */
    requireRunningPair?: boolean;
  },
): Promise<void> {
  const { db } = deps;
  const emit = emitter(deps);
  const {
    taskId,
    runId,
    scheduleKind,
    error,
    failureResultText,
    failureReceipt,
  } = args;
  if (failureResultText !== undefined && failureReceipt !== undefined)
    throw new TypeError("TASK_FAILURE_DELIVERY_AMBIGUOUS");
  const deliveredFailureText = failureReceipt
    ? renderDelegatedTaskFailureReceipt(failureReceipt)
    : failureResultText;

  let durableTransitionReturned = false;
  try {
    const runTransition = await transitionTaskLifecycleTerminal(db, {
      taskId,
      ...(scheduleKind === "cron"
        ? {}
        : {
            taskStatus: "errored" as const,
            taskPatch: {
              lastError: error,
              fireLockId: null,
              fireLockedAt: null,
            },
          }),
      runId,
      runStatus: "errored",
      ...(args.requireRunningPair ? { requireRunningPair: true } : {}),
      runPatch: {
        lastError: error,
        ...(deliveredFailureText ? { resultText: deliveredFailureText } : {}),
        completedAt: new Date(),
      },
    });
    durableTransitionReturned = true;
    const task = runTransition.task;
    if (
      !runTransition.transitioned &&
      runTransition.outcome !== "same_terminal"
    ) {
      log(`[task-report-back] ignored stale error task=${taskId} run=${runId}`);
      return;
    }
    // Delivery accepts only fixed safe receipts or the closed structured ACP
    // receipt. A same-terminal retry must not enqueue another wake or duplicate
    // a raw failure receipt. The rendered result is durable, so a retry cannot
    // substitute a different explanation.
    const retryingSameError =
      runTransition.outcome === "same_terminal" &&
      runTransition.run?.lastError === error &&
      runTransition.run.resultText === deliveredFailureText;
    const deliverable =
      failureResultText === SAFE_DELEGATED_TASK_FAILURE_RESULT ||
      failureResultText === SAFE_BACKGROUND_TASK_FAILURE_RESULT ||
      failureResultText === SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT ||
      failureResultText === SAFE_WRITER_REVIEW_FAILED_RESULT ||
      failureResultText === SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT ||
      failureResultText === SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT ||
      failureResultText === SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT ||
      failureReceipt !== undefined;
    if (
      (runTransition.transitioned || retryingSameError) &&
      deliverable &&
      deliveredFailureText &&
      task?.callingRoomId
    ) {
      await deliverTaskTerminalOutcome(deps, {
        task,
        deliveryId: runId,
        taskRunId: runId,
        resultText: deliveredFailureText,
        kind: "failure",
        retryKind: "error",
        attemptWake:
          runTransition.transitioned ||
          wakeRetryMarkers.get(runId) === "error",
      });
    }
    if (runTransition.transitioned) {
      emit({
        type: "task.errored",
        taskId,
        taskRunId: runId,
        status: scheduleKind === "cron" ? "pending" : "errored",
        ownerId: task?.ownerId ?? "",
      });
    }
  } finally {
    if (durableTransitionReturned) releaseTaskRunReportBackState(taskId, runId);
    else releaseTaskRunReportBackStatePreservingResolvedWriterReview(taskId, runId);
  }
}

/**
 * Deliver a cancellation after {@link stopTask} has won the durable terminal
 * transition and aborted the linked Job. Cancellation never reuses the live
 * Desktop return binding: Stop revokes that binding before this seam runs.
 */
export async function reportBackTaskCancellation(
  deps: ReportBackDeps,
  task: Task,
  taskRunId?: string,
): Promise<void> {
  const deliveryId = `cancelled:${task.id}`;
  try {
    await deliverTaskTerminalOutcome(deps, {
      task,
      deliveryId,
      ...(taskRunId ? { taskRunId } : {}),
      resultText: SAFE_TASK_CANCELLED_RESULT,
      kind: "cancellation",
      retryKind: "cancellation",
      attemptWake: true,
    });
  } finally {
    releaseTaskRunReportBackState(task.id, deliveryId, taskRunId);
  }
}

/** Terminalize a Human-rejected Writer review without mislabeling it success. */
export async function reportBackTaskWriterReviewRejected(
  deps: ReportBackDeps,
  args: { taskId: string; runId: string },
): Promise<void> {
  let durableTransitionReturned = false;
  try {
    const transition = await transitionTaskLifecycleTerminal(deps.db, {
      taskId: args.taskId,
      taskStatus: "cancelled",
      taskPatch: { cancelledAt: new Date() },
      runId: args.runId,
      runStatus: "cancelled",
      runPatch: {
        resultText: SAFE_WRITER_REVIEW_REJECTED_RESULT,
        completedAt: new Date(),
      },
    });
    durableTransitionReturned = true;
    const task = transition.task;
    if (!transition.transitioned || !task) return;
    await deliverTaskTerminalOutcome(deps, {
      task,
      deliveryId: args.runId,
      taskRunId: args.runId,
      resultText: SAFE_WRITER_REVIEW_REJECTED_RESULT,
      kind: "cancellation",
      retryKind: "cancellation",
      attemptWake: true,
    });
    emitter(deps)({
      type: "task.status",
      taskId: task.id,
      ownerId: task.ownerId,
      status: "cancelled",
    });
  } finally {
    if (durableTransitionReturned) releaseTaskRunReportBackState(args.taskId, args.runId);
    else releaseTaskRunReportBackStatePreservingResolvedWriterReview(args.taskId, args.runId);
  }
}

/**
 * A canonical Writer save survived, but process-local authority for its
 * required verification did not. Preserve the accepted producing run and
 * terminalize only its parent Task; no verifier run was started.
 */
export async function reportBackTaskWriterReviewVerificationLostOnRestart(
  deps: ReportBackDeps,
  args: { taskId: string; runId: string; proposalId: string },
): Promise<void> {
  const transition = await terminalizeTaskWriterReviewVerificationLost(deps.db, {
    taskId: args.taskId,
    taskRunId: args.runId,
    proposalId: args.proposalId,
    error: "LIVE_WRITER_VERIFICATION_LOST_ON_RESTART",
  });
  if (!transition.transitioned) return;
  try {
    await deliverTaskTerminalOutcome(deps, {
      task: transition.task,
      deliveryId: `writer-review-verification-lost:${transition.task.id}:${transition.run.id}`,
      resultText: SAFE_WRITER_REVIEW_SAVED_VERIFICATION_LOST_RESULT,
      kind: "failure",
      retryKind: "error",
      attemptWake: true,
    });
    emitter(deps)({
      type: "task.status",
      taskId: transition.task.id,
      ownerId: transition.task.ownerId,
      status: "errored",
    });
  } finally {
    releaseTaskRunReportBackState(transition.task.id);
  }
}

/**
 * Terminalize and deliver a failure that happens before the ordinary Task
 * executor owns the run (room resolution, envelope/model selection, or Job
 * admission). This is intentionally task-scoped because some such failures
 * occur before a TaskRun row exists.
 */
export async function reportBackTaskDispatchError(
  deps: ReportBackDeps,
  args: { taskId: string; error: string },
): Promise<void> {
  const { taskId, error } = args;
  let terminalRunId: string | undefined;
  try {
    const transition = await transitionTaskLifecycleTerminal(deps.db, {
      taskId,
      taskStatus: "errored",
      taskPatch: {
        lastError: error,
        fireLockId: null,
        fireLockedAt: null,
      },
      runStatus: "errored",
      runPatch: {
        lastError: error,
        resultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
        completedAt: new Date(),
      },
    });
    const task = transition.task;
    terminalRunId = transition.run?.id;
    if (!transition.transitioned || !task) {
      log(`[task-report-back] ignored stale dispatch error task=${taskId}`);
      return;
    }
    await deliverTaskTerminalOutcome(deps, {
      task,
      deliveryId: terminalRunId ?? `dispatch-error:${task.id}`,
      ...(terminalRunId ? { taskRunId: terminalRunId } : {}),
      resultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
      kind: "failure",
      retryKind: "error",
      attemptWake: true,
    });
    if (terminalRunId) {
      emitter(deps)({
        type: "task.errored",
        taskId,
        taskRunId: terminalRunId,
        status: "errored",
        ownerId: task.ownerId,
      });
    }
  } finally {
    releaseTaskRunReportBackState(
      taskId,
      terminalRunId ?? `dispatch-error:${taskId}`,
    );
  }
}
