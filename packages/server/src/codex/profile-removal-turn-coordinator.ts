/**
 * Server-owned drain preceding destructive Codex profile removal.
 *
 * This is intentionally not an Electron supervisor coordinator.  The server
 * owns canonical Task/Job lifecycle and asks it to Stop every retained Task
 * bound to the tombstoned profile.  Electron retains only exact app-server
 * interruption, terminal receipts, and process containment.
 */

export type CodexProfileRemovalBindingWork = {
  readonly taskId: string;
  readonly jobId: string;
};

type ObservedBindingWork = CodexProfileRemovalBindingWork & {
  readonly taskStatus: string;
};

export type CodexProfileRemovalTarget = {
  readonly userId: string;
  readonly profileId: string;
};

export interface CodexProfileRemovalTurnCoordinatorDeps {
  /** Owner/profile-scoped retained binding facts; no browser input crosses here. */
  readonly listBindingWork: (
    target: CodexProfileRemovalTarget,
  ) => Promise<readonly CodexProfileRemovalBindingWork[]>;
  /** Reads the canonical Task row after the binding worklist has been derived. */
  readonly readTask: (taskId: string) => Promise<{
    readonly ownerId: string;
    readonly status: string;
  } | null>;
  /** The one ordinary Task lifecycle path. It owns abort and durable status. */
  readonly stopTask: (taskId: string) => Promise<unknown>;
  /** A Job is fully unwound only after it leaves the generic manager. */
  readonly getJob: (jobId: string) => unknown;
  readonly now?: () => number;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export class CodexProfileRemovalTurnCoordinatorFailure extends Error {
  readonly code = "CODEX_PROFILE_REMOVAL_DRAIN_UNAVAILABLE";

  constructor(readonly reason: "timeout" | "task_stop_failed" | "invalid_binding_work") {
    super("CODEX_PROFILE_REMOVAL_DRAIN_UNAVAILABLE");
    this.name = "CodexProfileRemovalTurnCoordinatorFailure";
  }
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled", "errored"]);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 25;

/**
 * Stops only each canonical Task once, then waits for the ordinary lifecycle
 * to settle.  A fixed-point reread catches a binding that crossed the
 * tombstone boundary immediately before its selection gate committed.
 */
export class CodexProfileRemovalTurnCoordinator {
  private readonly now: () => number;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: CodexProfileRemovalTurnCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    if (!positive(this.timeoutMs) || !positive(this.pollMs)) {
      throw new Error("invalid Codex profile-removal drain bounds");
    }
  }

  async drain(target: CodexProfileRemovalTarget): Promise<void> {
    const deadline = this.now() + this.timeoutMs;
    const stoppedTaskIds = new Set<string>();

    while (true) {
      this.assertBefore(deadline);
      const current = await this.readWork(target);

      const toStop = uniqueNonterminalTaskIds(current).filter((taskId) => !stoppedTaskIds.has(taskId));
      try {
        await Promise.all(toStop.map(async (taskId) => {
          stoppedTaskIds.add(taskId);
          await this.deps.stopTask(taskId);
        }));
      } catch {
        throw new CodexProfileRemovalTurnCoordinatorFailure("task_stop_failed");
      }

      // The first reread is the fixed-point admission check. A Task becomes
      // terminal synchronously at the canonical lifecycle boundary, while its
      // Job remains present until the generator/app-server interrupt has
      // fully unwound. Both facts must be true before host teardown begins.
      const settled = await this.readWork(target);
      if (isDrained(settled, this.deps.getJob)) {
        // Re-read once more with no intervening writes. This proves the
        // removal gate's observed workset reached a stable fixed point rather
        // than merely an empty/terminal first snapshot.
        const verified = await this.readWork(target);
        if (sameWorkset(settled, verified) && isDrained(verified, this.deps.getJob)) return;
      }

      this.assertBefore(deadline);
      await this.wait(Math.min(this.pollMs, Math.max(1, deadline - this.now())));
    }
  }

  private assertBefore(deadline: number): void {
    if (this.now() >= deadline) {
      throw new CodexProfileRemovalTurnCoordinatorFailure("timeout");
    }
  }

  private async readWork(target: CodexProfileRemovalTarget): Promise<readonly ObservedBindingWork[]> {
    const bindings = await this.deps.listBindingWork(target);
    if (!validBindingWork(bindings)) {
      throw new CodexProfileRemovalTurnCoordinatorFailure("invalid_binding_work");
    }
    const taskIds = [...new Set(bindings.map((entry) => entry.taskId))];
    const tasks = await Promise.all(taskIds.map(async (taskId) => [
      taskId,
      await this.deps.readTask(taskId),
    ] as const));
    const taskById = new Map(tasks);
    if (
      taskById.size !== taskIds.length ||
      [...taskById.values()].some((task) => !task || task.ownerId !== target.userId || !nonEmpty(task.status))
    ) {
      throw new CodexProfileRemovalTurnCoordinatorFailure("invalid_binding_work");
    }
    return bindings.map((binding) => ({
      ...binding,
      taskStatus: taskById.get(binding.taskId)!.status,
    }));
  }
}

function uniqueNonterminalTaskIds(work: readonly ObservedBindingWork[]): string[] {
  return [...new Set(
    work.filter((entry) => !TERMINAL_TASK_STATUSES.has(entry.taskStatus)).map((entry) => entry.taskId),
  )];
}

function isDrained(
  work: readonly ObservedBindingWork[],
  getJob: (jobId: string) => unknown,
): boolean {
  return work.every(
    (entry) => TERMINAL_TASK_STATUSES.has(entry.taskStatus) && getJob(entry.jobId) === undefined,
  );
}

function sameWorkset(
  left: readonly ObservedBindingWork[],
  right: readonly ObservedBindingWork[],
): boolean {
  return worksetKey(left) === worksetKey(right);
}

function worksetKey(work: readonly ObservedBindingWork[]): string {
  return [...work]
    .map((entry) => `${entry.taskId}\u0000${entry.jobId}\u0000${entry.taskStatus}`)
    .sort()
    .join("\u0001");
}

function validBindingWork(work: readonly CodexProfileRemovalBindingWork[]): boolean {
  return work.every(
    (entry) => nonEmpty(entry.taskId) && nonEmpty(entry.jobId),
  );
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
