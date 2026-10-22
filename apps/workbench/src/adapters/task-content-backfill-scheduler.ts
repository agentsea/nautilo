import {
  createTaskContentBackfillWorker,
  type TaskContentBackfillBatchResult,
} from "@nautilo/lattice-bridge/client/browser";

export interface WorkbenchTaskContentBackfillClient {
  runBatch(input: Readonly<{ signal: AbortSignal }> ):
    Promise<TaskContentBackfillBatchResult>;
}

export interface WorkbenchTaskContentBackfillReadinessPort {
  /** Current Task content owner state; conversation policy is insufficient. */
  readTaskProtectionActive(input: Readonly<{ signal: AbortSignal }> ):
    Promise<boolean>;
}

export function createDesktopTaskContentBackfillSchedulerClient(input: Readonly<{
  service(): Promise<TaskContentBackfillBatchResult>;
  cancel(): Promise<void>;
}>): WorkbenchTaskContentBackfillClient {
  return Object.freeze({
    async runBatch({ signal }: Readonly<{ signal: AbortSignal }>) {
      if (signal.aborted) {
        return Object.freeze({ state: "waiting" as const, resumeAt: null });
      }
      const cancel = () => { void input.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await input.service();
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
}

/**
 * Mounts one sequential Task repair worker behind current Task-owner readiness,
 * device admission, page visibility, and foreground activity gates.
 */
export function createWorkbenchTaskContentBackfillScheduler(input: Readonly<{
  client: WorkbenchTaskContentBackfillClient;
  readiness: WorkbenchTaskContentBackfillReadinessPort;
  visibility: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  clock: Parameters<typeof createTaskContentBackfillWorker>[0]["clock"];
  errorResumeAt(): number;
}>) {
  let disposed = false;
  const runBatch = async (
    operation: Readonly<{ signal: AbortSignal }>,
  ): Promise<TaskContentBackfillBatchResult> => {
    if (operation.signal.aborted || disposed) {
      return Object.freeze({ state: "waiting" as const, resumeAt: null });
    }
    const active = await input.readiness.readTaskProtectionActive(operation);
    if (operation.signal.aborted || disposed || !active) {
      return Object.freeze({ state: "waiting" as const, resumeAt: null });
    }
    return input.client.runBatch(operation);
  };
  const worker = createTaskContentBackfillWorker({
    runBatch,
    clock: input.clock,
    errorResumeAt: input.errorResumeAt,
  });
  const visibilityChanged = () => {
    worker.setVisible(input.visibility.visibilityState === "visible");
  };
  input.visibility.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();

  return Object.freeze({
    setReady(ready: boolean) {
      worker.setReady(ready);
    },
    setForegroundBusy(busy: boolean) {
      worker.setForegroundBusy(busy);
    },
    notify() {
      worker.notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.visibility.removeEventListener("visibilitychange", visibilityChanged);
      worker.dispose();
    },
  });
}
