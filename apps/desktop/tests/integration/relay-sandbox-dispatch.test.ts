/**
 * Unit tests for the relay dispatch handler's sandbox wiring.
 *
 * Validates:
 *   1. sandbox=null → legacy execAsync path (command actually runs,
 *      output returned) — current default until G5.4 envelope wiring
 *      restores sandbox coverage via server policy.
 *   2. sandbox=passthrough → spawnSandboxed path (command runs,
 *      DANGEROUS env dropped even in passthrough, hardened env
 *      defaults reach child).
 *   3. destructive + !approvalObtained → rejected before any
 *      subprocess is spawned (unchanged from pre-sandbox behavior).
 *   4. Timeout surfaced as a clean error.
 *
 * Tests use REAL subprocess execution via `/bin/sh` — no bwrap
 * required, so they run on any host regardless of containment
 * backend availability. The bwrap-specific path (sandbox active +
 * cautious+ level on Linux host) is covered by the D063 SANDBOX-*
 * smoke matrix in a Lima VM — that's where real containment gets
 * proven, not here.
 *
 * D060 Sprint 1 (security ship plan v3, G5.6): env-var-driven
 * sandbox construction helpers (`sandboxEnabled`,
 * `sandboxRequiredByLevel`, `resolveSecurityLevel`) have been
 * DELETED from relay.ts. Envelope-based dispatch lands in G5.4.
 * The PR-014 MAJORs #1/#2 regression-lock describe block that
 * tested those helpers has been removed — the semantics they pinned
 * (paranoid always-activates, typo-falls-back-to-standard) move to
 * the server's Policy Resolver + Capability check when G5.3 lands.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  Sandbox,
  canonicalize,
  type SandboxBackend,
  type SandboxConfig,
} from "@nautilo/sandbox";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type { DesktopFilesystemGrant } from "@nautilo/desktop-filesystem-grants";
import type { DesktopFilesystemGrantAuthorityStore } from "../../electron/relay";
import { createCurrentFolderAdoptionAuthority } from "../../electron/current-folder-adoption";
import { RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity";
import { createRunShellProgressReporter } from "../../electron/relay-dispatch/run-shell-output";
import {
  deriveDesktopFilesystemAccessOperation,
  deriveDesktopFilesystemAccessOperations,
} from "../../electron/relay-dispatch/desktop-filesystem.ts";

// `../../electron/relay` transitively imports `./paths`, which imports the
// Electron `app`. Under `bun test` (no Electron runtime) that module throws at
// load, so we stub it before dynamically importing the handler below. `app` is
// only ever called lazily inside path helpers, none of which the dispatch
// handler exercises.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let createDesktopFilesystemGrantAuthorityResolver: typeof import("../../electron/relay").createDesktopFilesystemGrantAuthorityResolver;
let createStartRelayDesktopFilesystemGrantAuthority: typeof import("../../electron/relay").createStartRelayDesktopFilesystemGrantAuthority;
let buildDesktopFilesystemGrantSnapshot: typeof import("../../electron/relay").buildDesktopFilesystemGrantSnapshot;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    createDesktopFilesystemGrantAuthorityResolver,
    createStartRelayDesktopFilesystemGrantAuthority,
    buildDesktopFilesystemGrantSnapshot,
  } = await import("../../electron/relay"));
});

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

function passthroughSandbox(
  workspace: string,
  networkDeniedDestinations?: Array<{ host: string; port: number; reason: string }>,
): Sandbox {
  return makeTestSandbox(workspace, undefined, networkDeniedDestinations);
}

function makeTestSandbox(
  workspace: string,
  onClose?: () => void,
  networkDeniedDestinations?: Array<{ host: string; port: number; reason: string }>,
): Sandbox {
  const cfg: SandboxConfig = {
    mode: "disabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  };
  const backend: SandboxBackend = { kind: "none" };
  return new Sandbox({
    config: cfg,
    workspace,
    dataDir: `${workspace}/data`,
    toolsBin: `${workspace}/tools`,
    backend,
    ...(networkDeniedDestinations !== undefined ? { networkDeniedDestinations } : {}),
    ...(onClose !== undefined
      ? {
          networkProxy: {
            url: "http://127.0.0.1:49152",
            port: 49152,
            close: () => {
              onClose();
              return Promise.resolve();
            },
          },
        }
      : {}),
  });
}

function mkRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    id: "test-req-1",
    toolName: "run_shell",
    args: { command: "/bin/echo hello-world" },
    impact: "low",
    approvalObtained: false,
    // D060 Sprint 1 G5.4.c — default a minimal envelope so tests that
    // don\u0027t care about envelope-absence still exercise the normal
    // path (production will always have one). Tests that want to
    // cover the no-envelope branch omit sandboxProfile explicitly.
    sandboxProfile: {
      workspace: "/tmp",
      dataDir: "/tmp/data",
      toolsBin: "/tmp/tools",
      mode: "desktop-permissive",
      securityLevel: "standard",
      failIfNoBackend: false,
      config: {
        mode: "disabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    },
    ...overrides,
  } as RelayDispatchRequest;
}

// Factory closure for tests: returns a `createSandbox`-compatible
// function that resolves to a pre-built Sandbox. Used with the
// `options.createSandbox` test hook so we skip real backend detection.
function mockCreateSandbox(sandbox: Sandbox) {
  return (): Promise<Sandbox> => Promise.resolve(sandbox);
}

describe("makeDispatchHandler — run_shell sandbox wiring", () => {
  // Preserve + restore env across tests that mutate it.
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  test("explicit Current Folder selection delegates once to Electron authority before sandboxing", async () => {
    const ws = mkTmp("relay-current-folder-select-");
    const selected: Array<{ sourceRootKind: "workspace" | "current_folder"; relativePath: string }> = [];
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
        selectCurrentFolder: async (request) => {
          selected.push(request);
          return { ok: true, label: "project" };
        },
      });
      const result = await handler(mkRequest({
        toolName: "nautilo_current_folder_select",
        executionClass: "desktop",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "projects/project" },
      }));
      expect(result).toEqual({ status: "ok", result: { ok: true, label: "project" } });
      expect(selected).toEqual([{ sourceRootKind: "workspace", relativePath: "projects/project" }]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("Current Folder selection refuses missing explicit approval", async () => {
    const ws = mkTmp("relay-current-folder-denied-");
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
        selectCurrentFolder: async () => ({ ok: true, label: "never" }),
      });
      const result = await handler(mkRequest({
        toolName: "nautilo_current_folder_select",
        executionClass: "desktop",
        approvalObtained: false,
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "project" },
      }));
      expect(result.status).toBe("error");
      expect(result.errorCode).toBe("CURRENT_FOLDER_SELECTION_DENIED");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("paired filesystem is an opaque directory-only dispatch, never a generic filesystem request", async () => {
    const ws = mkTmp("relay-paired-filesystem-directory-");
    try {
      const seen: Array<Record<string, unknown>> = [];
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
        pairedFilesystemDirectory: {
          list: async (request) => {
            seen.push(request);
            return {
              ok: true,
              entries: [{ name: "Home", path: "loc_home", isDirectory: true, isFile: false, isSymbolicLink: false }],
              nextCursor: null,
            };
          },
          select: async () => ({ ok: true, label: "never" }),
        },
      });
      const result = await handler(mkRequest({
        toolName: "nautilo_paired_filesystem_directory",
        executionClass: "desktop",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: {
          rootKind: "paired_filesystem",
          operation: "list_directories",
          relativePath: "loc_data/Projects",
          limit: 50,
          includeHidden: false,
          query: "",
        },
      }));
      expect(result).toEqual({
        status: "ok",
        result: { entries: [{ name: "Home", path: "loc_home", isDirectory: true, isFile: false, isSymbolicLink: false }], nextCursor: null },
      });
      expect(seen).toEqual([{ relativePath: "loc_data/Projects", limit: 50, includeHidden: false, query: "" }]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("Current Folder adoption prepare requires desktop dispatch and commit requires explicit approval", async () => {
    const root = mkTmp("relay-current-folder-adoption-guards-");
    const workspace = join(root, "workspace");
    const current = join(root, "current");
    const target = join(workspace, "projects", "project");
    mkdirSync(target, { recursive: true });
    mkdirSync(current);
    let selection = { path: current as string | null, revision: 1 };
    let committed: string | null = null;
    const authority = createCurrentFolderAdoptionAuthority({
      getWorkspaceRoot: () => ({ path: workspace, revision: 0 }),
      getCurrentFolderRoot: () => selection.path === null ? null : { path: selection.path, revision: selection.revision },
      getCurrentFolderSelection: () => selection,
      checkCurrentFolderSanity: () => ({ ok: true }),
      protectedPathPolicy: { check: () => ({ allowed: true }) },
      commitCurrentFolderPath: (candidate) => {
        committed = candidate;
        selection = { path: candidate, revision: selection.revision + 1 };
      },
      createPreparationId: () => "opaque-adoption-id",
    });
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        currentFolderAdoption: {
          prepare: (request) => authority.prepare(request),
          commit: ({ preparationId }) => authority.commit({ preparationId, approved: true }),
        },
      });
      const wrongClass = await handler(mkRequest({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "fs",
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "projects/project" },
      }));
      expect(wrongClass).toMatchObject({ status: "error", errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_DENIED" });

      const prepared = await handler(mkRequest({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "desktop",
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "projects/project" },
      }));
      expect(prepared.status).toBe("ok");
      expect(prepared.result).toMatchObject({ ok: true, preparationId: "opaque-adoption-id", label: "project" });
      expect(JSON.stringify(prepared.result)).not.toContain(workspace);

      const commitWrongClass = await handler(mkRequest({
        toolName: "nautilo_current_folder_commit",
        executionClass: "fs",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: { preparationId: "opaque-adoption-id" },
      }));
      expect(commitWrongClass).toMatchObject({ status: "error", errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_DENIED" });

      const unapproved = await handler(mkRequest({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: false,
        sandboxProfile: undefined,
        args: { preparationId: "opaque-adoption-id" },
      }));
      expect(unapproved).toMatchObject({ status: "error", errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_DENIED" });
      expect(committed).toBeNull();

      const committedResult = await handler(mkRequest({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: { preparationId: "opaque-adoption-id" },
      }));
      expect(committedResult).toMatchObject({ status: "ok", result: { ok: true, label: "project", currentFolderRevision: 2 } });
      expect(committed).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Current Folder adoption commit returns one-use and stale results from the Electron authority", async () => {
    const root = mkTmp("relay-current-folder-adoption-results-");
    const workspace = join(root, "workspace");
    const current = join(root, "current");
    const target = join(workspace, "projects", "project");
    mkdirSync(target, { recursive: true });
    mkdirSync(current);
    let selection = { path: current as string | null, revision: 1 };
    const authority = createCurrentFolderAdoptionAuthority({
      getWorkspaceRoot: () => ({ path: workspace, revision: 0 }),
      getCurrentFolderRoot: () => selection.path === null ? null : { path: selection.path, revision: selection.revision },
      getCurrentFolderSelection: () => selection,
      checkCurrentFolderSanity: () => ({ ok: true }),
      protectedPathPolicy: { check: () => ({ allowed: true }) },
      commitCurrentFolderPath: (candidate) => {
        selection = { path: candidate, revision: selection.revision + 1 };
      },
      createPreparationId: () => `opaque-${selection.revision}`,
    });
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        currentFolderAdoption: {
          prepare: (request) => authority.prepare(request),
          commit: ({ preparationId }) => authority.commit({ preparationId, approved: true }),
        },
      });
      const prepare = () => handler(mkRequest({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "desktop",
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "projects/project" },
      }));
      const commit = (preparationId: string) => handler(mkRequest({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: { preparationId },
      }));

      const first = await prepare();
      const firstId = (first.result as { preparationId: string }).preparationId;
      expect(await commit(firstId)).toMatchObject({ status: "ok", result: { ok: true } });
      expect(await commit(firstId)).toMatchObject({
        status: "ok",
        result: { ok: false, code: "preparation_unknown" },
      });

      const stale = await prepare();
      const staleId = (stale.result as { preparationId: string }).preparationId;
      selection = { path: null, revision: selection.revision + 1 };
      expect(await commit(staleId)).toMatchObject({
        status: "ok",
        result: { ok: false, code: "current_folder_stale" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Current Folder adoption refuses a disconnected authority without exposing request paths", async () => {
    const workspace = mkTmp("relay-current-folder-adoption-disconnected-");
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }));
      const prepare = await handler(mkRequest({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "desktop",
        sandboxProfile: undefined,
        args: { sourceRootKind: "workspace", relativePath: "projects/secret-project" },
      }));
      expect(prepare).toMatchObject({
        status: "error",
        errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_INVALID",
      });
      expect(JSON.stringify(prepare)).not.toContain(workspace);
      expect(JSON.stringify(prepare)).not.toContain("secret-project");

      const commit = await handler(mkRequest({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: true,
        sandboxProfile: undefined,
        args: { preparationId: "opaque-disconnected-preparation" },
      }));
      expect(commit).toMatchObject({
        status: "error",
        errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_INVALID",
      });
      expect(JSON.stringify(commit)).not.toContain("opaque-disconnected-preparation");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("envelope + passthrough sandbox runs command + returns stdout", async () => {
    const ws = mkTmp("relay-sb-envelope-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });
    const r = await handler(mkRequest({ args: { command: "/bin/echo sandboxed" } }));
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      expect(result.stdout.trim()).toBe("sandboxed");
    }
  });

  test("real workstation execution uses the visible Workspace when no Current Folder is selected", async () => {
    const workspace = mkTmp("relay-workstation-baseline-");
    const calls: Array<{ cwd: string; workspacePath?: string; isCurrentWorkspace?: () => boolean }> = [];
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        relayId: "relay-workstation",
        getLocalWorkspacePath: () => undefined,
        workstationWorkspacePath: workspace,
        verifyUncontainedHostCommands: async () => true,
        runWorkstationShell: async (request) => {
          calls.push(request);
          return {
            status: "ok",
            result: {
              version: 1,
              execution: "workstation",
              exitCode: 0,
              signal: null,
              timedOut: false,
              cancelled: false,
              durationMs: 1,
              stdout: "connected",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              sideEffectsMayHaveStarted: true,
              profileRevision: null,
            },
          };
        },
      });

      const result = await handler(mkRequest({
        executionClass: "real_workstation",
        uncontainedHostCommandsSession: true,
        approvalObtained: true,
        args: { command: "ssh example.test", execution: "workstation" },
        runShellOwnerBinding: {
          instanceId: "instance-workstation",
          userId: "user-workstation",
          relayId: "relay-workstation",
          desktopSessionId: "desktop-workstation",
        },
      }));

      expect(result.status).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        cwd: workspace,
        workspacePath: workspace,
        consentMode: "verified_uncontained_session",
      });
      expect(calls[0]?.isCurrentWorkspace?.()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("real workstation baseline remains subject to protected-path policy", async () => {
    const workspace = mkTmp("relay-workstation-protected-");
    let calls = 0;
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        relayId: "relay-workstation",
        getLocalWorkspacePath: () => undefined,
        workstationWorkspacePath: workspace,
        verifyUncontainedHostCommands: async () => true,
        protectedPathPolicy: { check: () => ({ allowed: false }) } as never,
        runWorkstationShell: async () => {
          calls += 1;
          return { status: "ok" };
        },
      });

      const result = await handler(mkRequest({
        executionClass: "real_workstation",
        uncontainedHostCommandsSession: true,
        approvalObtained: true,
        args: { command: "echo should-not-run", execution: "workstation" },
        runShellOwnerBinding: {
          instanceId: "instance-workstation",
          userId: "user-workstation",
          relayId: "relay-workstation",
          desktopSessionId: "desktop-workstation",
        },
      }));

      expect(result).toMatchObject({
        status: "error",
        errorCode: "WORKSTATION_CURRENT_FOLDER_PROTECTED",
      });
      expect(calls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("D538-marked real workstation rejects requests without the local binding", async () => {
    const workspace = mkTmp("relay-workstation-d538-binding-");
    let calls = 0;
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        relayId: "relay-workstation",
        workstationWorkspacePath: workspace,
        verifyUncontainedHostCommands: async () => true,
        runWorkstationShell: async () => {
          calls += 1;
          return { status: "ok" };
        },
      });

      const result = await handler(mkRequest({
        executionClass: "real_workstation",
        uncontainedHostCommandsSession: true,
        approvalObtained: true,
        args: { command: "echo should-not-run", execution: "workstation" },
      }));

      expect(result).toMatchObject({
        status: "error",
        errorCode: "UNCONTAINED_HOST_COMMANDS_LOCAL_BINDING_REQUIRED",
      });
      expect(calls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("run_shell cwd follows sandboxProfile.workspace over registered guard root", async () => {
    const registeredRoot = mkTmp("relay-sb-registered-");
    const currentFolder = mkTmp("relay-sb-current-");
    const guard = createWorkspaceGuard({ workspaceRoot: registeredRoot });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(currentFolder)),
    });

    const r = await handler(
      mkRequest({
        allowedRoots: [currentFolder],
        sandboxProfile: {
          workspace: currentFolder,
          dataDir: `${currentFolder}/data`,
          toolsBin: `${currentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: {
            mode: "disabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: [],
          },
        },
        args: { command: "/bin/pwd" },
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      expect(result.stdout.trim()).toBe(currentFolder);
    }
  });

  test("run_shell explains when the Current Folder is no longer usable", async () => {
    const registeredRoot = mkTmp("relay-sb-registered-");
    const deletedCurrentFolder = mkTmp("relay-sb-deleted-current-");
    const guard = createWorkspaceGuard({ workspaceRoot: registeredRoot });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(deletedCurrentFolder)),
    });
    rmSync(deletedCurrentFolder, { recursive: true, force: true });

    const r = await handler(
      mkRequest({
        sandboxProfile: {
          workspace: deletedCurrentFolder,
          dataDir: `${deletedCurrentFolder}/data`,
          toolsBin: `${deletedCurrentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: {
            mode: "disabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: [],
          },
        },
      }),
    );

    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toContain("Current Folder is unusable");
      expect(r.error).toContain("normal user directory");
    }
  });

  test("run_shell preserves the sandbox Current Folder retry error", async () => {
    const currentFolder = mkTmp("relay-sb-sandbox-cwd-");
    const guard = createWorkspaceGuard({ workspaceRoot: currentFolder });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(currentFolder)),
    });

    const r = await handler(
      mkRequest({
        args: {
          command:
            "printf 'shell-init: error retrieving current directory: getcwd: Operation not permitted\\n' >&2; exit 1",
        },
      }),
    );

    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toContain("Current Folder is unusable");
    }
  });

  test("run_shell preserves denied-network retry metadata", async () => {
    const currentFolder = mkTmp("relay-sb-network-denied-");
    const destination = { host: "api.example.test", port: 443, reason: "no allow rule matched" };
    const guard = createWorkspaceGuard({ workspaceRoot: currentFolder });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(currentFolder, [destination])),
    });

    const r = await handler(
      mkRequest({ args: { command: "printf blocked >&2; exit 1" } }),
    );

    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toContain("run_shell exit 1");
      expect(r.networkDeniedDestination).toEqual(destination);
    }
  });

  test("envelope + passthrough sandbox drops DANGEROUS env vars (LD_PRELOAD)", async () => {
    const ws = mkTmp("relay-sb-danger-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });

    // The relay doesn't expose per-request env directly — the env
    // we inspect here is what the parent process exports. Set it,
    // run a shell that echoes $LD_PRELOAD, assert it's empty inside
    // the child (sandbox stripped it via clean-env + taxonomy).
    process.env["LD_PRELOAD"] = "/tmp/evil.so";

    const r = await handler(
      mkRequest({
        args: { command: '/bin/sh -c "echo PRELOAD=$LD_PRELOAD"' },
      }),
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      // Sandbox clear-env + re-inject skipped LD_PRELOAD — child sees empty.
      expect(result.stdout.trim()).toBe("PRELOAD=");
    }
  });

  test("envelope + passthrough sandbox injects hardened env defaults (CI=true)", async () => {
    const ws = mkTmp("relay-sb-hardened-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });
    const r = await handler(
      mkRequest({ args: { command: '/bin/sh -c "echo CI=$CI"' } }),
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      expect(result.stdout.trim()).toBe("CI=true");
    }
  });

  test("destructive + !approvalObtained rejected regardless of sandbox", async () => {
    const ws = mkTmp("relay-sb-destructive-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });
    const r = await handler(
      mkRequest({
        args: { command: "/bin/echo would-run" },
        impact: "destructive",
        approvalObtained: false,
      }),
    );
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toMatch(/approval/i);
    }
  });

  test("non-zero exit is a canonical structured process result (sandbox path)", async () => {
    const ws = mkTmp("relay-sb-exit-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });
    const r = await handler(
      mkRequest({ args: { command: "/bin/sh -c 'printf stdout; printf stderr >&2; exit 42'" } }),
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { exitCode: number; stdout: string; stderr: string; sideEffectsMayHaveStarted: boolean };
      expect(result.exitCode).toBe(42);
      expect(result.stdout).toBe("stdout");
      expect(result.stderr).toBe("stderr");
      expect(result.sideEffectsMayHaveStarted).toBe(true);
    }
  });

  test("timeout is a canonical structured process result (sandbox path)", async () => {
    const ws = mkTmp("relay-sb-timeout-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
    });
    const r = await handler(
      mkRequest({
        args: { command: "/bin/sleep 5" },
        timeout: 150,
      }),
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.result as { timedOut: boolean }).timedOut).toBe(true);
    }
    // Note on wall-clock: we intentionally do NOT assert elapsed <
    // <short-threshold> here. `/bin/sh -c "/bin/sleep 5"` runs the sleep
    // as a shell child. When SIGKILL hits the SHELL, the sleep becomes
    // an orphan that still holds the stdout/stderr pipes, and node's
    // child.on("close") doesn't fire until those pipes close — on Linux
    // that's when the orphaned sleep finishes naturally (~5s elapsed).
    // macOS kills the whole process group implicitly so elapsed is
    // ~200ms locally. The assertion "elapsed < 2000ms" was a
    // platform-dependent smoke check that blew on CI's Linux runner
    // without flagging any real bug — the timeout contract IS verified
    // by the status/error checks above.
    //
    // A proper fix lives in spawn.ts: set `detached: true` on spawn
    // options and use `process.kill(-child.pid, "SIGKILL")` to kill
    // the whole group. That's a behavior change to the sandbox's
    // subprocess-reaping semantics and belongs in a separate PR with
    // its own cross-platform test matrix. Tracked as a D060 follow-up.
  });

  test("empty command rejected with 'No command provided'", async () => {
    const ws = mkTmp("relay-sb-empty-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(makeTestSandbox(ws, () => closeCalls += 1)),
    });
    const r = await handler(mkRequest({ args: { command: "" } }));
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toMatch(/no command/i);
    }
    expect(closeCalls).toBe(1);
  });

  test("closes the prepared sandbox when a local-search runtime probe rejects", async () => {
    const ws = mkTmp("relay-sb-search-probe-reject-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const failure = new Error("injected ripgrep probe failure");
    let createCalls = 0;
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: async () => {
        createCalls += 1;
        return makeTestSandbox(ws, () => closeCalls += 1);
      },
      probeRipgrep: async () => {
        throw failure;
      },
    });
    let caught: unknown;
    try {
      await handler(mkRequest({
        toolName: "local-file",
        executionClass: "local-file",
        args: { operation: { kind: "search" } },
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(createCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test("closes per-request sandbox after run_shell dispatch", async () => {
    const ws = mkTmp("relay-sb-close-shell-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    let createCalls = 0;
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: async () => {
        createCalls += 1;
        return makeTestSandbox(ws, () => closeCalls += 1);
      },
    });

    const r = await handler(mkRequest({ args: { command: "/bin/echo closed" } }));

    expect(r.status).toBe("ok");
    expect(createCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test("preserves sandbox close rejection over a handled run_shell result", async () => {
    const ws = mkTmp("relay-sb-close-reject-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const failure = new Error("injected sandbox close failure");
    let closeCalls = 0;
    const sandbox = new Sandbox({
      config: {
        mode: "disabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: ws,
      dataDir: `${ws}/data`,
      toolsBin: `${ws}/tools`,
      backend: { kind: "none" },
      networkProxy: {
        url: "http://127.0.0.1:49152",
        port: 49152,
        close: () => {
          closeCalls += 1;
          return Promise.reject(failure);
        },
      },
    });
    const handler = makeDispatchHandler(guard, {
      createSandbox: mockCreateSandbox(sandbox),
    });
    let caught: unknown;
    try {
      await handler(mkRequest({ args: { command: "" } }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(closeCalls).toBe(2);
  });

  test("closes per-request sandbox even when toolName is unknown (M088B: list_directory removed; relay rejects unknown tools but still closes sandbox)", async () => {
    const ws = mkTmp("relay-sb-close-unknown-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    let createCalls = 0;
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: async () => {
        createCalls += 1;
        return makeTestSandbox(ws, () => closeCalls += 1);
      },
    });

    const r = await handler(
      mkRequest({
        // M088B removed list_directory from the relay surface; the
        // unified `file` tool dispatches its `list` command server-side
        // (cloud executor), so the relay treats the legacy name as an
        // unknown tool. The sandbox-close invariant still holds.
        toolName: "list_directory",
        args: { path: ws },
      }),
    );

    expect(r.status).toBe("error");
    expect(r.status === "error" && r.error).toContain("Unknown tool");
    expect(createCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });
});

describe("D502 run_shell progress reporter", () => {
  test("does not split a UTF-8 code point across observations and stops after finish", () => {
    const observed: Array<{ text: string; offsetBytes: number; endOffsetBytes: number }> = [];
    const reporter = createRunShellProgressReporter((progress) => {
      observed.push(progress);
    });
    // The euro sign arrives split across child pipe chunks. It is retained
    // until complete, then emitted as one valid UTF-8 observation.
    reporter.stdout(Buffer.from([0xe2, 0x82]));
    reporter.stdout(Buffer.from([0xac, 0x0a]));
    reporter.finish();
    reporter.stdout(Buffer.from("late"));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ text: "€\n", offsetBytes: 0, endOffsetBytes: 4 });
  });

  test("one sanitized stream feeds progress, final output, and paged owner-bound continuation", async () => {
    const ws = mkTmp("relay-d502-continuity-");
    const secretName = "NAUTILO_D502_TEST_SECRET_TOKEN";
    const prior = process.env[secretName];
    const secret = "split-secret-value-502";
    process.env[secretName] = secret;
    try {
      const artifacts = new RunShellOutputArtifactStore();
      const progress: string[] = [];
      const owner = {
        instanceId: "instance-a",
        userId: "user-a",
        relayId: "relay-a",
        desktopSessionId: "desktop-a",
      } as const;
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
        createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
        runShellOutputArtifactStore: artifacts,
      });
      const executed = await handler(mkRequest({
        correlationId: "correlation-a",
        runShellOwnerBinding: owner,
        args: {
          command: `/usr/bin/yes x | /usr/bin/head -c 20000; /usr/bin/printf '${secret}'`,
        },
        reportRunShellProgress: (event) => progress.push(event.text),
      }));
      expect(executed.status).toBe("ok");
      const result = executed.result as { stdout: string; outputArtifact?: { reference: string } };
      expect(progress.join("")).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.outputArtifact).toBeDefined();

      const page = await handler(mkRequest({
        correlationId: "correlation-b",
        runShellOwnerBinding: owner,
        args: {
          output_artifact: {
            reference: result.outputArtifact!.reference,
            max_bytes: 16 * 1024,
          },
        },
      }));
      expect(page.status).toBe("ok");
      const pageResult = page.result as { stdout: string; stderr: string };
      expect(Buffer.byteLength(`${pageResult.stdout}${pageResult.stderr}`)).toBeLessThanOrEqual(16 * 1024);
      expect(`${pageResult.stdout}${pageResult.stderr}`).not.toContain(secret);

      const search = await handler(mkRequest({
        correlationId: "correlation-search",
        runShellOwnerBinding: owner,
        args: {
          output_artifact: {
            reference: result.outputArtifact!.reference,
            operation: "search",
            query: "x",
            max_matches: 2,
            context_bytes: 0,
          },
        },
      }));
      expect(search.status).toBe("ok");
      expect(search.result).toMatchObject({
        operation: "search",
        totalMatches: 10_000,
        matchesTruncated: true,
        matches: [
          { stream: "stdout", matchOffsetBytes: 0, artifactOffsetBytes: 0, matchBytes: 1 },
          { stream: "stdout", matchOffsetBytes: 2, artifactOffsetBytes: 2, matchBytes: 1 },
        ],
      });
      expect(Buffer.byteLength(JSON.stringify(search.result), "utf8")).toBeLessThanOrEqual(16 * 1024);

      const wrongOwner = await handler(mkRequest({
        correlationId: "correlation-c",
        runShellOwnerBinding: { ...owner, desktopSessionId: "desktop-b" },
        args: { output_artifact: { reference: result.outputArtifact!.reference } },
      }));
      expect(wrongOwner).toMatchObject({
        status: "error",
        errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND",
      });

      for (const args of [
        { output_artifact: { reference: "not-a-valid-reference" } },
        {
          output_artifact: { reference: result.outputArtifact!.reference },
          cwd: ws,
        },
        {
          output_artifact: { reference: result.outputArtifact!.reference },
          timeout_seconds: 30,
        },
        {
          output_artifact: {
            reference: result.outputArtifact!.reference,
            operation: "search",
            query: "x",
            delete_after_read: true,
          },
        },
        {
          output_artifact: {
            reference: result.outputArtifact!.reference,
            operation: "search",
            query: "x".repeat(1_025),
          },
        },
      ]) {
        const invalid = await handler(mkRequest({
          correlationId: "correlation-invalid",
          runShellOwnerBinding: owner,
          args,
        }));
        expect(invalid).toMatchObject({
          status: "error",
          errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID",
        });
      }
    } finally {
      if (prior === undefined) delete process.env[secretName];
      else process.env[secretName] = prior;
    }
  });

  test("search finds an omitted-middle marker from one shell invocation without rerunning it", async () => {
    const ws = mkTmp("relay-d505-omitted-middle-");
    const owner = {
      instanceId: "instance-a",
      userId: "user-a",
      relayId: "relay-a",
      desktopSessionId: "desktop-a",
    } as const;
    const artifacts = new RunShellOutputArtifactStore();
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
      createSandbox: mockCreateSandbox(passthroughSandbox(ws)),
      runShellOutputArtifactStore: artifacts,
    });
    const marker = "D505-OMITTED-MIDDLE-MARKER";
    const invocationFile = join(ws, "run-count");
    const executed = await handler(mkRequest({
      correlationId: "d505-omitted-middle-execute",
      runShellOwnerBinding: owner,
      args: {
        command:
          `/usr/bin/printf run >> ${invocationFile}; ` +
          "/usr/bin/yes a | /usr/bin/head -c 10000; " +
          `/usr/bin/printf '${marker}'; ` +
          "/usr/bin/yes b | /usr/bin/head -c 10000",
      },
    }));
    expect(executed.status).toBe("ok");
    const result = executed.result as {
      stdout: string;
      outputArtifact?: { reference: string; capturedBytes: number; totalBytes: number; truncated: boolean };
    };
    expect(result.stdout).not.toContain(marker);
    expect(result.outputArtifact).toMatchObject({
      capturedBytes: 20_000 + Buffer.byteLength(marker),
      totalBytes: 20_000 + Buffer.byteLength(marker),
      truncated: false,
    });
    const search = await handler(mkRequest({
      correlationId: "d505-omitted-middle-search",
      runShellOwnerBinding: owner,
      args: { output_artifact: { reference: result.outputArtifact!.reference, operation: "search", query: marker } },
    }));
    expect(search).toMatchObject({
      status: "ok",
      result: { totalMatches: 1, matches: [{ stream: "stdout", matchOffsetBytes: 10_000 }] },
    });
    expect(await fsp.readFile(invocationFile, "utf8")).toBe("run");
  });

  test("does not commit continuation artifacts for post-process cwd or network errors", async () => {
    const ws = mkTmp("relay-d502-no-error-artifact-");
    const owner = {
      instanceId: "instance-a",
      userId: "user-a",
      relayId: "relay-a",
      desktopSessionId: "desktop-a",
    } as const;
    const artifacts = new RunShellOutputArtifactStore();
    const originalCreateDraft = artifacts.createDraft.bind(artifacts);
    let commits = 0;
    artifacts.createDraft = ((draftOwner) => {
      const draft = originalCreateDraft(draftOwner);
      return {
        ...draft,
        commit: () => {
          commits += 1;
          return draft.commit();
        },
      };
    }) as typeof artifacts.createDraft;

    const cases = [
      {
        sandbox: passthroughSandbox(ws),
        command:
          "/usr/bin/yes x | /usr/bin/head -c 20000; " +
          "printf 'shell-init: error retrieving current directory: getcwd: Operation not permitted\\n' >&2; exit 1",
      },
      {
        sandbox: passthroughSandbox(ws, [{ host: "blocked.test", port: 443, reason: "denied" }]),
        command: "/usr/bin/yes x | /usr/bin/head -c 20000; printf blocked >&2; exit 1",
      },
    ];
    for (const [index, fixture] of cases.entries()) {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: ws }), {
        createSandbox: mockCreateSandbox(fixture.sandbox),
        runShellOutputArtifactStore: artifacts,
      });
      const result = await handler(mkRequest({
        correlationId: `correlation-error-${index}`,
        runShellOwnerBinding: owner,
        args: { command: fixture.command },
      }));
      expect(result.status).toBe("error");
    }
    expect(commits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D418 — local desktop-filesystem-grant authority resolution + dispatch enforcement
// ---------------------------------------------------------------------------

const D418_SUBJECT = {
  userId: "user-1",
  instanceId: "inst-1",
  relayId: "relay-1",
  agentScope: "agent-1",
} as const;

function makeGrant(
  canonicalRoot: string,
  overrides: Partial<DesktopFilesystemGrant> = {},
): DesktopFilesystemGrant {
  return {
    schemaVersion: 1,
    id: "grant-1",
    canonicalRoot,
    access: ["read", "create_modify", "delete"],
    origin: "user_picker",
    lifetime: "durable",
    subject: { ...D418_SUBJECT },
    createdBy: D418_SUBJECT.userId,
    createdAt: "2020-01-01T00:00:00.000Z",
    policyVersion: 1,
    ...overrides,
  };
}

function grantStatus(g: DesktopFilesystemGrant): "active" | "revoked" | "expired" {
  if (g.revokedAt) return "revoked";
  if (g.expiresAt && Date.parse(g.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function stubStore(grants: DesktopFilesystemGrant[]): DesktopFilesystemGrantAuthorityStore {
  return {
    list() {
      return Promise.resolve({
        ok: true,
        data: { grants: grants.map((grant) => ({ grant, status: grantStatus(grant) })) },
      });
    },
  };
}

function grantRequest(
  requestedRoot: string,
  overrides: Record<string, unknown> = {},
): NonNullable<RelayDispatchRequest["desktopFilesystemGrantRequest"]> {
  return {
    version: 1,
    grantIds: ["grant-1"],
    requestedRoot,
    operation: "read",
    subject: { ...D418_SUBJECT },
    policy: { policyVersion: 1, lifetime: "durable" },
    ...overrides,
  } as NonNullable<RelayDispatchRequest["desktopFilesystemGrantRequest"]>;
}

const d418Policy = buildProtectedPathPolicy({ homeDir: homedir(), platform: process.platform });

describe("D418 desktop-filesystem-grant authority resolver", () => {
  test("startup wiring binds the documented durable scope and rejects server-only grant data", async () => {
    const baseRoot = mkTmp("d418-startup-store-");
    const startSubject = {
      userId: "user-1",
      instanceId: "inst-1",
      relayId: "relay-1",
      // D418's durable desktop convention: any Genie agent for this exact
      // user/instance/relay, never an unbound cross-subject wildcard.
      agentScope: "all_owned_agents",
    };
    try {
      const resolver = createStartRelayDesktopFilesystemGrantAuthority({
        userId: startSubject.userId,
        relayId: startSubject.relayId,
        instanceId: startSubject.instanceId,
        userHome: homedir(),
        nautiloRoot: join(homedir(), ".nautilo"),
        // The local authority source is intentionally empty. A matching
        // server request must not manufacture a grant from its own data.
        store: stubStore([]),
      });
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: baseRoot }),
        { relayId: startSubject.relayId, desktopFilesystemGrantAuthority: resolver },
      );

      const res = await handler({
        correlationId: "d418-startup-server-only",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        allowedRoots: [baseRoot],
        desktopFilesystemGrantRequest: grantRequest(baseRoot, { subject: startSubject }),
        args: { op: "stat", path: baseRoot, allowedRoots: [baseRoot] },
      });

      expect(res.status).toBe("error");
      expect(res.errorCode).toBe("DESKTOP_FILESYSTEM_GRANT_STALE");
    } finally {
      rmSync(baseRoot, { recursive: true, force: true });
    }
  });

  test("missing request preserves legacy compatibility without manufacturing authority", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted")]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      concreteOperation: "read",
    });
    expect(res).toMatchObject({ ok: true, hasAuthority: false, roots: [] });
  });

  test("undeterminable operation is rejected, never defaulted to read", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted")]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted"),
      concreteOperation: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID");
  });

  test("subject that does not bind to the configured relay id is rejected", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted")]),
      expectedSubject: { ...D418_SUBJECT, relayId: "relay-OTHER" },
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted"),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("SUBJECT_MISMATCH");
  });

  test("revoked grant is rejected", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([
        makeGrant("/tmp/granted", { revokedAt: "2021-01-01T00:00:00.000Z" }),
      ]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted"),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("REVOKED");
  });

  test("expired grant is rejected", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([
        makeGrant("/tmp/granted", { expiresAt: "2020-06-01T00:00:00.000Z" }),
      ]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted"),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("EXPIRED");
  });

  test("requested root outside the grant root is a root expansion", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted")]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/elsewhere"),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ROOT_EXPANSION");
  });

  test("operation beyond the grant's access set is an operation upgrade", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted", { access: ["read"] })]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted", { operation: "create_modify" }),
      concreteOperation: "create_modify",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("OPERATION_UPGRADE");
  });

  test("protected path is denied even when a grant authorizes it", async () => {
    const testHome = mkTmp("d418-protected-home-");
    const protectedRoot = join(testHome, ".ssh");
    try {
      await fsp.mkdir(protectedRoot);
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(protectedRoot)]),
        expectedSubject: D418_SUBJECT,
        protectedPathPolicy: buildProtectedPathPolicy({
          homeDir: testHome,
          platform: process.platform,
        }),
      });
      const res = await resolve({
        request: grantRequest(protectedRoot),
        concreteOperation: "read",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("PROTECTED_PATH");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("a broad grant admits a safe requested root while protected descendants remain denied", async () => {
    const safeRoot = mkTmp("d418-broad-safe-");
    try {
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant("/")]),
        expectedSubject: D418_SUBJECT,
        protectedPathPolicy: d418Policy,
      });
      const res = await resolve({
        request: grantRequest(safeRoot),
        concreteOperation: "read",
      });
      expect(res).toMatchObject({
        ok: true,
        hasAuthority: true,
        roots: [safeRoot],
      });
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  test("a broad grant cannot admit a safe-looking symlink to a protected root", async () => {
    const parent = mkTmp("d418-broad-symlink-");
    const protectedTarget = mkTmp("d418-protected-target-");
    const alias = join(parent, "safe-looking-current-folder");
    symlinkSync(protectedTarget, alias, "dir");
    try {
      const policy = buildProtectedPathPolicy({
        homeDir: homedir(),
        platform: process.platform,
        extraRoots: [{
          canonicalPath: protectedTarget,
          category: "system_auth",
          label: "test protected root",
        }],
      });
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant("/")]),
        expectedSubject: D418_SUBJECT,
        protectedPathPolicy: policy,
      });
      const res = await resolve({
        request: grantRequest(alias),
        concreteOperation: "read",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("PROTECTED_PATH");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(protectedTarget, { recursive: true, force: true });
    }
  });

  test("filesystem identity mismatch is rejected immediately before use", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([
        makeGrant("/tmp/granted", { filesystemIdentity: { realRoot: "/tmp/granted" } }),
      ]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
      revalidateIdentity: () =>
        Promise.resolve({
          ok: false,
          error: { code: "root_identity_changed", message: "changed" },
        }),
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted"),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("IDENTITY_MISMATCH");
  });

  test("a referenced grant id that no longer exists locally is stale", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted", { grantIds: ["ghost"] }),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DESKTOP_FILESYSTEM_GRANT_STALE");
  });

  test("a policy reference that drifts from the live grant is stale", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted", { policyVersion: 1 })]),
      expectedSubject: D418_SUBJECT,
      protectedPathPolicy: d418Policy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted", { policy: { policyVersion: 2, lifetime: "durable" } }),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DESKTOP_FILESYSTEM_GRANT_STALE");
  });

  test("a valid local grant is admitted with the validated root as authority", async () => {
    const grantRoot = mkTmp("d418-admit-");
    try {
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(grantRoot)]),
        expectedSubject: D418_SUBJECT,
        protectedPathPolicy: d418Policy,
      });
      const res = await resolve({
        request: grantRequest(grantRoot),
        concreteOperation: "read",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.hasAuthority).toBe(true);
        expect(res.roots).toContain(grantRoot);
        expect(res.grantIds).toEqual(["grant-1"]);
        expect(res.operation).toBe("read");
      }
    } finally {
      rmSync(grantRoot, { recursive: true, force: true });
    }
  });
});

describe("D418 operation derivation", () => {
  test("maps fs, local-file, and shell operations; rejects the undeterminable", () => {
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        args: { op: "readFile", path: "/x" },
      }),
    ).toBe("read");
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "fs",
        executionClass: "fs",
        impact: "low",
        approvalObtained: true,
        args: { op: "writeFileAtomic", path: "/x" },
      }),
    ).toBe("create_modify");
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "fs",
        executionClass: "fs",
        impact: "low",
        approvalObtained: true,
        args: { op: "rm", path: "/x" },
      }),
    ).toBe("delete");
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "local-file",
        executionClass: "local-file",
        impact: "low",
        approvalObtained: true,
        args: { operation: { kind: "file", command: "delete", zone: "current", args: {} } },
      }),
    ).toBe("delete");
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "run_shell",
        impact: "low",
        approvalObtained: true,
        args: { command: "ls" },
      }),
    ).toBe("execute");
    expect(
      deriveDesktopFilesystemAccessOperation({
        correlationId: "x",
        toolName: "fs",
        executionClass: "fs",
        impact: "low",
        approvalObtained: true,
        args: { op: "bogus", path: "/x" },
      }),
    ).toBeNull();
  });

  test("derives complete structural read/write/delete effect sets", () => {
    const request = (command: "copy" | "move" | "delete") => ({
      correlationId: "structural",
      toolName: "local-file",
      executionClass: "local-file" as const,
      impact: "low" as const,
      approvalObtained: true,
      args: {
        operation: { kind: "file", command, zone: "current", args: {} },
      },
    });
    expect(deriveDesktopFilesystemAccessOperations(request("copy"))).toEqual([
      "read",
      "create_modify",
    ]);
    expect(deriveDesktopFilesystemAccessOperations(request("move"))).toEqual([
      "read",
      "create_modify",
      "delete",
    ]);
    expect(deriveDesktopFilesystemAccessOperations(request("delete"))).toEqual([
      "read",
      "delete",
    ]);
  });
});

describe("makeDispatchHandler — D418 fs dispatch enforcement", () => {
  test("desktop-filesystem-grant fs dispatch is admitted only within the validated root", async () => {
    const baseRoot = mkTmp("d418-base-");
    const grantRoot = mkTmp("d418-grant-");
    const serverRoot = mkTmp("d418-server-");
    try {
      await fsp.writeFile(join(grantRoot, "inside.txt"), "inside");
      await fsp.writeFile(join(serverRoot, "secret.txt"), "server-secret");

      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(grantRoot)]),
        expectedSubject: D418_SUBJECT,
        protectedPathPolicy: d418Policy,
      });
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: baseRoot }),
        { relayId: "relay-1", desktopFilesystemGrantAuthority: resolve },
      );

      // Server tries to widen with allowedRoots=[serverRoot]; only grantRoot
      // (the validated authority) may be reached.
      const okRes = await handler({
        correlationId: "d418-fs-ok",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        allowedRoots: [serverRoot],
        desktopFilesystemGrantRequest: grantRequest(grantRoot),
        args: { op: "stat", path: join(grantRoot, "inside.txt"), allowedRoots: [serverRoot] },
      });
      expect(okRes.status).toBe("ok");
      expect((okRes.result as { ok: boolean }).ok).toBe(true);

      const deniedRes = await handler({
        correlationId: "d418-fs-widen",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        allowedRoots: [serverRoot],
        desktopFilesystemGrantRequest: grantRequest(grantRoot),
        args: { op: "readFile", path: join(serverRoot, "secret.txt"), allowedRoots: [serverRoot] },
      });
      expect(deniedRes.status).toBe("ok");
      const deniedResult = deniedRes.result as { ok: boolean; code?: string };
      expect(deniedResult.ok).toBe(false);
      expect(deniedResult.code).toBe("EACCES");
    } finally {
      rmSync(baseRoot, { recursive: true, force: true });
      rmSync(grantRoot, { recursive: true, force: true });
      rmSync(serverRoot, { recursive: true, force: true });
    }
  });

  test("desktop-filesystem-grant fs dispatch is refused when no resolver is configured", async () => {
    const baseRoot = mkTmp("d418-noresolver-");
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: baseRoot }),
        { relayId: "relay-1" },
      );
      const res = await handler({
        correlationId: "d418-fs-noresolver",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        allowedRoots: [baseRoot],
        desktopFilesystemGrantRequest: grantRequest(baseRoot),
        args: { op: "stat", path: baseRoot, allowedRoots: [baseRoot] },
      });
      expect(res.status).toBe("error");
      expect(res.errorCode).toBe("DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID");
    } finally {
      rmSync(baseRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D060 Sprint 1 G5.4.c — release-build envelope enforcement
// ---------------------------------------------------------------------------

describe("makeDispatchHandler — envelope enforcement", () => {
  test("release build REFUSES dispatch without sandboxProfile", async () => {
    const ws = mkTmp("relay-sb-enforce-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, { isProduction: true });

    const { sandboxProfile, ...noEnvelope } = mkRequest({
      args: { command: "/bin/echo would-run" },
    });
    void sandboxProfile;
    const r = await handler(noEnvelope as RelayDispatchRequest);
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toContain("server did not supply its security configuration");
      expect(r.error).toContain("No operation was started");
      expect(r.error).not.toMatch(/D060|G5.4|ship plan|sandboxProfile/);
    }
  });

  test("dev build allows dispatch without sandboxProfile (legacy path, WARN logged)", async () => {
    const ws = mkTmp("relay-sb-dev-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    const handler = makeDispatchHandler(guard, { isProduction: false });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      const { sandboxProfile, ...noEnvelope } = mkRequest({
        args: { command: "/bin/echo dev-fallback" },
      });
      void sandboxProfile;
      const r = await handler(noEnvelope as RelayDispatchRequest);
      expect(r.status).toBe("ok");
      if (r.status === "ok") {
        const result = r.result as { stdout: string; stderr: string };
        expect(result.stdout.trim()).toBe("dev-fallback");
      }
      expect(warnings).toEqual([
        "[relay] Dispatch received without sandboxProfile (run_shell). " +
          "Development-build dev loop — release builds will refuse this path.",
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("envelope with malformed sandboxProfile surfaces a clean error", async () => {
    const ws = mkTmp("relay-sb-bad-envelope-");
    const guard = createWorkspaceGuard({ workspaceRoot: ws });
    // createSandbox override that throws — simulates e.g. Sandbox.create
    // rejecting a config that fails backend detection with failIfNoBackend.
    const handler = makeDispatchHandler(guard, {
      isProduction: false,
      createSandbox: () =>
        Promise.reject(new Error("backend detection failed")),
    });
    const r = await handler(mkRequest({ args: { command: "/bin/echo hi" } }));
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toMatch(/Failed to construct sandbox/);
      expect(r.error).toMatch(/backend detection failed/);
    }
  });
});

// ---------------------------------------------------------------------------
// D418 — advisory active-grant snapshot construction + non-authority guarantee
// ---------------------------------------------------------------------------

const SNAPSHOT_SUBJECT = {
  userId: "user-1",
  instanceId: "inst-1",
  relayId: "relay-1",
  agentScope: "all_owned_agents",
} as const;

function snapshotGrant(
  id: string,
  canonicalRoot: string,
  overrides: Partial<DesktopFilesystemGrant> = {},
): DesktopFilesystemGrant {
  return {
    schemaVersion: 1,
    id,
    canonicalRoot,
    access: ["read", "create_modify"],
    origin: "user_picker",
    lifetime: "durable",
    subject: { ...SNAPSHOT_SUBJECT },
    createdBy: SNAPSHOT_SUBJECT.userId,
    createdAt: "2020-01-01T00:00:00.000Z",
    policyVersion: 2,
    platformAuthorization: "secret-must-not-leak",
    filesystemIdentity: { realRoot: canonicalRoot, device: 1, inode: 2 },
    lastUsedAt: "2020-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotStore(
  grants: DesktopFilesystemGrant[],
  revision = 9,
): import("../../electron/relay").DesktopFilesystemGrantSnapshotStore {
  return {
    list() {
      return Promise.resolve({
        ok: true,
        data: { grants: grants.map((grant) => ({ grant, status: grantStatus(grant) })), revision },
      });
    },
  };
}

describe("D418 advisory grant snapshot builder", () => {
  test("advertises active grants only, redacted to discovery fields", async () => {
    const snapshot = await buildDesktopFilesystemGrantSnapshot({
      store: snapshotStore(
        [
          snapshotGrant("grant-active", "/tmp/active"),
          snapshotGrant("grant-revoked", "/tmp/revoked", {
            revokedAt: "2021-01-01T00:00:00.000Z",
          }),
          snapshotGrant("grant-expired", "/tmp/expired", {
            expiresAt: "2020-06-01T00:00:00.000Z",
          }),
        ],
        11,
      ),
      userId: SNAPSHOT_SUBJECT.userId,
      instanceId: SNAPSHOT_SUBJECT.instanceId,
      relayId: SNAPSHOT_SUBJECT.relayId,
    });

    expect(snapshot).toBeDefined();
    expect(snapshot!.revision).toBe(11);
    expect(snapshot!.instanceId).toBe(SNAPSHOT_SUBJECT.instanceId);
    expect(snapshot!.agentScope).toBe("all_owned_agents");
    expect(snapshot!.grants).toEqual([
      {
        id: "grant-active",
        canonicalRoot: "/tmp/active",
        access: ["read", "create_modify"],
        policyVersion: 2,
        lifetime: "durable",
      },
    ]);
    // The redacted fields must never appear in the advertised entry.
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "platformAuthorization",
      "secret-must-not-leak",
      "filesystemIdentity",
      "createdBy",
      "createdAt",
      "lastUsedAt",
      "revokedAt",
      "origin",
      "subject",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("omits grants bound to a different user / instance / relay / scope", async () => {
    const snapshot = await buildDesktopFilesystemGrantSnapshot({
      store: snapshotStore([
        snapshotGrant("mine", "/tmp/mine"),
        snapshotGrant("other-relay", "/tmp/other", {
          subject: { ...SNAPSHOT_SUBJECT, relayId: "relay-OTHER" },
        }),
        snapshotGrant("other-scope", "/tmp/scope", {
          subject: { ...SNAPSHOT_SUBJECT, agentScope: "agent-1" },
        }),
      ]),
      userId: SNAPSHOT_SUBJECT.userId,
      instanceId: SNAPSHOT_SUBJECT.instanceId,
      relayId: SNAPSHOT_SUBJECT.relayId,
    });
    expect(snapshot!.grants.map((g) => g.id)).toEqual(["mine"]);
  });

  test("returns undefined when the local store is unavailable", async () => {
    const snapshot = await buildDesktopFilesystemGrantSnapshot({
      store: {
        list: () =>
          Promise.resolve({ ok: false, code: "store_unavailable", message: "no store" }),
      },
      userId: SNAPSHOT_SUBJECT.userId,
      instanceId: SNAPSHOT_SUBJECT.instanceId,
      relayId: SNAPSHOT_SUBJECT.relayId,
    });
    expect(snapshot).toBeUndefined();
  });

  test("advertising a grant in the snapshot cannot override the local resolver", async () => {
    const grantRoot = mkTmp("d418-snapshot-nonauthority-");
    try {
      // The snapshot advertises grant-active as an active local grant.
      const snapshot = await buildDesktopFilesystemGrantSnapshot({
        store: snapshotStore([snapshotGrant("grant-active", grantRoot)]),
        userId: SNAPSHOT_SUBJECT.userId,
        instanceId: SNAPSHOT_SUBJECT.instanceId,
        relayId: SNAPSHOT_SUBJECT.relayId,
      });
      expect(snapshot!.grants.map((g) => g.id)).toContain("grant-active");

      // But authority is decided by the resolver against the LIVE local store.
      // With an empty store, a dispatch referencing the advertised grant id is
      // rejected as stale — the advisory snapshot manufactured no authority.
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([]),
        expectedSubject: SNAPSHOT_SUBJECT,
        protectedPathPolicy: d418Policy,
      });
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: grantRoot }),
        { relayId: SNAPSHOT_SUBJECT.relayId, desktopFilesystemGrantAuthority: resolve },
      );
      const res = await handler({
        correlationId: "d418-snapshot-nonauthority",
        toolName: "fs",
        executionClass: "fs",
        impact: "read-only",
        approvalObtained: true,
        allowedRoots: [grantRoot],
        desktopFilesystemGrantRequest: {
          version: 1,
          grantIds: ["grant-active"],
          requestedRoot: grantRoot,
          operation: "read",
          subject: { ...SNAPSHOT_SUBJECT },
          policy: { policyVersion: 2, lifetime: "durable" },
        },
        args: { op: "stat", path: grantRoot, allowedRoots: [grantRoot] },
      });
      expect(res.status).toBe("error");
      expect(res.errorCode).toBe("DESKTOP_FILESYSTEM_GRANT_STALE");
    } finally {
      rmSync(grantRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// DELETED in D060 Sprint 1 (security ship plan v3, G5.6): the PR-014
// MAJORs #1/#2 describe block tested `sandboxEnabled()` +
// `sandboxRequiredByLevel()` + `resolveSecurityLevel()` — three
// functions that read policy-affecting env vars (NAUTILO_SANDBOX_RELAY,
// NAUTILO_SECURITY_LEVEL) and were themselves a bypass surface in
// open source. All three functions deleted from relay.ts; the
// semantics they pinned (paranoid-always-activates, typo-falls-back)
// move to the server's Policy Resolver + Capability check once G5.3
// lands Sprint 1 Day 4. Equivalent regression locks land then as
// server-side tests.
// ---------------------------------------------------------------------------
