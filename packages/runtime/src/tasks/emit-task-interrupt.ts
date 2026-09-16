import type { ServerEvent } from "@nautilo/types";
import {
  interruptValueToServerEvent,
  readPendingInterruptEventsForThread,
} from "@nautilo/agent";
import { eventBus } from "../event-bus";

/**
 * M164 — surface Task/subagent approval interrupts to the Task owner.
 *
 * A tool call inside a Task run goes through the SAME approval pipeline as a
 * main chat turn, so it can park on `approval_ask`, `prove_it_challenge`, or the
 * `identity_challenge` (enrollPin) pre-step. The Task runner detects the
 * interrupt and marks the run `awaiting`, but — unlike `langgraph-executor` —
 * it never translated the interrupt to a public WS event, so the owner's
 * approval dock / PIN modal never opened and the Task parked forever.
 *
 * This module bridges that gap. It reuses the canonical
 * `interruptValueToServerEvent` mapping and then PATCHES the produced event for
 * Task context so:
 *   - `ws-publisher` routes it user-scoped (we force `userId = ownerId`);
 *   - the workbench bypasses active-room filtering (`origin: "task"`);
 *   - the resume route can find the run (`taskId`, `taskRunId` ride along);
 *   - an orphan Task (no room) cannot offer the `room` standing-approval verb
 *     (post-model could not persist it without a room — R13 / §4.7).
 *
 * SCOPE (M164): only the approval trio (`approval.ask` / `prove_it.challenge` /
 * `identity.challenge`) is surfaced here. Any other interrupt value (including
 * `await_human_reply`, which has its own M151 owner-scoped lifecycle path) is
 * left alone — the run simply stays `awaiting`.
 */

const TASK_APPROVAL_EVENT_TYPES: ReadonlySet<ServerEvent["type"]> = new Set([
  "approval.ask",
  "prove_it.challenge",
  "identity.challenge",
]);

export interface TaskApprovalPatchContext {
  taskId: string;
  taskRunId: string;
  ownerId: string;
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
  if (event.type === "approval.ask") {
    return {
      ...event,
      userId: ctx.ownerId,
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
      userId: ctx.ownerId,
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
  const events = await read(ctx.graphThreadId, ctx.laneKey);
  return events
    .filter((event) => TASK_APPROVAL_EVENT_TYPES.has(event.type))
    .map((event) => patchTaskApprovalEvent(event, ctx));
}
