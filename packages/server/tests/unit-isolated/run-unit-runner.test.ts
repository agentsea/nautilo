/** Tests the runner scheduler without recursively invoking the server suite. */
import { describe, expect, test } from "bun:test";
import {
  makeJobs,
  parseBatchConcurrency,
  parseBatchTimeoutMs,
  runPool,
  type ChildHandle,
  type SpawnJob,
} from "../../scripts/run-unit";

function job(name: string) {
  return { label: name, files: [name], isolated: false };
}

function fakeChild(
  exitCode: number,
  settleMs = 0,
  onKill?: (signal: NodeJS.Signals) => void,
): ChildHandle {
  let killed = false;
  return {
    pid: 1,
    exited: new Promise((resolve) => {
      setTimeout(() => resolve(killed ? null : exitCode), settleMs);
    }),
    killGroup: (signal) => {
      killed = true;
      onKill?.(signal);
    },
  };
}

describe("server run-unit runner", () => {
  test("keeps sorted ordinary files in deterministic 25-file batches", () => {
    const files = Array.from({ length: 53 }, (_, index) => `tests/unit/${String(index).padStart(3, "0")}.test.ts`);
    const jobs = makeJobs(files, 25, false);
    expect(jobs.map((entry) => entry.files.length)).toEqual([25, 25, 3]);
    expect(jobs.flatMap((entry) => entry.files)).toEqual(files);
  });

  test("makes every isolated file its own Bun job", () => {
    const jobs = makeJobs(["a.test.ts", "b.test.ts", "c.test.ts"], 25, true);
    expect(jobs.map((entry) => entry.files)).toEqual([["a.test.ts"], ["b.test.ts"], ["c.test.ts"]]);
  });

  test("defaults to two workers and bounds overrides to four", () => {
    expect(parseBatchConcurrency(undefined)).toBe(2);
    expect(parseBatchConcurrency("1")).toBe(1);
    expect(parseBatchConcurrency("4")).toBe(4);
    expect(parseBatchConcurrency("5")).toBe(4);
    expect(parseBatchConcurrency("not-a-number")).toBe(2);
    expect(parseBatchTimeoutMs(undefined)).toBe(180_000);
  });

  test("fails fast, stops launching, and reaps active jobs", async () => {
    const jobs = [job("first"), job("broken"), job("active"), job("queued")];
    const killed: Array<{ label: string; signal: NodeJS.Signals }> = [];
    const plan = new Map<string, readonly [number, number]>([
      ["first", [0, 5]],
      ["broken", [1, 10]],
      ["active", [0, 50]],
      ["queued", [0, 50]],
    ]);
    const spawnJob: SpawnJob = (entry) => {
      const [code, delay] = plan.get(entry.label) ?? [0, 0];
      return fakeChild(code, delay, (signal) => killed.push({ label: String(entry.label), signal }));
    };

    const result = await runPool({ jobs, concurrency: 2, spawnJob, jobTimeoutMs: 1_000 });
    expect(result.failed?.job.label).toBe("broken");
    expect(result.started).toBeLessThan(jobs.length);
    expect(killed).toContainEqual({ label: "active", signal: "SIGKILL" });
  });

  test("external cancellation hard-kills active groups and stops new jobs", async () => {
    let interrupted = false;
    let killAll: (() => void) | undefined;
    const signals: NodeJS.Signals[] = [];
    setTimeout(() => {
      interrupted = true;
      killAll?.();
    }, 5);

    const result = await runPool({
      jobs: [job("active"), job("queued")],
      concurrency: 1,
      jobTimeoutMs: 1_000,
      shouldStop: () => interrupted,
      registerKillAll: (kill) => {
        killAll = kill;
      },
      spawnJob: () => fakeChild(0, 30, (signal) => signals.push(signal)),
    });
    expect(result.interrupted).toBe(true);
    expect(result.started).toBe(1);
    expect(signals).toEqual(["SIGKILL"]);
  });

  test("external per-job wall timeout kills the owned group and reports exit 124", async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await runPool({
      jobs: [job("wedged")],
      concurrency: 1,
      jobTimeoutMs: 10,
      spawnJob: () => fakeChild(0, 30, (signal) => signals.push(signal)),
    });
    expect(result.failed?.job.label).toBe("wedged");
    expect(result.failed?.exitCode).toBe(124);
    expect(signals).toEqual(["SIGKILL"]);
  });
});
