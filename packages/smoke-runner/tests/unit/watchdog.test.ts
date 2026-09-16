import { describe, expect, test } from "bun:test";
import { HealthWatchdog } from "../../src/watchdog.ts";
import type { VmDriver, VmStatus, HealthProbeOptions } from "../../src/driver.ts";
import type {
  Platform,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
} from "../../src/types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock driver that returns scripted healthProbe results in order.
 * Exhaustive scripts loop back to the final result.
 */
class MockDriver implements VmDriver {
  readonly platform: Platform = "linux";
  readonly vmName = "mock-vm";
  private calls = 0;

  constructor(private readonly script: HealthProbeResult[]) {}

  get healthProbeCallCount(): number {
    return this.calls;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async status(): Promise<VmStatus> { return "running"; }
  async snapshotTake(_name: string): Promise<void> {}
  async snapshotRestore(_name: string): Promise<void> {}
  async snapshotList(): Promise<readonly string[]> { return []; }
  async execShell(_cmd: string, _opts?: ExecOptions): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false };
  }
  async healthProbe(_opts?: HealthProbeOptions): Promise<HealthProbeResult> {
    const idx = Math.min(this.calls, this.script.length - 1);
    this.calls++;
    return this.script[idx]!;
  }
}

const ok = (): HealthProbeResult => ({
  ok: true,
  checkedAt: new Date().toISOString(),
  probeResults: [
    { probe: "ssh", ok: true },
    { probe: "canary-files", ok: true },
  ],
});

const dead = (reason: string): HealthProbeResult => ({
  ok: false,
  reason,
  checkedAt: new Date().toISOString(),
  probeResults: [
    { probe: "ssh", ok: false, detail: reason },
  ],
});

describe("HealthWatchdog", () => {
  test("does not fire onDead while probes pass", async () => {
    const driver = new MockDriver([ok(), ok(), ok()]);
    const w = new HealthWatchdog(driver, { intervalMs: 20 });

    let fired = 0;
    w.onDead(() => { fired++; });

    w.start();
    await sleep(80);
    w.stop();

    expect(fired).toBe(0);
    expect(driver.healthProbeCallCount).toBeGreaterThanOrEqual(2);
    expect(w.isDead()).toBe(false);
  });

  test("fires onDead on the first failing probe", async () => {
    const driver = new MockDriver([ok(), ok(), dead("ssh timeout")]);
    const w = new HealthWatchdog(driver, { intervalMs: 20 });

    let fired = 0;
    let lastReason = "";
    w.onDead((reason) => { fired++; lastReason = reason; });

    w.start();
    await sleep(120);
    w.stop();

    expect(fired).toBe(1);
    expect(lastReason).toBe("ssh timeout");
    expect(w.isDead()).toBe(true);
  });

  test("fires every registered handler once", async () => {
    const driver = new MockDriver([dead("kaboom")]);
    const w = new HealthWatchdog(driver, { intervalMs: 10 });

    let a = 0, b = 0, c = 0;
    w.onDead(() => { a++; });
    w.onDead(() => { b++; });
    w.onDead(() => { c++; });

    w.start();
    await sleep(50);
    w.stop();

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  test("handler errors are swallowed", async () => {
    const driver = new MockDriver([dead("boom")]);
    const w = new HealthWatchdog(driver, { intervalMs: 10 });

    let secondFired = 0;
    w.onDead(() => { throw new Error("handler threw"); });
    w.onDead(() => { secondFired++; });

    w.start();
    await sleep(50);
    w.stop();

    expect(secondFired).toBe(1);
  });

  test("does not double-fire after declaring dead", async () => {
    const driver = new MockDriver([dead("x"), dead("y"), dead("z")]);
    const w = new HealthWatchdog(driver, { intervalMs: 10 });

    let fired = 0;
    w.onDead(() => { fired++; });

    w.start();
    await sleep(80);
    w.stop();

    expect(fired).toBe(1);
  });

  test("stop() before first tick cancels cleanly", async () => {
    const driver = new MockDriver([dead("ok")]);
    const w = new HealthWatchdog(driver, { intervalMs: 100 });

    w.start();
    w.stop(); // immediate stop before the 0ms-delayed first tick runs
    await sleep(200);

    // No probe should have been taken (0ms scheduleNext but stop()
    // clears the timer before the microtask runs). Even if it did,
    // the result is dropped.
    expect(w.isDead()).toBe(false);
  });

  test("records per-probe events in getEvents()", async () => {
    const driver = new MockDriver([ok(), dead("slow disk")]);
    const w = new HealthWatchdog(driver, { intervalMs: 15 });

    w.start();
    await sleep(80);
    w.stop();

    const events = w.getEvents();
    // First tick: 2 ok events. Second tick: 1 failing event.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.probe === "ssh" && !e.ok)).toBe(true);
  });

  test("healthProbe throw is treated as dead", async () => {
    class ThrowingDriver extends MockDriver {
      override async healthProbe(): Promise<HealthProbeResult> {
        throw new Error("kernel panic");
      }
    }
    const driver = new ThrowingDriver([ok()]);
    const w = new HealthWatchdog(driver, { intervalMs: 10 });

    let reason = "";
    w.onDead((r) => { reason = r; });

    w.start();
    await sleep(50);
    w.stop();

    expect(reason).toBe("kernel panic");
  });

  test("start is idempotent", async () => {
    const driver = new MockDriver([ok(), ok()]);
    const w = new HealthWatchdog(driver, { intervalMs: 30 });

    w.start();
    w.start(); // second call should be a no-op
    await sleep(80);
    w.stop();

    // Single-threaded polling — two start()s would double the rate if broken
    expect(driver.healthProbeCallCount).toBeLessThan(5);
  });
});
