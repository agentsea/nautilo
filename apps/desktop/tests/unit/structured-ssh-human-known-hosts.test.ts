import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import {
  HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE,
  observeHumanKnownHosts,
  runHumanKnownHostsLookup,
  SYSTEM_SANDBOX_EXEC_PATH,
  type HumanKnownHostsChild,
  type HumanKnownHostsRunnerInput,
} from "../../electron/structured-ssh/human-known-hosts.ts";
import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";

const exited = (code: number, stdout = "", stderr = ""): StructuredSshProcessResult => ({ processStarted: true, termination: "exited", code, signal: null, stdout, stderr });

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function hostKey(fill: number): { readonly publicKey: string; readonly fingerprint: string } {
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, fill))]);
  return {
    publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

function request(overrides: Partial<{ host: string; port: number; knownHostFiles: readonly string[]; signal: AbortSignal }> = {}) {
  return {
    target: { host: overrides.host ?? "build.example.test", port: overrides.port ?? 2222 },
    knownHostFiles: overrides.knownHostFiles ?? ["~/.ssh/known_hosts", "/etc/ssh/ssh_known_hosts"],
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

function lookupInput(signal?: AbortSignal): HumanKnownHostsRunnerInput {
  return {
    executable: SYSTEM_OPENSSH_PATHS.sshKeygen,
    argv: ["-F", "[build.example.test]:2222", "-f", "/Users/human/.ssh/known_hosts"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    timeoutMs: 5_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 8 * 1024,
    ...(signal === undefined ? {} : { signal }),
  };
}

function fakeChild(pid = 41) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const child: HumanKnownHostsChild = {
    pid,
    stdout,
    stderr,
    kill(signal) { kills.push(signal); return true; },
    once: events.once.bind(events) as HumanKnownHostsChild["once"],
  };
  return { child, stdout, stderr, kills, close: (code: number | null = 0, signal: NodeJS.Signals | null = null) => events.emit("close", code, signal), fail: () => events.emit("error", new Error("unavailable")) };
}

describe("Human OpenSSH known_hosts observation", () => {
  test("uses the fixed Seatbelt profile and only ssh-keygen -F host -f path", async () => {
    const fake = fakeChild();
    let captured: unknown;
    const result = runHumanKnownHostsLookup(lookupInput(), {
      sandboxAvailable: () => true,
      spawn(file, argv, options) { captured = { file, argv, options }; return fake.child; },
    });
    fake.close(1);
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "exited", code: 1 });
    expect(captured).toEqual({
      file: SYSTEM_SANDBOX_EXEC_PATH,
      argv: ["-p", HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.sshKeygen, "-F", "[build.example.test]:2222", "-f", "/Users/human/.ssh/known_hosts"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform === "darwin", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } },
    });
    expect(HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE).toContain("(deny network*)");
    expect(HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE).toContain("(deny file-write*)");
    expect(HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE).toContain('(allow file-write* (literal "/dev/null"))');
    expect(HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE).toContain("(deny process-exec)");
    expect(HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE).toContain('(allow process-exec (literal "/usr/bin/ssh-keygen"))');
  });

  test("accepts representative hashed-host ssh-keygen output and returns matching secret-free metadata", async () => {
    const key = hostKey(7);
    const calls: HumanKnownHostsRunnerInput[] = [];
    const result = await observeHumanKnownHosts(request({ knownHostFiles: ["~/.ssh/known_hosts"] }), {
      homeDirectory: () => "/Users/human",
      run: async (input) => {
        calls.push(input);
        return exited(0, `# Host [build.example.test]:2222 found: line 12 \n|1|bG9jYWwtc2FsdA==|aGFzaGVkLWhvc3Q= ${key.publicKey} retained-only-locally\n`);
      },
    });
    expect(calls).toEqual([{
      executable: SYSTEM_OPENSSH_PATHS.sshKeygen,
      argv: ["-F", "[build.example.test]:2222", "-f", "/Users/human/.ssh/known_hosts"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 8 * 1024,
    }]);
    expect(result).toEqual({ ok: true, trust: "trusted", hostKeys: [{ algorithm: "ssh-ed25519", fingerprint: key.fingerprint }] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/Users/human");
    expect(serialized).not.toContain("hashed-host");
    expect(serialized).not.toContain("retained-only-locally");
    expect(serialized).not.toContain(key.publicKey.split(" ")[1]!);
  });

  test("treats absent hosts and missing known_hosts files as ordinary absence", async () => {
    const result = await observeHumanKnownHosts(request(), {
      homeDirectory: () => "/Users/human",
      run: async () => exited(1),
    });
    expect(result).toEqual({ ok: true, trust: "absent", hostKeys: [] });
  });

  test("checks configured files in order and fails closed for malformed output or runner errors", async () => {
    const key = hostKey(8);
    const seen: string[] = [];
    await expect(observeHumanKnownHosts(request(), {
      homeDirectory: () => "/Users/human",
      run: async (input) => {
        seen.push(input.argv[3]!);
        return input.argv[3] === "/Users/human/.ssh/known_hosts"
          ? exited(0, `# Host [build.example.test]:2222 found: line 1\nlabel ${key.publicKey}\n`)
          : exited(1);
      },
    })).resolves.toEqual({ ok: true, trust: "trusted", hostKeys: [{ algorithm: "ssh-ed25519", fingerprint: key.fingerprint }] });
    expect(seen).toEqual(["/Users/human/.ssh/known_hosts", "/etc/ssh/ssh_known_hosts"]);
    await expect(observeHumanKnownHosts(request({ knownHostFiles: ["/Users/human/.ssh/known_hosts"] }), {
      run: async () => exited(0, "malicious ssh-ed25519 bm90LWEta2V5\n"),
    })).resolves.toEqual({ ok: false, reason: "lookup_output_invalid" });
    await expect(observeHumanKnownHosts(request({ knownHostFiles: ["/Users/human/.ssh/known_hosts"] }), {
      run: async () => exited(1, "", "known_hosts corrupt"),
    })).resolves.toEqual({ ok: false, reason: "lookup_failed" });
  });

  test("rejects unsafe paths before spawn and reports timeout or overflow without trust", async () => {
    const unsafe = ["relative/known_hosts", "~/../secret", "~other/.ssh/known_hosts", "/tmp/*.hosts", "/tmp/%d", "/tmp/a b"];
    for (const path of unsafe) {
      let called = false;
      await expect(observeHumanKnownHosts(request({ knownHostFiles: [path] }), { homeDirectory: () => "/Users/human", run: async () => { called = true; return exited(1); } })).resolves.toEqual({ ok: false, reason: "invalid_request" });
      expect(called).toBe(false);
    }
    const failure = (termination: StructuredSshProcessResult["termination"]): StructuredSshProcessResult => ({ processStarted: true, termination, code: null, signal: null, stdout: "/Users/human/.ssh/known_hosts", stderr: "/Users/human/.ssh/known_hosts" });
    await expect(observeHumanKnownHosts(request(), { homeDirectory: () => "/Users/human", run: async () => failure("timed_out") })).resolves.toEqual({ ok: false, reason: "lookup_timed_out" });
    await expect(observeHumanKnownHosts(request(), { homeDirectory: () => "/Users/human", run: async () => failure("stdout_limit") })).resolves.toEqual({ ok: false, reason: "lookup_output_limited" });
  });

  test("fails closed before spawn when Seatbelt is unavailable or argv escapes its fixed grammar", async () => {
    let spawned = false;
    await expect(runHumanKnownHostsLookup(lookupInput(), { sandboxAvailable: () => false, spawn: () => { spawned = true; throw new Error("must not spawn"); } })).resolves.toEqual({ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" });
    await expect(runHumanKnownHostsLookup({ ...lookupInput(), argv: ["-F", "host", "-f", "/tmp/*.hosts"] }, { sandboxAvailable: () => true, spawn: () => { spawned = true; throw new Error("must not spawn"); } })).resolves.toEqual({ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" });
    expect(spawned).toBe(false);
  });

  test("reports runner timeout and output overflow explicitly", async () => {
    const overflow = fakeChild();
    const overflowed = runHumanKnownHostsLookup(lookupInput(), { sandboxAvailable: () => true, spawn: () => overflow.child, killProcessGroup: () => undefined });
    overflow.stdout.write(Buffer.alloc((16 * 1024) + 1, 120));
    overflow.fail();
    await expect(overflowed).resolves.toMatchObject({ processStarted: true, termination: "stdout_limit", stdout: "x".repeat(16 * 1024) });

    const timedOut = fakeChild();
    let timeout: (() => void) | undefined;
    const pending = runHumanKnownHostsLookup(lookupInput(), {
      sandboxAvailable: () => true,
      spawn: () => timedOut.child,
      setTimeout: (callback) => { timeout = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => undefined,
      killProcessGroup: () => undefined,
    });
    timeout?.();
    timedOut.fail();
    await expect(pending).resolves.toMatchObject({ processStarted: true, termination: "timed_out" });
  });
});
