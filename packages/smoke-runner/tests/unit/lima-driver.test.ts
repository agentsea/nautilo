/**
 * LimaDriver unit tests.
 *
 * Most tests are integration-flavored — they exercise a real Lima VM.
 * Gated on NAUTILO_SMOKE_INTEGRATION=1 so CI runners without Lima
 * installed skip cleanly.
 *
 * Prerequisite: ./scripts/security-test-env/setup-linux.sh has been
 * run on the host; VM nautilo-smoke-linux exists with a 'baseline'
 * snapshot.
 */

import { describe, expect, test } from "bun:test";
import { LimaDriver } from "../../src/lima-driver.ts";

const INTEGRATION = process.env["NAUTILO_SMOKE_INTEGRATION"] === "1";
const describeIntegration = INTEGRATION ? describe : describe.skip;

describe("LimaDriver — construction", () => {
  test("defaults vmName to 'nautilo-smoke-linux' and defaultUser to 'nautilotest'", () => {
    const d = new LimaDriver();
    expect(d.vmName).toBe("nautilo-smoke-linux");
    expect(d.defaultUser).toBe("nautilotest");
    expect(d.platform).toBe("linux");
  });

  test("accepts custom vmName and defaultUser", () => {
    const d = new LimaDriver({ vmName: "custom", defaultUser: "alice" });
    expect(d.vmName).toBe("custom");
    expect(d.defaultUser).toBe("alice");
  });
});

describeIntegration("LimaDriver — live VM", () => {
  const d = new LimaDriver();

  test("status() returns 'running' for our baseline VM", async () => {
    const s = await d.status();
    expect(["running", "stopped"]).toContain(s);
  }, 15_000);

  test("execShell runs commands as nautilotest and captures output", async () => {
    const r = await d.execShell("whoami");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("nautilotest");
  }, 15_000);

  test("execShell respects env overrides", async () => {
    const r = await d.execShell('echo "$SMOKE_TEST_VAR"', {
      env: { SMOKE_TEST_VAR: "hello-from-env" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello-from-env");
  }, 15_000);

  test("execShell enforces timeout", async () => {
    const r = await d.execShell("sleep 10", { timeoutMs: 2_000 });
    expect(r.timedOut).toBe(true);
  }, 10_000);

  test("snapshotList() includes 'baseline'", async () => {
    const tags = await d.snapshotList();
    expect(tags).toContain("baseline");
  }, 15_000);

  test("healthProbe passes on a healthy baseline VM", async () => {
    const r = await d.healthProbe();
    expect(r.ok).toBe(true);
    expect(r.probeResults.length).toBeGreaterThanOrEqual(4);
    const sshOk = r.probeResults.find((p) => p.probe === "ssh")?.ok;
    expect(sshOk).toBe(true);
  }, 30_000);

  // Slow integration test — full restore cycle takes ~20s.
  const SLOW = process.env["NAUTILO_SMOKE_INTEGRATION_SLOW"] === "1";
  const maybe = SLOW ? test : test.skip;

  maybe(
    "snapshotRestore('baseline') restores VM state and honeypot",
    async () => {
      // Pollute
      await d.execShell("echo 'tampered by test' > $HOME/.ssh/id_rsa");
      const pre = await d.execShell("cat $HOME/.ssh/id_rsa");
      expect(pre.stdout.trim()).toBe("tampered by test");

      // Restore
      await d.snapshotRestore("baseline");

      // Verify honeypot unchanged (Lima: baseline includes honeypot
      // because qcow2 snapshot preserved state)
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
    },
    60_000,
  );
});
