import { describe, test, expect } from "bun:test";
import { Runner } from "../../src/runner";
import { makeMockDriver, makeMockClient, makeExpectations } from "./mock-driver";
import type { HealthProbeResult } from "../../src/types";

/**
 * D063 Phase 2.11 integration test — watchdog detects VM death mid-test.
 *
 * Scenario: the test's security scan takes longer than the watchdog
 * tick interval. Midway through, the VM's healthProbe starts failing
 * (e.g. kernel panic, SSH daemon died, disk full). The Runner must:
 *   - detect the watchdog firing,
 *   - classify the outcome as `vm_dead` (not `fail`, not `error`),
 *   - embed the probe failure in `watchdogEvents`,
 *   - surface a message pointing at the failed probe.
 */

const PROBE_OK: HealthProbeResult = {
  ok: true,
  checkedAt: new Date().toISOString(),
  probeResults: [
    { probe: "ssh", ok: true },
    { probe: "canary-files", ok: true },
  ],
};

const PROBE_DEAD: HealthProbeResult = {
  ok: false,
  reason: "canary-files: /etc/hostname unreadable",
  checkedAt: new Date().toISOString(),
  probeResults: [
    { probe: "ssh", ok: true },
    { probe: "canary-files", ok: false, detail: "/etc/hostname unreadable (EIO)" },
  ],
};

describe("D063 Phase 2.11 — watchdog VM-dead detection", () => {
  test("VM dying mid-scan → outcome 'vm_dead' + watchdog reason surfaced", async () => {
    const driver = makeMockDriver({
      platform: "linux",
      // First probe OK, subsequent ones fail. The watchdog polls
      // every ~50ms (we pass a fast interval) so several ticks happen
      // during the ~300ms scan window.
      healthProbeSequence: [PROBE_OK, PROBE_OK, PROBE_DEAD, PROBE_DEAD, PROBE_DEAD],
    });

    const client = makeMockClient({
      scanResults: [{ layer: "command", level: "standard", blocked: true, reason: "scanner ran OK but VM died meanwhile" }],
      // Delay the scan so the watchdog has time to tick at least 3x.
      scanDelayMs: 300,
    });

    const expectations = makeExpectations({
      "DEAD-01": {
        platforms: ["linux"],
        layer: "command-scanner",
        destructive_command: "rm -rf /some/path",
        modes_supported: ["destructive"],
        expect_blocked: true,
        security_levels: ["standard"],
      },
    });

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 50,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });

    expect(report.results).toHaveLength(1);
    const r = report.results[0]!;
    expect(r.outcome).toBe("vm_dead");
    // Reason includes the failed probe name.
    const msg = r.messages.join(" ");
    expect(msg).toContain("watchdog");
    expect(msg).toContain("canary-files");
    // Watchdog events array includes at least one !ok event.
    const failedEvents = r.watchdogEvents.filter((e) => !e.ok);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents[0]!.probe).toBe("canary-files");
  });

  test("VM healthy throughout → outcome matches scanner (not vm_dead)", async () => {
    const driver = makeMockDriver({
      platform: "linux",
      healthProbeResult: PROBE_OK,
    });

    const client = makeMockClient({
      scanResults: [{ layer: "command", level: "standard", blocked: true, reason: "rm -rf" }],
    });

    const expectations = makeExpectations({
      "HEALTHY-01": {
        platforms: ["linux"],
        layer: "command-scanner",
        destructive_command: "rm -rf /tmp/foo",
        modes_supported: ["destructive"],
        expect_blocked: true,
        security_levels: ["standard"],
      },
    });

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 50,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });

    expect(report.results[0]!.outcome).toBe("pass");
    // No failed watchdog events.
    expect(report.results[0]!.watchdogEvents.filter((e) => !e.ok)).toHaveLength(0);
  });

  test("snapshot restore happens before each test (clean-state invariant)", async () => {
    const driver = makeMockDriver({
      platform: "linux",
      healthProbeResult: PROBE_OK,
    });
    const client = makeMockClient({
      scanResults: [{ layer: "command", level: "standard", blocked: true }],
    });

    const expectations = makeExpectations({
      "A": { platforms: ["linux"], layer: "command-scanner", destructive_command: "cmd-a", modes_supported: ["destructive"], expect_blocked: true, security_levels: ["standard"] },
      "B": { platforms: ["linux"], layer: "command-scanner", destructive_command: "cmd-b", modes_supported: ["destructive"], expect_blocked: true, security_levels: ["standard"] },
    });

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 50,
    });
    await runner.runMatrix({ platforms: ["linux"] });

    // Two tests ran → two snapshot restores.
    expect(driver.snapshotRestoreCalls).toHaveLength(2);
    expect(driver.snapshotRestoreCalls.every((n) => n === "baseline")).toBe(true);
  });
});
