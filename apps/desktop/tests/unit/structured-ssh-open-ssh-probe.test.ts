import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { runOpenSshConfigProbe, OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, SYSTEM_SANDBOX_EXEC_PATH, type OpenSshConfigProbeChild } from "../../electron/structured-ssh/open-ssh-probe.ts";
import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";
import type { OpenSshPlanRunnerInput } from "../../electron/structured-ssh/open-ssh-plan.ts";

function fakeChild(pid = 41) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const child: OpenSshConfigProbeChild = {
    pid,
    stdin,
    stdout,
    stderr,
    kill(signal) { kills.push(signal); return true; },
    once: events.once.bind(events) as OpenSshConfigProbeChild["once"],
  };
  return { child, stdin, stdout, stderr, kills, close: (code: number | null = 0, signal: NodeJS.Signals | null = null) => events.emit("close", code, signal), fail: () => events.emit("error", new Error("sandbox unavailable")) };
}

function input(signal?: AbortSignal): OpenSshPlanRunnerInput {
  return {
    executable: SYSTEM_OPENSSH_PATHS.ssh,
    argv: ["-G", "-l", "writer", "-p", "2222", "--", "alpha.example.test"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    timeoutMs: 5_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("OpenSSH configuration observation probe", () => {
  test("uses only the fixed Seatbelt and ssh argv, with no shell and Match-exec denial", async () => {
    const fake = fakeChild();
    let captured: unknown;
    const result = runOpenSshConfigProbe(input(), {
      sandboxAvailable: () => true,
      spawn(file, argv, options) { captured = { file, argv, options }; return fake.child; },
    });
    fake.close(0);
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "exited", code: 0 });
    expect(captured).toEqual({
      file: SYSTEM_SANDBOX_EXEC_PATH,
      argv: ["-p", OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.ssh, "-G", "-l", "writer", "-p", "2222", "--", "alpha.example.test"],
      options: { shell: false, stdio: ["pipe", "pipe", "pipe"], detached: process.platform === "darwin", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } },
    });
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).toContain("(deny process-exec)");
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).toContain("(deny network*)");
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).toContain("(deny file-write*)");
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).toContain('(allow file-write* (literal "/dev/null"))');
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).toContain('(allow process-exec (literal "/usr/bin/ssh"))');
    expect(OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE).not.toContain("/bin/sh");
  });

  test("fails closed before spawn when Seatbelt is unavailable or the resolver input is not its fixed grammar", async () => {
    let spawned = false;
    await expect(runOpenSshConfigProbe(input(), { sandboxAvailable: () => false, spawn: () => { spawned = true; throw new Error("must not spawn"); } })).resolves.toEqual({ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" });
    await expect(runOpenSshConfigProbe({ ...input(), argv: ["-G", "-F", "/tmp/attacker.conf", "--", "alpha.example.test"] }, { sandboxAvailable: () => true, spawn: () => { spawned = true; throw new Error("must not spawn"); } })).resolves.toEqual({ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" });
    await expect(runOpenSshConfigProbe({ ...input(), executable: "/bin/sh" as typeof SYSTEM_OPENSSH_PATHS.ssh }, { sandboxAvailable: () => true, spawn: () => { spawned = true; throw new Error("must not spawn"); } })).resolves.toEqual({ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" });
    expect(spawned).toBe(false);
  });

  test("admits only the bounded random named stdin probe grammar", async () => {
    const fake = fakeChild();
    let captured: unknown;
    const namedStdin = `Include ~/.ssh/config\nHost *\n  User __nautilo_probe_${"a".repeat(32)}\n`;
    const result = runOpenSshConfigProbe({ ...input(), argv: ["-G", "-F", "/dev/stdin", "--", "alpha.example.test"], stdin: namedStdin }, {
      sandboxAvailable: () => true,
      spawn(file, argv) { captured = { file, argv }; return fake.child; },
    });
    fake.close(0);
    await expect(result).resolves.toMatchObject({ termination: "exited", code: 0 });
    expect(captured).toEqual({ file: SYSTEM_SANDBOX_EXEC_PATH, argv: ["-p", OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.ssh, "-G", "-F", "/dev/stdin", "--", "alpha.example.test"] });
    await expect(runOpenSshConfigProbe({ ...input(), argv: ["-G", "-F", "/dev/stdin", "--", "alpha.example.test"], stdin: `${namedStdin}Host injected\n` }, { sandboxAvailable: () => true, spawn: () => { throw new Error("must not spawn"); } })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
  });

  test("reports output overflow explicitly instead of silently truncating", async () => {
    const fake = fakeChild();
    const result = runOpenSshConfigProbe(input(), { sandboxAvailable: () => true, spawn: () => fake.child, killProcessGroup: () => undefined });
    fake.stdout.write(Buffer.alloc(64 * 1024 + 1, 120));
    fake.fail();
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "stdout_limit", stdout: "x".repeat(64 * 1024), stderr: "" });
    if (process.platform === "darwin") expect(fake.kills).toEqual([]);
    else expect(fake.kills).toEqual(["SIGKILL"]);
  });

  test("reports timeout and sandbox launch errors without exposing shell execution", async () => {
    const timeoutFake = fakeChild(42);
    let timeout: (() => void) | undefined;
    const timedOut = runOpenSshConfigProbe(input(), {
      sandboxAvailable: () => true,
      spawn: () => timeoutFake.child,
      setTimeout: (callback) => { timeout = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => undefined,
      killProcessGroup: () => undefined,
    });
    timeout?.();
    timeoutFake.fail();
    await expect(timedOut).resolves.toMatchObject({ processStarted: true, termination: "timed_out" });

    const failed = fakeChild();
    const failedResult = runOpenSshConfigProbe(input(), { sandboxAvailable: () => true, spawn: () => failed.child });
    failed.fail();
    await expect(failedResult).resolves.toEqual({ processStarted: true, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" } satisfies StructuredSshProcessResult);
  });

  const liveSeatbelt = process.platform === "darwin" && existsSync(SYSTEM_SANDBOX_EXEC_PATH);
  if (!liveSeatbelt) {
    test.skip("live Seatbelt enforcement requires macOS sandbox-exec", () => {});
  } else {
    test("live Seatbelt permits only the initial system ssh exec", () => {
      const allowed = spawnSync(SYSTEM_SANDBOX_EXEC_PATH, ["-p", OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.ssh, "-F", "/dev/null", "-G", "localhost"], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        encoding: "utf8",
      });
      expect(allowed.status).toBe(0);

      const denied = spawnSync(SYSTEM_SANDBOX_EXEC_PATH, ["-p", OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, "/usr/bin/true"], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        encoding: "utf8",
      });
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain("Operation not permitted");
    });

    test("live Seatbelt prevents an OpenSSH Match exec command from running", () => {
      const directory = mkdtempSync(join(tmpdir(), "nautilo-ssh-probe-"));
      const configPath = join(directory, "config");
      const markerPath = join(directory, "match-exec-ran");
      try {
        writeFileSync(configPath, [
          `Match exec \"/usr/bin/touch ${markerPath}\"`,
          "  User blocked-child",
          "Host *",
          "  HostName localhost",
          "" ,
        ].join("\n"), { mode: 0o600 });
        const observed = spawnSync(SYSTEM_SANDBOX_EXEC_PATH, [
          "-p",
          OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE,
          SYSTEM_OPENSSH_PATHS.ssh,
          "-F",
          configPath,
          "-G",
          "localhost",
        ], {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
          encoding: "utf8",
        });
        // OpenSSH treats the denied Match predicate as a config-resolution
        // failure on current macOS. That is the desired fail-closed result:
        // the probe returns no plan and the configured command never runs.
        expect(observed.status).not.toBe(0);
        expect(readFileSync(configPath, "utf8")).toContain("Match exec");
        expect(existsSync(markerPath)).toBe(false);
        expect(observed.stdout).not.toContain("user blocked-child");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
