#!/usr/bin/env bun
/**
 * Stack-193 — Workbench isolated unit test runner.
 *
 * Runs each Workbench unit test file (the globs rooted at tests/unit and
 * tests/unit-isolated matching .test.ts and .test.tsx files, recursively)
 * in its own `bun test --timeout <ms> <file>` subprocess so process-global
 * state (bun:test `mock.module` partial mocks, happy-dom globals
 * installed by `tests/bun-dom-preload.ts`) cannot leak across files.
 * That cross-file pollution is the root cause of the CI failures
 * (missing WS_URL, missing canSwitchDesktopServer, document
 * undefined): every file passes alone, but a one-process
 * `bun test tests/unit/` run trips on state left by an earlier file.
 *
 * Bounded parallelism (default 4; `WORKBENCH_UNIT_CONCURRENCY` 1–8)
 * with TRUE fail-fast: on the first nonzero child exit we stop
 * launching new files, SIGTERM every active child, await their exit,
 * print the first failing file, and exit nonzero. We do NOT wait for
 * queued files. SIGINT/SIGTERM are propagated to active children.
 *
 * stdio is inherited so CI shows the failing file's real Bun output.
 *
 * Invoked by `bun run test:unit` (see apps/workbench/package.json).
 * This file lives under `scripts/`, so the tests/unit glob never
 * matches the runner itself (requirement 7).
 */
import { Glob } from "bun";

const WORKBENCH_ROOT = `${import.meta.dir}/..`;
const TEST_GLOBS = ["tests/unit/**/*.test.{ts,tsx}", "tests/unit-isolated/**/*.test.{ts,tsx}"];

const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;

export type ChildHandle = {
  readonly exited: Promise<number | null>;
  kill: (signal?: string | number) => void;
};

export type SpawnChild = (file: string) => ChildHandle;

export type PoolResult = {
  readonly passed: number;
  readonly started: number;
  readonly total: number;
  readonly failed: { file: string; exitCode: number | null } | null;
};

export type PoolHandle = { killActive: (signal?: string | number) => void };

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  const truncated = Math.trunc(value);
  if (truncated < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (truncated > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return truncated;
}

export function parseConcurrency(
  raw: string | undefined,
  fallback: number = DEFAULT_CONCURRENCY,
): number {
  if (raw === undefined || raw === "") return clampConcurrency(fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return clampConcurrency(fallback);
  return clampConcurrency(parsed);
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  const truncated = Math.trunc(value);
  if (truncated < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  return truncated;
}

export function parseTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_TIMEOUT_MS,
): number {
  if (raw === undefined || raw === "") return clampTimeout(fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return clampTimeout(fallback);
  return clampTimeout(parsed);
}

export async function collectTestFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of TEST_GLOBS) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: root, absolute: true })) {
      files.push(path);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  return files;
}

export type RunPoolOptions = {
  files: string[];
  concurrency: number;
  spawnChild: SpawnChild;
  onFileStart?: (file: string, index: number, total: number) => void;
  registerKillAll?: (kill: () => void) => void;
};

export async function runPool(options: RunPoolOptions): Promise<PoolResult> {
  const { files, concurrency, spawnChild, onFileStart, registerKillAll } = options;
  const total = files.length;
  let nextIndex = 0;
  let passed = 0;
  let started = 0;
  let failed: PoolResult["failed"] = null;
  let stopLaunching = false;
  const active: ChildHandle[] = [];

  const killActive = (signal: string | number = "SIGTERM"): void => {
    for (const child of active) {
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    }
  };
  registerKillAll?.(() => killActive("SIGTERM"));

  async function worker(): Promise<void> {
    while (!stopLaunching) {
      if (failed !== null) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      const file = files[index];
      if (failed !== null) return;
      onFileStart?.(file, index, total);
      const child = spawnChild(file);
      started += 1;
      active.push(child);
      const exit = await child.exited;
      const activeIndex = active.indexOf(child);
      if (activeIndex >= 0) active.splice(activeIndex, 1);
      if (exit === 0) {
        passed += 1;
        continue;
      }
      if (failed === null) {
        failed = { file, exitCode: exit };
        stopLaunching = true;
        killActive("SIGTERM");
      }
    }
  }

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, total);
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return { passed, started, total, failed };
}

function realSpawnChild(timeoutMs: number): SpawnChild {
  return (file) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "test", "--timeout", String(timeoutMs), file],
      cwd: WORKBENCH_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      exited: proc.exited,
      kill: (signal) => {
        try {
          proc.kill(signal ?? "SIGTERM");
        } catch {
          /* already exited */
        }
      },
    };
  };
}

async function main(): Promise<number> {
  const concurrency = parseConcurrency(process.env.WORKBENCH_UNIT_CONCURRENCY);
  const timeoutMs = parseTimeoutMs(process.env.WORKBENCH_UNIT_TIMEOUT_MS);
  const files = await collectTestFiles(WORKBENCH_ROOT);
  if (files.length === 0) {
    process.stderr.write(
      `workbench:unit-isolated: no test files matched "${TEST_GLOBS.join('", "')}"\n`,
    );
    return 1;
  }

  const startMs = Date.now();
  process.stderr.write(
    `workbench:unit-isolated: ${files.length} files, ${concurrency} workers, ${timeoutMs}ms timeout\n`,
  );

  let killAll: () => void = () => {};
  let shuttingDown = false;
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\nworkbench:unit-isolated: received ${signal}, killing children\n`);
    killAll();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    // Let the killed children settle so their output flushes.
    setTimeout(() => process.exit(process.exitCode ?? 1), 50);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const result = await runPool({
    files,
    concurrency,
    spawnChild: realSpawnChild(timeoutMs),
    registerKillAll: (fn) => {
      killAll = fn;
    },
  });

  const elapsedMs = Date.now() - startMs;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  if (result.failed !== null) {
    const exit = result.failed.exitCode;
    process.stderr.write(
      `\nworkbench:unit-isolated: FAIL (fail-fast) ${result.failed.file} (exit ${exit})\n`,
    );
    process.stderr.write(
      `workbench:unit-isolated: ${result.passed}/${result.total} passed, ` +
        `${elapsedSec}s elapsed, stopped after first failure\n`,
    );
    return exit === null ? 1 : exit;
  }
  process.stderr.write(
    `workbench:unit-isolated: ${result.passed}/${result.total} passed, ` +
      `${elapsedSec}s elapsed\n`,
  );
  return 0;
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
