/**
 * Unit tests for the service-start closure built by
 * `buildPlatformEntry()`. D060 Phase 2 task 2.0.9.
 *
 * Phase 2 added macOS branching to `startInVmTestService` — Linux
 * uses `systemctl start nautilo-test.service`, macOS uses
 * `launchctl load -w /Library/LaunchDaemons/com.nautilo.test-server.plist`.
 * These tests assert the right command goes to the right driver
 * without needing a real VM.
 *
 * The function is internal; we reach it via the closure that
 * `buildPlatformEntry` returns in `beforeToolInvocation`. That closure
 * is what the smoke Runner actually invokes, so this test covers
 * the real consumer path.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformEntry } from "../../src/lib/factory";
import type {
  VmDriver,
  VmStatus,
  HealthProbeOptions,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
  Platform,
} from "@nautilo/smoke-runner";

// ---------------------------------------------------------------------------
// Mock driver — records every execShell call
// ---------------------------------------------------------------------------

class ShellRecorder implements VmDriver {
  readonly platform: Platform;
  readonly vmName: string;
  readonly calls: Array<{ cmd: string; opts: ExecOptions | undefined }> = [];
  /**
   * When a command matches a key in this map, return the mapped
   * result. Otherwise default to exit 0, empty stdout/stderr.
   */
  public responses: Map<RegExp, ExecResult> = new Map();

  constructor(platform: Platform, vmName: string) {
    this.platform = platform;
    this.vmName = vmName;
  }

  async execShell(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    for (const [pattern, result] of this.responses.entries()) {
      if (pattern.test(cmd)) return result;
    }
    return { exitCode: 0, stdout: cmd.includes("launchctl kickstart") ? "12345\n" : "", stderr: "", durationMs: 1, timedOut: false };
  }

  // Unused members — present to satisfy the VmDriver interface.
  async status(): Promise<VmStatus> {
    return "running";
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async snapshotTake(_name: string): Promise<void> {}
  async snapshotRestore(_name: string): Promise<void> {}
  async snapshotList(): Promise<readonly string[]> {
    return [];
  }
  async healthProbe(_opts?: HealthProbeOptions): Promise<HealthProbeResult> {
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      probeResults: [],
    };
  }
}

// Test against the real factory-exported startInVmTestService. The
// ShellRecorder's default exit=0 for unknown commands lets the
// health-gate (curl /api/test/ping + journalctl-grep) satisfy on
// the first iteration — no hang, no duplication of the dispatch
// shape across test + production code.
import { startInVmTestService } from "../../src/lib/factory";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startInVmTestService — platform dispatch", () => {
  test("Linux driver invokes systemctl start (server) + systemctl start (relay) + health-gate + registration-gate", async () => {
    const rec = new ShellRecorder("linux", "nautilo-smoke-linux");
    await startInVmTestService(rec);
    // D060 Sprint 2 G2: Linux path now starts BOTH services.
    // Expected call sequence:
    //   1. `systemctl start nautilo-test.service` (server)
    //   2. `curl .../api/test/ping` (server health-gate; satisfies
    //      on first iteration because ShellRecorder default exit=0)
    //   3. `systemctl start nautilo-relay.service` (relay, G2)
    //   4. `journalctl -u nautilo-relay ... grep 'Connected as '`
    //      (relay registration gate; same first-iteration success)
    expect(rec.calls.length).toBeGreaterThanOrEqual(4);
    expect(rec.calls[0]?.cmd).toContain("systemctl start nautilo-test.service");
    expect(rec.calls[0]?.cmd).not.toContain("launchctl");
    expect(rec.calls[1]?.cmd).toContain("/api/test/ping");
    expect(rec.calls[2]?.cmd).toContain("systemctl start nautilo-relay.service");
    expect(rec.calls[3]?.cmd).toContain("nautilo-relay");
    expect(rec.calls[3]?.cmd).toContain("Connected as");
  });

  test("macOS keeps the server daemon and restarts Relay in the user GUI session", async () => {
    const rec = new ShellRecorder("macos", "nautilo-smoke-macos");
    await startInVmTestService(rec);
    // D060 Sprint 2 G2 Wednesday: macOS path now starts BOTH the
    // server LaunchDaemon AND the relay LaunchAgent. Expected
    // sequence: server-load → server health-gate → relay-load →
    // relay registration-gate.
    expect(rec.calls.length).toBeGreaterThanOrEqual(4);

    const serverCmd = rec.calls[0]?.cmd ?? "";
    // Order matters: unload must precede load so re-running on an
    // already-loaded daemon is idempotent (bare `launchctl load`
    // exits non-zero with "already loaded").
    expect(serverCmd.indexOf("launchctl unload")).toBeGreaterThan(-1);
    expect(serverCmd.indexOf("launchctl load -w")).toBeGreaterThan(
      serverCmd.indexOf("launchctl unload"),
    );
    expect(serverCmd).toContain("com.nautilo.test-server.plist");
    expect(serverCmd).not.toContain("systemctl");

    expect(rec.calls[1]?.cmd).toContain("/api/test/ping"); // server health-gate

    const relayCmd = rec.calls[2]?.cmd ?? "";
    expect(relayCmd).toContain("com.nautilo.relay.plist");
    expect(relayCmd).toContain("launchctl bootstrap");
    expect(relayCmd).toContain("launchctl kickstart -kp");
    expect(relayCmd).not.toContain("launchctl bootout");
    expect(relayCmd).toContain("gui/$relay_uid");
    expect(relayCmd).toContain("$HOME/Library/LaunchAgents/");
    expect(relayCmd).not.toContain("sudo");
    expect(relayCmd).not.toContain("LaunchDaemons");
    expect(relayCmd).not.toContain("systemctl");

    // Relay registration-gate uses the log-file tail (no
    // unit-scoped journal on macOS). No sudo needed — setup-macos.sh
    // chowns the log file admin:staff and the LaunchAgent runs as
    // admin so launchd appends without changing ownership.
    expect(rec.calls[3]?.cmd).toContain("/var/log/nautilo-relay.log");
    expect(rec.calls[3]?.cmd).toContain("/var/log/nautilo-relay.err");
    expect(rec.calls[3]?.cmd).toContain("Connected as");
    expect(rec.calls[3]?.cmd).not.toContain("sudo");
  });

  test("macOS restart closure preserves server and Relay lifecycle separation", async () => {
    // The runner restores stopped services before invoking this closure.
    // Server and Relay retain their separate launchd domains.
    const rec = new ShellRecorder("macos", "vm");
    await startInVmTestService(rec);
    expect(rec.calls.length).toBeGreaterThanOrEqual(4);
    expect(rec.calls[0]?.cmd).toContain("launchctl load");
    expect(rec.calls[2]?.cmd).toContain("launchctl bootstrap");
  });

  test("macOS G2 relay-start failure surfaces as a descriptive error (distinct from server)", async () => {
    const rec = new ShellRecorder("macos", "vm");
    rec.responses.set(/com\.nautilo\.relay\.plist/, {
      exitCode: 5,
      stdout: "",
      stderr: "Load failed: 5: Input/output error",
      durationMs: 1,
      timedOut: false,
    });
    let thrown: unknown;
    try {
      await startInVmTestService(rec);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /relay-start for 'com\.nautilo\.relay' exited 5 on macos.*Load failed/,
    );
  });

  test("Linux G2 relay-start failure surfaces as a descriptive error", async () => {
    const rec = new ShellRecorder("linux", "vm");
    // Server start + health-gate pass (default exit=0). Relay start
    // fails — we want the error to clearly identify the relay, not
    // be mistaken for a server issue.
    rec.responses.set(/systemctl start nautilo-relay/, {
      exitCode: 5,
      stdout: "",
      stderr: "Unit nautilo-relay.service not found.",
      durationMs: 1,
      timedOut: false,
    });
    let thrown: unknown;
    try {
      await startInVmTestService(rec);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /relay-start for 'nautilo-relay\.service' exited 5.*Unit nautilo-relay\.service not found/,
    );
  });

  test("macOS refuses empty, malformed, zero or unsafe kickstart PIDs before probing readiness", async () => {
    for (const stdout of ["", "0", "-1", "123x", "123\n456", "9007199254740992"]) {
      const recorder = new ShellRecorder("macos", "owned-fixture");
      recorder.responses.set(/launchctl kickstart/, { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false });
      let failure: unknown;
      try { await startInVmTestService(recorder); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("valid process PID");
      expect(recorder.calls).toHaveLength(3);
    }
  });

  test("non-zero exit surfaces as a descriptive error (Linux)", async () => {
    const rec = new ShellRecorder("linux", "vm");
    rec.responses.set(/systemctl/, {
      exitCode: 1,
      stdout: "",
      stderr: "Failed to load environment files",
      durationMs: 1,
      timedOut: false,
    });
    let thrown: unknown;
    try {
      await startInVmTestService(rec);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /service-start for 'nautilo-test\.service' exited 1 on linux.*Failed to load environment files/,
    );
  });

  test("non-zero exit surfaces as a descriptive error (macOS)", async () => {
    const rec = new ShellRecorder("macos", "vm");
    rec.responses.set(/launchctl/, {
      exitCode: 1,
      stdout: "",
      stderr: "Load failed: 5: Input/output error",
      durationMs: 1,
      timedOut: false,
    });
    let thrown: unknown;
    try {
      await startInVmTestService(rec);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /service-start for 'com\.nautilo\.test-server' exited 1 on macos.*Load failed/,
    );
  });
});

describe("macOS Relay restart shell lifecycle", () => {
  let root: string;
  let command: string;
  let probe: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "smoke-launchagent-"));
    const recorder = new ShellRecorder("macos", "owned-fixture");
    await startInVmTestService(recorder);
    // Only filesystem destinations are mapped into this fixture. The emitted
    // shell control flow executes unchanged against fake id/launchctl binaries.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    command = recorder.calls[2]!.cmd;
    probe = recorder.calls[3]!.cmd
      .replaceAll("/var/log/nautilo-relay.log", quote(join(root, "relay.log")))
      .replaceAll("/var/log/nautilo-relay.err", quote(join(root, "relay.err")));
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "Library/LaunchAgents"), { recursive: true });
    await writeFile(join(root, "Library/LaunchAgents/com.nautilo.relay.plist"), "fixture");
    await writeFile(join(root, "bin/id"), '#!/bin/bash\nif [ "$1" = -un ]; then printf admin; else printf 501; fi\n', { mode: 0o700 });
    await writeFile(join(root, "bin/launchctl"), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$SMOKE_LAUNCH_FIXTURE/trace"
case "$1" in
  print)
    if [ "$2" = gui/501 ]; then test "\${SMOKE_GUI_PRESENT:-1}" = 1
    else
      test "$2" = gui/501/com.nautilo.relay
      test -f "$SMOKE_LAUNCH_FIXTURE/loaded"
      printf '  path = %s\\n  program = %s\\n' "\${SMOKE_JOB_PATH:-$HOME/Library/LaunchAgents/com.nautilo.relay.plist}" "\${SMOKE_JOB_PROGRAM:-/etc/nautilo/start-smoke-relay.sh}"
    fi ;;
  kickstart)
    test "$2" = -kp
    test "$3" = gui/501/com.nautilo.relay
    test -f "$SMOKE_LAUNCH_FIXTURE/loaded"
    test "\${SMOKE_KICKSTART_OK:-1}" = 1
    printf '12345\\n' ;;
  bootstrap)
    test "$2" = gui/501
    test "$3" = "$HOME/Library/LaunchAgents/com.nautilo.relay.plist"
    if [ "\${SMOKE_AUTOLOAD_RACE:-0}" = 1 ]; then touch "$SMOKE_LAUNCH_FIXTURE/loaded"; exit 5; fi
    test "\${SMOKE_BOOTSTRAP_OK:-1}" = 1
    test ! -e "$SMOKE_LAUNCH_FIXTURE/loaded"
    touch "$SMOKE_LAUNCH_FIXTURE/loaded" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function run(overrides: Record<string, string> = {}) {
    return spawnSync("/bin/bash", ["-c", command], {
      env: { ...process.env, HOME: root, PATH: `${join(root, "bin")}:/usr/bin:/bin`, SMOKE_LAUNCH_FIXTURE: root, ...overrides },
      encoding: "utf8",
    });
  }

  test("first boot loads once and repeated starts kickstart the exact existing service", async () => {
    expect(run().status).toBe(0);
    await writeFile(join(root, "relay.log"), "Connected as stale-relay\n");
    expect(run().status).toBe(0);
    expect(await readFile(join(root, "relay.log"), "utf8")).toBe("Connected as stale-relay\n");
    const trace = (await readFile(join(root, "trace"), "utf8")).split("\n").filter(Boolean);
    expect(trace.filter((line) => line.startsWith("bootout "))).toEqual([]);
    expect(trace.filter((line) => line.startsWith("bootstrap "))).toHaveLength(1);
    expect(trace.filter((line) => line.startsWith("kickstart "))).toEqual([
      "kickstart -kp gui/501/com.nautilo.relay", "kickstart -kp gui/501/com.nautilo.relay",
    ]);
  });

  test("missing GUI session fails before bootstrap", async () => {
    expect(run({ SMOKE_GUI_PRESENT: "0" }).status).not.toBe(0);
    expect(await readFile(join(root, "trace"), "utf8")).toBe("print gui/501\n");
  });

  test("kickstart failure cannot reload the definition or erase its logs", async () => {
    expect(run().status).toBe(0);
    await writeFile(join(root, "trace"), "");
    await writeFile(join(root, "relay.log"), "preserved diagnostic");
    expect(run({ SMOKE_KICKSTART_OK: "0" }).status).not.toBe(0);
    expect(await readFile(join(root, "trace"), "utf8")).not.toContain("bootstrap ");
    expect(await readFile(join(root, "relay.log"), "utf8")).toBe("preserved diagnostic");
  });

  test("bootstrap failure propagates instead of claiming the Relay started", () => {
    expect(run({ SMOKE_BOOTSTRAP_OK: "0" }).status).not.toBe(0);
  });

  test("concurrent login bootstrap reconciles only the expected job identity", async () => {
    const result = run({ SMOKE_AUTOLOAD_RACE: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("12345\n");
    const trace = await readFile(join(root, "trace"), "utf8");
    expect(trace.match(/^bootstrap /gm)).toHaveLength(1);
    expect(trace.match(/^kickstart /gm)).toHaveLength(1);
  });

  test("a racing job with a different plist or program fails with the original bootstrap error", async () => {
    for (const mismatch of [{ SMOKE_JOB_PATH: "/wrong.plist" }, { SMOKE_JOB_PROGRAM: "/wrong-program" }]) {
      await rm(join(root, "loaded"), { force: true });
      await writeFile(join(root, "trace"), "");
      expect(run({ SMOKE_AUTOLOAD_RACE: "1", ...mismatch }).status).toBe(5);
      expect(await readFile(join(root, "trace"), "utf8")).not.toContain("kickstart ");
    }
  });

  test("readiness rejects stale or partial PID markers and requires this process to connect", async () => {
    const runProbe = () => spawnSync("/bin/bash", ["-c", probe], { encoding: "utf8" }).status;
    await writeFile(join(root, "relay.err"), "");
    for (const text of ["Connected as stale\n", "smoke-relay-pid=123456\nConnected as stale\n", "smoke-relay-pid=12345\n"]) {
      await writeFile(join(root, "relay.log"), text);
      expect(runProbe()).not.toBe(0);
    }
    await writeFile(join(root, "relay.log"), "smoke-relay-pid=12345\nConnected as fresh\n");
    expect(runProbe()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlatformEntry — returns beforeToolInvocation only when token present
// ---------------------------------------------------------------------------

describe("buildPlatformEntry — token gating", () => {
  // These tests construct a real LimaDriver / TartDriver. The driver
  // constructors themselves don't start a VM, so we just assert the
  // factory shape; the VM-start path only happens when the returned
  // closure is actually CALLED, which integration tests cover.
  //
  // A more complete test requires exporting the token-read + closure-
  // build into a seam, deferred to a follow-up. For now, smoke-test
  // that the factory's shape is what the Runner expects.

  let originalEnv: typeof process.env;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns an entry with driver + client on both platforms", async () => {
    for (const platform of ["linux", "macos"] as const) {
      const entry = buildPlatformEntry(platform);
      expect(entry.driver).toBeDefined();
      expect(entry.client).toBeDefined();
      // D103 Phase F: stopped-but-provisioned VMs still need
      // tool-invocation support. The token is read lazily after
      // beforeToolInvocation starts the service, not while building
      // the entry.
      expect(entry.toolInvocationClient).toBeDefined();
      expect(entry.beforeToolInvocation).toBeDefined();
    }
  }, 60_000);
});
