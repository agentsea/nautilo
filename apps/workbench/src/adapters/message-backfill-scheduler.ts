import { createMessageBackfillWorker, type MessageBackfillBatchResult } from "@nautilo/lattice-bridge/client/browser";
import type { MessageBackfillUrgentSelection } from "@nautilo/api-client/browser";

export interface WorkbenchMessageBackfillClient {
  runBatch(input: Readonly<{signal: AbortSignal}>): Promise<MessageBackfillBatchResult>;
  prioritize(selection: MessageBackfillUrgentSelection): void;
}

export type PrioritizedHistoryRefreshResult =
  | "refreshed"
  | "retry"
  | "ignored";

// Message IDs are globally unique inside the current server/user scheduler
// scope. A mounted parent Room and its canonical child Subthread can name the
// same durable revision with different Room IDs.
const historyRefreshKey = (selection: MessageBackfillUrgentSelection) =>
  `${selection.messageId}:${selection.revision}`;

export function createDesktopMessageBackfillSchedulerClient(input: Readonly<{
  service(selection?: MessageBackfillUrgentSelection): Promise<MessageBackfillBatchResult>;
  cancel(): Promise<void>;
}>): WorkbenchMessageBackfillClient {
  let urgent: MessageBackfillUrgentSelection | undefined;
  return {
    prioritize(selection) {urgent = selection;},
    async runBatch({signal}) {
      if (signal.aborted) return {state: "waiting", resumeAt: null};
      const cancel = () => {void input.cancel().catch(() => undefined);};
      signal.addEventListener("abort", cancel, {once: true});
      const selected = urgent;
      urgent = undefined;
      try {return await input.service(selected);}
      finally {signal.removeEventListener("abort", cancel);}
    },
  };
}

/** UI readiness and structural latency hints only. The trusted facade owns every body operation. */
export function createWorkbenchMessageBackfillScheduler(input: Readonly<{
  client: WorkbenchMessageBackfillClient;
  visibility: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  clock: Parameters<typeof createMessageBackfillWorker>[0]["clock"];
  errorResumeAt(): number;
  /** Content-free hint that an explicitly prioritized visible row may now
   * have a different durable representation. */
  onPrioritizedHistoryChanged?(
    selection: MessageBackfillUrgentSelection,
  ): PrioritizedHistoryRefreshResult | Promise<PrioritizedHistoryRefreshResult>;
}>) {
  let priorityGeneration = 0;
  let activePriority: Readonly<{ key: string; generation: number }> | null = null;
  let lastRefreshedPriority: Readonly<{ key: string; generation: number }> | null = null;
  let disposed = false;
  let ready = false;
  let foregroundBusy = false;
  let visible = input.visibility.visibilityState === "visible";
  const refreshAttempts = new Map<string, {
    selection: MessageBackfillUrgentSelection;
    generation: number;
    queuedGeneration: number | null;
    cancelRetry: (() => void) | null;
    resumeAt: number | null;
    running: boolean;
  }>();
  const canRefreshHistory = () => ready && visible && !foregroundBusy;

  function scheduleHistoryRefreshRetry(key: string): void {
    const pending = refreshAttempts.get(key);
    if (disposed || pending === undefined || pending.running) return;
    pending.resumeAt ??= input.errorResumeAt();
    if (!canRefreshHistory() || pending.cancelRetry !== null) return;
    pending.cancelRetry = input.clock.schedule(() => {
      pending.cancelRetry = null;
      attemptHistoryRefresh(pending.selection);
    }, Math.max(0, pending.resumeAt - input.clock.now()));
  }

  function attemptHistoryRefresh(
    selection: MessageBackfillUrgentSelection,
  ): void {
    if (disposed || input.onPrioritizedHistoryChanged === undefined) return;
    const key = historyRefreshKey(selection);
    const generation = activePriority?.key === key ? activePriority.generation : 0;
    if (lastRefreshedPriority?.key === key
      && lastRefreshedPriority.generation === generation) return;
    const existing = refreshAttempts.get(key);
    if (existing?.running) {
      if (generation !== existing.generation) existing.queuedGeneration = generation;
      return;
    }
    const pending = existing ?? {
      selection,
      generation,
      queuedGeneration: null,
      cancelRetry: null,
      resumeAt: null,
      running: false,
    };
    pending.generation = generation;
    refreshAttempts.set(key, pending);
    if (pending.cancelRetry !== null) return;
    if (!canRefreshHistory()) {
      scheduleHistoryRefreshRetry(key);
      return;
    }

    pending.running = true;
    pending.resumeAt = null;
    let result: PrioritizedHistoryRefreshResult
      | Promise<PrioritizedHistoryRefreshResult>;
    try {
      result = input.onPrioritizedHistoryChanged(selection);
    } catch {
      result = "retry";
    }
    const scheduleRetry = () => {
      const current = refreshAttempts.get(key);
      if (disposed || current !== pending) return;
      pending.running = false;
      if (pending.queuedGeneration !== null) {
        pending.generation = pending.queuedGeneration;
        pending.queuedGeneration = null;
      }
      scheduleHistoryRefreshRetry(key);
    };
    void Promise.resolve(result).then((outcome) => {
      const current = refreshAttempts.get(key);
      if (disposed || current !== pending) return;
      pending.running = false;
      if (outcome === "refreshed") {
        const completedGeneration = pending.generation;
        const queuedGeneration = pending.queuedGeneration;
        lastRefreshedPriority = {
          key,
          generation: completedGeneration,
        };
        refreshAttempts.delete(key);
        if (queuedGeneration !== null
          && activePriority?.key === key
          && activePriority.generation === queuedGeneration) {
          attemptHistoryRefresh(selection);
        }
        return;
      }
      if (outcome === "ignored") {
        const queuedGeneration = pending.queuedGeneration;
        refreshAttempts.delete(key);
        if (queuedGeneration !== null
          && activePriority?.key === key
          && activePriority.generation === queuedGeneration) {
          attemptHistoryRefresh(selection);
        }
        return;
      }
      scheduleHistoryRefreshRetry(key);
    }, scheduleRetry);
  }
  const worker = createMessageBackfillWorker({runBatch: (operation) => input.client.runBatch(operation),
    clock: input.clock, errorResumeAt: input.errorResumeAt,
    onState(state) {
      if (state.state === "running") return;
      // Own reconciliations name their exact changed coordinate. A separate
      // server proof covers the same priority won by another device. Scans,
      // authority preparation, failures and stale acknowledgements stay silent.
      const selection = state.reconciledSelection
        ?? state.resolvedSelection
        ?? null;
      if (selection !== null) attemptHistoryRefresh(selection);
    }});
  const pauseHistoryRefreshRetries = (): void => {
    for (const pending of refreshAttempts.values()) {
      pending.cancelRetry?.();
      pending.cancelRetry = null;
    }
  };
  const resumeHistoryRefreshRetries = (): void => {
    for (const key of refreshAttempts.keys()) scheduleHistoryRefreshRetry(key);
  };
  const selectHistoryRefresh = (selection: MessageBackfillUrgentSelection): void => {
    priorityGeneration += 1;
    activePriority = {
      key: historyRefreshKey(selection),
      generation: priorityGeneration,
    };
  };
  const visibilityChanged = () => {
    visible = input.visibility.visibilityState === "visible";
    worker.setVisible(visible);
    if (canRefreshHistory()) resumeHistoryRefreshRetries();
    else pauseHistoryRefreshRetries();
  };
  input.visibility.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  return {
    setReady(nextReady: boolean) {
      ready = nextReady;
      worker.setReady(nextReady);
      if (canRefreshHistory()) resumeHistoryRefreshRetries();
      else pauseHistoryRefreshRetries();
    },
    setForegroundBusy(nextForegroundBusy: boolean) {
      foregroundBusy = nextForegroundBusy;
      worker.setForegroundBusy(nextForegroundBusy);
      if (canRefreshHistory()) resumeHistoryRefreshRetries();
      else pauseHistoryRefreshRetries();
    },
    notify: worker.notify,
    /** Runs the bounded exact-history lane without depending on a repair-worker
     * acknowledgement. Full mode may legitimately have no repair work while a
     * mounted ciphertext row still needs to be reread after key delivery. */
    refreshHistory(selection: MessageBackfillUrgentSelection) {
      selectHistoryRefresh(selection);
      attemptHistoryRefresh(selection);
    },
    prioritize(selection: MessageBackfillUrgentSelection) {
      selectHistoryRefresh(selection);
      input.client.prioritize(selection);
      worker.notify();
    },
    dispose() {
      disposed = true;
      for (const attempt of refreshAttempts.values()) attempt.cancelRetry?.();
      refreshAttempts.clear();
      input.visibility.removeEventListener("visibilitychange", visibilityChanged);
      worker.dispose();
    },
  };
}
