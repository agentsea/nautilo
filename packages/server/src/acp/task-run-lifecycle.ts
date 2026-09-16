import type { DelegatedTaskFailureReceipt } from "@nautilo/runtime";
import type { CanonicalHarnessTaskFacts, HarnessTaskRunLifecyclePort } from "../messaging/harness-admission";

export const ACP_EXECUTION_FAILED = "ACP_EXECUTION_FAILED" as const;

export class HermesAcpTaskRunLifecycleRejected extends Error {
  readonly code = "ACP_TASK_RUN_LIFECYCLE_REJECTED";
  constructor() { super("ACP_TASK_RUN_LIFECYCLE_REJECTED"); this.name = "HermesAcpTaskRunLifecycleRejected"; }
}

export type HermesAcpLifecycleTask = Readonly<{
  id: string; ownerId: string; requestorId: string; agentId: string; parentTaskId: string | null; targetRoomId: string | null; scheduleKind: "now" | "one_shot" | "cron"; status: string;
}>;
export type HermesAcpLifecycleRun = Readonly<{ id: string; taskId: string; jobId: string | null; status: string }>;
export type HermesAcpLifecycleJob = Readonly<{ id: string; ownerId: string; requestorId: string; roomId: string | null; status: string; input: Readonly<Record<string, unknown>> | null }>;

/** The executor supplies its selection snapshot so a later reader cannot swap
 * authority fields while retaining the same TaskRun/Job IDs. */
export type HermesAcpLifecycleAuthority = Readonly<{ ownerId: string; requestorId: string; agentId: string; roomId: string }>;
export type HermesAcpLifecycleFacts = CanonicalHarnessTaskFacts & { readonly jobId: string; readonly authority: HermesAcpLifecycleAuthority };

/** Canonical readers/writers are injected: this ACP-owned adapter imports no Codex lifecycle. */
export interface HermesAcpTaskRunLifecycleDeps {
  readonly reader: Readonly<{
    getTask(taskId: string): Promise<HermesAcpLifecycleTask | null>;
    getTaskRun(taskRunId: string): Promise<HermesAcpLifecycleRun | null>;
    getJob(jobId: string): Promise<HermesAcpLifecycleJob | null>;
  }>;
  readonly writer: Readonly<{
    linkJob(input: HermesAcpLifecycleFacts): Promise<"linked" | "already_linked" | "conflict">;
  }>;
  readonly reportBack: Readonly<{
    complete(input: Readonly<{ taskId: string; taskRunId: string; scheduleKind: "now" | "one_shot"; resultText: string }>): Promise<void>;
    fail(input: Readonly<{ taskId: string; taskRunId: string; scheduleKind: "now" | "one_shot"; code: typeof ACP_EXECUTION_FAILED; failureReceipt?: DelegatedTaskFailureReceipt }>): Promise<void>;
  }>;
}

/** ACP execution calls this before each host side effect; it is deliberately
 * stronger than the generic lifecycle port and keeps TaskRun/Job authority live. */
export interface HermesAcpTaskRunLifecyclePort extends Omit<HarnessTaskRunLifecyclePort, "linkJob" | "complete" | "fail"> {
  linkJob(input: HermesAcpLifecycleFacts): Promise<void>;
  complete(input: HermesAcpLifecycleFacts & { readonly resultText: string }): Promise<void>;
  fail(input: HermesAcpLifecycleFacts & { readonly code: string; readonly failureReceipt?: DelegatedTaskFailureReceipt }): Promise<void>;
  assertCurrent(input: HermesAcpLifecycleFacts): Promise<void>;
}

function exactInput(input: Readonly<Record<string, unknown>> | null, taskId: string, taskRunId: string): boolean {
  return input?.["taskId"] === taskId && input?.["taskRunId"] === taskRunId;
}

export class HermesAcpTaskRunLifecycleAdapter implements HermesAcpTaskRunLifecyclePort {
  constructor(private readonly deps: HermesAcpTaskRunLifecycleDeps) {}

  async linkJob(input: HermesAcpLifecycleFacts): Promise<void> {
    await this.assertExact(input, false);
    if (await this.deps.writer.linkJob(input) === "conflict") {
      throw new HermesAcpTaskRunLifecycleRejected();
    }
    await this.assertExact(input, true);
  }

  async complete(input: HermesAcpLifecycleFacts & { readonly resultText: string }): Promise<void> {
    const task = await this.assertExact(input, true);
    await this.deps.reportBack.complete({ taskId: input.taskId, taskRunId: input.taskRunId, scheduleKind: task.scheduleKind, resultText: input.resultText });
  }

  async fail(input: HermesAcpLifecycleFacts & { readonly code: string; readonly failureReceipt?: DelegatedTaskFailureReceipt }): Promise<void> {
    if (input.code !== ACP_EXECUTION_FAILED) throw new HermesAcpTaskRunLifecycleRejected();
    const task = await this.assertExact(input, true);
    await this.deps.reportBack.fail({ taskId: input.taskId, taskRunId: input.taskRunId, scheduleKind: task.scheduleKind, code: ACP_EXECUTION_FAILED, ...(input.failureReceipt ? { failureReceipt: input.failureReceipt } : {}) });
  }

  async assertCurrent(input: HermesAcpLifecycleFacts): Promise<void> {
    await this.assertExact(input, true);
  }

  private async assertExact(input: HermesAcpLifecycleFacts, linked: boolean): Promise<HermesAcpLifecycleTask & { scheduleKind: "now" | "one_shot" }> {
    const [task, run, job] = await Promise.all([this.deps.reader.getTask(input.taskId), this.deps.reader.getTaskRun(input.taskRunId), this.deps.reader.getJob(input.jobId)]);
    const authority = input.authority;
    if (!task || !run || !job || !task.ownerId || task.id !== input.taskId || task.parentTaskId !== input.parentTaskId || task.scheduleKind === "cron" || task.status !== "running" || run.id !== input.taskRunId || run.status !== "running" || run.taskId !== task.id || (linked ? run.jobId !== job.id : run.jobId !== null && run.jobId !== job.id) || job.id !== input.jobId || job.status !== "running" || !exactInput(job.input, task.id, run.id) || task.ownerId !== authority.ownerId || task.requestorId !== authority.requestorId || task.agentId !== authority.agentId || task.targetRoomId !== authority.roomId || job.ownerId !== authority.ownerId || job.requestorId !== authority.requestorId || job.roomId !== authority.roomId) throw new HermesAcpTaskRunLifecycleRejected();
    return task as HermesAcpLifecycleTask & { scheduleKind: "now" | "one_shot" };
  }
}
