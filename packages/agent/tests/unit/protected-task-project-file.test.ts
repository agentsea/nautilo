import * as logger from "@nautilo/logger";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { RelayLocalFileRequest } from "@nautilo/relay";
import { getCurrentProtectedTaskProjectFilePort, matchesProtectedTaskProjectFilePort,
  runWithProtectedTaskProjectFilePort, type ProtectedTaskProjectFilePort } from "../../src/runtime/protected-task-project-file";
import { executeLocalFileCommand } from "../../src/tools/file/local-file-dispatch";
import { createFileTool } from "../../src/tools/file/file-tool";
import { setRelayRegistry } from "../../src/tools/invocation-service";
import { runWithRequiredOrdinaryHostContext } from "../../src/runtime/ordinary-host-dispatch-context";
import { setLiveReviewWriteGuard } from "../../src/tools/file/live-review-write-guard";

const root = "/project/nautilo-repo-docs/task-run-1";
const state = { taskRun: true, trustedExecutionEntrypoint: "background.task" as const,
  currentTaskId: "task-1", currentTaskRunId: "run-1", agentId: "agent-1", causalHumanUserId: "human-1" };
const context = { ownerId: "human-1", agentId: "agent-1", approvalObtained: true,
  zoneCtx: { currentFolder: root, workspaceRoot: root } };
function fixture() {
  const calls: RelayLocalFileRequest[] = [];
  let revoked = false;
  const port: ProtectedTaskProjectFilePort = { taskId: "task-1", taskRunId: "run-1", agentId: "agent-1",
    humanUserId: "human-1", relayId: "relay-1", workspaceRoot: root,
    async dispatch(request) {
      if (revoked) throw new Error("Task project grant revoked");
      calls.push(request);
      return { ok: true, result: JSON.stringify({ privateResult: true }) };
    } };
  return { port, calls, revoke() { revoked = true; } };
}
async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof Error ? caught.message : undefined).toContain(message);
}
afterEach(() => { setRelayRegistry(null); setLiveReviewWriteGuard(null); });

describe("private protected Task project file custody", () => {
  test("matches every invocation identity without a foreground origin", () => {
    const { port } = fixture();
    expect(matchesProtectedTaskProjectFilePort(port, state)).toBe(true);
    for (const patch of [{ currentTaskId: "other" }, { currentTaskRunId: "other" }, { agentId: "other" },
      { causalHumanUserId: "other" }, { taskRun: false }, { trustedExecutionEntrypoint: "foreground.main" as const }]) {
      expect(matchesProtectedTaskProjectFilePort(port, { ...state, ...patch })).toBe(false);
    }
  });

  test("ends borrowed ports after callback completion and restores nested custody", async () => {
    const { port, calls } = fixture();
    let escaped: ProtectedTaskProjectFilePort | null = null;
    await runWithProtectedTaskProjectFilePort(port, async () => {
      escaped = getCurrentProtectedTaskProjectFilePort();
      expect(escaped?.taskId).toBe(port.taskId);
      await runWithProtectedTaskProjectFilePort({ ...port, taskId: "nested" }, () => {
        expect(getCurrentProtectedTaskProjectFilePort()?.taskId).toBe("nested");
      });
      expect(getCurrentProtectedTaskProjectFilePort()).toBe(escaped);
    });
    expect(getCurrentProtectedTaskProjectFilePort()).toBeNull();
    if (escaped === null) throw new Error("Missing borrowed port");
    const borrowed: ProtectedTaskProjectFilePort = escaped;
    await rejects(borrowed.dispatch({ operation: { kind: "file", command: "read", zone: "current", args: {} },
      allowedRoots: [root] }, { mutating: false, approvalObtained: false }), "custody ended");
    expect(calls).toHaveLength(0);
  });

  test("inherited asynchronous work cannot downgrade expired custody into ordinary routing", async () => {
    const { port } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let inherited: Promise<unknown> = Promise.resolve();
    await runWithProtectedTaskProjectFilePort(port, () => {
      inherited = gate.then(() => getCurrentProtectedTaskProjectFilePort());
    });
    release();
    await rejects(inherited, "custody ended");
  });

  test("suppresses private file path logs while preserving ordinary file tracing", async () => {
    const { port } = fixture();
    const log = spyOn(logger, "log").mockImplementation(() => undefined);
    const tool = createFileTool({ ownerId: port.humanUserId, agentId: port.agentId, currentFolder: root, workspacePath: root });
    try {
      await runWithProtectedTaskProjectFilePort(port, () => tool.invoke({ command: "read", zone: "current", path: "private-canary.md" }));
      expect(log).not.toHaveBeenCalled();
      await tool.invoke({ command: "read", zone: "current", path: "ordinary.md" });
      expect(log).toHaveBeenCalledWith("[file:read] path=ordinary.md zone=current");
    } finally { log.mockRestore(); }
  });

  test("reads and primary writes use only the exact private dispatcher without any registry", async () => {
    const { port, calls } = fixture();
    setRelayRegistry(null);
    await runWithProtectedTaskProjectFilePort(port, async () => {
      for (const command of ["read", "write", "insert", "str_replace"] as const) {
        expect(await executeLocalFileCommand({ command, zone: "current", path: "README.md", content: "private" }, context))
          .toBe(JSON.stringify({ privateResult: true }));
      }
    });
    expect(calls).toHaveLength(4);
    for (const request of calls) expect(request.allowedRoots).toEqual([root]);
  });

  test("revocation or host drift never retries through an ordinary filesystem owner", async () => {
    const f = fixture();
    await runWithProtectedTaskProjectFilePort(f.port, async () => {
      f.revoke();
      await rejects(executeLocalFileCommand({ command: "read", zone: "current", path: "README.md" }, context), "grant revoked");
      const result = await runWithRequiredOrdinaryHostContext({ relayId: "other-relay" }, () =>
        executeLocalFileCommand({ command: "read", zone: "current", path: "README.md" }, context));
      expect(result).toContain("host changed");
    });
    expect(f.calls).toHaveLength(0);
  });

  test("rejects parent traversal, foreign owner and artifact substitutes before dispatch", async () => {
    const { port, calls } = fixture();
    await runWithProtectedTaskProjectFilePort(port, async () => {
      expect(await executeLocalFileCommand({ command: "read", zone: "current", path: "../secret" }, context)).toContain("outside");
      expect(await executeLocalFileCommand({ command: "read", zone: "absolute", path: "/another/file" }, context)).toContain("outside");
      expect(await executeLocalFileCommand({ command: "read", zone: "current", path: "README.md" }, { ...context, ownerId: "other" })).toContain("authority changed");
      const tool = createFileTool({ ownerId: port.humanUserId, agentId: port.agentId, currentFolder: "/ambient", workspacePath: "/ambient" });
      expect(await tool.invoke({ command: "read", zone: "workspace", path: "README.md" })).toContain("captured local project");
    });
    expect(calls).toHaveLength(0);
  });

  test("does not use ambient Writer path probes for guarded structural mutations", async () => {
    const { port, calls } = fixture();
    setLiveReviewWriteGuard(() => { throw new Error("Ambient Writer probe must not run"); });
    await runWithProtectedTaskProjectFilePort(port, async () => {
      expect(await executeLocalFileCommand({ command: "delete", zone: "current", path: "README.md" }, context)).toContain("unavailable live document guard");
      expect(await executeLocalFileCommand({ command: "move", zone: "current", path: "README.md", destinationPath: "new.md" }, context)).toContain("unavailable live document guard");
    });
    expect(calls).toHaveLength(0);
  });

  test("history preflight and mutation stay in the same private custody", async () => {
    const { port, calls } = fixture();
    const history = { ...port, async dispatch(request: RelayLocalFileRequest) {
      calls.push(request);
      return { ok: true as const, result: request.operation.kind === "history" && request.operation.command === "list_revisions"
        ? JSON.stringify({ revisions: [{ canonicalPath: `${root}/README.md` }] }) : "restored" };
    } };
    setLiveReviewWriteGuard(target => {
      expect(target).toEqual({ surface: "currentFolder", ownerId: "human-1", relayId: "relay-1",
        canonicalTargetIdentities: [`${root}/README.md`] });
      return Promise.resolve(false);
    });
    await runWithProtectedTaskProjectFilePort(history, async () => {
      expect(await executeLocalFileCommand({ command: "undo", zone: "current", path: "README.md" }, context)).toBe("restored");
    });
    expect(calls.map(request => request.operation.kind === "office" ? "office" : request.operation.command)).toEqual(["list_revisions", "undo"]);
    expect(calls.every(request => request.allowedRoots.length === 1 && request.allowedRoots[0] === root)).toBe(true);
  });

  test("never falls through to Workspace history without an exact local Task reference", async () => {
    const { port, calls } = fixture();
    const tool = createFileTool({
      ownerId: port.humanUserId,
      agentId: port.agentId,
      currentFolder: root,
      workspacePath: root,
    });
    await runWithProtectedTaskProjectFilePort(port, async () => {
      expect(await tool.invoke({ command: "list_revisions" })).toContain("Task project file route is unavailable");
      expect(await tool.invoke({
        command: "pin_revision",
        revisionId: "00000000-0000-4000-8000-000000000001",
      })).toContain("Task project file route is unavailable");
      expect(await tool.invoke({
        command: "pin_revision",
        revisionId: "local:relay-1:00000000-0000-4000-8000-000000000001",
      })).toContain("revision pinning is unavailable");
      expect(await tool.invoke({
        command: "unpin_revision",
        revisionId: "local:relay-1:00000000-0000-4000-8000-000000000001",
      })).toContain("revision pinning is unavailable");
    });
    expect(calls).toHaveLength(0);
  });

  test("abort during a dispatched read suppresses its returned content", async () => {
    const { port } = fixture();
    const abort = new AbortController();
    await runWithProtectedTaskProjectFilePort({ ...port, async dispatch() {
      abort.abort(new Error("Task authority revoked"));
      return { ok: true, result: "unreleased-content" };
    } }, async () => {
      await rejects(executeLocalFileCommand({ command: "read", zone: "current", path: "README.md" },
        { ...context, signal: abort.signal }), "Task authority revoked");
    });
  });
});
