import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type { Sandbox } from "@nautilo/sandbox";
import {
  createWorkspaceGuard, type RelayDispatchRequest,
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

function fixture(tty = false, protectedPolicy: "valid" | "missing" | "mismatch" = "valid") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-integration-")));
  const policyHome = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-home-")));
  roots.push(root, policyHome);
  let selected = ""; let currentRevision = 1; let allowed = true; let activeProfile = false;
  let preparedHome: string | undefined;
  let closeCount = 0;
  let sandboxCount = 0;
  let spawnCount = 0;
  let finish!: (exit: LocalProcessExit) => void;
  const exited = new Promise<LocalProcessExit>((resolve) => { finish = resolve; });
  let onSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
  let command: PreparedLocalExecution | null = null;
  const host = new LocalExecutionHost({ retention: {
    maxOutputBytes: 1024, maxTotalOutputBytes: 4096, maxExecutions: 8,
    maxActiveExecutions: 4, completedTtlMs: 1000, maxInputRequestsPerExecution: 8,
  }, spawn(prepared, actualTty, output) {
    spawnCount += 1; command = prepared;
    expect(actualTty).toBe(tty);
    onSpawn();
    output("stdout", Buffer.from("started\n"));
    return { pid: 42, exited, write() {}, terminate() { finish({ exitCode: null, signal: "SIGKILL" }); } };
  } });
  hosts.push(host);
  const localExecution = new LocalExecutionDispatch(host);
  selected = root;
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
    relayId: "relay-a", isProduction: true, localExecution,
    ...(protectedPolicy === "missing" ? {} : { protectedPathPolicy: buildProtectedPathPolicy({ homeDir: policyHome, platform: process.platform }) }),
    getLocalWorkspacePath: () => selected,
    basicExecutionAuthority: () => ({ capability: { version: 1, currentFolder: selected, serverBindingId: "server-a", protectedPolicyVersion: protectedPolicy === "mismatch" ? 2 : 1 }, capabilityRevision: currentRevision, dataDir: join(root, "private") }),
    workstationProfileStateProvider: { getProfileSnapshot: async () => activeProfile ? { profileId: "active" } as never : undefined },
    localShellWorkspaceAuthority: async (workspace) => allowed ? ({ ok: true, workspace }) : ({ ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" }),
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
    localExecutionBinding: { version: 2, authority: { kind: "basic", roomId: "room-fixture", currentFolder: root, capabilityRevision: 1, protectedPolicyVersion: 1 }, generation: host.hostGeneration, invocationId: "call-a", executionId: "execution-a", operation: "start",
      owner: { instanceId: "instance-a", humanUserId: "human-a", agentId: "agent-a", runId: "run-a", conversationId: "conversation-a",
        relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pair-a", serverBindingId: "server-a",
        profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: 1 } },
    sandboxProfile: {
      workspace: root, dataDir: join(root, "data"), toolsBin: join(root, "tools"), mode: "desktop-permissive",
      securityLevel: "standard", failIfNoBackend: true,
      config: { mode: "disabled", writablePaths: ["/"], projectPaths: ["/"], readOnlyPaths: ["/"], passthroughEnv: ["GH_TOKEN"], networkPolicy: { mode: "host" } },
    },
  };
  return { root, host, localExecution, handler, request, spawned,
    select: (value: string) => { selected = value; currentRevision++; }, revoke: () => { allowed = false; },
    profile: () => { activeProfile = true; }, home: () => preparedHome,
    finish: () => finish({ exitCode: 7, signal: null }),
    counts: () => ({ closeCount, sandboxCount, spawnCount }),
    command: () => command,
    view: { generation: host.hostGeneration, executionId: "execution-a", cursor: 0, maxBytes: 1024 },
  };
}


for (const tty of [false, true]) test(`Basic ${tty ? "PTY" : "pipe"} rebuilds hostile envelope locally and keeps original root after selection changes`, async () => {
  const f = fixture(tty); expect((await f.handler(f.request)).status).toBe("ok"); await f.spawned;
  expect(f.command()?.cwd).toBe(f.root); expect(f.counts()).toEqual({ closeCount: 0, sandboxCount: 1, spawnCount: 1 });
  f.select("/tmp/new-selection");
  const continuation = { ...f.request, toolName: "write_stdin", args: { session_id: "execution-a", ...(tty ? { chars: "once" } : {}) }, localExecutionBinding: { ...f.request.localExecutionBinding!, operation: tty ? "input" as const : "read" as const, invocationId: "input" } };
  expect((await f.handler(continuation)).status).toBe("ok");
  f.finish(); await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  expect(f.counts()).toEqual({ closeCount: 1, sandboxCount: 1, spawnCount: 1 });
});
test("Basic refuses changed selection, local policy denial and active Development before preparation", async () => {
  for (const failure of ["selection", "policy", "profile"]) {
    const f = fixture(); if (failure === "selection") f.select("/tmp/other"); else if (failure === "policy") f.revoke(); else f.profile();
    await f.handler(f.request); const result = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
    expect(result.state).toBe("failed"); expect(f.counts()).toEqual({ closeCount: 0, sandboxCount: 0, spawnCount: 0 });
  }
});
test("Basic retained reads revalidate original directory identity and protected policy", async () => {
  const f = fixture(); await f.handler(f.request); await f.spawned;
  const read = { ...f.request, toolName: "write_stdin", args: { session_id: "execution-a" }, localExecutionBinding: { ...f.request.localExecutionBinding!, operation: "read" as const } };
  f.revoke(); expect((await f.handler(read)).status).toBe("error");
  const g = fixture(); await g.handler(g.request); await g.spawned;
  const moved = `${g.root}-moved`; renameSync(g.root, moved); roots.push(moved); mkdirSync(g.root);
  expect((await g.handler({ ...read, localExecutionBinding: { ...g.request.localExecutionBinding!, operation: "read" } })).status).toBe("error");
});

test("Basic requires the actual local protected policy before any preparation", async () => {
  for (const policy of ["missing", "mismatch"] as const) {
    const f = fixture(false, policy);
    await f.handler(f.request);
    const receipt = await f.host.read({ executionId: "execution-a", ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
    expect(receipt.state).toBe("failed");
    expect(f.counts()).toEqual({ closeCount: 0, sandboxCount: 0, spawnCount: 0 });
  }
});
test("Basic continuation rejects a changed Room or wire downgrade at the Desktop consumer", async () => {
  const f = fixture(true); await f.handler(f.request); await f.spawned;
  const original = f.request.localExecutionBinding!;
  if (original.version !== 2) throw new Error("Expected Basic fixture");
  for (const operation of ["read", "input"] as const) {
    for (const changed of [
      { ...original, authority: { ...original.authority, roomId: "another-room" } },
      { version: 1 as const, generation: original.generation, invocationId: original.invocationId, executionId: original.executionId, operation: original.operation, owner: original.owner },
    ]) {
      const result = await f.handler({ ...f.request, toolName: "write_stdin", args: { session_id: original.executionId, ...(operation === "input" ? { chars: "must not write" } : {}) }, localExecutionBinding: { ...changed, operation } });
      expect(result.status).toBe("error"); expect(result.errorCode).toBe("LOCAL_EXECUTION_AUTHORITY_MISMATCH");
    }
  }
  expect(f.counts().spawnCount).toBe(1);
});
