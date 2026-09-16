import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { discoverSshHostKeyCandidates, observeSshHostKey, selectPreferredSshHostKey } from "../../electron/structured-ssh/host-key-observation.ts";
import { SYSTEM_OPENSSH_PATHS, type RunStructuredSshProcessInput, type StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";

const exited = (code: number, stdout = "", stderr = ""): StructuredSshProcessResult => ({ processStarted: true, termination: "exited", code, signal: null, stdout, stderr });

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function hostKey(fill: number): { readonly publicKey: string; readonly fingerprint: string } {
  const type = "ssh-ed25519";
  const blob = Buffer.concat([sshString(type), sshString(Buffer.alloc(32, fill))]);
  return {
    publicKey: `${type} ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

function request(overrides: Partial<{ host: string; port: number; approvedFingerprint: string; signal: AbortSignal }> = {}) {
  const key = hostKey(9);
  return {
    target: { host: overrides.host ?? "build.example.test", port: overrides.port ?? 22 },
    approvedFingerprint: overrides.approvedFingerprint ?? key.fingerprint,
    signal: overrides.signal ?? new AbortController().signal,
    key,
  };
}

describe("structured SSH host-key observation", () => {
  test("deterministically prefers ed25519, then documented safe fallbacks", () => {
    const fingerprint = (character: string) => `SHA256:${character.repeat(43)}`;
    expect(selectPreferredSshHostKey([
      { algorithm: "ssh-rsa", fingerprint: fingerprint("r") },
      { algorithm: "ecdsa-sha2-nistp256", fingerprint: fingerprint("e") },
      { algorithm: "ssh-ed25519", fingerprint: fingerprint("d") },
    ])).toEqual({ algorithm: "ssh-ed25519", fingerprint: fingerprint("d") });
  });
  test("discovers only canonical fingerprint candidates and never key bytes or scanner labels", async () => {
    const first = hostKey(5);
    const second = hostKey(6);
    const result = await discoverSshHostKeyCandidates({ host: "build.example.test", port: 22 }, {
      run: async () => exited(0, `untrusted ${second.publicKey}\nuntrusted ${first.publicKey}\n`),
    });
    expect(result).toEqual({ ok: true, fingerprints: [first.fingerprint, second.fingerprint].sort() });
    expect(JSON.stringify(result)).not.toContain("ssh-ed25519");
    await expect(discoverSshHostKeyCandidates({ host: "build.example.test", port: 22 }, {
      run: async () => exited(0, `one ${first.publicKey}\ntwo ${first.publicKey}\n`),
    })).resolves.toEqual({ ok: false, reason: "scanner_output_invalid" });
  });

  test("uses only fixed ssh-keyscan argv, finite environment, bounds, and caller cancellation", async () => {
    const input = request({ port: 2222 });
    const calls: RunStructuredSshProcessInput[] = [];
    const result = await observeSshHostKey(input, {
      run: async (call) => {
        calls.push(call);
        return exited(0, `scanner-controlled-label ${input.key.publicKey} untrusted-comment\n`, "private /Users/human/.ssh/id");
      },
    });
    expect(calls).toEqual([{
      executable: SYSTEM_OPENSSH_PATHS.sshKeyscan,
      argv: ["-T", "5", "-p", "2222", "build.example.test"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
      signal: input.signal,
    }]);
    expect(result).toEqual({
      ok: true,
      data: {
        fingerprint: input.key.fingerprint,
        publicKey: input.key.publicKey,
        knownHostsLine: `[build.example.test]:2222 ${input.key.publicKey}`,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("scanner-controlled-label");
    expect(serialized).not.toContain("untrusted-comment");
    expect(serialized).not.toContain("/Users/human");
  });

  test("reconstructs known-host tokens from canonical hostname, IPv4, and IPv6 input", async () => {
    const hostname = request();
    const ipv4 = request({ host: "192.0.2.10", port: 2200 });
    const ipv6 = request({ host: "2001:db8::42", port: 2200 });
    for (const candidate of [hostname, ipv4, ipv6]) {
      const result = await observeSshHostKey(candidate, { run: async () => exited(0, `evil ${candidate.key.publicKey}\n`) });
      expect(result).toMatchObject({ ok: true, data: { knownHostsLine: `${candidate.target.port === 22 ? candidate.target.host : `[${candidate.target.host}]:${candidate.target.port}`} ${candidate.key.publicKey}` } });
    }
  });

  test("fails closed for changed, missing, duplicate, or malformed scanner output", async () => {
    const input = request();
    const other = hostKey(11);
    await expect(observeSshHostKey(input, { run: async () => exited(0, `scanner ${other.publicKey}\n`) })).resolves.toEqual({ ok: false, reason: "host_key_changed" });
    await expect(observeSshHostKey(input, { run: async () => exited(0, "# harmless scanner banner\nSSH-2.0-test\n") })).resolves.toEqual({ ok: false, reason: "host_key_missing" });
    await expect(observeSshHostKey(input, { run: async () => exited(0, `one ${input.key.publicKey}\ntwo ${input.key.publicKey}\n`) })).resolves.toEqual({ ok: false, reason: "host_key_ambiguous" });
    await expect(observeSshHostKey(input, { run: async () => exited(0, "scanner ssh-ed25519 bm90LWEta2V5\n") })).resolves.toEqual({ ok: false, reason: "scanner_output_invalid" });
  });

  test("fails closed for timeout, abort, bounded output, invalid input, and non-zero scan", async () => {
    const input = request();
    const failure = (termination: StructuredSshProcessResult["termination"]): StructuredSshProcessResult => ({ processStarted: true, termination, code: null, signal: null, stdout: "private host label", stderr: "/private/tmp/socket" });
    await expect(observeSshHostKey(input, { run: async () => failure("timed_out") })).resolves.toEqual({ ok: false, reason: "scan_timed_out" });
    await expect(observeSshHostKey(input, { run: async () => failure("aborted") })).resolves.toEqual({ ok: false, reason: "scan_aborted" });
    await expect(observeSshHostKey(input, { run: async () => failure("stdout_limit") })).resolves.toEqual({ ok: false, reason: "scan_output_limited" });
    await expect(observeSshHostKey(input, { run: async () => exited(1, "", "private scan failure") })).resolves.toEqual({ ok: false, reason: "scan_failed" });
    await expect(observeSshHostKey({ ...input, target: { host: "Build.Example.test", port: 22 } }, { run: async () => exited(0) })).resolves.toEqual({ ok: false, reason: "invalid_request" });
    await expect(observeSshHostKey({ ...input, signal: null as unknown as AbortSignal }, { run: async () => exited(0) })).resolves.toEqual({ ok: false, reason: "invalid_request" });
  });
});
