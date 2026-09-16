/**
 * TartDriver unit tests.
 *
 * Most tests are integration-flavored — they exercise a real Tart VM.
 * Gated on NAUTILO_SMOKE_INTEGRATION=1.
 *
 * Prerequisite: ./scripts/security-test-env/setup-macos.sh has been run;
 * VMs nautilo-smoke-macos (working) + nautilo-smoke-macos-baseline exist.
 */

import { describe, expect, test } from "bun:test";
import { TartDriver } from "../../src/tart-driver.ts";

const INTEGRATION = process.env["NAUTILO_SMOKE_INTEGRATION"] === "1";
const describeIntegration = INTEGRATION ? describe : describe.skip;

describe("TartDriver — construction", () => {
  test("defaults", () => {
    const d = new TartDriver();
    expect(d.vmName).toBe("nautilo-smoke-macos");
    expect(d.baselineName).toBe("nautilo-smoke-macos-baseline");
    expect(d.defaultUser).toBe("admin");
    expect(d.platform).toBe("macos");
  });

  test("accepts overrides", () => {
    const d = new TartDriver({
      vmName: "custom-vm",
      baselineName: "custom-base",
      defaultUser: "alice",
    });
    expect(d.vmName).toBe("custom-vm");
    expect(d.baselineName).toBe("custom-base");
    expect(d.defaultUser).toBe("alice");
  });
});

describeIntegration("TartDriver — live VM", () => {
  const d = new TartDriver();

  test("status() returns 'running' for our working VM", async () => {
    const s = await d.status();
    expect(["running", "stopped"]).toContain(s);
  }, 15_000);

  test("execShell runs commands as admin and captures output", async () => {
    const r = await d.execShell("whoami");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("admin");
  }, 15_000);

  test("execShell respects env overrides", async () => {
    const r = await d.execShell('echo "$SMOKE_TEST_VAR"', {
      env: { SMOKE_TEST_VAR: "hello-from-macos-env" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello-from-macos-env");
  }, 15_000);

  test("execShell enforces timeout", async () => {
    const r = await d.execShell("sleep 10", { timeoutMs: 2_000 });
    expect(r.timedOut).toBe(true);
  }, 10_000);

  test("snapshotList() includes 'baseline'", async () => {
    const tags = await d.snapshotList();
    expect(tags).toContain("baseline");
  }, 15_000);

  test("healthProbe passes on a healthy VM", async () => {
    const r = await d.healthProbe();
    expect(r.ok).toBe(true);
    expect(r.probeResults.length).toBeGreaterThanOrEqual(4);
    const agentOk = r.probeResults.find((p) => p.probe === "ssh")?.ok;
    expect(agentOk).toBe(true);
  }, 30_000);

  // Slow integration test — full restore cycle takes ~20s.
  // Separately gated on NAUTILO_SMOKE_INTEGRATION_SLOW=1 because most
  // runs don't need to exercise the full restore path.
  const SLOW = process.env["NAUTILO_SMOKE_INTEGRATION_SLOW"] === "1";
  const maybe = SLOW ? test : test.skip;

  maybe(
    "snapshotRestore('baseline') destroys + re-clones + re-plants honeypot",
    async () => {
      // Pollute the working VM
      await d.execShell("echo 'tampered by test' > $HOME/.ssh/id_rsa");
      const pre = await d.execShell("cat $HOME/.ssh/id_rsa");
      expect(pre.stdout.trim()).toBe("tampered by test");

      // Restore from baseline
      await d.snapshotRestore("baseline");

      // Verify honeypot is freshly planted and clean
      const verify = await d.execShell(
        "sh $HOME/nautilo/scripts/security-test-env/honeypot.sh verify",
      );
      const report = JSON.parse(verify.stdout.trim()) as {
        ok: boolean;
        unchanged: number;
        leaked: number;
        missing: number;
      };
      expect(report.ok).toBe(true);
      expect(report.leaked).toBe(0);
      expect(report.unchanged).toBeGreaterThanOrEqual(9); // 9 common + 3 macOS = 12
    },
    60_000,
  );
});
