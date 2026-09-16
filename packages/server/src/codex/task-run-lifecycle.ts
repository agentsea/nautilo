import type { HarnessTaskRunLifecyclePort } from "../messaging/harness-admission";
import type { CanonicalHarnessTaskFacts } from "../messaging/harness-admission";
import { reportBackTaskCompletion, reportBackTaskError } from "@nautilo/runtime";
import {
  and,
  eq,
  inArray,
  isNull,
  jobs,
  taskRuns,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";

/** Stable, non-oracular lifecycle failure. */
export class CodexTaskRunLifecycleRejected extends Error {
  readonly code = "CODEX_TASK_RUN_LIFECYCLE_REJECTED";

  constructor() {
    super("CODEX_TASK_RUN_LIFECYCLE_REJECTED");
    this.name = "CodexTaskRunLifecycleRejected";
  }
}

type TaskStatus = "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
type TaskRunStatus = "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";

export interface CanonicalHarnessLifecycleTask {
  readonly id: string;
  readonly ownerId: string;
  readonly parentTaskId: string | null;
  readonly scheduleKind: "now" | "one_shot" | "cron";
  readonly status: TaskStatus;
}

export interface CanonicalHarnessLifecycleTaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly jobId: string | null;
  readonly status: TaskRunStatus;
}

export interface CanonicalHarnessLifecycleJob {
  readonly id: string;
  readonly input: Readonly<Record<string, unknown>> | null;
}

/** Read side is separated from conditional writes to make races fail closed. */
export interface CodexTaskRunLifecycleReader {
  getTask(taskId: string): Promise<CanonicalHarnessLifecycleTask | null>;
  getTaskRun(taskRunId: string): Promise<CanonicalHarnessLifecycleTaskRun | null>;
  getJob(jobId: string): Promise<CanonicalHarnessLifecycleJob | null>;
}

export type LinkJobResult = "linked" | "already_linked" | "conflict";
export type FailUnavailableJobResult =
  | { readonly status: "failed" | "already_failed"; readonly scheduleKind: "now" | "one_shot" }
  | { readonly status: "conflict" };

/**
 * Conditional writer contract. Implementations must constrain every mutation
 * by the exact Task, TaskRun, and Job relation rather than issuing a broad
 * status update after an optimistic read.
 */
export interface CodexTaskRunLifecycleWriter {
  linkJob(input: { taskId: string; taskRunId: string; jobId: string }): Promise<LinkJobResult>;
  failUnavailableJob(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly taskRunId: string;
    readonly jobId: string;
    readonly code: "CODEX_REQUEST_UNAVAILABLE";
    readonly now: Date;
  }): Promise<FailUnavailableJobResult>;
}

export interface CodexUnavailableRequestOwner {
  readonly userId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly jobId: string;
}

/** Exact owner-bound terminal owner for durable native-input recovery. */
export interface CodexUnavailableRequestTerminalizationPort {
  terminalize(request: CodexUnavailableRequestOwner): Promise<void>;
}

export interface CodexTaskRunReportBackPort {
  complete(input: {
    readonly taskId: string;
    readonly taskRunId: string;
    readonly scheduleKind: "now" | "one_shot";
    readonly resultText: string;
  }): Promise<void>;
  fail(input: {
    readonly taskId: string;
    readonly taskRunId: string;
    readonly scheduleKind: "now" | "one_shot";
    readonly code: string;
  }): Promise<void>;
}

export interface CodexTaskRunLifecycleDeps {
  readonly reader: CodexTaskRunLifecycleReader;
  readonly writer: CodexTaskRunLifecycleWriter;
  readonly reportBack: CodexTaskRunReportBackPort;
}

function inputString(input: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isKnownFailureCode(code: string): boolean {
  return code === "CODEX_EXECUTION_FAILED" || code === "CLAUDE_EXECUTION_FAILED";
}

/**
 * Canonical Task/TaskRun terminalization for a harness turn.
 *
 * The exact Task/TaskRun/Job assertion stays at the harness boundary, then
 * terminalization and Room delivery flow through the ordinary Task report-back
 * implementation. Stop/abort therefore keep winning the canonical lifecycle
 * race instead of being converted into an error here.
 */
export class CodexTaskRunLifecycleAdapter implements HarnessTaskRunLifecyclePort {
  constructor(private readonly deps: CodexTaskRunLifecycleDeps) {}

  async linkJob(input: CanonicalHarnessTaskFacts & { readonly jobId: string }): Promise<void> {
    await this.assertExact(input, false);
    const outcome = await this.deps.writer.linkJob({
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      jobId: input.jobId,
    });
    if (outcome === "conflict") throw new CodexTaskRunLifecycleRejected();
  }

  async complete(
    input: CanonicalHarnessTaskFacts & {
      readonly jobId: string;
      readonly resultText: string;
    },
  ): Promise<void> {
    const task = await this.assertExact(input, true);
    await this.deps.reportBack.complete({
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      scheduleKind: task.scheduleKind,
      resultText: input.resultText,
    });
  }

  async fail(
    input: CanonicalHarnessTaskFacts & { readonly jobId: string; readonly code: string },
  ): Promise<void> {
    if (!isKnownFailureCode(input.code)) throw new CodexTaskRunLifecycleRejected();
    const task = await this.assertExact(input, true);
    await this.deps.reportBack.fail({
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      scheduleKind: task.scheduleKind,
      code: input.code,
    });
  }

  private async assertExact(
    input: CanonicalHarnessTaskFacts & { readonly jobId: string },
    requireLinkedJob: boolean,
  ): Promise<CanonicalHarnessLifecycleTask & { readonly scheduleKind: "now" | "one_shot" }> {
    const [task, run, job] = await Promise.all([
      this.deps.reader.getTask(input.taskId),
      this.deps.reader.getTaskRun(input.taskRunId),
      this.deps.reader.getJob(input.jobId),
    ]);
    if (
      !task ||
      !run ||
      !job ||
      !task.ownerId ||
      task.id !== input.taskId ||
      task.parentTaskId !== input.parentTaskId ||
      task.scheduleKind === "cron" ||
      run.id !== input.taskRunId ||
      run.taskId !== task.id ||
      (requireLinkedJob ? run.jobId !== job.id : run.jobId !== null && run.jobId !== job.id) ||
      job.id !== input.jobId ||
      inputString(job.input, "taskId") !== task.id ||
      inputString(job.input, "taskRunId") !== run.id
    ) {
      throw new CodexTaskRunLifecycleRejected();
    }
    return task as CanonicalHarnessLifecycleTask & { readonly scheduleKind: "now" | "one_shot" };
  }
}

/**
 * A durable native-input request cannot resume once its live broker closure is
 * gone. Claim its exact persisted Job first, then reuse canonical Task report-
 * back. If report-back is interrupted, a retry sees the same controlled Job
 * failure and safely retries the idempotent Task/TaskRun finalizer.
 */
export class CodexUnavailableRequestTerminalizer
  implements CodexUnavailableRequestTerminalizationPort
{
  constructor(
    private readonly writer: CodexTaskRunLifecycleWriter,
    private readonly reportBack: CodexTaskRunReportBackPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async terminalize(request: CodexUnavailableRequestOwner): Promise<void> {
    const code = "CODEX_REQUEST_UNAVAILABLE" as const;
    const claimed = await this.writer.failUnavailableJob({
      ownerId: request.userId,
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      jobId: request.jobId,
      code,
      now: this.now(),
    });
    if (claimed.status === "conflict") return;
    await this.reportBack.fail({
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      scheduleKind: claimed.scheduleKind,
      code,
    });
  }
}

/** Concrete read adapter for server composition, always using the injected DB. */
export function createCodexTaskRunLifecycleReader(
  db: DirectDatabase,
): CodexTaskRunLifecycleReader {
  return {
    async getTask(taskId) {
      const [row] = await db
        .select({
          id: tasks.id,
          ownerId: tasks.ownerId,
          parentTaskId: tasks.parentTaskId,
          scheduleKind: tasks.scheduleKind,
          status: tasks.status,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      return row
        ? {
            ...row,
            scheduleKind: row.scheduleKind,
            status: row.status as TaskStatus,
          }
        : null;
    },
    async getTaskRun(taskRunId) {
      const [row] = await db
        .select({
          id: taskRuns.id,
          taskId: taskRuns.taskId,
          jobId: taskRuns.jobId,
          status: taskRuns.status,
        })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId))
        .limit(1);
      return row ? { ...row, status: row.status as TaskRunStatus } : null;
    },
    async getJob(jobId) {
      const [row] = await db
        .select({ id: jobs.id, input: jobs.input })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      return row ?? null;
    },
  };
}

function exactJobInput(
  input: Readonly<Record<string, unknown>> | null,
  taskId: string,
  taskRunId: string,
): boolean {
  return inputString(input, "taskId") === taskId && inputString(input, "taskRunId") === taskRunId;
}

/**
 * Concrete transactional writer. It re-reads and locks the exact Task,
 * TaskRun, and Job tuple in that order inside one transaction before mutating status, so a
 * swapped ID or concurrent lifecycle transition cannot be accepted after an
 * optimistic service read.
 */
export function createCodexTaskRunLifecycleWriter(
  db: DirectDatabase,
): CodexTaskRunLifecycleWriter {
  return {
    async linkJob(input) {
      return db.transaction(async (tx) => {
        // Keep the global lifecycle lock order: Task → TaskRun → Job.
        // This validation must be transaction-local: the adapter's optimistic
        // pre-read is not an authority boundary in the face of concurrent edits.
        const [task] = await tx
          .select({ id: tasks.id, scheduleKind: tasks.scheduleKind })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .for("update");
        if (!task || task.scheduleKind === "cron") return "conflict" as const;
        const [run] = await tx
          .select({ taskId: taskRuns.taskId, jobId: taskRuns.jobId, status: taskRuns.status })
          .from(taskRuns)
          .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
          .for("update");
        const [job] = await tx
          .select({ id: jobs.id, input: jobs.input })
          .from(jobs)
          .where(eq(jobs.id, input.jobId))
          .for("key share");
        if (
          !run ||
          !job ||
          !exactJobInput(job.input, input.taskId, input.taskRunId)
        ) {
          return "conflict" as const;
        }
        if (run.jobId === input.jobId) return "already_linked" as const;
        if (run.jobId !== null || run.status !== "running") return "conflict" as const;
        const updated = await tx
          .update(taskRuns)
          .set({ jobId: input.jobId })
          .where(
            and(
              eq(taskRuns.id, input.taskRunId),
              eq(taskRuns.taskId, input.taskId),
              isNull(taskRuns.jobId),
              eq(taskRuns.status, "running"),
            ),
          )
          .returning({ id: taskRuns.id });
        return updated.length === 1 ? "linked" as const : "conflict" as const;
      });
    },
    async failUnavailableJob(input) {
      return db.transaction(async (tx) => {
        // Preserve the repository-wide lifecycle lock order.
        const [task] = await tx
          .select({
            id: tasks.id,
            ownerId: tasks.ownerId,
            scheduleKind: tasks.scheduleKind,
            status: tasks.status,
            lastError: tasks.lastError,
          })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.ownerId, input.ownerId)))
          .for("update");
        if (!task || task.scheduleKind === "cron") return { status: "conflict" as const };
        const [run] = await tx
          .select({
            taskId: taskRuns.taskId,
            jobId: taskRuns.jobId,
            status: taskRuns.status,
            lastError: taskRuns.lastError,
          })
          .from(taskRuns)
          .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
          .for("update");
        const [job] = await tx
          .select({ id: jobs.id, ownerId: jobs.ownerId, status: jobs.status, message: jobs.message, input: jobs.input })
          .from(jobs)
          .where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, input.ownerId)))
          .for("update");
        if (
          !run ||
          run.jobId !== input.jobId ||
          !job ||
          !exactJobInput(job.input, input.taskId, input.taskRunId) ||
          !canFailUnavailableLifecycle(task, run, input.code)
        ) {
          return { status: "conflict" as const };
        }
        if (job.status === "failed" && job.message === input.code) {
          return {
            status: "already_failed" as const,
            scheduleKind: task.scheduleKind,
          };
        }
        if (!["queued", "running"].includes(job.status)) return { status: "conflict" as const };
        const updated = await tx
          .update(jobs)
          .set({
            status: "failed",
            message: input.code,
            result: null,
            completedAt: input.now,
          })
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.ownerId, input.ownerId),
              inArray(jobs.status, ["queued", "running"]),
            ),
          )
          .returning({ id: jobs.id });
        if (updated.length !== 1) return { status: "conflict" as const };
        return {
          status: "failed" as const,
          scheduleKind: task.scheduleKind,
        };
      });
    },
  };
}

function canFailUnavailableLifecycle(
  task: { readonly status: string; readonly lastError: string | null },
  run: { readonly status: string; readonly lastError: string | null },
  code: "CODEX_REQUEST_UNAVAILABLE",
): boolean {
  const taskActive = ["pending", "running", "awaiting", "paused"].includes(task.status);
  const runActive = ["running", "awaiting", "paused"].includes(run.status);
  if (taskActive && runActive) return true;
  return task.status === "errored" && task.lastError === code &&
    run.status === "errored" && run.lastError === code;
}

/** Bind the Codex adapter to the existing canonical Task finalizers. */
export function createCodexTaskRunReportBack(
  db: DirectDatabase,
  finalizers: {
    readonly complete?: typeof reportBackTaskCompletion;
    readonly fail?: typeof reportBackTaskError;
  } = {},
): CodexTaskRunReportBackPort {
  const complete = finalizers.complete ?? reportBackTaskCompletion;
  const fail = finalizers.fail ?? reportBackTaskError;
  return {
    async complete(input) {
      const args = {
        taskId: input.taskId,
        runId: input.taskRunId,
        scheduleKind: input.scheduleKind,
        resultText: input.resultText,
      };
      try {
        await complete({ db }, args);
      } catch {
        // A transient append failure can happen after the canonical terminal
        // transition committed. One immediate retry is safe: report-back
        // proves the same durable result text and derives its message identity
        // from the immutable TaskRun id. A persistent failure still escapes.
        await complete({ db }, args);
      }
    },
    async fail(input) {
      await fail(
        { db },
        {
          taskId: input.taskId,
          runId: input.taskRunId,
          scheduleKind: input.scheduleKind,
          error: input.code,
        },
      );
    },
  };
}
