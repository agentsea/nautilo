import { createMessageBackfillWorker } from
  "../message/message-backfill-worker.ts";

export type TaskContentBackfillBatchResult = Readonly<{
  state: "more" | "waiting" | "caught_up";
  /** Absolute time on the injected clock, or null until an external hint. */
  resumeAt: number | null;
}>;

export type TaskContentBackfillWorkerState = Readonly<{
  state: "running" | "more" | "waiting" | "caught_up" | "error";
  resumeAt: number | null;
}>;

export type TaskContentBackfillWorker = Readonly<{
  setReady(ready: boolean): void;
  setForegroundBusy(busy: boolean): void;
  setVisible(visible: boolean): void;
  notify(): void;
  dispose(): void;
}>;

/** Sequential scheduler shared with Message repair, without Message priority state. */
export function createTaskContentBackfillWorker(input: Readonly<{
  runBatch(input: Readonly<{ signal: AbortSignal }> ):
    Promise<TaskContentBackfillBatchResult>;
  clock: Readonly<{
    now(): number;
    schedule(callback: () => void, delayMs: number): () => void;
  }>;
  onState?(state: TaskContentBackfillWorkerState): void;
  errorResumeAt?(): number | null;
}>): TaskContentBackfillWorker {
  return createMessageBackfillWorker({
    runBatch: input.runBatch,
    clock: input.clock,
    ...(input.errorResumeAt === undefined
      ? {} : { errorResumeAt: input.errorResumeAt }),
    ...(input.onState === undefined ? {} : {
      onState: state => input.onState?.({
        state: state.state,
        resumeAt: state.resumeAt,
      }),
    }),
  });
}
