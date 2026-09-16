import { EventEmitter } from "node:events";
import { createECDH, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { SYSTEM_OPENSSH_PATHS, runStructuredSshProcess, type RunStructuredSshProcessInput, type StructuredSshChild, type StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";
import { computeOpenSshSha256Fingerprint, parseSystemAgentIdentities, probeSystemSshAgent, resolveSystemAgentIdentity, validateSystemAgentPublicKey } from "../../electron/structured-ssh/system-agent.ts";

const exited = (code: number, stdout = "", stderr = ""): StructuredSshProcessResult => ({ processStarted: true, termination: "exited", code, signal: null, stdout, stderr });
const unavailable = (termination: StructuredSshProcessResult["termination"]): StructuredSshProcessResult => ({ processStarted: false, termination, code: null, signal: null, stdout: "private=/Users/human/.ssh/id", stderr: "socket=/private/tmp/agent" });

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4), "base64");
}

function positiveMpint(value: Buffer): Buffer {
  const first = value.findIndex((byte) => byte !== 0);
  const unsigned = value.subarray(first < 0 ? value.byteLength - 1 : first);
  return unsigned[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), unsigned]) : unsigned;
}

function keyLine(type: string, blob: Buffer): { readonly line: string; readonly fingerprint: string } {
  return { line: `${type} ${blob.toString("base64")}`, fingerprint: computeOpenSshSha256Fingerprint(blob) };
}

function ed25519PublicKey(): { readonly line: string; readonly fingerprint: string } {
  const type = "ssh-ed25519";
  return keyLine(type, Buffer.concat([sshString(type), sshString(Buffer.alloc(32, 7))]));
}

function rsaPublicKey(): { readonly line: string; readonly fingerprint: string } {
  const { publicKey: generated } = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65_537 });
  const jwk = generated.export({ format: "jwk" }) as JsonWebKey;
  const type = "ssh-rsa";
  return keyLine(type, Buffer.concat([sshString(type), sshString(positiveMpint(base64UrlToBuffer(jwk.e!))), sshString(positiveMpint(base64UrlToBuffer(jwk.n!)))]));
}

function ecdsaPublicKey(type: "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521"): { readonly line: string; readonly fingerprint: string } {
  const curve = type.replace("ecdsa-sha2-", "") as "nistp256" | "nistp384" | "nistp521";
  const nodeCurve = ({ nistp256: "prime256v1", nistp384: "secp384r1", nistp521: "secp521r1" } as const)[curve];
  const point = createECDH(nodeCurve).generateKeys();
  return keyLine(type, Buffer.concat([sshString(type), sshString(curve), sshString(point)]));
}

function publicKey(): { readonly line: string; readonly fingerprint: string } {
  return ed25519PublicKey();
}

function fakeChild(pid = 4242) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const child: StructuredSshChild = {
    pid,
    stdout,
    stderr,
    kill(signal) { kills.push(signal); return true; },
    once: events.once.bind(events) as StructuredSshChild["once"],
  };
  return { child, stdout, stderr, close: (code: number | null = 0, signal: NodeJS.Signals | null = null) => events.emit("close", code, signal), fail: () => events.emit("error", new Error("private error")), kills };
}

const runnerInput = (signal?: AbortSignal): RunStructuredSshProcessInput => ({
  executable: SYSTEM_OPENSSH_PATHS.sshAdd,
  argv: ["-l"],
  env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", SSH_AUTH_SOCK: "/private/tmp/agent" },
  timeoutMs: 1_000,
  maxStdoutBytes: 8,
  maxStderrBytes: 8,
  ...(signal ? { signal } : {}),
});

describe("structured SSH fixed-process runner", () => {
  test("accepts only fixed binaries, argv arrays, and the explicit finite environment allowlist", async () => {
    const fake = fakeChild();
    let captured: unknown;
    const result = runStructuredSshProcess(runnerInput(), {
      spawn(file, argv, options) { captured = { file, argv, options }; return fake.child; },
    });
    fake.close();
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "exited", code: 0 });
    expect(captured).toEqual({
      file: "/usr/bin/ssh-add",
      argv: ["-l"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform === "darwin", env: runnerInput().env },
    });
    await expect(runStructuredSshProcess({ ...runnerInput(), executable: "/bin/sh" as typeof SYSTEM_OPENSSH_PATHS.ssh })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    const keyscan = fakeChild();
    const keyscanResult = runStructuredSshProcess({ ...runnerInput(), executable: SYSTEM_OPENSSH_PATHS.sshKeyscan, argv: ["-T", "5", "-p", "22", "build.example.test"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } }, { spawn: () => keyscan.child });
    keyscan.close();
    await expect(keyscanResult).resolves.toMatchObject({ processStarted: true, termination: "exited", code: 0 });
    await expect(runStructuredSshProcess({ ...runnerInput(), argv: ["-l\0--leak"] })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    let spawned = false;
    const rejectEnv = (env: Record<string, string>) => runStructuredSshProcess({ ...runnerInput(), env }, { spawn: () => { spawned = true; return fake.child; } });
    await expect(rejectEnv({ ...runnerInput().env, DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib" })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    await expect(rejectEnv({ ...runnerInput().env, UNRELATED_SETTING: "value" })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    await expect(rejectEnv({ ...runnerInput().env, PATH: "/tmp/attacker-bin:/usr/bin" })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    await expect(rejectEnv({ ...runnerInput().env, SSH_AUTH_SOCK: "relative-agent.sock" })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
    expect(spawned).toBe(false);
  });

  test("bounds stdout and stderr separately and terminates a macOS process group", async () => {
    const fake = fakeChild(89);
    const groups: [number, NodeJS.Signals][] = [];
    const result = runStructuredSshProcess(runnerInput(), {
      spawn: () => fake.child,
      killProcessGroup: (pid, signal) => groups.push([pid, signal]),
    });
    fake.stdout.write("123456789");
    fake.fail();
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "stdout_limit", stdout: "12345678", stderr: "" });
    if (process.platform === "darwin") expect(groups).toEqual([[89, "SIGKILL"]]);
    else expect(fake.kills).toEqual(["SIGKILL"]);
  });

  test("timeout and abort keep their established outcome when child error races termination", async () => {
    const timeoutFake = fakeChild(90);
    let timeout: (() => void) | undefined;
    const timeoutResult = runStructuredSshProcess(runnerInput(), {
      spawn: () => timeoutFake.child,
      setTimeout: (callback) => { timeout = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => undefined,
      killProcessGroup: () => undefined,
    });
    timeout?.();
    timeoutFake.fail();
    await expect(timeoutResult).resolves.toMatchObject({ processStarted: true, termination: "timed_out" });

    const controller = new AbortController();
    const abortFake = fakeChild(91);
    const abortResult = runStructuredSshProcess(runnerInput(controller.signal), { spawn: () => abortFake.child, killProcessGroup: () => undefined });
    controller.abort();
    abortFake.fail();
    await expect(abortResult).resolves.toMatchObject({ processStarted: true, termination: "aborted" });

    const errorFake = fakeChild(92);
    const errorResult = runStructuredSshProcess(runnerInput(), { spawn: () => errorFake.child });
    errorFake.fail();
    await expect(errorResult).resolves.toMatchObject({ processStarted: true, termination: "spawn_failed" });
  });

  test("settles after a bounded post-kill grace when a child emits no terminal event", async () => {
    const fake = fakeChild(93);
    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    const result = runStructuredSshProcess(runnerInput(), {
      spawn: () => fake.child,
      setTimeout: (callback) => {
        nextTimer += 1;
        scheduled.set(nextTimer, callback);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => scheduled.delete(timer as unknown as number),
      killProcessGroup: () => undefined,
    });
    scheduled.get(1)?.();
    scheduled.get(2)?.();
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "timed_out", code: null, signal: "SIGKILL" });
  });

  test("marks pre-spawn abort and a synchronous spawn throw as not started, but preserves started after every post-spawn race", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(runStructuredSshProcess(runnerInput(alreadyAborted.signal))).resolves.toMatchObject({ processStarted: false, termination: "aborted" });
    await expect(runStructuredSshProcess(runnerInput(), { spawn: () => { throw new Error("no child"); } })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });

    const fake = fakeChild(94);
    const result = runStructuredSshProcess(runnerInput(), { spawn: () => fake.child });
    fake.close(255);
    await expect(result).resolves.toMatchObject({ processStarted: true, termination: "exited", code: 255 });
  });

  test("admits exactly the 32 confinement entries plus six bounded SSH operation entries", async () => {
    const accepted = fakeChild(95);
    const acceptedResult = runStructuredSshProcess({ ...runnerInput(), argv: Array.from({ length: 38 }, () => "x") }, { spawn: () => accepted.child });
    accepted.close();
    await expect(acceptedResult).resolves.toMatchObject({ processStarted: true, termination: "exited" });
    await expect(runStructuredSshProcess({ ...runnerInput(), argv: Array.from({ length: 39 }, () => "x") })).resolves.toMatchObject({ processStarted: false, termination: "spawn_failed" });
  });
});

describe("system SSH agent advisory probe", () => {
  test("uses exact Apple binaries, fixed argv, a finite env, and returns only public identity metadata", async () => {
    const calls: RunStructuredSshProcessInput[] = [];
    const key = publicKey();
    const comment = "/Users/human/.ssh/secret-key key-comment@example.test";
    const readiness = await probeSystemSshAgent({
      platform: "darwin",
      getEnv: () => "/private/tmp/agent-socket-secret",
      run: async (input) => {
        calls.push(input);
        if (input.executable === SYSTEM_OPENSSH_PATHS.ssh) return exited(0, "", "OpenSSH_9.9");
        if (input.executable === SYSTEM_OPENSSH_PATHS.scp) return exited(1, "", "usage: scp");
        return exited(0, `${key.line} ${comment}\n`);
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({ executable: "/usr/bin/ssh", argv: ["-V"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } }),
      expect.objectContaining({ executable: "/usr/bin/scp", argv: ["-V"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } }),
      expect.objectContaining({ executable: "/usr/bin/ssh-add", argv: ["-L"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", SSH_AUTH_SOCK: "/private/tmp/agent-socket-secret" } }),
    ]);
    expect(readiness.binaryProbes).toEqual({ ssh: "observed", scp: "observed" });
    expect(readiness.identityProbe).toBe("identities_observed");
    expect(readiness.executionState).toBe("identity_selection_required");
    expect(readiness.identities).toEqual([expect.objectContaining({ provider: "system-agent", publicKeyFingerprint: key.fingerprint })]);
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("key-comment");
    expect(serialized).not.toContain("agent-socket-secret");
    expect(serialized).not.toContain("/Users/human");
  });

  test("reports advisory probe failures without claiming executable readiness", async () => {
    const binaries = async (input: RunStructuredSshProcessInput): Promise<StructuredSshProcessResult> =>
      input.executable === SYSTEM_OPENSSH_PATHS.sshAdd ? exited(0, "not an ssh-add line\n") : exited(0);
    const noSocket = await probeSystemSshAgent({ platform: "darwin", getEnv: () => undefined, run: binaries });
    expect(noSocket).toMatchObject({ identities: [], identityProbe: "agent_unavailable", executionState: "not_ready" });

    const noIdentities = await probeSystemSshAgent({ platform: "darwin", getEnv: () => "/private/tmp/a", run: async (input) => input.executable === SYSTEM_OPENSSH_PATHS.sshAdd ? exited(1, "", "The agent has no identities.") : exited(0) });
    expect(noIdentities).toMatchObject({ identities: [], identityProbe: "no_identities", executionState: "not_ready" });

    const malformed = await probeSystemSshAgent({ platform: "darwin", getEnv: () => "/private/tmp/a", run: binaries });
    expect(malformed).toMatchObject({ identities: [], identityProbe: "identity_metadata_invalid", executionState: "not_ready" });

    const bounded = await probeSystemSshAgent({ platform: "darwin", getEnv: () => "/private/tmp/a", run: async (input) => input.executable === SYSTEM_OPENSSH_PATHS.sshAdd ? unavailable("stdout_limit") : exited(0) });
    expect(bounded).toMatchObject({ identities: [], identityProbe: "identity_metadata_invalid", executionState: "not_ready" });
  });

  test("propagates cancellation to every binary probe", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: RunStructuredSshProcessInput[] = [];
    const result = await probeSystemSshAgent({
      platform: "darwin",
      signal: controller.signal,
      run: async (input) => {
        calls.push(input);
        return unavailable("aborted");
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(result).toMatchObject({ identityProbe: "ssh_probe_unavailable", executionState: "not_ready" });
  });

  test("labels -V as a binary observation, never auth, exec, or copy readiness", async () => {
    const noCopy = await probeSystemSshAgent({ platform: "darwin", getEnv: () => "/private/tmp/a", run: async (input) => {
      if (input.executable === SYSTEM_OPENSSH_PATHS.scp) return unavailable("spawn_failed");
      if (input.executable === SYSTEM_OPENSSH_PATHS.sshAdd) return exited(0, `${publicKey().line} comment\n`);
      return exited(0);
    } });
    expect(noCopy).toMatchObject({
      binaryProbes: { ssh: "observed", scp: "unavailable" },
      identityProbe: "identities_observed",
      executionState: "identity_selection_required",
    });
    const unsupported = await probeSystemSshAgent({ platform: "linux" });
    expect(unsupported).toEqual({
      provider: "system-agent",
      identities: [],
      binaryProbes: { ssh: "unavailable", scp: "unavailable" },
      identityProbe: "unsupported_platform",
      executionState: "not_ready",
    });
  });

  test("strictly parses canonical public keys and rejects malformed or duplicate output", () => {
    const one = `${publicKey().line} private-comment\n`;
    expect(parseSystemAgentIdentities(exited(0, `${one}${one}`))).toBeNull();
    expect(parseSystemAgentIdentities(exited(0, "ssh-ed25519 bm90LWEta2V5\n"))).toBeNull();
    expect(parseSystemAgentIdentities(exited(0, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAAgEB\n"))).toBeNull();
    expect(parseSystemAgentIdentities(exited(0, "ssh-ed25519 AAAAA3NzaC1yc2E=\n"))).toBeNull();
  });

  test("validates complete Ed25519, RSA, and NIST ECDSA public-key wire formats", () => {
    const valid = [
      ed25519PublicKey(),
      rsaPublicKey(),
      ecdsaPublicKey("ecdsa-sha2-nistp256"),
      ecdsaPublicKey("ecdsa-sha2-nistp384"),
      ecdsaPublicKey("ecdsa-sha2-nistp521"),
    ];
    for (const key of valid) expect(validateSystemAgentPublicKey(key.line)).toEqual(expect.objectContaining({ canonical: key.line, fingerprint: key.fingerprint }));

    const malformedRsa = Buffer.concat([sshString("ssh-rsa"), sshString(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(128, 2))]);
    expect(validateSystemAgentPublicKey(`ssh-rsa ${malformedRsa.toString("base64")}`)).toBeNull();
    const malformedPoint = Buffer.concat([sshString("ecdsa-sha2-nistp256"), sshString("nistp256"), sshString(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]))]);
    expect(validateSystemAgentPublicKey(`ecdsa-sha2-nistp256 ${malformedPoint.toString("base64")}`)).toBeNull();
  });

  test("re-enumerates the same agent socket and resolves exactly one selected current key", async () => {
    const key = publicKey();
    const inventory = parseSystemAgentIdentities(exited(0, `${key.line} human-comment\n`));
    expect(inventory).not.toBeNull();
    const selected = inventory?.[0]!;
    const calls: RunStructuredSshProcessInput[] = [];
    const resolved = await resolveSystemAgentIdentity(selected, {
      platform: "darwin",
      getEnv: () => "/private/tmp/only-local-agent",
      run: async (input) => { calls.push(input); return exited(0, `${key.line} another-comment\n`); },
    });
    expect(calls).toEqual([expect.objectContaining({ executable: "/usr/bin/ssh-add", argv: ["-L"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", SSH_AUTH_SOCK: "/private/tmp/only-local-agent" } })]);
    expect(resolved).toMatchObject({ ok: true, data: { identity: selected, publicKey: key.line, sshAuthSock: "/private/tmp/only-local-agent" } });
    expect(JSON.stringify(resolved)).not.toContain("another-comment");

    const replaced = await resolveSystemAgentIdentity(selected, {
      platform: "darwin",
      getEnv: () => "/private/tmp/only-local-agent",
      run: async () => exited(0, `${ecdsaPublicKey("ecdsa-sha2-nistp256").line}\n`),
    });
    expect(replaced).toEqual({ ok: false, reason: "identity_unavailable" });
  });
});
