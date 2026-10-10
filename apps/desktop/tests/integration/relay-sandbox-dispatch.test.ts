/**
 * Relay dispatch retirement, sandbox-lifecycle, and filesystem-grant
 * regressions. These tests prove dispatch contracts, not OS containment.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
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

let createLocalShellWorkspaceAuthorityResolver: typeof import("../../electron/relay").createLocalShellWorkspaceAuthorityResolver;
let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let createDesktopFilesystemGrantAuthorityResolver: typeof import("../../electron/relay").createDesktopFilesystemGrantAuthorityResolver;
let createStartRelayDesktopFilesystemGrantAuthority: typeof import("../../electron/relay").createStartRelayDesktopFilesystemGrantAuthority;
let buildDesktopFilesystemGrantSnapshot: typeof import("../../electron/relay").buildDesktopFilesystemGrantSnapshot;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    createLocalShellWorkspaceAuthorityResolver,
    createDesktopFilesystemGrantAuthorityResolver,
    createStartRelayDesktopFilesystemGrantAuthority,
    buildDesktopFilesystemGrantSnapshot,
  } = await import("../../electron/relay"));
});

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
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
    // Default a minimal envelope so tests that
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

describe("makeDispatchHandler — desktop dispatch and retired shell boundaries", () => {

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

  test("retired run_shell requests refuse before sandbox construction or host effects", async () => {
    const workspace = mkTmp("relay-retired-shell-");
    const effectPath = join(workspace, "must-not-exist");
    let sandboxCreations = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      createSandbox: () => {
        sandboxCreations += 1;
        throw new Error("retired execution reached sandbox construction");
      },
    });

    try {
      for (const request of [
        mkRequest({ args: { command: `/usr/bin/touch ${effectPath}` } }),
        mkRequest({
          executionClass: "real_workstation",
          uncontainedHostCommandsSession: true,
          approvalObtained: true,
          args: { command: `/usr/bin/touch ${effectPath}`, execution: "workstation" },
        }),
        mkRequest({
          impact: "destructive",
          approvalObtained: true,
          args: { command: `/usr/bin/touch ${effectPath}` },
        }),
      ]) {
        const result = await handler(request);
        expect(result).toMatchObject({
          status: "error",
          errorCode: "LOCAL_EXECUTION_UPGRADE_REQUIRED",
        });
        expect(result.status === "error" && result.error).toContain("exec_command and write_stdin");
        expect(result.status === "error" && result.error).toContain("Saved output remains readable");
      }
      expect(sandboxCreations).toBe(0);
      expect(await fsp.stat(effectPath).then(() => true, () => false)).toBeFalse();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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

  test("closes per-request sandbox even when toolName is unknown (removed tools still close the sandbox)", async () => {
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
        // list_directory is removed from the relay surface; the
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

// ---------------------------------------------------------------------------
// local desktop-filesystem-grant authority resolution + dispatch enforcement
// ---------------------------------------------------------------------------

const GRANT_SUBJECT = {
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
    subject: { ...GRANT_SUBJECT },
    createdBy: GRANT_SUBJECT.userId,
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
    subject: { ...GRANT_SUBJECT },
    policy: { policyVersion: 1, lifetime: "durable" },
    ...overrides,
  } as NonNullable<RelayDispatchRequest["desktopFilesystemGrantRequest"]>;
}

const grantPolicy = buildProtectedPathPolicy({ homeDir: homedir(), platform: process.platform });

describe("Desktop-filesystem-grant authority resolver", () => {
  test("startup wiring binds the documented durable scope and rejects server-only grant data", async () => {
    const baseRoot = mkTmp("grant-startup-store-");
    const startSubject = {
      userId: "user-1",
      instanceId: "inst-1",
      relayId: "relay-1",
      // The durable Desktop convention: any Genie agent for this exact
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
        correlationId: "grant-startup-server-only",
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
    });
    const res = await resolve({
      concreteOperation: "read",
    });
    expect(res).toMatchObject({ ok: true, hasAuthority: false, roots: [] });
  });

  test("undeterminable operation is rejected, never defaulted to read", async () => {
    const resolve = createDesktopFilesystemGrantAuthorityResolver({
      store: stubStore([makeGrant("/tmp/granted")]),
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: { ...GRANT_SUBJECT, relayId: "relay-OTHER" },
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted", { operation: "create_modify" }),
      concreteOperation: "create_modify",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("OPERATION_UPGRADE");
  });

  test("protected path is denied even when a grant authorizes it", async () => {
    const testHome = mkTmp("grant-protected-home-");
    const protectedRoot = join(testHome, ".ssh");
    try {
      await fsp.mkdir(protectedRoot);
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(protectedRoot)]),
        expectedSubject: GRANT_SUBJECT,
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
    const safeRoot = mkTmp("grant-broad-safe-");
    try {
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant("/")]),
        expectedSubject: GRANT_SUBJECT,
        protectedPathPolicy: grantPolicy,
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
    const parent = mkTmp("grant-broad-symlink-");
    const protectedTarget = mkTmp("grant-protected-target-");
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
        expectedSubject: GRANT_SUBJECT,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
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
      expectedSubject: GRANT_SUBJECT,
      protectedPathPolicy: grantPolicy,
    });
    const res = await resolve({
      request: grantRequest("/tmp/granted", { policy: { policyVersion: 2, lifetime: "durable" } }),
      concreteOperation: "read",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DESKTOP_FILESYSTEM_GRANT_STALE");
  });

  test("a valid local grant is admitted with the validated root as authority", async () => {
    const grantRoot = mkTmp("grant-admit-");
    try {
      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(grantRoot)]),
        expectedSubject: GRANT_SUBJECT,
        protectedPathPolicy: grantPolicy,
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

describe("Grant operation derivation", () => {
  test("maps fs and local-file operations; rejects the undeterminable", () => {
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

describe("makeDispatchHandler — filesystem dispatch enforcement", () => {
  test("desktop-filesystem-grant fs dispatch is admitted only within the validated root", async () => {
    const baseRoot = mkTmp("grant-base-");
    const grantRoot = mkTmp("grant-grant-");
    const serverRoot = mkTmp("grant-server-");
    try {
      await fsp.writeFile(join(grantRoot, "inside.txt"), "inside");
      await fsp.writeFile(join(serverRoot, "secret.txt"), "server-secret");

      const resolve = createDesktopFilesystemGrantAuthorityResolver({
        store: stubStore([makeGrant(grantRoot)]),
        expectedSubject: GRANT_SUBJECT,
        protectedPathPolicy: grantPolicy,
      });
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: baseRoot }),
        { relayId: "relay-1", desktopFilesystemGrantAuthority: resolve },
      );

      // Server tries to widen with allowedRoots=[serverRoot]; only grantRoot
      // (the validated authority) may be reached.
      const okRes = await handler({
        correlationId: "grant-fs-ok",
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
        correlationId: "grant-fs-widen",
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
    const baseRoot = mkTmp("grant-noresolver-");
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: baseRoot }),
        { relayId: "relay-1" },
      );
      const res = await handler({
        correlationId: "grant-fs-noresolver",
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
// advisory active-grant snapshot construction + non-authority guarantee
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

describe("Advisory grant snapshot builder", () => {
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
    const grantRoot = mkTmp("grant-snapshot-nonauthority-");
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
        protectedPathPolicy: grantPolicy,
      });
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: grantRoot }),
        { relayId: SNAPSHOT_SUBJECT.relayId, desktopFilesystemGrantAuthority: resolve },
      );
      const res = await handler({
        correlationId: "grant-snapshot-nonauthority",
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

describe("Task grants do not change ordinary workspace selection", () => {
  test("active and revoked Task grants preserve baseline; ordinary revocation still denies", async () => {
    const workspace = mkTmp("relay-task-scope-");
    let grants: DesktopFilesystemGrant[] = [];
    try {
      const resolver = createLocalShellWorkspaceAuthorityResolver({
        expectedSubject: GRANT_SUBJECT,
        protectedPathPolicy: buildProtectedPathPolicy({ homeDir: "/fixture/home", platform: process.platform }),
        store: { list: async () => ({ ok: true, data: { revision: 1, grants: grants.map(grant => ({ grant, status: grantStatus(grant) })) } }) },
      });
      expect((await resolver(workspace)).ok).toBe(true);
      grants = [makeGrant(workspace, { subject: { ...GRANT_SUBJECT, agentScope: "task:root" } })];
      expect((await resolver(workspace)).ok).toBe(true);
      grants = [{ ...grants[0]!, revokedAt: "2020-01-02T00:00:00.000Z" }];
      expect((await resolver(workspace)).ok).toBe(true);
      grants.push(makeGrant(workspace, { id: "ordinary", revokedAt: "2020-01-02T00:00:00.000Z" }));
      expect(await resolver(workspace)).toMatchObject({ ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
