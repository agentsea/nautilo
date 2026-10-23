import { desc, eq, sql } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { TASK_LOCAL_EXECUTION_RECREATE_TEXT } from "./tasks";

/** Lifecycle controls need operational state, never definition or result content. */
export async function getTaskLifecycleState(db: DirectDatabase, taskId: string) {
  const latestRunStatus = db.select({ status: taskRuns.status }).from(taskRuns)
    .where(eq(taskRuns.taskId, tasks.id))
    .orderBy(desc(taskRuns.startedAt)).limit(1);
  const [row] = await db.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    targetRoomId: tasks.targetRoomId,
    status: tasks.status,
    contentRepresentation: tasks.contentRepresentation,
    scheduleKind: tasks.scheduleKind,
    pauseRequestId: tasks.pauseRequestId,
    pauseRequestedAt: tasks.pauseRequestedAt,
    pauseReason: tasks.pauseReason,
    localExecutionRecaptureRequired: sql<boolean>`(${tasks.localExecutionDelegation} IS NULL
      AND ${tasks.lastError} IS NOT DISTINCT FROM ${TASK_LOCAL_EXECUTION_RECREATE_TEXT})`,
    fundingOutcomeUncertain: sql<boolean>`COALESCE(${tasks.lastError} = 'funding_interrupted_uncertain', false)`,
    latestRunPaused: sql<boolean>`COALESCE((${latestRunStatus}) = 'paused', false)`,
  }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row;
}

export type TaskLifecycleState = NonNullable<
  Awaited<ReturnType<typeof getTaskLifecycleState>>
>;
