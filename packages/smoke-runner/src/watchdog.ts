/**
 * HealthWatchdog — polls a VmDriver's healthProbe on an interval,
 * fires a one-shot `onDead` handler the first time any probe fails.
 *
 * Used by the Runner around each destructive test. If the VM dies
 * mid-command, the watchdog tells the runner to mark the test
 * `vm_dead` and trigger a snapshot restore.
 *
 * Stateful (start/stop lifecycle). Not thread-safe — owned by the
 * per-test code block that starts it.
 *
 * D063 Phase 2 task 2.5.
 */

import type { VmDriver, HealthProbeOptions } from "./driver.ts";
import type { WatchdogEvent, HealthProbeResult } from "./types.ts";

export interface HealthWatchdogOptions {
  /** Poll interval in ms. Default 3000. */
  readonly intervalMs?: number;
  /** Per-probe timeout in ms. Default 5000. */
  readonly probeTimeoutMs?: number;
  /** Passed to `driver.healthProbe(opts)`. */
  readonly probeOptions?: HealthProbeOptions;
}

export type WatchdogDeadHandler = (reason: string) => void;

export class HealthWatchdog {
  private readonly driver: VmDriver;
  private readonly intervalMs: number;
  private readonly probeOptions: HealthProbeOptions;

  private running = false;
  private deadHandlers: WatchdogDeadHandler[] = [];
  private events: WatchdogEvent[] = [];
  private declaredDead = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor(driver: VmDriver, opts: HealthWatchdogOptions = {}) {
    this.driver = driver;
    this.intervalMs = opts.intervalMs ?? 3_000;
    this.probeOptions = {
      ...(opts.probeOptions ?? {}),
      ...(opts.probeTimeoutMs !== undefined ? { timeoutMs: opts.probeTimeoutMs } : {}),
    };
  }

  /**
   * Register a handler for the first time a probe fails. Multiple
   * handlers allowed; all fire once on the first detected failure.
   */
  onDead(handler: WatchdogDeadHandler): void {
    this.deadHandlers.push(handler);
  }

  /** Retrieve the event log so far. Used by Runner to embed in TestResult. */
  getEvents(): readonly WatchdogEvent[] {
    return [...this.events];
  }

  /** True if any probe has reported failure since start(). */
  isDead(): boolean {
    return this.declaredDead;
  }

  /** Begin polling. Idempotent — second call is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.declaredDead = false;
    this.events = [];
    this.abortController = new AbortController();
    this.scheduleNext(0); // first probe immediately
  }

  /** Stop polling. Idempotent — safe to call after start() never ran. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    let result: HealthProbeResult;
    try {
      result = await this.driver.healthProbe(this.probeOptions);
    } catch (err) {
      result = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
        probeResults: [
          {
            probe: "ssh",
            ok: false,
            detail: "healthProbe threw",
          },
        ],
      };
    }

    if (!this.running) return; // stopped while we were awaiting

    // Record per-probe events
    for (const pr of result.probeResults) {
      this.events.push({
        at: result.checkedAt,
        probe: pr.probe,
        ok: pr.ok,
        ...(pr.detail !== undefined ? { detail: pr.detail } : {}),
      });
    }

    if (!result.ok && !this.declaredDead) {
      this.declaredDead = true;
      const reason = result.reason ?? "health probe failed";
      // Copy handlers so in-flight onDead calls can't re-enter
      const handlers = [...this.deadHandlers];
      for (const h of handlers) {
        try {
          h(reason);
        } catch {
          // handler errors must not take the watchdog down
        }
      }
      // Keep running? No — once dead, stop polling. The runner will
      // call stop() anyway but we avoid double-fire.
      this.stop();
      return;
    }

    this.scheduleNext(this.intervalMs);
  }
}
