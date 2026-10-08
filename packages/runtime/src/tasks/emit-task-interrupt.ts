import { parseLocalExecutionDelegation, type ServerEvent } from "@nautilo/types";
import type { Task } from "@nautilo/db";
import {
  interruptValueToServerEvent,
  readPendingInterruptEventsForThread,
} from "@nautilo/agent";
import { eventBus } from "../event-bus";

/** Task approval events use the same checkpoint pipeline as foreground turns.
 * Delegated Tasks ask their verified requesting Human; ordinary Tasks retain
 * the management owner's approval contract. Routing is presentation only and
 * never substitutes for fresh source authorization on reply. */
export function taskApprovalRecipient(task: Pick<Task, "ownerId" | "requestorId" | "agentId" | "localExecutionDelegation">): string | null {
  if (task.localExecutionDelegation == null) return task.ownerId;
  const delegation = parseLocalExecutionDelegation(task.localExecutionDelegation);
  return delegation && delegation.humanUserId === task.requestorId
    && delegation.agentId === task.agentId ? delegation.humanUserId : null;
}

const TASK_APPROVAL_EVENT_TYPES: ReadonlySet<ServerEvent["type"]> = new Set([
  "approval.ask",
  "prove_it.challenge",
  "identity.challenge",
]);

export interface TaskApprovalPatchContext {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  /** Canonical recipient selected from the Task, never model input. */
  approvalRecipientId?: string | null;
  /** Whether the Task run has a room (`state.roomId`). When false, the orphan
   *  `approval.ask` drops the unpersistable `room` verb. */
  hasRoom: boolean;
}

/**
 * Patch a mapped approval-trio event with Task context. Pure; returns the input
 * unchanged for any non-approval-trio event so it is safe to apply to whatever
 * `interruptValueToServerEvent` (or `emitChainedInterrupts`) produced.
 */
export function patchTaskApprovalEvent(
  event: ServerEvent,
  ctx: TaskApprovalPatchContext,
): ServerEvent {
  if (TASK_APPROVAL_EVENT_TYPES.has(event.type) && ctx.approvalRecipientId === null) {
    throw new Error("Canonical Task approval recipient unavailable");
  }
  if (event.type === "approval.ask") {
    return {
      ...event,
      userId: ctx.approvalRecipientId ?? ctx.ownerId,
      taskId: ctx.taskId,
      taskRunId: ctx.taskRunId,
      origin: "task",
      ...(ctx.hasRoom
        ? {}
        : { allowedVerbs: event.allowedVerbs.filter((v) => v !== "room") }),
    };
  }
  if (event.type === "prove_it.challenge" || event.type === "identity.challenge") {
    return {
      ...event,
      userId: ctx.approvalRecipientId ?? ctx.ownerId,
      taskId: ctx.taskId,
      taskRunId: ctx.taskRunId,
      origin: "task",
    };
  }
  return event;
}

export interface TaskInterruptContext extends TaskApprovalPatchContext {
  graphThreadId: string;
  /** `task:<taskId>` */
  laneKey: string;
  interrupt: Record<string, unknown>;
}

/**
 * Build the owner-scoped, Task-patched approval event for a parked interrupt, or
 * `null` when the interrupt is not one of the surfaced approval-trio types.
 */
export function buildTaskInterruptEvent(
  ctx: TaskInterruptContext,
): ServerEvent | null {
  if (ctx.approvalRecipientId === null) return null;
  const mapped = interruptValueToServerEvent(
    ctx.interrupt,
    ctx.graphThreadId,
    ctx.laneKey,
  );
  if (!mapped || !TASK_APPROVAL_EVENT_TYPES.has(mapped.type)) return null;
  return patchTaskApprovalEvent(mapped, ctx);
}

/**
 * Emit the Task approval event for a parked interrupt. Returns the emitted event
 * (or `null` if the interrupt mapped to a non-approval event / nothing). `emit`
 * is injectable for tests; defaults to the runtime `eventBus`.
 */
export function emitTaskInterruptEvent(
  ctx: TaskInterruptContext,
  emit: (event: ServerEvent) => void = (event) => eventBus.emit(event),
): ServerEvent | null {
  const event = buildTaskInterruptEvent(ctx);
  if (event) emit(event);
  return event;
}

/**
 * Re-project approval interrupts still parked in a durable Task checkpoint.
 * This copies no approval authority; it applies the same Task/owner patch as
 * the original live event and is idempotent in clients.
 */
export async function replayTaskInterruptEvents(
  ctx: TaskApprovalPatchContext & {
    graphThreadId: string;
    laneKey: string;
  },
  read: (threadId: string, laneKey: string) => Promise<ServerEvent[]> =
    readPendingInterruptEventsForThread,
): Promise<ServerEvent[]> {
  if (ctx.approvalRecipientId === null) return [];
  const events = await read(ctx.graphThreadId, ctx.laneKey);
  return events
    .filter((event) => TASK_APPROVAL_EVENT_TYPES.has(event.type))
    .map((event) => patchTaskApprovalEvent(event, ctx));
}
