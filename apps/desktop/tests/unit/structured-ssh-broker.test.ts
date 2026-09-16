import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { encodeStructuredSshRemoteCommand, runStructuredSshBroker, type StructuredSshBrokerDependencies } from "../../electron/structured-ssh/broker.ts";
import type { SshCapability, SshInvocationSubject } from "../../electron/structured-ssh/contracts.ts";
import type { OpenSshDestinationPlan } from "../../electron/structured-ssh/open-ssh-plan.ts";
import type { StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";
import { RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity.ts";

const capabilitySubject = {
  instanceId: "nautilo-instance-1", userId: "user-1", agentId: "agent-1", relayId: "relay-1", desktopSessionId: "desktop-session-1",
};
const invocationSubject: SshInvocationSubject = {
  ...capabilitySubject,
  actorId: "genie-1", actorRole: "owner", executionEntrypoint: "foreground.main",
  relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1", capabilityRevision: 4,
};

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([size, bytes]);
}

function observedHostKey() {
  const type = "ssh-ed25519";
  const blob = Buffer.concat([sshString(type), sshString(Buffer.alloc(32, 7))]);
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  const publicKey = `${type} ${blob.toString("base64")}`;
  return { fingerprint, publicKey, knownHostsLine: `[build.example.test]:2222 ${publicKey}` };
}

function capability(overrides: Partial<SshCapability> = {}): SshCapability {
  return {
    version: 1, subject: capabilitySubject, enabled: true,
    tools: { auth: true, exec: true, copyUpload: true, copyDownload: true },
    issuedAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

const plan: OpenSshDestinationPlan = {
  destination: { host: "build.example.test", remoteUser: "deploy", port: 2222 },
  identitySources: [{ kind: "file", identityFile: "/identity-a" }, { kind: "agent", identityAgent: null }],
  knownHostFiles: ["/known_hosts"],
  safetyDirectives: {
    proxycommand: "none", proxyjump: "none", forwardagent: "no", permitlocalcommand: "no", localcommand: "none",
    localforward: "none", remoteforward: "none", dynamicforward: "none", canonicalizehostname: "no",
    controlmaster: "no", controlpath: "none", remotecommand: "none",
  },
};

const exited = (code = 0, stdout = "", stderr = ""): StructuredSshProcessResult => ({ processStarted: true, termination: "exited", code, signal: null, stdout, stderr });
const request = (operation: "auth" | "exec" = "exec") => operation === "auth"
  ? { version: 1 as const, toolCallId: "call-1", toolName: "structured_ssh_auth" as const, args: { destination: { host: "build" } } }
  : { version: 1 as const, toolCallId: "call-1", toolName: "structured_ssh_exec" as const, args: { destination: { host: "build" }, program: "printf", argv: ["hello", "it's", "$(never-local)", ""], timeoutSeconds: 300 } };
const copyRequest = (operation: "copy-upload" | "copy-download") => operation === "copy-upload"
  ? { version: 1 as const, toolCallId: "call-copy", toolName: "structured_ssh_copy_upload" as const, args: { destination: { host: "build" }, localPath: "release.tar", remotePath: "/tmp/release.tar", timeoutSeconds: 300 } }
  : { version: 1 as const, toolCallId: "call-copy", toolName: "structured_ssh_copy_download" as const, args: { destination: { host: "build" }, remotePath: "/tmp/result.tar", localPath: "result.tar", timeoutSeconds: 300 } };

function dependencies(overrides: Partial<StructuredSshBrokerDependencies> = {}) {
  const order: string[] = [];
  let cleanupCalls = 0;
  const host = observedHostKey();
  const value: StructuredSshBrokerDependencies = {
    getPinnedHostTrust: async () => { order.push("trust"); return { ok: true, record: { version: 1, host: "build.example.test", port: 2222, hostKeyFingerprint: host.fingerprint, confirmedAt: "2026-08-08T00:00:00.000Z" } }; },
    observeHostKey: async () => { order.push("observe"); return { ok: true, data: host }; },
    createHostTrustBundle: async () => ({
      argv: ["-o", "UserKnownHostsFile=/app-data/structured-ssh-run/known_hosts"],
      redactOutput: (text) => text
        .replaceAll("/app-data/structured-ssh-run/known_hosts", "[local-path-redacted]")
        .replaceAll("/app-data", "[local-path-redacted]"),
      validateForLaunch: async () => { order.push("validate"); },
      cleanup: async () => { cleanupCalls += 1; order.push("cleanup"); },
    }),
    run: async () => { order.push("run"); return exited(0, "output", ""); },
    readDefaultAgentSocket: () => undefined,
    readHomeDirectory: () => "/local-home",
    ...overrides,
  };
  return { value, order, cleanupCalls: () => cleanupCalls };
}

function input(signal = new AbortController().signal, overrides: Partial<Parameters<typeof runStructuredSshBroker>[1]> = {}) {
  return { plan, capability: capability(), sshCapabilityRevision: 17, subject: invocationSubject, appDataDirectory: "/app-data", workspaceRoot: "/workspace", signal, ...overrides };
}

describe("structured SSH broker", () => {
  test("uses -F /dev/null and only the fresh plan's identities in fixed argv", async () => {
    const fixture = dependencies();
    let runInput: unknown;
    const brokerInput = input();
    fixture.value.run = async (value) => { runInput = value; fixture.order.push("run"); return exited(0, "safe output", "safe stderr"); };
    const result = await runStructuredSshBroker(request(), brokerInput, fixture.value);
    expect(fixture.order).toEqual(["trust", "observe", "validate", "validate", "run", "cleanup"]);
    expect(runInput).toMatchObject({
      executable: "/usr/bin/ssh",
      argv: ["-F", "/dev/null", "-i", "/identity-a", "-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile=/app-data/structured-ssh-run/known_hosts", "-T", "-p", "2222", "-l", "deploy", "--", "build.example.test", "'printf' 'hello' 'it'\"'\"'s' '$(never-local)' ''"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" }, timeoutMs: 300_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024, terminateOnOutputLimit: false, signal: brokerInput.signal,
    });
    expect(runInput).toHaveProperty("onStdoutChunk", expect.any(Function));
    expect(runInput).toHaveProperty("onStderrChunk", expect.any(Function));
    expect((runInput as { argv: readonly string[] }).argv).toContain("-F");
    expect(JSON.stringify(result)).not.toContain("/identity-a");
    expect(result).toEqual({ ok: true, operation: "exec", exitCode: 0, stdout: "safe output", stderr: "safe stderr", stdoutTruncated: false, stderrTruncated: false, sideEffectStarted: true, retrySafe: false });
  });

  test("encodes remote argv literally at the exact 4096-byte boundary", () => {
    expect(encodeStructuredSshRemoteCommand("é", ["", "a'b", "$HOME;*", "��"])).toBe("'é' '' 'a'\"'\"'b' '$HOME;*' '��'");
    expect(encodeStructuredSshRemoteCommand("curl", ["-w", "%{http_code}\n", "https://build.example.test/"]))
      .toBe("'curl' '-w' '%{http_code}\n' 'https://build.example.test/'");
    expect(encodeStructuredSshRemoteCommand("a".repeat(4094), [])).toHaveLength(4096);
    expect(encodeStructuredSshRemoteCommand("a".repeat(4095), [])).toBeNull();
  });

  test("auth uses a no-op and does not return remote output", async () => {
    const fixture = dependencies();
    let command = "";
    fixture.value.run = async (value) => { command = value.argv.at(-1)!; return exited(0, "private", "private"); };
    const result = await runStructuredSshBroker(request("auth"), input(), fixture.value);
    expect(command).toBe(":");
    expect(result).toEqual({ ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("copies only resolved workspace paths through fixed scp argv", async () => {
    for (const operation of ["copy-upload", "copy-download"] as const) {
      const fixture = dependencies({
        resolveCopyPath: async () => ({ ok: true, path: operation === "copy-upload" ? "/workspace/release.tar" : "/workspace/result.tar", bytes: 0, validateForLaunch: async () => true, validateAfterTransfer: async () => ({ ok: true, bytes: 12 }) }),
      });
      let runInput: Parameters<NonNullable<StructuredSshBrokerDependencies["run"]>>[0] | undefined;
      fixture.value.run = async (value) => { runInput = value; return exited(); };
      await expect(runStructuredSshBroker(copyRequest(operation), input(), fixture.value)).resolves.toEqual({ ok: true, operation, bytes: 12, sideEffectStarted: true, retrySafe: false });
      expect(runInput?.argv).toEqual(operation === "copy-upload"
        ? ["-F", "/dev/null", "-i", "/identity-a", "-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile=/app-data/structured-ssh-run/known_hosts", "-P", "2222", "/workspace/release.tar", "deploy@build.example.test:/tmp/release.tar"]
        : ["-F", "/dev/null", "-i", "/identity-a", "-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile=/app-data/structured-ssh-run/known_hosts", "-P", "2222", "deploy@build.example.test:/tmp/result.tar", "/workspace/result.tar"]);
    }
  });

  test("uses only a locally validated default-agent socket in the finite environment", async () => {
    const fixture = dependencies({ readDefaultAgentSocket: () => "/agent.sock" });
    let runInput: Parameters<NonNullable<StructuredSshBrokerDependencies["run"]>>[0] | undefined;
    fixture.value.run = async (value) => { runInput = value; return exited(); };
    await expect(runStructuredSshBroker(request(), input(), fixture.value)).resolves.toMatchObject({ ok: true });
    expect(runInput?.env).toEqual({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", SSH_AUTH_SOCK: "/agent.sock" });
    expect(runInput?.argv).not.toContain("IdentityAgent=/agent.sock");
  });

  test("redacts every reconstructed local value from successful stdout and stderr while preserving ordinary output", async () => {
    const fixture = dependencies({ readDefaultAgentSocket: () => "/agent.sock" });
    const privateValues = [
      "/identity-a",
      "/agent.sock",
      "/app-data/structured-ssh-run/known_hosts",
      "/app-data",
      "/local-home",
      "/workspace",
    ];
    const diagnostics = `ordinary remote warning\n${privateValues.join("\n")}`;
    fixture.value.run = async () => exited(0, diagnostics, diagnostics);
    const result = await runStructuredSshBroker(request(), input(), fixture.value);
    if (!result.ok || result.operation !== "exec") throw new Error("expected successful exec");
    expect(result.stdout).toContain("ordinary remote warning");
    expect(result.stderr).toContain("ordinary remote warning");
    for (const privateValue of privateValues) {
      expect(result.stdout).not.toContain(privateValue);
      expect(result.stderr).not.toContain(privateValue);
    }
  });

  test("returns nonzero remote exec status and retains sanitized output beyond the inline preview without rerunning SSH", async () => {
    const store = new RunShellOutputArtifactStore();
    const owner = { instanceId: "nautilo-instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-session-1" };
    const prefix = Buffer.alloc(70 * 1024, 0x61);
    const suffix = Buffer.from("\nFINAL-DIAGNOSTIC /identity-a\n", "utf8");
    let runs = 0;
    const fixture = dependencies({
      outputArtifactStore: store,
      outputArtifactOwner: owner,
      run: async (value) => {
        runs += 1;
        value.onStdoutChunk?.(prefix);
        value.onStdoutChunk?.(suffix);
        return exited(23, prefix.subarray(0, 64 * 1024).toString("utf8"), "");
      },
    });
    const result = await runStructuredSshBroker(request(), input(), fixture.value);
    expect(result).toMatchObject({ ok: true, operation: "exec", exitCode: 23, stdoutTruncated: true, stderrTruncated: false });
    if (!result.ok || result.operation !== "exec" || result.outputArtifact === undefined) throw new Error("expected retained exec output");
    expect(runs).toBe(1);
    expect(result.stdout).toContain("FINAL-DIAGNOSTIC");
    expect(result.stdout).not.toContain("/identity-a");
    expect(store.search({
      reference: result.outputArtifact.reference,
      owner,
      query: Buffer.from("FINAL-DIAGNOSTIC"),
      maxMatches: 2,
      contextBytes: 64,
    })).toMatchObject({ totalMatches: 1, matches: [expect.objectContaining({ context: expect.stringContaining("FINAL-DIAGNOSTIC [REDACTED]") })] });
    expect(store.search({
      reference: result.outputArtifact.reference,
      owner,
      query: Buffer.from("/identity-a"),
      maxMatches: 2,
      contextBytes: 64,
    })).toMatchObject({ totalMatches: 0 });
    store.clear();
  });

  test("classifies OpenSSH's reserved exit 255 as transport failure for exec", async () => {
    let runs = 0;
    const fixture = dependencies({
      run: async () => {
        runs += 1;
        return exited(255, "remote stdout", "root@build.example.test: Permission denied (publickey).");
      },
    });

    const result = await runStructuredSshBroker(request(), input(), fixture.value);
    expect(result).toEqual({
      ok: false,
      operation: "exec",
      reason: "ssh_exit_nonzero",
      sideEffectStarted: true,
      retrySafe: false,
    });
    expect(runs).toBe(1);
    expect(JSON.stringify(result)).not.toContain("Permission denied");
    expect(JSON.stringify(result)).not.toContain("remote stdout");
    expect(fixture.cleanupCalls()).toBe(1);
  });

  test("preserves ordinary nonzero remote exec status instead of treating it as an SSH transport failure", async () => {
    let runs = 0;
    const fixture = dependencies({
      run: async () => {
        runs += 1;
        return exited(42, "remote stdout", "remote stderr /identity-a");
      },
    });

    const result = await runStructuredSshBroker(request(), input(), fixture.value);
    expect(result).toMatchObject({
      ok: true,
      operation: "exec",
      exitCode: 42,
      stdout: "remote stdout",
      stdoutTruncated: false,
      stderrTruncated: false,
      sideEffectStarted: true,
      retrySafe: false,
    });
    if (!result.ok || result.operation !== "exec") throw new Error("expected an ordinary remote-command result");
    expect(result.stderr).toContain("remote stderr");
    expect(result.stderr).not.toContain("/identity-a");
    expect(runs).toBe(1);
    expect(fixture.cleanupCalls()).toBe(1);
  });

  test("projects only redacted exec observations and truthful SCP start/final counts before the canonical receipt", async () => {
    const execEvents: unknown[] = [];
    const exec = dependencies({
      readDefaultAgentSocket: () => "/agent.sock",
      reportProgress: (event) => execEvents.push(event),
      run: async (value) => {
        value.onStdoutChunk?.(Buffer.from("remote /identity-"));
        value.onStdoutChunk?.(Buffer.from("a output\n"));
        value.onStderrChunk?.(Buffer.from("socket=/agent.sock\n"));
        return exited(0, "remote /identity-a output\n", "socket=/agent.sock\n");
      },
    });
    await expect(runStructuredSshBroker(request(), input(), exec.value)).resolves.toMatchObject({ ok: true, operation: "exec" });
    expect(JSON.stringify(execEvents)).not.toContain("/identity-a");
    expect(JSON.stringify(execEvents)).not.toContain("/agent.sock");
    expect(execEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "exec", kind: "exec-output", stream: "stdout" }),
      expect.objectContaining({ operation: "exec", kind: "exec-output", stream: "stderr" }),
    ]));

    const transferEvents: unknown[] = [];
    const copy = dependencies({
      reportProgress: (event) => transferEvents.push(event),
      resolveCopyPath: async () => ({
        ok: true as const,
        path: "/workspace/release.tar",
        bytes: 12,
        validateForLaunch: async () => true,
        validateAfterTransfer: async () => ({ ok: true as const, bytes: 12 }),
      }),
      run: async () => exited(),
    });
    await expect(runStructuredSshBroker(copyRequest("copy-upload"), input(), copy.value)).resolves.toMatchObject({ ok: true, bytes: 12 });
    expect(transferEvents).toEqual([
      expect.objectContaining({ sequence: 0, operation: "copy-upload", kind: "transfer", phase: "starting", transferredBytes: 0, totalBytes: 12 }),
      expect.objectContaining({ sequence: 1, operation: "copy-upload", kind: "transfer", phase: "transferring", transferredBytes: 12, totalBytes: 12 }),
    ]);

    const preSpawnEvents: unknown[] = [];
    const preSpawn = dependencies({
      reportProgress: (event) => preSpawnEvents.push(event),
      resolveCopyPath: async () => ({
        ok: true as const,
        path: "/workspace/release.tar",
        bytes: 12,
        validateForLaunch: async () => true,
        validateAfterTransfer: async () => ({ ok: true as const, bytes: 12 }),
      }),
      run: async () => ({ processStarted: false, termination: "spawn_failed" as const, code: null, signal: null, stdout: "", stderr: "" }),
    });
    await expect(runStructuredSshBroker(copyRequest("copy-upload"), input(), preSpawn.value)).resolves.toMatchObject({ ok: false, reason: "ssh_spawn_failed", sideEffectStarted: false });
    expect(preSpawnEvents).toEqual([]);
  });

  test("supports an explicit validated agent and rejects unsafe plan identity sources before host work", async () => {
    const explicitPlan: OpenSshDestinationPlan = { ...plan, identitySources: [{ kind: "file", identityFile: "/identity-a" }, { kind: "agent", identityAgent: "/explicit-agent.sock" }] };
    const explicit = dependencies();
    let argv: readonly string[] = [];
    explicit.value.run = async (value) => { argv = value.argv; return exited(); };
    await expect(runStructuredSshBroker(request(), input(undefined, { plan: explicitPlan }), explicit.value)).resolves.toMatchObject({ ok: true });
    expect(argv).toContain("IdentityAgent=/explicit-agent.sock");

    for (const identitySources of [
      [{ kind: "file", identityFile: "/bad path" }],
      [{ kind: "file", identityFile: "~/../bad" }],
      [{ kind: "agent", identityAgent: "$SSH_AUTH_SOCK" }],
      [{ kind: "agent", identityAgent: "/agent.sock" }, { kind: "agent", identityAgent: null }],
    ] as const) {
      const fixture = dependencies();
      const unsafePlan = { ...plan, identitySources } as unknown as OpenSshDestinationPlan;
      await expect(runStructuredSshBroker(request(), input(undefined, { plan: unsafePlan }), fixture.value)).resolves.toEqual({ ok: false, operation: "exec", reason: "identity_source_unavailable", sideEffectStarted: false, retrySafe: true });
      expect(fixture.order).toEqual([]);
    }
    const malformedDefaultSocket = dependencies({ readDefaultAgentSocket: () => "relative-agent.sock" });
    await expect(runStructuredSshBroker(request(), input(), malformedDefaultSocket.value)).resolves.toEqual({ ok: false, operation: "exec", reason: "identity_source_unavailable", sideEffectStarted: false, retrySafe: true });
    expect(malformedDefaultSocket.order).toEqual([]);
  });

  test("accepts the resolver's 64 identity-file ceiling and rejects only overflow", async () => {
    const identitySources = Array.from({ length: 64 }, (_, index) => ({
      kind: "file" as const,
      identityFile: `/identity-${index}`,
    }));
    const bounded = dependencies();
    let argv: readonly string[] = [];
    bounded.value.run = async (value) => { argv = value.argv; return exited(); };
    await expect(runStructuredSshBroker(
      request(),
      input(undefined, { plan: { ...plan, identitySources } }),
      bounded.value,
    )).resolves.toMatchObject({ ok: true, operation: "exec" });
    expect(argv.filter((value) => value === "-i")).toHaveLength(64);

    const overflow = dependencies();
    await expect(runStructuredSshBroker(
      request(),
      input(undefined, {
        plan: {
          ...plan,
          identitySources: [...identitySources, { kind: "file", identityFile: "/identity-overflow" }],
        },
      }),
      overflow.value,
    )).resolves.toEqual({
      ok: false,
      operation: "exec",
      reason: "identity_source_unavailable",
      sideEffectStarted: false,
      retrySafe: true,
    });
    expect(overflow.order).toEqual([]);
  });

  test("accepts independent valid local and relay capability revisions, while rejecting malformed local revision", async () => {
    const cases: Array<[Partial<Parameters<typeof runStructuredSshBroker>[1]>, string]> = [
      [{ sshCapabilityRevision: -1 }, "invalid_request"],
      [{ capability: capability({ enabled: false, disabledAt: "2026-08-08T00:00:00.000Z" }) }, "capability_disabled"],
      [{ capability: capability({ tools: { auth: true, exec: false, copyUpload: true, copyDownload: true } }) }, "capability_not_authorized"],
      ...(["instanceId", "userId", "agentId", "relayId", "desktopSessionId"] as const).map((field) => [{
        subject: { ...invocationSubject, [field]: field === "instanceId" ? "nautilo-instance-2" : "other" },
      }, "capability_subject_mismatch"] as const),
    ];
    for (const [override, reason] of cases) {
      const fixture = dependencies();
      await expect(runStructuredSshBroker(request(), input(undefined, override), fixture.value)).resolves.toMatchObject({ ok: false, reason, sideEffectStarted: false, retrySafe: true });
      expect(fixture.order).toEqual([]);
    }
    const independentRevisions = dependencies();
    await expect(runStructuredSshBroker(request(), input(undefined, { sshCapabilityRevision: 17, subject: { ...invocationSubject, capabilityRevision: 4 } }), independentRevisions.value)).resolves.toMatchObject({ ok: true, operation: "exec" });
  });

  test("requires a current app-local pin and an exact live observation", async () => {
    const untrusted = dependencies({ getPinnedHostTrust: async () => ({ ok: false }) });
    await expect(runStructuredSshBroker(request(), input(), untrusted.value)).resolves.toMatchObject({ ok: false, reason: "host_not_trusted" });
    expect(untrusted.order).not.toContain("run");
    const changed = dependencies({ observeHostKey: async () => ({ ok: false, reason: "host_key_changed" }) });
    await expect(runStructuredSshBroker(request(), input(), changed.value)).resolves.toMatchObject({ ok: false, reason: "host_key_changed" });
    expect(changed.order).not.toContain("run");
  });

  test("does not launch after a local-path or host-trust confinement failure", async () => {
    const copy = dependencies({ resolveCopyPath: async () => ({ ok: false }) });
    await expect(runStructuredSshBroker(copyRequest("copy-upload"), input(), copy.value)).resolves.toMatchObject({ ok: false, reason: "copy_path_not_authorized" });
    expect(copy.order).not.toContain("run");
    const host = dependencies({ createHostTrustBundle: async () => ({ argv: [], redactOutput: (text) => text, validateForLaunch: async () => { throw new Error("private host file"); }, cleanup: async () => {} }) });
    await expect(runStructuredSshBroker(request(), input(), host.value)).resolves.toMatchObject({ ok: false, reason: "confinement_failed" });
    expect(host.order).not.toContain("run");
  });

  test("preserves cancellation and truthful process-start semantics without diagnostics", async () => {
    const controller = new AbortController(); controller.abort();
    const aborted = dependencies();
    await expect(runStructuredSshBroker(request(), input(controller.signal), aborted.value)).resolves.toEqual({ ok: false, operation: "exec", reason: "aborted", sideEffectStarted: false, retrySafe: true });
    expect(aborted.order).toEqual([]);
    const cancelledDuringTrust = new AbortController();
    const interruptedBeforeLaunch = dependencies({
      getPinnedHostTrust: async () => {
        cancelledDuringTrust.abort();
        return { ok: true, record: { version: 1, host: "build.example.test", port: 2222, hostKeyFingerprint: observedHostKey().fingerprint, confirmedAt: "2026-08-08T00:00:00.000Z" } };
      },
    });
    await expect(runStructuredSshBroker(request(), input(cancelledDuringTrust.signal), interruptedBeforeLaunch.value)).resolves.toEqual({
      ok: false, operation: "exec", reason: "aborted", sideEffectStarted: false, retrySafe: true,
    });
    expect(interruptedBeforeLaunch.order).toEqual([]);

    const cases: Array<[StructuredSshProcessResult, string, boolean]> = [
      [{ processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "secret", stderr: "secret" }, "ssh_spawn_failed", false],
      [{ processStarted: false, termination: "aborted", code: null, signal: "SIGKILL", stdout: "secret", stderr: "secret" }, "aborted", false],
      [{ processStarted: true, termination: "aborted", code: null, signal: "SIGKILL", stdout: "secret", stderr: "secret" }, "aborted", true],
      [{ processStarted: true, termination: "timed_out", code: null, signal: "SIGKILL", stdout: "secret", stderr: "secret" }, "ssh_timed_out", true],
      [{ processStarted: true, termination: "stdout_limit", code: null, signal: "SIGKILL", stdout: "truncated", stderr: "secret" }, "ssh_output_limited", true],
    ];
    for (const [process, reason, started] of cases) {
      let runs = 0;
      const fixture = dependencies({ run: async () => { runs += 1; return process; } });
      const result = await runStructuredSshBroker(request(), input(), fixture.value);
      expect(result).toEqual({ ok: false, operation: "exec", reason, sideEffectStarted: started, retrySafe: !started });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(runs).toBe(1);
      expect(fixture.cleanupCalls()).toBe(1);
    }
  });

  test("treats runner throws as an uncertain remote effect and retains cleanup failure precedence", async () => {
    const thrown = dependencies({ run: async () => { throw new Error("/Users/human/.ssh/id"); } });
    await expect(runStructuredSshBroker(request(), input(), thrown.value)).resolves.toEqual({ ok: false, operation: "exec", reason: "ssh_runner_failed", sideEffectStarted: true, retrySafe: false });
    const cleanup = dependencies({
      run: async () => { throw new Error("private"); },
      createHostTrustBundle: async () => ({ argv: [], redactOutput: (text) => text, validateForLaunch: async () => {}, cleanup: async () => { throw new Error("private"); } }),
    });
    await expect(runStructuredSshBroker(request(), input(), cleanup.value)).resolves.toEqual({ ok: false, operation: "exec", reason: "cleanup_failed", sideEffectStarted: true, retrySafe: false });
  });
});
