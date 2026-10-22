import { expect, test } from "bun:test";
import {
  createTaskContentBackfillWorker,
  type TaskContentBackfillWorkerState,
} from "../../src/client/task/task-content-backfill-worker.ts";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("runs one Task repair batch at a time and follows immediate work", async () => {
  const scheduled: Array<() => void> = [];
  const states: TaskContentBackfillWorkerState[] = [];
  let runs = 0;
  let active = 0;
  let maximumActive = 0;
  let finish: (() => void) | undefined;
  const worker = createTaskContentBackfillWorker({
    clock: {
      now: () => 1_000,
      schedule: callback => {
        scheduled.push(callback);
        return () => {};
      },
    },
    onState: state => states.push(state),
    runBatch: async () => {
      runs += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (runs === 1) await new Promise<void>(resolve => { finish = resolve; });
      active -= 1;
      return runs === 1
        ? { state: "more", resumeAt: 1_000 }
        : { state: "caught_up", resumeAt: null };
    },
  });
  worker.setVisible(true);
  worker.setReady(true);
  scheduled.shift()?.();
  await flush();
  worker.notify();
  worker.notify();
  expect(runs).toBe(1);
  finish?.();
  await flush();
  scheduled.shift()?.();
  await flush();
  expect(runs).toBe(2);
  expect(maximumActive).toBe(1);
  expect(states.map(state => state.state)).toEqual([
    "running", "more", "running", "caught_up",
  ]);
});

test("cancels in-flight repair when custody readiness is lost", async () => {
  const scheduled: Array<() => void> = [];
  let aborted = false;
  const worker = createTaskContentBackfillWorker({
    clock: {
      now: () => 1_000,
      schedule: callback => {
        scheduled.push(callback);
        return () => {};
      },
    },
    runBatch: async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }, { once: true }));
      return { state: "waiting", resumeAt: null };
    },
  });
  worker.setVisible(true);
  worker.setReady(true);
  scheduled.shift()?.();
  await flush();
  worker.setReady(false);
  await flush();
  expect(aborted).toBe(true);
  expect(scheduled).toHaveLength(0);
});

