import {
  getSharedDirectDb,
  findAwaitingTaskForRoom,
  pauseAwaitingTaskRunForAuthorizationDenial,
  transitionTaskApprovalExecution,
  rooms,
  eq,
} from "@nautilo/db";
import { resumeGraphWithHumanReply } from "@nautilo/agent";
import {
  createPersistingProcessor,
  eventBus,
  reportBackTaskCompletion,
  reportBackTaskError,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT,
  getMaintenanceGate,
  createMaintenanceAcceptanceAuthority,
  jobManager,
} from "@nautilo/runtime";
import { log, warn } from "@nautilo/logger";
import {
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  createAcceptedInvocationAuthority,
} from "@nautilo/trust";

/**
 * M151 (Task Phase 7a) — the human-message chokepoint reply hook.
 *
 * After a human message is persisted in a room, resume any task run parked
 * `awaiting` THIS human's reply in THIS room. Runs alongside (not instead of)
 * normal routing — fire-and-forget; never blocks or fails the chat turn.
 *
 * The resume leg runs OUTSIDE `taskRunExecutor`, so it owns the finalization:
 * once the resumed graph reaches END without re-parking, it relays the run's
 * final text back to the calling room via `reportBackTaskCompletion` (the same
 * finalizer the executor uses) and transitions the task/run to terminal.
 */
export async function maybeResumeAwaitingTask(
  roomId: string,
  fromUserId: string,
  replyText: string,
): Promise<void> {
  if (!roomId || !fromUserId) return;

  const db = getSharedDirectDb();
  try {
    const found = await findAwaitingTaskForRoom(db, roomId, fromUserId);
    if (!found) return;

    const { task, graphThreadId, runId } = found;

    // The reply is ordinary Room participation. Only the Task's persisted
    // requestor authorizes and funds the resumed Agent execution.
    let requestorAllowed = true;
    try {
      await assertCanInvokeAgent({
        humanUserId: task.requestorId,
        origin: "task_human_reply",
        roomId,
        agentId: task.agentId,
      });
      await assertCanUseServerProviderCredentials(task.requestorId, "task_human_reply");
    } catch (error) {
      if (!(error instanceof AgentInvocationDeniedError)
        && !(error instanceof ServerProviderCredentialsDeniedError)) throw error;
      requestorAllowed = false;
    }

    if (!requestorAllowed) {
      const transition = await pauseAwaitingTaskRunForAuthorizationDenial(db, {
        taskId: task.id,
        taskRunId: runId,
        graphThreadId,
      });
      if (transition.transitioned && transition.task) {
        eventBus.emit({
          type: "task.status",
          taskId: task.id,
          ownerId: transition.task.ownerId,
          status: "paused",
        });
      }
      log(
        `[task-await-resume] requestor authorization paused task=${task.id} run=${runId}`,
      );
      return;
    }

    // Invocation acceptance is minted only after this independent entrance
    // gate succeeds. A drain leaves the persisted reply and parked Task intact.
    await getMaintenanceGate().assertAcceptingNewWork();
    const maintenanceAuthority = createMaintenanceAcceptanceAuthority();
    const invocationAuthority = createAcceptedInvocationAuthority(task.requestorId);

    const laneKey = `task:${task.id}`;
    log(`[task-await-resume] resuming task=${task.id} run=${runId} thread=${graphThreadId}`);

    // M151 — persist the resumed agent turns under the target room's owner (a
    // member), so they render in the room. For an ask_peer DM that's the PEER;
    // for a namespace target it's the requester (== task.ownerId). Fall back to
    // the task owner if the room row is missing.
    let transcriptOwnerId = task.ownerId;
    const [rm] = await db
      .select({ ownerId: rooms.ownerId, kind: rooms.kind })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (rm?.ownerId) transcriptOwnerId = rm.ownerId;

    const base = createPersistingProcessor({
      threadId: graphThreadId,
      ownerId: transcriptOwnerId,
      agentId: task.agentId,
      roomId,
      ...(rm?.kind === "subthread" ? { subthreadRoomId: roomId } : {}),
      laneKey,
      eventBus,
    });

    await jobManager.runResumeJobLifecycle({ laneKey, roomId, graphThreadId,
      humanUserId: task.requestorId, taskRun: { taskId: task.id, taskRunId: runId } }, async (signal) => {
      const transition = (from: "awaiting" | "running", to: "awaiting" | "running") => transitionTaskApprovalExecution(db, {
        taskId: task.id, runId, graphThreadId, ownerId: task.ownerId, from, to,
      });
      if (signal.aborted || !await transition("awaiting", "running") || signal.aborted) return;
      eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "running" });
      const processor = { ...base,
        process: (event: Parameters<typeof base.process>[0]) => signal.aborted ? undefined : base.process(event),
        emit: (event: Parameters<typeof base.emit>[0]) => { if (!signal.aborted) base.emit(event); },
      };
      try {
        const result = await resumeGraphWithHumanReply(
            graphThreadId,
            replyText,
            fromUserId,
            processor,
            laneKey,
            signal,
          );
        if (signal.aborted) return;
        if (result.reparked) {
          if (await transition("running", "awaiting")) eventBus.emit({ type: "task.status", taskId: task.id, ownerId: task.ownerId, status: "awaiting" });
          return;
        }
        // The resume leg runs OUTSIDE taskRunExecutor, so it owns finalization:
        // relay the run's final text back to the calling room + go terminal.
        await reportBackTaskCompletion(
          { db },
          {
            taskId: task.id,
            runId,
            scheduleKind: task.scheduleKind,
            resultText: result.finalText,
            requireRunningPair: true,
          },
        );
      } catch (error) {
        if (signal.aborted) return;
        await reportBackTaskError({ db }, { taskId: task.id, runId,
          scheduleKind: task.scheduleKind, error: error instanceof Error ? error.message : String(error),
          failureResultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT, requireRunningPair: true });
      }
    }, invocationAuthority, maintenanceAuthority);
  } catch (err) {
    warn(
      `[task-await-resume] resume failed room=${roomId} user=${fromUserId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read-only intent probe used by canonical dispatch before choosing a DM path. */
export async function hasAwaitingTaskReply(
  roomId: string,
  fromUserId: string,
): Promise<boolean> {
  if (!roomId || !fromUserId) return false;
  return Boolean(
    await findAwaitingTaskForRoom(getSharedDirectDb(), roomId, fromUserId),
  );
}
