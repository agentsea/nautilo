import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createWorkspaceGuard } from "@nautilo/relay";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkstationShellHost } from "../../electron/workstation-shell-host";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d486-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay"));
});

const workspace = process.cwd();
const temporaryWorkspaces: string[] = [];

afterEach(() => {
  for (const root of temporaryWorkspaces.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-d497-workstation-"));
  temporaryWorkspaces.push(root);
  return root;
}

describe("D486 real workstation dispatch", () => {
  test("uses the Electron-owned Current Folder when cwd is omitted or absolute", async () => {
    const calls: Array<{
      command: string;
      cwd: string;
      workspacePath?: string;
      isCurrentWorkspace?: () => boolean;
      timeoutMs?: number;
    }> = [];
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      isProduction: true,
      getLocalWorkspacePath: () => workspace,
      runWorkstationShell: async (request) => {
        calls.push(request);
        return { status: "ok", result: { stdout: "authenticated", stderr: "" } };
      },
    });

    const omittedCwdResult = await handler({
      correlationId: "d486-ok",
      toolName: "run_shell",
      args: {
        command: "gh auth status",
        execution: "workstation",
      },
      timeout: 12_000,
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });

    const absoluteCwdResult = await handler({
      correlationId: "d486-absolute-cwd-ignored",
      toolName: "run_shell",
      args: {
        command: "gh auth status",
        execution: "workstation",
        cwd: "/server-controlled/path",
      },
      timeout: 12_000,
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });

    expect(omittedCwdResult).toEqual({
      status: "ok",
      result: { stdout: "authenticated", stderr: "" },
    });
    expect(absoluteCwdResult).toEqual({
      status: "ok",
      result: { stdout: "authenticated", stderr: "" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "gh auth status",
      cwd: workspace,
      workspacePath: workspace,
      timeoutMs: 12_000,
    });
    expect(calls[1]).toMatchObject({
      command: "gh auth status",
      cwd: workspace,
      workspacePath: workspace,
      timeoutMs: 12_000,
    });
    expect(calls[0]?.isCurrentWorkspace?.()).toBe(true);
    expect(calls[1]?.isCurrentWorkspace?.()).toBe(true);
  });

  test("rejects an empty Electron Current Folder before the workstation executor", async () => {
    let calls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      getLocalWorkspacePath: () => "",
      runWorkstationShell: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });

    const result = await handler({
      correlationId: "d486-empty-current-folder",
      toolName: "run_shell",
      args: { command: "pwd", execution: "workstation" },
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("WORKSTATION_CURRENT_FOLDER_REQUIRED");
    expect(calls).toBe(0);
  });

  test("resolves a contained relative cwd beneath the Electron-selected Current Folder", async () => {
    const root = makeWorkspace();
    const child = join(root, "nautilo", "packages");
    mkdirSync(child, { recursive: true });
    const calls: Array<{
      command: string;
      cwd: string;
      workspacePath?: string;
      isCurrentWorkspace?: () => boolean;
    }> = [];
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
      getLocalWorkspacePath: () => root,
      runWorkstationShell: async (request) => {
        calls.push(request);
        return { status: "ok", result: { stdout: "ok", stderr: "" } };
      },
    });

    const result = await handler({
      correlationId: "d497-contained-relative",
      toolName: "run_shell",
      args: { command: "pwd", execution: "workstation", cwd: "nautilo/packages" },
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "pwd",
      cwd: realpathSync(child),
      workspacePath: realpathSync(root),
    });
    expect(calls[0]?.isCurrentWorkspace?.()).toBe(true);
  });

  test("rejects unsafe or unavailable server cwd values before the workstation executor", async () => {
    const root = makeWorkspace();
    const child = join(root, "nautilo");
    const protectedChild = join(root, "protected");
    const outside = makeWorkspace();
    mkdirSync(child);
    mkdirSync(protectedChild);
    writeFileSync(join(root, "not-a-directory"), "x");
    symlinkSync(outside, join(root, "escape"));
    let calls = 0;
    const canonicalProtectedChild = realpathSync(protectedChild);
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
      getLocalWorkspacePath: () => root,
      protectedPathPolicy: {
        check: (candidate) => ({ allowed: candidate !== canonicalProtectedChild }),
      } as never,
      runWorkstationShell: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });
    const dispatch = async (cwd: unknown) =>
      await handler({
        correlationId: `d497-denied-${String(cwd)}`,
        toolName: "run_shell",
        args: { command: "pwd", execution: "workstation", cwd },
        impact: "low",
        approvalObtained: true,
        executionClass: "real_workstation",
      });

    expect((await dispatch("../outside")).errorCode).toBe("WORKSTATION_CWD_TRAVERSAL");
    expect((await dispatch("nautilo/./child")).errorCode).toBe("WORKSTATION_CWD_INVALID");
    expect((await dispatch("nautilo\0child")).errorCode).toBe("WORKSTATION_CWD_INVALID");
    expect((await dispatch({ path: "nautilo" })).errorCode).toBe("WORKSTATION_CWD_INVALID");
    expect((await dispatch("missing")).errorCode).toBe("WORKSTATION_CWD_MISSING");
    expect((await dispatch("not-a-directory")).errorCode).toBe("WORKSTATION_CWD_NOT_DIRECTORY");
    expect((await dispatch("escape")).errorCode).toBe("WORKSTATION_CWD_OUTSIDE_CURRENT_FOLDER");
    expect((await dispatch("protected")).errorCode).toBe("WORKSTATION_CWD_PROTECTED");
    expect(calls).toBe(0);
  });

  test("fails closed when the Electron-selected Current Folder changes before spawn", async () => {
    const root = makeWorkspace();
    const replacement = makeWorkspace();
    let selectedRoot = root;
    let spawns = 0;
    const host = createWorkstationShellHost({
      resolveSubject: async () => ({
        instanceId: "instance-1",
        userId: "user-1",
        relayId: "relay-1",
        serverOrigin: "https://nautilo.example",
        pairingFingerprint: "pairing-1",
      }),
      requestConsent: async () => {
        selectedRoot = replacement;
        return "session";
      },
      spawnProcess: (() => {
        spawns += 1;
        throw new Error("must not spawn after Current Folder drift");
      }) as never,
    });
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
      getLocalWorkspacePath: () => selectedRoot,
      runWorkstationShell: (request) => host.execute(request),
    });

    const result = await handler({
      correlationId: "d497-current-folder-drift",
      toolName: "run_shell",
      args: { command: "pwd", execution: "workstation" },
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });

    expect(result.errorCode).toBe("WORKSTATION_CURRENT_FOLDER_STALE");
    expect(spawns).toBe(0);
  });

  test("fails closed without Electron executor", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      getLocalWorkspacePath: () => workspace,
    });
    const result = await handler({
      correlationId: "d486-no-host",
      toolName: "run_shell",
      args: { command: "gh auth status", execution: "workstation" },
      impact: "low",
      approvalObtained: true,
      executionClass: "real_workstation",
    });
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("WORKSTATION_EXECUTOR_UNAVAILABLE");
  });

  test("rejects missing approval and structured Git", async () => {
    let calls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      getLocalWorkspacePath: () => workspace,
      runWorkstationShell: async () => {
        calls += 1;
        return { status: "ok" };
      },
    });
    const unapproved = await handler({
      correlationId: "d486-unapproved",
      toolName: "run_shell",
      args: { command: "git status", execution: "workstation" },
      impact: "low",
      approvalObtained: false,
      executionClass: "real_workstation",
    });
    const structuredGit = await handler({
      correlationId: "d486-git",
      toolName: "run_shell",
      args: { git: { operation: "status" }, execution: "workstation" },
      impact: "read-only",
      approvalObtained: true,
      executionClass: "real_workstation",
    });
    expect(unapproved.errorCode).toBe("REAL_WORKSTATION_APPROVAL_REQUIRED");
    expect(structuredGit.errorCode).toBe("REAL_WORKSTATION_GIT_VARIANT_INVALID");
    expect(calls).toBe(0);
  });
});
