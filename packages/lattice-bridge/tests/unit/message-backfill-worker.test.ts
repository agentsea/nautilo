import { describe, expect, test } from "bun:test";

import {
  createMessageBackfillWorker,
  type MessageBackfillBatchResult,
  type MessageBackfillWorkerState,
} from "../../src/client/message/message-backfill-worker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClock {
  nowMs = 1_000;
  private nextId = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  readonly clock = {
    now: () => this.nowMs,
    schedule: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.nowMs + delayMs, callback });
      return () => { this.tasks.delete(id); };
    },
  };

  runDue(): void {
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }

  advanceTo(nowMs: number): void {
    this.nowMs = nowMs;
    this.runDue();
  }

  get pending(): number {
    return this.tasks.size;
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Message backfill worker", () => {
  test("drains more work serially and yields through the scheduler", async () => {
    const time = new FakeClock();
    const first = deferred<MessageBackfillBatchResult>();
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      async runBatch() {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const result = calls === 1
          ? await first.promise
          : { state: "caught_up", resumeAt: null } as const;
        active -= 1;
        return result;
      },
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    expect(calls).toBe(1);
    worker.notify();
    worker.notify();
    expect(calls).toBe(1);

    first.resolve({ state: "more", resumeAt: null });
    await flush();
    expect(calls).toBe(1);
    expect(time.pending).toBe(1);
    time.runDue();
    await flush();
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
  });

  test("aborts paused work, suppresses its stale result, and resumes from server state", async () => {
    const time = new FakeClock();
    const lostResponse = deferred<MessageBackfillBatchResult>();
    const signals: AbortSignal[] = [];
    const states: MessageBackfillWorkerState[] = [];
    let calls = 0;
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      onState: (state) => states.push(state),
      runBatch({ signal }) {
        calls += 1;
        signals.push(signal);
        return calls === 1
          ? lostResponse.promise
          : Promise.resolve({ state: "caught_up", resumeAt: null });
      },
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    worker.setReady(false);
    expect(signals[0]?.aborted).toBe(true);
    worker.setReady(true);
    time.runDue();
    expect(calls).toBe(1);

    lostResponse.resolve({ state: "caught_up", resumeAt: null });
    await flush();
    time.runDue();
    await flush();
    expect(calls).toBe(2);
    expect(states.filter(({ state }) => state === "caught_up")).toHaveLength(1);
  });

  test("pauses for foreground work and hidden lifecycle state", async () => {
    const time = new FakeClock();
    const signals: AbortSignal[] = [];
    const batches: Array<ReturnType<typeof deferred<MessageBackfillBatchResult>>> = [];
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      runBatch({ signal }) {
        signals.push(signal);
        const batch = deferred<MessageBackfillBatchResult>();
        batches.push(batch);
        return batch.promise;
      },
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    worker.setForegroundBusy(true);
    expect(signals[0]?.aborted).toBe(true);
    worker.setForegroundBusy(false);
    batches[0]?.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    expect(signals).toHaveLength(2);

    worker.setVisible(false);
    expect(signals[1]?.aborted).toBe(true);
    batches[1]?.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    expect(signals).toHaveLength(2);
    worker.setVisible(true);
    time.runDue();
    expect(signals).toHaveLength(3);
  });

  test("honors server resume times indefinitely without an attempt budget", async () => {
    const time = new FakeClock();
    const results: MessageBackfillBatchResult[] = [
      { state: "waiting", resumeAt: 101_000 },
      { state: "waiting", resumeAt: 201_000 },
      { state: "caught_up", resumeAt: 301_000 },
      { state: "caught_up", resumeAt: null },
    ];
    let calls = 0;
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      runBatch: async () => results[calls++]!,
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    await flush();
    expect(calls).toBe(1);
    time.advanceTo(100_999);
    expect(calls).toBe(1);
    time.advanceTo(101_000);
    await flush();
    expect(calls).toBe(2);
    time.advanceTo(201_000);
    await flush();
    expect(calls).toBe(3);
    time.advanceTo(301_000);
    await flush();
    expect(calls).toBe(4);
  });

  test("reports content-free errors and retries only from supplied recovery timing or notify", async () => {
    const time = new FakeClock();
    const states: MessageBackfillWorkerState[] = [];
    let calls = 0;
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      errorResumeAt: () => calls === 1 ? null : 6_000,
      onState: (state) => states.push(state),
      runBatch: async () => {
        calls += 1;
        if (calls < 3) throw new Error("sensitive provider detail");
        return { state: "caught_up", resumeAt: null };
      },
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    await flush();
    expect(states.at(-1)).toEqual({ state: "error", resumeAt: null });
    expect(time.pending).toBe(0);

    worker.notify();
    time.runDue();
    await flush();
    expect(states.at(-1)).toEqual({ state: "error", resumeAt: 6_000 });
    time.advanceTo(5_999);
    expect(calls).toBe(2);
    time.advanceTo(6_000);
    await flush();
    expect(calls).toBe(3);
    expect(JSON.stringify(states)).not.toContain("sensitive provider detail");
  });

  test("dispose cancels scheduled work, aborts active work, and ignores later hints", async () => {
    const time = new FakeClock();
    const batch = deferred<MessageBackfillBatchResult>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const worker = createMessageBackfillWorker({
      clock: time.clock,
      runBatch(input) {
        calls += 1;
        signal = input.signal;
        return batch.promise;
      },
    });

    worker.setVisible(true);
    worker.setReady(true);
    time.runDue();
    worker.dispose();
    expect(signal?.aborted).toBe(true);
    worker.notify();
    worker.setReady(true);
    batch.resolve({ state: "more", resumeAt: null });
    await flush();
    time.runDue();
    expect(calls).toBe(1);
    expect(time.pending).toBe(0);
  });
});
