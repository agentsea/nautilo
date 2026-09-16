import { and, eq, isNull, jobs, roomMembers, rooms, taskRuns, tasks, actors, type DirectDatabase } from "@nautilo/db";
import { log } from "@nautilo/logger";
import { reportBackTaskCompletion, reportBackTaskError, SAFE_DELEGATED_TASK_FAILURE_RESULT } from "@nautilo/runtime";
import type { TaskHarnessExecutionRouteRegistration } from "../harness/task-execution-route";
import { ACP_EXECUTION_FAILED, HermesAcpTaskRunLifecycleAdapter, type HermesAcpTaskRunLifecycleDeps } from "./task-run-lifecycle";
import { createOpenCodeAcpTaskExecutionRouteSelector, createOpenCodeAcpTaskHarnessExecutionRouteRegistration, type OpenCodeAcpTaskExecutionDeps } from "./opencode-task-execution";
import { projectOpenCodeAcpRoomOutput } from "./opencode-room-output";

/** Server-only C1 assembly. It owns direct DB readers and canonical report-back
 * but does not wire the optional registration into app composition yet. */
export function createOpenCodeAcpTaskExecutionComposition(
  db: DirectDatabase,
  reportBack: Readonly<{ complete: typeof reportBackTaskCompletion; fail: typeof reportBackTaskError }> = {
    complete: reportBackTaskCompletion,
    fail: reportBackTaskError,
  },
) {
  const reader: OpenCodeAcpTaskExecutionDeps["tasks"] = { async getTask(taskId) {
    const [row] = await db.select({ id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId, agentId: tasks.agentId, parentTaskId: tasks.parentTaskId, targetRoomId: tasks.targetRoomId, prompt: tasks.prompt, metadata: tasks.metadata }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ?? null;
  } };
  const facts: OpenCodeAcpTaskExecutionDeps["facts"] = {
    async roomExists(roomId) { return Boolean((await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0]); },
    async getAgentOwner(agentId) { return (await db.select({ ownerId: actors.ownerId }).from(actors).where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent"))).limit(1))[0]?.ownerId ?? null; },
    async isAgentMember(roomId, agentId) { return Boolean((await db.select({ id: roomMembers.actorId }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId)).where(and(eq(roomMembers.roomId, roomId), eq(actors.agentId, agentId), eq(actors.kind, "agent"))).limit(1))[0]); },
  };
  const lifecycleDeps: HermesAcpTaskRunLifecycleDeps = {
    reader: {
      async getTask(taskId) { const [row] = await db.select({ id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId, agentId: tasks.agentId, parentTaskId: tasks.parentTaskId, targetRoomId: tasks.targetRoomId, scheduleKind: tasks.scheduleKind, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1); return row ?? null; },
      async getTaskRun(taskRunId) { const [row] = await db.select({ id: taskRuns.id, taskId: taskRuns.taskId, jobId: taskRuns.jobId, status: taskRuns.status }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1); return row ?? null; },
      async getJob(jobId) { const [row] = await db.select({ id: jobs.id, ownerId: jobs.ownerId, requestorId: jobs.requestorId, roomId: jobs.roomId, input: jobs.input, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1); return row ?? null; },
    },
    writer: { async linkJob(input) { return db.transaction(async (tx) => {
      const [task] = await tx.select({ id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId, agentId: tasks.agentId, parentTaskId: tasks.parentTaskId, targetRoomId: tasks.targetRoomId, status: tasks.status, scheduleKind: tasks.scheduleKind }).from(tasks).where(eq(tasks.id, input.taskId)).for("update");
      const [run] = await tx.select({ id: taskRuns.id, taskId: taskRuns.taskId, jobId: taskRuns.jobId, status: taskRuns.status }).from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId))).for("update");
      const [job] = await tx.select({ id: jobs.id, ownerId: jobs.ownerId, requestorId: jobs.requestorId, roomId: jobs.roomId, input: jobs.input, status: jobs.status }).from(jobs).where(eq(jobs.id, input.jobId)).for("update");
      if (!task || task.id !== input.taskId || task.scheduleKind === "cron" || task.status !== "running" || task.ownerId !== input.authority.ownerId || task.requestorId !== input.authority.requestorId || task.agentId !== input.authority.agentId || task.parentTaskId !== input.parentTaskId || task.targetRoomId !== input.authority.roomId || !run || run.id !== input.taskRunId || run.taskId !== input.taskId || run.status !== "running" || !job || job.id !== input.jobId || job.status !== "running" || job.ownerId !== input.authority.ownerId || job.requestorId !== input.authority.requestorId || job.roomId !== input.authority.roomId || job.input?.["taskId"] !== input.taskId || job.input?.["taskRunId"] !== input.taskRunId) return "conflict" as const;
      if (run.jobId === input.jobId) return "already_linked" as const;
      if (run.jobId !== null) return "conflict" as const;
      const updated = await tx.update(taskRuns).set({ jobId: input.jobId }).where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId), isNull(taskRuns.jobId), eq(taskRuns.status, "running"))).returning({ id: taskRuns.id });
      return updated.length === 1 ? "linked" as const : "conflict" as const;
    }); } },
    reportBack: {
      async complete(input) { const args = { taskId: input.taskId, runId: input.taskRunId, scheduleKind: input.scheduleKind, resultText: input.resultText }; try { await reportBack.complete({ db }, args); } catch { await reportBack.complete({ db }, args); } },
      async fail(input) { if (input.code !== ACP_EXECUTION_FAILED) throw new Error("ACP_REPORT_BACK_INVALID"); const args = input.failureReceipt ? { taskId: input.taskId, runId: input.taskRunId, scheduleKind: input.scheduleKind, error: ACP_EXECUTION_FAILED, failureReceipt: input.failureReceipt } as const : { taskId: input.taskId, runId: input.taskRunId, scheduleKind: input.scheduleKind, error: ACP_EXECUTION_FAILED, failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT } as const; try { await reportBack.fail({ db }, args); } catch { await reportBack.fail({ db }, args); } },
    },
  };
  const taskRunsPort = new HermesAcpTaskRunLifecycleAdapter(lifecycleDeps);
  return { reader, facts, lifecycle: lifecycleDeps, taskRuns: taskRunsPort };
}

export function createOpenCodeAcpTaskExecutionRouteRegistration(
  db: DirectDatabase,
  relay: OpenCodeAcpTaskExecutionDeps["relay"],
): TaskHarnessExecutionRouteRegistration {
  const { reader, facts, taskRuns } = createOpenCodeAcpTaskExecutionComposition(db);
  return createOpenCodeAcpTaskHarnessExecutionRouteRegistration(() => createOpenCodeAcpTaskExecutionRouteSelector({ tasks: reader, facts, relay, taskRuns, projector: { project: (event) => projectOpenCodeAcpRoomOutput(event, { ownerId: event.scope.binding.ownerId, taskId: event.scope.binding.taskId, taskRunId: event.scope.binding.taskRunId }) }, diagnostics: { onFailureStage: (stage) => log(`[opencode-acp] execution_failure_stage=${stage}`), onStartFailureAfter: (stage) => log(`[opencode-acp] start_failure_after=${stage}`), onSetupFailureAfter: (checkpoint, code) => log(`[opencode-acp] setup_failure_after=${checkpoint} code=${code}`), onSelectionFailure: (checkpoint, code) => log(`[opencode-acp] selection_failure_at=${checkpoint} code=${code}`) } }));
}
