/**
 * Stack-193 — deterministic self-test for the isolated unit runner's
 * fail-fast scheduler (`scripts/run-unit-isolated.ts`).
 *
 * Uses a fake `spawnChild` with controllable exit codes + timing, so
 * this exercises the pool's fail-fast / kill-active / stop-launching
 * logic WITHOUT spawning real `bun test` subprocesses (no recursive
 * full run, no process pollution). It is itself discovered by the
 * runner's `tests/unit/**` glob and runs in its own isolated child.
 */
import { describe, expect, test } from "bun:test";
import {
  collectTestFiles,
  parseConcurrency,
  parseTimeoutMs,
  runPool,
  type ChildHandle,
  type SpawnChild,
} from "../../scripts/run-unit-isolated";

function fakeChild(exitCode: number, settleMs = 0): ChildHandle {
  let killed = false;
  let killSignal: string | number | undefined;
  const exited = new Promise<number | null>((resolve) => {
    setTimeout(() => {
      if (killed) resolve(null);
      else resolve(exitCode);
    }, settleMs);
  });
  return {
    exited,
    kill: (signal) => {
      killed = true;
      killSignal = signal;
    },
  };
}

function fakeSpawn(plan: Map<string, { exit: number; settleMs: number }>): SpawnChild {
  return (file) => {
    const entry = plan.get(file);
    if (!entry) return fakeChild(0);
    return fakeChild(entry.exit, entry.settleMs);
  };
}

function names(n: number, prefix = "f"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}.test.ts`);
}

describe("run-unit-isolated scheduler", () => {
  test("all-pass run reports every file passed and no failure", async () => {
    const files = names(6);
    const result = await runPool({
      files,
      concurrency: 3,
      spawnChild: fakeSpawn(new Map()),
    });
    expect(result.total).toBe(6);
    expect(result.passed).toBe(6);
    expect(result.started).toBe(6);
    expect(result.failed).toBeNull();
  });

  test("fail-fast: first nonzero stops the pool and kills active children", async () => {
    const files = names(8);
    const plan = new Map<string, { exit: number; settleMs: number }>([
      [files[0]!, { exit: 0, settleMs: 10 }],
      [files[1]!, { exit: 1, settleMs: 20 }], // first failure
      [files[2]!, { exit: 0, settleMs: 40 }],
      [files[3]!, { exit: 0, settleMs: 40 }],
    ]);
    const killed: string[] = [];
    const spawn: SpawnChild = (file) => {
      const child = fakeChild(plan.get(file)?.exit ?? 0, plan.get(file)?.settleMs ?? 0);
      const originalKill = child.kill;
      return {
        exited: child.exited.then((code) => {
          if (code === null) killed.push(file);
          return code;
        }),
        kill: (signal) => originalKill(signal),
      };
    };
    const result = await runPool({
      files,
      concurrency: 2,
      spawnChild: spawn,
    });

    expect(result.failed).not.toBeNull();
    expect(result.failed?.file).toBe(files[1]);
    expect(result.failed?.exitCode).toBe(1);
    expect(result.passed).toBeLessThan(result.total);
    expect(result.started).toBeLessThanOrEqual(result.total);
    // At least one in-flight child should have been killed on fail-fast.
    expect(killed.length).toBeGreaterThan(0);
  });

  test("concurrency 1 runs strictly serially", async () => {
    const files = names(4);
    const startOrder: string[] = [];
    const result = await runPool({
      files,
      concurrency: 1,
      spawnChild: fakeSpawn(new Map()),
      onFileStart: (file) => startOrder.push(file),
    });
    expect(result.passed).toBe(4);
    expect(startOrder).toEqual(files);
  });

  test("parseConcurrency clamps to 1–8 and falls back on bad input", () => {
    expect(parseConcurrency(undefined)).toBe(4);
    expect(parseConcurrency("")).toBe(4);
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("8")).toBe(8);
    expect(parseConcurrency("0")).toBe(1);
    expect(parseConcurrency("99")).toBe(8);
    expect(parseConcurrency("not-a-number")).toBe(4);
    expect(parseConcurrency("-3")).toBe(1);
  });

  test("parseTimeoutMs clamps to a positive minimum and falls back on bad input", () => {
    expect(parseTimeoutMs(undefined)).toBe(60_000);
    expect(parseTimeoutMs("")).toBe(60_000);
    expect(parseTimeoutMs("30000")).toBe(30_000);
    expect(parseTimeoutMs("0")).toBe(1_000);
    expect(parseTimeoutMs("-5")).toBe(1_000);
    expect(parseTimeoutMs("nope")).toBe(60_000);
  });

  test("collectTestFiles returns a deterministically sorted, non-empty list", async () => {
    const files = await collectTestFiles(`${import.meta.dir}/../..`);
    expect(files.length).toBeGreaterThan(0);
    const sorted = [...files].sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
    );
    expect(files).toEqual(sorted);
    // Runner lives under scripts/ and must never be matched by the glob.
    expect(files.some((f) => f.includes("scripts/run-unit-isolated"))).toBe(false);
  });
});
