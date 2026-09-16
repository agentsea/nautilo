import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  stopAllDrivers,
  registerShutdownHandlers,
  type NamedDriver,
} from "../../src/shutdown.ts";
import type { VmDriver, VmStatus } from "../../src/driver.ts";

function mockDriver(overrides: Partial<VmDriver> = {}): VmDriver {
  return {
    platform: "linux",
    vmName: "mock",
    async info() { return { tool: "lima", version: "0.0.0", vmName: "mock" }; },
    async status() { return "running" as VmStatus; },
    async start() { /* no-op */ },
    async stop() { /* no-op */ },
    async snapshotTake() { /* no-op */ },
    async snapshotRestore() { /* no-op */ },
    async snapshotList() { return []; },
    async execShell() { return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 }; },
    async healthProbe() { return { ok: true, checks: [] }; },
    ...overrides,
  } as VmDriver;
}

describe("stopAllDrivers", () => {
  it("calls stop() on each driver", async () => {
    const stopA = mock(() => Promise.resolve());
    const stopB = mock(() => Promise.resolve());
    const drivers: NamedDriver[] = [
      { name: "A", driver: mockDriver({ stop: stopA }) },
      { name: "B", driver: mockDriver({ stop: stopB }) },
    ];
    const logs: string[] = [];
    await stopAllDrivers(drivers, { log: (l) => logs.push(l) });
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    // Each driver generates 2 log lines (stopping… + stopped)
    expect(logs.filter((l) => l.includes("A stopped")).length).toBe(1);
    expect(logs.filter((l) => l.includes("B stopped")).length).toBe(1);
  });

  it("continues stopping other drivers if one fails", async () => {
    const stopA = mock(() => Promise.reject(new Error("boom")));
    const stopB = mock(() => Promise.resolve());
    const drivers: NamedDriver[] = [
      { name: "A", driver: mockDriver({ stop: stopA }) },
      { name: "B", driver: mockDriver({ stop: stopB }) },
    ];
    const logs: string[] = [];
    await stopAllDrivers(drivers, { log: (l) => logs.push(l) });
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("A stop failed: boom"))).toBe(true);
    expect(logs.some((l) => l.includes("B stopped"))).toBe(true);
  });

  it("times out slow drivers without hanging the whole stop", async () => {
    const stopSlow = mock(() => new Promise<void>(() => { /* never resolves */ }));
    const stopFast = mock(() => Promise.resolve());
    const drivers: NamedDriver[] = [
      { name: "slow", driver: mockDriver({ stop: stopSlow }) },
      { name: "fast", driver: mockDriver({ stop: stopFast }) },
    ];
    const logs: string[] = [];
    const start = Date.now();
    await stopAllDrivers(drivers, { log: (l) => logs.push(l), perDriverTimeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(logs.some((l) => l.includes("slow stop failed") && l.includes("timed out"))).toBe(true);
    expect(logs.some((l) => l.includes("fast stopped"))).toBe(true);
  });

  it("handles an empty driver list without error", async () => {
    const logs: string[] = [];
    await stopAllDrivers([], { log: (l) => logs.push(l) });
    expect(logs).toEqual([]);
  });
});

describe("registerShutdownHandlers", () => {
  // Save and restore process.exit so tests don't actually kill the runner.
  const realExit = process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    // Non-throwing stub: record the exit code and return. The async
    // shutdown IIFE completes normally; tests poll for the exit code.
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCode = code ?? 0;
    };
  });

  afterEach(() => {
    process.exit = realExit;
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  async function fireSignalAndWaitForExit(
    sig: NodeJS.Signals,
    maxWaitMs = 500,
  ): Promise<void> {
    process.emit(sig);
    const deadline = Date.now() + maxWaitMs;
    while (exitCode === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("runs beforeExit, stops drivers, and exits 0 on SIGINT", async () => {
    const stopA = mock(() => Promise.resolve());
    const beforeExit = mock(() => Promise.resolve());
    const drivers: NamedDriver[] = [{ name: "A", driver: mockDriver({ stop: stopA }) }];
    const logs: string[] = [];
    registerShutdownHandlers({
      drivers,
      log: (l) => logs.push(l),
      beforeExit,
      signals: ["SIGINT"],
    });
    await fireSignalAndWaitForExit("SIGINT");
    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it("skips driver stop when keepVms is true", async () => {
    const stopA = mock(() => Promise.resolve());
    const drivers: NamedDriver[] = [{ name: "A", driver: mockDriver({ stop: stopA }) }];
    const logs: string[] = [];
    registerShutdownHandlers({
      drivers,
      keepVms: true,
      log: (l) => logs.push(l),
      signals: ["SIGINT"],
    });
    await fireSignalAndWaitForExit("SIGINT");
    expect(stopA).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("--keep-vms set"))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("is idempotent against repeated signals", async () => {
    const stopA = mock(() => new Promise<void>((r) => setTimeout(r, 40)));
    const drivers: NamedDriver[] = [{ name: "A", driver: mockDriver({ stop: stopA }) }];
    const logs: string[] = [];
    registerShutdownHandlers({
      drivers,
      log: (l) => logs.push(l),
      signals: ["SIGINT"],
    });
    // Three rapid SIGINTs — only the first triggers real work.
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGINT");
    const deadline = Date.now() + 500;
    while (exitCode === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(logs.filter((l) => l.includes("shutdown already in flight")).length).toBeGreaterThanOrEqual(1);
  });

  it("exits with code 1 when beforeExit throws", async () => {
    const stopA = mock(() => Promise.resolve());
    const beforeExit = mock(() => Promise.reject(new Error("close-failed")));
    const drivers: NamedDriver[] = [{ name: "A", driver: mockDriver({ stop: stopA }) }];
    const logs: string[] = [];
    registerShutdownHandlers({
      drivers,
      beforeExit,
      log: (l) => logs.push(l),
      signals: ["SIGINT"],
    });
    await fireSignalAndWaitForExit("SIGINT");
    expect(beforeExit).toHaveBeenCalledTimes(1);
    // Driver stop still runs even when beforeExit fails — don't leak VMs.
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("beforeExit failed: close-failed"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  it("unregister removes the signal listeners", () => {
    const drivers: NamedDriver[] = [];
    const before = process.listenerCount("SIGINT");
    const unregister = registerShutdownHandlers({
      drivers,
      signals: ["SIGINT"],
    });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    unregister();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
