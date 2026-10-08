import assert from "node:assert/strict";
import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type { Sandbox } from "@nautilo/sandbox";
import {
  createWorkspaceGuard, type RelayDispatchRequest, type RelayWorkstationShellBinding,
} from "@nautilo/relay";
import { LocalExecutionHost } from "../../electron/local-execution-host";
import { LocalExecutionDispatch, localExecutionOwnerKey } from "../../electron/relay-dispatch/local-execution";
import type { LocalProcessExit, PreparedLocalExecution } from "../../electron/local-execution-process";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/local-execution-test" } }));
let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay")); });
const roots: string[] = [];
const hosts: LocalExecutionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.finishDisposal();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(tty = false, authorityExpiresAt?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-integration-")));
  const policyHome = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-home-")));
  roots.push(root, policyHome);
  let selected = ""; let allowed = true;
  let preparedHome: string | undefined;
  let closeCount = 0;
  let sandboxCount = 0;
  let spawnCount = 0;
  let finish!: (exit: LocalProcessExit) => void;
  let onSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
  let command: PreparedLocalExecution | null = null;
  const host = new LocalExecutionHost({ retention: {
    maxOutputBytes: 1024, maxTotalOutputBytes: 4096, maxExecutions: 8,
    maxActiveExecutions: 4, completedTtlMs: 1000, maxInputRequestsPerExecution: 8,
  }, spawn(prepared, actualTty, output) {
    spawnCount += 1; command = prepared;
    let settle!: (exit: LocalProcessExit) => void;
    const exited = new Promise<LocalProcessExit>(resolve => { settle = resolve; });
    if (spawnCount === 1) finish = settle;
    expect(actualTty).toBe(tty);
    onSpawn();
    output("stdout", Buffer.from("started\n"));
    return { pid: 42, exited, write() {}, terminate() { settle({ exitCode: null, signal: "SIGKILL" }); } };
  } });
  hosts.push(host);
  const settled = new Promise<void>(resolve => { host.subscribeSettled(snapshot => { if (snapshot.executionId === "execution-a") resolve(); }); });
  const localExecution = new LocalExecutionDispatch(host);
  selected = root;
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
    relayId: "relay-a", isProduction: true, localExecution,
    protectedPathPolicy: buildProtectedPathPolicy({ homeDir: policyHome, platform: process.platform }),
    getLocalWorkspacePath: () => selected,
    resolveLocalExecutionDelegation: async binding => {
      if (!allowed || binding.authority.delegation.projectGrantId !== "task-grant") throw new Error("GRANT_REVOKED");
      return { root, grantIds: ["task-grant", "profile-tools-grant"], access: ["read", "create_modify", "delete", "execute"], dataDir: join(root, "private"),
        readOnlyRoots: [], writableRoots: [], networkPolicy: { mode: "isolated" },
        ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }), isCurrent: () => allowed };
    },
    createSandbox: async (envelope, authority) => {
      sandboxCount += 1;
      expect(envelope.config.networkPolicy).toEqual({ mode: "isolated" });
      expect(envelope.config.passthroughEnv).toEqual([]); expect(envelope.config.writablePaths).toEqual([]);
      expect(envelope.workspace).toBe(root); expect(envelope.config.readOnlyPaths).toBeUndefined();
      expect(envelope.failIfNoBackend).toBe(true); preparedHome = authority?.managedHome;
      expect(preparedHome).toBeDefined(); expect(preparedHome).not.toBe(root);
      return {
        containmentActive: () => true, protectedFileMaskSupported: () => true,
        wrap: (program: string, args: readonly string[], cwd: string) => ({ program, args: [...args], cwd, env: { BUILD_TEST: "prepared" } }),
        close: () => { closeCount += 1; return Promise.resolve(); },
      } as unknown as Sandbox;
    },
  });
  const request: RelayDispatchRequest = {
    correlationId: "dispatch-a", toolName: "exec_command", args: { cmd: "printf first\nprintf second", tty, yield_time_ms: 0 },
    impact: "destructive", approvalObtained: true,
    runShellOwnerBinding: { instanceId: "instance-a", userId: "human-a", relayId: "relay-a", desktopSessionId: "desktop-a" },
    localExecutionBinding: { version: 4, authority: { kind: "delegated", roomId: "room-fixture", taskId: "task", taskRunId: "run-a",
      delegation: { version: 1, humanUserId: "human-a", agentId: "agent-a", sourceRoomId: "room-fixture", sourceConversationId: "source-thread", rootTaskId: "task",
        target: { instanceId: "instance-a", relayId: "relay-a", pairingGeneration: "raw-pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" },
        projectGrantId: "task-grant", ceiling: "basic", profile: null } }, generation: host.hostGeneration, invocationId: "call-a", executionId: "execution-a", operation: "start",
      owner: { instanceId: "instance-a", humanUserId: "human-a", agentId: "agent-a", runId: "run-a", conversationId: "conversation-a",
        relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pair-a", serverBindingId: "server-a",
        profileId: null, profileRevision: null, grantIds: ["task-grant"], grantRevision: null, protectedPolicyVersion: 1 } },
    sandboxProfile: {
      workspace: root, dataDir: join(root, "data"), toolsBin: join(root, "tools"), mode: "desktop-permissive",
      securityLevel: "standard", failIfNoBackend: true,
      config: { mode: "disabled", writablePaths: ["/"], projectPaths: ["/"], readOnlyPaths: ["/"], passthroughEnv: ["GH_TOKEN"], networkPolicy: { mode: "host" } },
    },
  };
  return { root, host, localExecution, handler, request, spawned, settled,
    select: (value: string) => { selected = value; }, revoke: () => { allowed = false; },
    home: () => preparedHome,
    finish: () => finish({ exitCode: 7, signal: null }),
    counts: () => ({ closeCount, sandboxCount, spawnCount }),
    command: () => command,
    view: { generation: host.hostGeneration, executionId: "execution-a", cursor: 0, maxBytes: 1024 },
  };
}

test("delegated preparation uses original durable root after Current Folder changes", async () => {
  const f = fixture(); f.select("/tmp/other-selection");
  expect((await f.handler(f.request)).status).toBe("ok"); await f.spawned;
  expect(f.command()?.cwd).toBe(f.root);
  expect(f.localExecution.retainedContainedRoots()).toContain(f.root);
  expect(f.home()).not.toBe(f.root); f.finish();
});
test("revoked delegated source refuses preparation without a spawn", async () => {
  const f = fixture(); f.revoke(); await f.handler(f.request);
  const result = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  expect(result.state).toBe("failed"); expect(f.counts().spawnCount).toBe(0);
});
test("exact Task grant reduction fences its retained process", async () => {
  const f = fixture(); await f.handler(f.request); await f.spawned;
  f.localExecution.fenceAll("unrelated-grant");
  expect(f.localExecution.retainedContainedRoots()).toContain(f.root);
  f.localExecution.fenceAll("task-grant");
  const result = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  expect(["cancelling", "cancelled"]).toContain(result.state);
});

test("borrowed profile root reduction cancels delegated execution outside its project root", async () => {
  const f = fixture(); await f.handler(f.request); await f.spawned;
  expect(f.localExecution.retainedContainedGrantIds()).toContain("profile-tools-grant");
  f.localExecution.fenceAll("profile-tools-grant");
  const result = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 0 });
  expect(["cancelling", "cancelled"]).toContain(result.state);
});


test("delegated transport loss cancels only Task work and preserves its retained output", async () => {
  const f = fixture(); await f.handler(f.request); await f.spawned;
  const owner = f.request.localExecutionBinding!.owner;
  const prepared: PreparedLocalExecution = { program: "/bin/sh", args: ["-c", "fixture"], cwd: f.root, env: {}, dispose() {} };
  const basic = { ...f.request.localExecutionBinding!, version: 2 as const, executionId: "foreground-basic", invocationId: "basic-call",
    authority: { kind: "basic" as const, roomId: "room", currentFolder: f.root, capabilityRevision: 1, protectedPolicyVersion: 1 },
    owner: { ...owner, grantIds: [] } };
  const shell: RelayWorkstationShellBinding = {
    version: 2, toolCallId: "development-call", relayId: "relay-a", desktopSessionId: "desktop-a", serverBindingId: "server-a",
    pairingGeneration: "pair-a", profileId: "profile", profileRevision: 1, grantIds: ["development-grant"], grantRevision: 1,
    capabilityRevision: 1, currentFolder: f.root, protectedPolicyVersion: 1,
    subject: { userId: "human-a", instanceId: "instance-a", relayId: "relay-a", agentScope: "all_owned_agents" },
    operation: "execute", executionClass: "profile_bound_sandbox",
  };
  const development = { version: 1 as const, generation: f.host.hostGeneration, operation: "start" as const,
    executionId: "foreground-development", invocationId: "development-call",
    owner: { ...owner, profileId: "profile", profileRevision: 1, grantIds: ["development-grant"], grantRevision: 1 } };
  for (const binding of [basic, development]) {
    expect(await f.localExecution.dispatch({ request: { ...f.request,
      localExecutionBinding: binding, args: { cmd: "fixture", yield_time_ms: 1 },
      ...(binding.version === 1 ? { workstationShellBinding: shell } : {}) },
      revalidate: async () => {}, prepare: async () => prepared })).toMatchObject({ status: "ok", result: { state: "running" } });
  }
  f.localExecution.fenceDelegated(); await f.settled;
  const cancelled = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  expect(cancelled).toMatchObject({ state: "cancelled", output: { data: "started\n" } });
  for (const executionId of [basic.executionId, development.executionId]) {
    expect(await f.localExecution.humanRead({ ...f.view, executionId })).toMatchObject({ state: "running", resources: "owned" });
  }
  expect(f.counts().spawnCount).toBe(3);
});

test("Human can read and stop original Task output after its active Run admission ends", async () => {
  const f = fixture(); await f.handler(f.request); await f.spawned;
  // The Human route uses the original locally retained owner, not a fresh
  // TaskRun grant or authority borrowed from the next recurrence.
  f.revoke();
  expect(await f.localExecution.humanRead(f.view)).toMatchObject({ state: "running", output: { data: "started\n" } });
  expect(["cancelling", "cancelled"]).toContain((await f.localExecution.humanRead(f.view, true)).state);
  await f.settled;
  expect(f.counts().spawnCount).toBe(1);
  expect(await f.localExecution.humanRead(f.view)).toMatchObject({ state: "cancelled", output: { data: "started\n" } });
  await assert.rejects(f.localExecution.humanRead({ ...f.view, generation: "another-generation" }), /LOCAL_EXECUTION_GENERATION_MISMATCH/);
  await assert.rejects(f.localExecution.humanRead({ ...f.view, executionId: "another-run-execution" }, true), /LOCAL_EXECUTION_NOT_FOUND/);
});


test("finite delegated grant expiry cancels a yielded process through the existing timer", async () => {
  const now = Date.now(); const lifetime = 100_000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === lifetime) expire = () => { callback(...args); };
    return schedule(callback, delay, ...args);
  });
  try {
    const f = fixture(false, now + lifetime); await f.handler(f.request); await f.spawned;
    expect(await f.localExecution.humanRead(f.view)).toMatchObject({ state: "running" });
    expect(expire).toBeDefined();
    clock.mockReturnValue(now + lifetime); expire!(); await f.settled;
    expect(await f.localExecution.humanRead(f.view)).toMatchObject({ state: "cancelled", resources: "released", output: { data: "started\n" } });
    expect(f.counts().spawnCount).toBe(1);
  } finally { timer.mockRestore(); clock.mockRestore(); }
});
