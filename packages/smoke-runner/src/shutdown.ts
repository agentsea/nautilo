/**
 * Graceful shutdown for long-lived VM consumers (`nautilo-smoke run`,
 * `nautilo-smoke serve`, and any future CLI that boots VMs).
 *
 * The problem this solves: the drivers' `stop()` methods work fine, but
 * nothing was calling them. Before this helper, `run` would execute the
 * matrix and exit with the Lima + Tart VMs still running — consuming
 * CPU / RAM for days until someone noticed. And `serve`'s SIGINT
 * handler only closed the HTTP server; the VMs kept going.
 *
 * Shape:
 *
 * - `stopAllDrivers(drivers)` — fire-and-forget stop of N drivers in
 *   parallel. Failures are logged, not thrown. Use in normal `finally`.
 * - `registerShutdownHandlers({ drivers, beforeExit })` — installs
 *   SIGINT / SIGTERM / SIGHUP handlers that (a) run `beforeExit` (HTTP
 *   close / writer flush / etc.), then (b) stop drivers in parallel,
 *   then (c) `process.exit(0)`. Idempotent against repeat signals.
 *
 * Both respect the `--keep-vms` escape hatch via `keepVms: true`.
 */

import type { VmDriver } from "./driver.ts";

export interface NamedDriver {
  readonly name: string;
  readonly driver: VmDriver;
}

export interface StopAllOptions {
  readonly log?: (line: string) => void;
  /** Per-driver stop timeout. Default 60s (matches the drivers' own timeout). */
  readonly perDriverTimeoutMs?: number;
}

/**
 * Stop every driver in parallel. Failures are logged and swallowed so
 * one driver's hang or error doesn't mask another's stop. Safe to call
 * from a `finally` block on normal exit paths.
 */
export async function stopAllDrivers(
  drivers: readonly NamedDriver[],
  opts: StopAllOptions = {},
): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const timeoutMs = opts.perDriverTimeoutMs ?? 60_000;

  await Promise.allSettled(
    drivers.map(async ({ driver, name }) => {
      log(`[smoke-runner] stopping ${name}…`);
      try {
        await withTimeout(driver.stop(), timeoutMs, `${name} stop`);
        log(`[smoke-runner] ${name} stopped`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[smoke-runner] ${name} stop failed: ${msg}`);
      }
    }),
  );
}

export interface ShutdownOptions extends StopAllOptions {
  readonly drivers: readonly NamedDriver[];
  /**
   * Runs BEFORE driver stop. Use this to close an HTTP server, flush a
   * writer, cancel pending work, etc. Errors are logged, not thrown.
   */
  readonly beforeExit?: () => Promise<void> | void;
  /** If true, don't stop drivers — operator wanted to leave them up. */
  readonly keepVms?: boolean;
  /**
   * Signals to listen for. Default `["SIGINT", "SIGTERM", "SIGHUP"]`.
   * Tests may want to narrow this.
   */
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Install signal handlers that gracefully shut down VMs on Ctrl-C /
 * kill / HUP. Returns an unregister function.
 *
 * Idempotent: repeat signals while a shutdown is in flight are
 * ignored, so the user can spam Ctrl-C without racing the stop.
 *
 * Exits the process with code 0 on clean shutdown, 1 if `beforeExit`
 * threw. Driver stop failures do NOT affect the exit code (they're
 * logged) because the priority is getting out cleanly; the user can
 * see the failure in the logs and intervene.
 */
export function registerShutdownHandlers(opts: ShutdownOptions): () => void {
  const log = opts.log ?? ((line: string) => console.log(line));
  const signals: readonly NodeJS.Signals[] = opts.signals ?? ["SIGINT", "SIGTERM", "SIGHUP"];

  let shuttingDown = false;

  const handle = (sig: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(`[smoke-runner] ${sig} received again; shutdown already in flight`);
      return;
    }
    shuttingDown = true;
    log(`[smoke-runner] received ${sig}, shutting down gracefully…`);

    void (async () => {
      let exitCode = 0;
      try {
        if (opts.beforeExit) {
          try {
            await opts.beforeExit();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[smoke-runner] beforeExit failed: ${msg}`);
            exitCode = 1;
          }
        }

        if (opts.keepVms) {
          log(`[smoke-runner] --keep-vms set; leaving ${opts.drivers.length} VM(s) running`);
        } else {
          await stopAllDrivers(opts.drivers, {
            log,
            ...(opts.perDriverTimeoutMs !== undefined ? { perDriverTimeoutMs: opts.perDriverTimeoutMs } : {}),
          });
        }
      } finally {
        process.exit(exitCode);
      }
    })();
  };

  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const sig of signals) {
    const fn = (): void => handle(sig);
    process.on(sig, fn);
    listeners.set(sig, fn);
  }

  return function unregister(): void {
    for (const [sig, fn] of listeners) {
      process.off(sig, fn);
    }
    listeners.clear();
  };
}

/**
 * Promise + AbortTimer race. Rejects with a descriptive error on
 * timeout so the log line tells the operator which driver is stuck.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
