import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@nautilo/sandbox";
import {
  createWorkspaceGuard, RELAY_WORKSTATION_SHELL_BINDING_VERSION, RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  type RelayDispatchRequest, type RelayWorkstationShellBinding,
} from "@nautilo/relay";
import { DesktopRelaySession } from "../../electron/desktop-relay-session";
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

function fixture(tty = false, revokeDuringPreparation = false, authorityExpiresAt?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-integration-")));
  roots.push(root);
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
  const binding: RelayWorkstationShellBinding = {
    version: RELAY_WORKSTATION_SHELL_BINDING_VERSION, toolCallId: "call-a",
    relayId: "relay-a", desktopSessionId: "desktop-a", serverBindingId: "server-a", pairingGeneration: "pair-a",
    profileId: "profile-a", profileRevision: 1, grantIds: ["grant-a"], capabilityRevision: 1,
    currentFolder: root, grantRevision: 1, protectedPolicyVersion: 1,
    subject: { userId: "human-a", instanceId: "instance-a", relayId: "relay-a", agentScope: "all_owned_agents" },
    operation: "execute", executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  };
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
    relayId: "relay-a", isProduction: true, localExecution,
    getLocalWorkspacePath: () => root,
    localShellWorkspaceAuthority: async () => ({ ok: true, workspace: root, ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }) }),
    workstationShellBindingAuthority: async () => sandboxCount > 0 && revokeDuringPreparation
      ? { ok: false, code: "GRANT_REVOKED" }
      : { ok: true, roots: [root], readOnlyRoots: [], writableRoots: [root], grantIds: ["grant-a"], networkPolicy: { mode: "host" } },
    createGuardedShellScratch: () => ({ workspace: root, protectedFileMaskPath: join(root, "mask") }),
    createSandbox: async (envelope) => {
      sandboxCount += 1;
      expect(envelope.config.networkPolicy).toEqual({ mode: "host" });
      return {
        containmentActive: () => true, protectedFileMaskSupported: () => true,
        wrap: (program: string, args: readonly string[], cwd: string) => ({ program, args: [...args], cwd, env: { BUILD_TEST: "prepared" } }),
        close: () => { closeCount += 1; return Promise.resolve(); },
      } as unknown as Sandbox;
    },
  });
  const request: RelayDispatchRequest = {
    correlationId: "dispatch-a", toolName: "exec_command", args: { cmd: "printf first\nprintf second", tty, yield_time_ms: 0 },
    impact: "destructive", approvalObtained: true, workstationShellBinding: binding,
    runShellOwnerBinding: { instanceId: "instance-a", userId: "human-a", relayId: "relay-a", desktopSessionId: "desktop-a" },
    localExecutionBinding: { version: 1, generation: host.hostGeneration, invocationId: "call-a", executionId: "execution-a", operation: "start",
      owner: { instanceId: "instance-a", humanUserId: "human-a", agentId: "agent-a", runId: "run-a", conversationId: "conversation-a",
        relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pair-a", serverBindingId: "server-a",
        profileId: "profile-a", profileRevision: 1, grantIds: ["grant-a"], grantRevision: 1, protectedPolicyVersion: 1 } },
    sandboxProfile: {
      workspace: root, dataDir: join(root, "data"), toolsBin: join(root, "tools"), mode: "desktop-permissive",
      securityLevel: "standard", failIfNoBackend: true,
      config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: [], networkPolicy: { mode: "isolated" } },
    },
  };
  return { root, host, localExecution, handler, request, spawned,
    finish: () => finish({ exitCode: 7, signal: null }),
    counts: () => ({ closeCount, sandboxCount, spawnCount }),
    command: () => command,
    view: { generation: host.hostGeneration, executionId: "execution-a", cursor: 0, maxBytes: 1024 },
  };
}

describe("complete Desktop dispatch resource lifetime", () => {
  for (const tty of [false, true]) {
    test(`${tty ? "PTY" : "pipe"} retains its exact prepared sandbox after yield and releases only on actual exit`, async () => {
      const f = fixture(tty);
      expect((await f.handler(f.request)).status).toBe("ok");
      await f.spawned;
      expect(f.counts()).toEqual({ sandboxCount: 1, spawnCount: 1, closeCount: 0 });
      expect(f.command()).toMatchObject({ program: "/bin/sh", args: ["-c", "printf first\nprintf second"], cwd: f.root, env: { BUILD_TEST: "prepared" } });
      expect((await f.localExecution.humanRead(f.view)).state).toBe("running");
      f.finish();
      await f.host.finishDisposal();
      expect(f.counts().closeCount).toBe(1);
      const receipt = await f.localExecution.humanRead(f.view);
      expect(receipt.exitCode).toBe(7);
      expect(receipt.output.data).toBe("started\n");
      expect(receipt.resources).toBe("released");
    });
  }

  test("an explicit current-directory workdir launches in the authorized Current Folder", async () => {
    const f = fixture();
    expect((await f.handler({ ...f.request, args: { ...f.request.args, workdir: "." } })).status).toBe("ok");
    await f.spawned;
    expect(f.command()).toMatchObject({ cwd: f.root });
    expect(f.counts().spawnCount).toBe(1);
  });

  test("managed traversal workdirs remain rejected with a stable receipt code", async () => {
    const f = fixture();
    expect((await f.handler({ ...f.request, args: { ...f.request.args, workdir: "../outside" } })).status).toBe("ok");
    const ownerKey = localExecutionOwnerKey(f.request.localExecutionBinding!.owner);
    const receipt = await f.host.read({ executionId: f.view.executionId, ownerKey, cursor: 0, maxBytes: 1024, yieldMs: 100 });
    expect(receipt.state).toBe("failed");
    expect(receipt.failureCode).toBe("WORKSTATION_CWD_TRAVERSAL");
    expect(f.counts().spawnCount).toBe(0);
  });

  test("grant revoked during asynchronous sandbox preparation prevents spawn and closes once", async () => {
    const f = fixture(false, true);
    expect((await f.handler({ ...f.request, args: { ...f.request.args, yield_time_ms: 100 } })).status).toBe("ok");
    const receipt = await f.localExecution.humanRead(f.view);
    expect(receipt.state).toBe("failed");
    expect(receipt.failureCode).toBe("GRANT_REVOKED");
    expect(f.counts()).toEqual({ sandboxCount: 1, spawnCount: 0, closeCount: 1 });
  });

  test("Current Folder refresh preserves the execution generation and retained receipt until real retirement", async () => {
    const session = new DesktopRelaySession({ serverUrl: "https://server.example" });
    const host = session.localExecution.host;
    const generation = host.hostGeneration;
    const read = { executionId: "retained", ownerKey: "owner", cursor: 0, maxBytes: 1024, yieldMs: 100 };
    host.start({ executionId: read.executionId, ownerKey: read.ownerKey, requestIdentity: "request",
      requestFingerprint: "command", hostGeneration: generation, tty: false,
      prepare: async () => { throw new Error("deterministic preparation failure"); },
    });
    const receipt = await host.read(read);
    expect(receipt.state).toBe("failed");
    let refreshed = 0;
    session.attachCurrentFolderRefresh(() => { refreshed += 1; });
    expect(session.refreshCurrentFolder()).toBe(true);
    expect(refreshed).toBe(1);
    expect(host.hostGeneration).toBe(generation);
    expect(await host.read(read)).toEqual(receipt);
    session.retire();
    await session.finishRetirement();
    expect(session.refreshCurrentFolder()).toBe(false);
    expect(refreshed).toBe(1);
  });

  test("the locally derived grant deadline stops an active process and releases its sandbox", async () => {
    const f = fixture(false, false, Date.now() + 100);
    expect((await f.handler(f.request)).status).toBe("ok");
    await f.spawned;
    const receipt = await f.host.read({ executionId: "execution-a",
      ownerKey: localExecutionOwnerKey(f.request.localExecutionBinding!.owner),
      cursor: Buffer.byteLength("started\n"), maxBytes: 1024, yieldMs: 500 });
    expect(receipt.state).toBe("cancelled");
    expect(receipt.signal).toBe("SIGKILL");
    expect(f.counts().closeCount).toBe(1);
  });

  test("replacing the original folder prevents model continuation while retaining the Human receipt", async () => {
    const f = fixture();
    expect((await f.handler(f.request)).status).toBe("ok");
    await f.spawned;
    const moved = `${f.root}-original`;
    renameSync(f.root, moved);
    roots.push(moved);
    mkdirSync(f.root);
    const result = await f.handler({ ...f.request, toolName: "write_stdin",
      args: { session_id: "execution-a", yield_time_ms: 0 },
      localExecutionBinding: { ...f.request.localExecutionBinding!, operation: "read", invocationId: "read-a" },
    });
    expect(result).toMatchObject({ status: "error", errorCode: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" });
    expect((await f.localExecution.humanRead(f.view)).output.data).toBe("started\n");
  });

  test("already-aborted owning run never prepares or starts a process", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await f.handler(f.request, controller.signal);
    expect(result).toMatchObject({ status: "ok", result: { state: "cancelled" } });
    expect(f.counts()).toEqual({ sandboxCount: 0, spawnCount: 0, closeCount: 0 });
  });
});
