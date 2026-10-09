import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { LocalExecutionHost } from "../../electron/local-execution-host";
import { LocalExecutionDispatch } from "../../electron/relay-dispatch/local-execution";
import type { LocalProcessExit, PreparedLocalExecution } from "../../electron/local-execution-process";
mock.module("electron", () => ({ app: { getPath: () => "/tmp/full-mac-test" } }));
let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay")); });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "full-mac-fixture-")));
  let activation = "activation"; let count = 0; let command: PreparedLocalExecution | undefined;
  let finish!: (exit: LocalProcessExit) => void;
  let didSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => { didSpawn = resolve; });
  const host = new LocalExecutionHost({ retention: { maxOutputBytes: 1024, maxTotalOutputBytes: 2048, maxExecutions: 4, maxActiveExecutions: 2, completedTtlMs: 1000, maxInputRequestsPerExecution: 4 },
    spawn(prepared, tty, output) { command = prepared; count++; expect(tty).toBeFalse(); output("stdout", Buffer.from("fixture output"));
      const exited = new Promise<LocalProcessExit>(resolve => { finish = resolve; });
      didSpawn();
      return { pid: 42, exited, write: () => { throw new Error("input forbidden"); }, terminate: () => finish({ exitCode: null, signal: "SIGKILL" }) }; } });
  cleanups.push(async () => { await host.finishDisposal(); rmSync(root, { recursive: true, force: true }); });
  const settled = new Promise<void>(resolve => { host.subscribeSettled(() => { resolve(); }); });
  const localExecution = new LocalExecutionDispatch(host);
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), { relayId: "relay", isProduction: true, localExecution,
    getLocalWorkspacePath: () => root, verifyUncontainedHostCommands: async binding => binding.activationId === activation,
    createSandbox: () => { throw new Error("Full Mac must not create a contained profile"); } });
  const request: RelayDispatchRequest = { correlationId: "correlation", toolName: "exec_command", args: { cmd: "printf fixture", yield_time_ms: 100 },
    impact: "destructive", approvalObtained: true, executionClass: "real_workstation", uncontainedHostCommandsSession: true,
    runShellOwnerBinding: { instanceId: "", userId: "human", relayId: "relay", desktopSessionId: "desktop" },
    localExecutionBinding: { version: 3, generation: host.hostGeneration, executionId: "execution", invocationId: "call", operation: "start",
      localNetworkPolicy: { mode: "host" },
      authority: { kind: "full_mac", activationId: "activation", roomId: "room" }, owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "thread", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pair", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } } };
  return { handler, request, host, localExecution, root, settled, spawned, count: () => count, command: () => command, replace: () => { activation = "replacement"; },
    finish: () => finish({ exitCode: 7, signal: null }) };
}
test("Full Mac uses the managed pipe receipt and a closed local environment; released results remain readable after activation loss", async () => {
  const f = fixture(); expect(await f.handler(f.request)).toMatchObject({ status: "ok" });
  await f.spawned;
  expect(await f.localExecution.humanRead({ generation: f.host.hostGeneration, executionId: "execution", cursor: 0, maxBytes: 1024 }))
    .toMatchObject({ state: "running" });
  expect(f.command()).toMatchObject({ program: "/bin/sh", cwd: f.root, env: { HOME: homedir() } });
  expect(Object.keys(f.command()!.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
  expect(await f.handler(f.request)).toMatchObject({ status: "ok" }); expect(f.count()).toBe(1);
  f.finish(); await f.settled; f.replace();
  expect(await f.handler({ ...f.request, toolName: "write_stdin", args: { session_id: "execution", yield_time_ms: 100 }, localExecutionBinding: { ...f.request.localExecutionBinding!, operation: "read" } }))
    .toMatchObject({ status: "ok", result: { state: "completed", exitCode: 7, output: { data: "fixture output" } } });
});
test("interactive requests, missing approval, and replacement activation cannot prepare Full Mac", async () => {
  const f = fixture();
  for (const request of [{ ...f.request, args: { ...f.request.args, tty: true } }, { ...f.request, approvalObtained: false },
    { ...f.request, executionClass: undefined }, { ...f.request, toolName: "write_stdin", args: { session_id: "execution", chars: "again" }, localExecutionBinding: { ...f.request.localExecutionBinding!, operation: "input" as const } }]) {
    expect((await f.handler(request)).status).toBe("error");
  }
  f.replace(); expect(await f.handler(f.request)).toMatchObject({ status: "ok", result: { state: "failed", failureCode: "LOCAL_EXECUTION_FULL_MAC_ACTIVATION_ENDED" } }); expect(f.count()).toBe(0);
});

test("transport loss locally cancels yielded Full Mac without a server cancel frame", async () => {
  const f = fixture(); await f.handler(f.request); expect(f.count()).toBe(1);
  f.localExecution.fenceFullMac(); await f.settled;
  expect(await f.localExecution.humanRead({ generation: f.host.hostGeneration, executionId: "execution", cursor: 0, maxBytes: 1024 }))
    .toMatchObject({ state: "cancelled", signal: "SIGKILL", resources: "released" });
});

test("a restricted local-network ceiling refuses Full Mac before spawn", async () => {
  const f = fixture();
  const result = await f.handler({ ...f.request, localExecutionBinding: {
    ...f.request.localExecutionBinding!, localNetworkPolicy: { mode: "isolated" },
  } });
  expect(result).toMatchObject({ status: "ok", result: {
    state: "failed", failureCode: "LOCAL_EXECUTION_FULL_MAC_NETWORK_POLICY_UNSUPPORTED",
  } });
  expect(f.count()).toBe(0);
});
