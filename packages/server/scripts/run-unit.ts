#!/usr/bin/env bun
/**
 * Server unit-test runner.
 *
 * `tests/unit` runs in sorted 25-file `bun test --isolate` batches: files get
 * isolated modules while each bounded batch can release Bun memory afterwards.
 * `tests/unit-isolated` needs a full Bun process per file for mock.module
 * hygiene. The phases are deliberately separate: isolated tests do not start
 * until every ordinary batch has passed.
 *
 * Every spawned Bun invocation is made a POSIX process-group leader. That is
 * important because Bun can wedge below its per-test timeout; the external wall
 * timeout can then SIGKILL the whole owned group, rather than leave descendants
 * consuming a core after this runner exits.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const SERVER_ROOT = `${import.meta.dir}/..`;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_TIMEOUT_MS = 180_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BATCH_CONCURRENCY = 2;
const MAX_BATCH_CONCURRENCY = 4;

export type ChildHandle = {
  readonly exited: Promise<number | null>;
  readonly pid: number | undefined;
  killGroup: (signal: NodeJS.Signals) => void;
};

export type SpawnJob = (job: TestJob) => ChildHandle;

export type TestJob = {
  readonly label: string;
  readonly files: readonly string[];
  readonly isolated: boolean;
};

export type PoolResult = {
  readonly passed: number;
  readonly started: number;
  readonly total: number;
  readonly failed: { job: TestJob; exitCode: number | null } | null;
  readonly interrupted: boolean;
};

function parseInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function parseBatchConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_BATCH_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, value));
}

export function parseBatchTimeoutMs(raw: string | undefined): number {
  return parseInteger(raw, DEFAULT_BATCH_TIMEOUT_MS, 1_000, 3_600_000);
}

export function parseTestTimeoutMs(raw: string | undefined): number {
  return parseInteger(raw, DEFAULT_TEST_TIMEOUT_MS, 1_000, 3_600_000);
}

export function parseBatchSize(raw: string | undefined): number {
  return parseInteger(raw, DEFAULT_BATCH_SIZE, 1, 1_000);
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(SERVER_ROOT, directory), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => relative(SERVER_ROOT, join(entry.parentPath, entry.name)))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function makeJobs(files: readonly string[], batchSize: number, isolated: boolean): TestJob[] {
  const jobs: TestJob[] = [];
  for (let offset = 0; offset < files.length; offset += isolated ? 1 : batchSize) {
    const group = files.slice(offset, offset + (isolated ? 1 : batchSize));
    jobs.push({
      label: isolated
        ? group[0] ?? "unknown isolated test"
        : `${group[0] ?? "unknown"} … ${group.at(-1) ?? "unknown"}`,
      files: group,
      isolated,
    });
  }
  return jobs;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // A nonexistent process group has already been reaped. Other signal errors
    // are useful evidence and should not be hidden behind a fake success.
    if (!isNoSuchProcess(error)) throw error;
  }
}

export function spawnBunJob(job: TestJob, testTimeoutMs: number): ChildHandle {
  const args = ["test", "--timeout", String(testTimeoutMs)];
  if (!job.isolated) args.push("--isolate");
  args.push(...job.files);
  const child = spawn(process.execPath, args, {
    cwd: SERVER_ROOT,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  return {
    exited: new Promise((resolve) => child.once("close", (code) => resolve(code))),
    pid: child.pid,
    killGroup: (signal) => killProcessGroup(child, signal),
  };
}

export type RunPoolOptions = {
  readonly jobs: readonly TestJob[];
  readonly concurrency: number;
  readonly spawnJob: SpawnJob;
  readonly onJobStart?: (job: TestJob, index: number, total: number) => void;
  readonly onJobFinish?: (job: TestJob, elapsedMs: number, exitCode: number | null) => void;
  readonly onJobTimeout?: (job: TestJob, timeoutMs: number) => void;
  readonly shouldStop?: () => boolean;
  readonly registerKillAll?: (kill: () => void) => void;
  readonly jobTimeoutMs: number;
};

export async function runPool(options: RunPoolOptions): Promise<PoolResult> {
  const {
    jobs,
    concurrency,
    spawnJob,
    onJobStart,
    onJobFinish,
    onJobTimeout,
    shouldStop = () => false,
    registerKillAll,
    jobTimeoutMs,
  } = options;
  let next = 0;
  let passed = 0;
  let started = 0;
  let failed: PoolResult["failed"] = null;
  let stopped = false;
  const active = new Set<ChildHandle>();

  const stopActive = (): void => {
    // These are disposable test workers. A hard group kill is intentional:
    // waiting for a Bun root to exit after SIGTERM can lose the process-group
    // handle while a stubborn descendant continues consuming CPU.
    for (const child of active) child.killGroup("SIGKILL");
  };
  registerKillAll?.(stopActive);

  async function worker(): Promise<void> {
    while (!stopped && !shouldStop()) {
      const index = next++;
      const job = jobs[index];
      if (job === undefined) return;
      onJobStart?.(job, index, jobs.length);
      const startedAt = Date.now();
      const child = spawnJob(job);
      started += 1;
      active.add(child);
      let jobTimedOut = false;
      const timeout = setTimeout(() => {
        if (!active.has(child) || stopped) return;
        jobTimedOut = true;
        onJobTimeout?.(job, jobTimeoutMs);
        // This job gets an immediate hard kill. Remove it before the shared
        // fail-fast cleanup signals the other active groups so macOS does not
        // reject a second signal to the just-reaped process group with EPERM.
        active.delete(child);
        child.killGroup("SIGKILL");
        if (failed === null) {
          failed = { job, exitCode: 124 };
          stopped = true;
          stopActive();
        }
      }, jobTimeoutMs);
      const exitCode = await child.exited;
      clearTimeout(timeout);
      active.delete(child);
      onJobFinish?.(job, Date.now() - startedAt, exitCode);
      if (jobTimedOut) return;
      if (exitCode === 0) {
        passed += 1;
        continue;
      }
      if (failed === null && !shouldStop()) {
        failed = { job, exitCode };
        stopped = true;
        stopActive();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return { passed, started, total: jobs.length, failed, interrupted: shouldStop() };
}

export async function runPhase(
  name: string,
  jobs: readonly TestJob[],
  concurrency: number,
  timeoutMs: number,
  testTimeoutMs: number,
  spawnJob: SpawnJob = (job) => spawnBunJob(job, testTimeoutMs),
): Promise<PoolResult> {
  const startedAt = Date.now();
  try {
    return await runPool({
      jobs,
      concurrency,
      spawnJob,
      jobTimeoutMs: timeoutMs,
      shouldStop: () => interrupted,
      registerKillAll: (kill) => {
        currentPhaseKill = kill;
      },
      onJobStart: (job, index, total) => {
        process.stderr.write(`server:test:unit: ${name} ${index + 1}/${total} start ${job.label}\n`);
      },
      onJobFinish: (job, elapsedMs, exitCode) => {
        process.stderr.write(
          `server:test:unit: ${name} ${exitCode === 0 ? "pass" : "fail"} ` +
            `${job.label} (${(elapsedMs / 1000).toFixed(1)}s)\n`,
        );
      },
      onJobTimeout: (job, elapsedMs) => {
        process.stderr.write(
          `\nserver:test:unit: ${name} timed out after ${elapsedMs}ms; SIGKILL ${job.label}\n` +
            `server:test:unit: files: ${job.files.join(" ")}\n`,
        );
      },
    });
  } finally {
    currentPhaseKill = undefined;
    process.stderr.write(`server:test:unit: ${name} finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
  }
}

let interrupted = false;
let signalExitCode = 1;
let currentPhaseKill: (() => void) | undefined;

async function main(): Promise<number> {
  const concurrency = parseBatchConcurrency(process.env["BUN_TEST_BATCH_CONCURRENCY"]);
  const batchTimeoutMs = parseBatchTimeoutMs(process.env["BUN_TEST_BATCH_TIMEOUT_MS"]);
  const testTimeoutMs = parseTestTimeoutMs(process.env["BUN_TEST_TIMEOUT_MS"]);
  const batchSize = parseBatchSize(process.env["BUN_TEST_BATCH_SIZE"]);
  const unitJobs = makeJobs(await collectFiles("tests/unit"), batchSize, false);
  const isolatedJobs = makeJobs(await collectFiles("tests/unit-isolated"), batchSize, true);
  if (unitJobs.length === 0 && isolatedJobs.length === 0) {
    process.stderr.write("server:test:unit: no test files found\n");
    return 1;
  }

  const stopForSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (interrupted) return;
    interrupted = true;
    signalExitCode = signal === "SIGINT" ? 130 : 143;
    process.stderr.write(`\nserver:test:unit: received ${signal}; stopping new jobs\n`);
    currentPhaseKill?.();
  };
  process.once("SIGINT", () => stopForSignal("SIGINT"));
  process.once("SIGTERM", () => stopForSignal("SIGTERM"));

  process.stderr.write(
    `server:test:unit: ${unitJobs.length} ordinary batches, ${isolatedJobs.length} isolated files; ` +
      `${concurrency} workers, ${batchTimeoutMs}ms wall timeout\n`,
  );
  const ordinary = await runPhase("ordinary", unitJobs, concurrency, batchTimeoutMs, testTimeoutMs);
  if (interrupted) return signalExitCode;
  if (ordinary.failed !== null) return ordinary.failed.exitCode ?? 1;

  // Phase barrier: an ordinary failure means isolated work never begins.
  const isolated = await runPhase("isolated", isolatedJobs, concurrency, batchTimeoutMs, testTimeoutMs);
  if (interrupted) return signalExitCode;
  if (isolated.failed !== null) return isolated.failed.exitCode ?? 1;
  return 0;
}

if (import.meta.main) process.exit(await main());
