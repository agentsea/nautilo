import { describe, test, expect } from "bun:test";
import { Runner } from "../../src/runner";
import { makeMockDriver, makeMockClient, makeExpectations } from "./mock-driver";

/**
 * D063 Phase 2.11 integration test — honeypot-leak detection.
 *
 * Scenarios:
 *   1. Honeypot verify returns {ok:true} → outcome is the scanner's
 *      classification (pass/warn).
 *   2. Honeypot verify returns {ok:false,leaked:N} → outcome is FORCE
 *      fail regardless of scanner decision. The whole point of the
 *      honeypot is to catch leaks the scanner missed or didn't run.
 *   3. Honeypot verify script missing → test doesn't crash, records
 *      the error as a message but doesn't force-fail (can't
 *      distinguish "script missing" from "script ran cleanly" without
 *      structured output).
 *   4. The verify command is invoked only when spec.honeypotRequired
 *      is true.
 */

const CLEAN_VERIFY = '{"ok":true,"unchanged":7,"leaked":0,"missing":0}\n';
const LEAKED_VERIFY = '{"ok":false,"unchanged":6,"leaked":1,"missing":0}\nDetails:\nLEAKED ~/.ssh/id_rsa\n';
const MISSING_VERIFY = '{"ok":false,"unchanged":5,"leaked":0,"missing":2}\nDetails:\nMISSING ~/.gnupg/pubring.kbx\n';

describe("D063 Phase 2.11 — honeypot-leak detection", () => {
  test("scanner blocked + honeypot clean → pass", async () => {
    const driver = makeMockDriver({
      platform: "linux",
      execShell: async (cmd) => {
        if (cmd.includes("honeypot.sh") && cmd.includes("verify")) {
          return { stdout: CLEAN_VERIFY, stderr: "", exitCode: 0, durationMs: 50, timedOut: false };
        }
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10, timedOut: false };
      },
    });
    const client = makeMockClient({
      scanResults: [{ layer: "path", level: "standard", blocked: true, reason: "protected path" }],
    });
    const expectations = makeExpectations({
      "PATH-01": {
        platforms: ["linux"],
        layer: "path-deny",
        destructive_command: "~/.ssh/id_rsa",
        modes_supported: ["destructive"],
        expect_blocked: true,
        honeypot_required: true,
        security_levels: ["standard"],
      },
    });
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 100,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });
    const r = report.results[0]!;
    expect(r.outcome).toBe("pass");
    expect(r.honeypotVerifyAfter).toBeDefined();
    expect(r.honeypotVerifyAfter!.ok).toBe(true);
    expect(r.honeypotVerifyAfter!.leaked).toBe(0);
  });

  test("honeypot LEAKED → outcome forced to fail even if scanner 'blocked'", async () => {
    // Pathological scenario: scanner reports blocked: true BUT a leak
    // happened anyway (bug in scanner wiring, or race). Honeypot verify
    // catches it and the overall result is fail.
    const driver = makeMockDriver({
      platform: "linux",
      execShell: async (cmd) => {
        if (cmd.includes("honeypot.sh") && cmd.includes("verify")) {
          return { stdout: LEAKED_VERIFY, stderr: "LEAKED ~/.ssh/id_rsa\n", exitCode: 1, durationMs: 50, timedOut: false };
        }
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10, timedOut: false };
      },
    });
    const client = makeMockClient({
      scanResults: [{ layer: "path", level: "standard", blocked: true, reason: "should have been blocked but leak happened" }],
    });
    const expectations = makeExpectations({
      "PATH-SMUGGLED": {
        platforms: ["linux"],
        layer: "path-deny",
        destructive_command: "cat ~/.ssh/id_rsa",
        modes_supported: ["destructive"],
        expect_blocked: true,
        honeypot_required: true,
        security_levels: ["standard"],
      },
    });
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 100,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });
    const r = report.results[0]!;
    expect(r.outcome).toBe("fail");
    expect(r.honeypotVerifyAfter).toBeDefined();
    expect(r.honeypotVerifyAfter!.ok).toBe(false);
    expect(r.honeypotVerifyAfter!.leaked).toBe(1);
    // Message mentions honeypot.
    expect(r.messages.some((m) => m.includes("honeypot") && m.includes("leaked"))).toBe(true);
  });

  test("honeypot MISSING fixture → fail (distinct from leaked but same severity)", async () => {
    const driver = makeMockDriver({
      platform: "linux",
      execShell: async (cmd) => {
        if (cmd.includes("honeypot.sh") && cmd.includes("verify")) {
          return { stdout: MISSING_VERIFY, stderr: "MISSING ~/.gnupg/pubring.kbx\n", exitCode: 1, durationMs: 50, timedOut: false };
        }
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10, timedOut: false };
      },
    });
    const client = makeMockClient({
      scanResults: [{ layer: "path", level: "standard", blocked: true }],
    });
    const expectations = makeExpectations({
      "PATH-MISSING": {
        platforms: ["linux"],
        layer: "path-deny",
        destructive_command: "rm -rf ~/.gnupg",
        modes_supported: ["destructive"],
        expect_blocked: true,
        honeypot_required: true,
        security_levels: ["standard"],
      },
    });
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 100,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });
    const r = report.results[0]!;
    expect(r.outcome).toBe("fail");
    expect(r.honeypotVerifyAfter!.missing).toBe(2);
    expect(r.messages.some((m) => m.includes("honeypot") && m.includes("missing"))).toBe(true);
  });

  test("honeypot_required: false → verify is NOT invoked", async () => {
    let verifyCalled = false;
    const driver = makeMockDriver({
      platform: "linux",
      execShell: async (cmd) => {
        if (cmd.includes("honeypot.sh") && cmd.includes("verify")) verifyCalled = true;
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10, timedOut: false };
      },
    });
    const client = makeMockClient({
      scanResults: [{ layer: "command", level: "standard", blocked: true }],
    });
    const expectations = makeExpectations({
      "SCAN-01": {
        platforms: ["linux"],
        layer: "command-scanner",
        destructive_command: "rm -rf /",
        modes_supported: ["destructive"],
        expect_blocked: true,
        honeypot_required: false, // <-- no honeypot
        security_levels: ["standard"],
      },
    });
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 100,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });
    expect(verifyCalled).toBe(false);
    expect(report.results[0]!.honeypotVerifyAfter).toBeUndefined();
  });

  test("verify script crashes → test records message but doesn't cascade fail", async () => {
    // The script returns unstructured output (bug, missing script, etc.).
    // Runner logs a message and leaves `honeypotVerifyAfter` unset,
    // letting the scanner's classification stand.
    const driver = makeMockDriver({
      platform: "linux",
      execShell: async (cmd) => {
        if (cmd.includes("honeypot.sh") && cmd.includes("verify")) {
          return { stdout: "sh: honeypot.sh: not found", stderr: "command not found", exitCode: 127, durationMs: 10, timedOut: false };
        }
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10, timedOut: false };
      },
    });
    const client = makeMockClient({
      scanResults: [{ layer: "path", level: "standard", blocked: true }],
    });
    const expectations = makeExpectations({
      "PATH-SCRIPT-MISSING": {
        platforms: ["linux"],
        layer: "path-deny",
        destructive_command: "~/.ssh/id_rsa",
        modes_supported: ["destructive"],
        expect_blocked: true,
        honeypot_required: true,
        security_levels: ["standard"],
      },
    });
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      watchdogIntervalMs: 100,
    });

    const report = await runner.runMatrix({ platforms: ["linux"] });
    const r = report.results[0]!;
    // Scanner's classification stands — didn't cascade to error.
    expect(r.outcome).toBe("pass");
    expect(r.honeypotVerifyAfter).toBeUndefined();
    // But a diagnostic message surfaces.
    expect(r.messages.some((m) => m.includes("honeypot") && m.includes("failed to execute"))).toBe(true);
  });
});
