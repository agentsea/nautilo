import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest, type RelaySandboxProfile } from "@nautilo/relay";
import type { Sandbox } from "@nautilo/sandbox";

import { prepareRelayApplyPatchDispatch } from "../../electron/apply-patch-dispatch.ts";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d565-local-file" },
}));

let createLocalFileHandlers: typeof import("../../electron/relay-dispatch/local-file.ts").createLocalFileHandlers;
let FIXED_DESKTOP_DISPATCH_NOT_HANDLED: typeof import("../../electron/relay-dispatch/router.ts").FIXED_DESKTOP_DISPATCH_NOT_HANDLED;

beforeAll(async () => {
  ({ createLocalFileHandlers } = await import("../../electron/relay-dispatch/local-file.ts"));
  ({ FIXED_DESKTOP_DISPATCH_NOT_HANDLED } = await import("../../electron/relay-dispatch/router.ts"));
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "nautilo-d565-local-file-"));
  roots.push(value);
  return value;
}

function request(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    correlationId: "d565-local-file",
    toolName: "other",
    args: {},
    impact: "read-only",
    approvalObtained: true,
    ...overrides,
  };
}

function envelope(workspace: string): RelaySandboxProfile {
  return {
    workspace,
    dataDir: workspace,
    toolsBin: "/trusted/tools",
    mode: "desktop-locked",
    securityLevel: "standard",
    failIfNoBackend: true,
    config: { mode: "enabled", writablePaths: [workspace], projectPaths: [workspace], passthroughEnv: [] },
  };
}

function readyRuntime() {
  return {
    ok: true as const,
    binaryPath: "/owned/apply-patch",
    platformKey: "darwin-arm64" as const,
    origin: "source" as const,
    runtimeVersion: "0.1.0",
    protocol: "nautilo.apply_patch/v1",
    provenance: {
      format: "nautilo.apply_patch.provenance/v1",
      upstreamRevision: "upstream",
      licenseSha256: "license",
      noticeSha256: "notice",
      rustToolchain: "stable",
      cargoLockSha256: "lock",
      nautiloExtractionRevision: "nautilo",
    },
    integrity: "pristine-byte-sha256" as const,
  };
}

function handlers(overrides: Partial<Parameters<typeof createLocalFileHandlers>[0]> = {}) {
  return createLocalFileHandlers({
    relayId: "relay-local-file",
    baseRoots: ["/tmp/base"],
    buildApplyPatchEnvelope: ({ base }) => base,
    resolveApplyPatchRuntime: async () => ({
      ok: false as const,
      code: "runtime_unavailable" as const,
      reason: "PLATFORM_UNSUPPORTED" as const,
      message: "runtime unavailable",
    }),
    createGuardedScratch: () => ({ workspace: "/tmp/scratch", protectedFileMaskPath: "/tmp/mask" }),
    ...overrides,
  });
}

describe("createLocalFileHandlers", () => {
  test("keeps non-matches inert and splits direct operations from sandboxed search", async () => {
    const family = handlers();
    const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });
    const search = request({
      toolName: "local-file",
      executionClass: "local-file",
      args: { operation: { kind: "search", command: "glob", args: {}, routing: {} } },
    });
    expect(await family.dispatchDirect({
      request: request(), guard, signal: undefined, authority: undefined, applyPatchPreparation: undefined,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    expect(await family.dispatchDirect({
      request: search, guard, signal: undefined, authority: undefined, applyPatchPreparation: undefined,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    expect(await family.dispatchSandboxedSearch({
      request: request(),
      guard,
      signal: undefined,
      authority: undefined,
      sandbox: null,
      getRipgrepRuntime: async () => {
        throw new Error("a non-search must not probe ripgrep");
      },
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
  });

  test("refuses a direct local-file request with no relay identity", async () => {
    const family = handlers({ relayId: undefined });
    const result = await family.dispatchDirect({
      request: request({ toolName: "local-file", executionClass: "local-file", args: { operation: {} } }),
      guard: createWorkspaceGuard({ workspaceRoot: "/tmp" }),
      signal: new AbortController().signal,
      authority: undefined,
      applyPatchPreparation: undefined,
    });
    expect(result).toEqual({
      handled: true,
      result: { status: "error", error: "local-file dispatch requires relayId" },
    });
  });

  test("refuses prepared apply_patch without relay identity before touching owner ports", async () => {
    const workspace = root();
    const prepared = prepareRelayApplyPatchDispatch({
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let ownerPortCalls = 0;
    const family = handlers({
      relayId: undefined,
      getLocalWorkspacePath: () => {
        ownerPortCalls += 1;
        return workspace;
      },
      protectedPathPolicy: { check: () => ({ allowed: true }) } as never,
      resolveApplyPatchRuntime: async () => {
        ownerPortCalls += 1;
        return {
          ok: false as const,
          code: "runtime_unavailable" as const,
          reason: "PLATFORM_UNSUPPORTED" as const,
          message: "must not run",
        };
      },
      buildApplyPatchEnvelope: ({ base }) => {
        ownerPortCalls += 1;
        return base;
      },
    });
    expect(await family.dispatchDirect({
      request: request({
        toolName: "local-file",
        executionClass: "local-file",
        impact: "destructive",
        sandboxProfile: envelope(workspace),
        args: {
          operation: {
            kind: "apply_patch",
            version: 1,
            patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
            routing: { zone: "current", turnId: "turn", agentId: "agent" },
          },
          expectedCurrentFolder: workspace,
        },
      }),
      guard: createWorkspaceGuard({ workspaceRoot: workspace }),
      signal: undefined,
      authority: undefined,
      applyPatchPreparation: prepared.preparation,
    })).toEqual({
      handled: true,
      result: { status: "error", error: "local-file dispatch requires relayId" },
    });
    expect(ownerPortCalls).toBe(0);
  });

  test("borrows the outer sandbox for search and never closes it", async () => {
    let closed = 0;
    const borrowed = { close: async () => { closed += 1; } } as unknown as Sandbox;
    const family = handlers();
    const result = await family.dispatchSandboxedSearch({
      request: request({
        toolName: "local-file",
        executionClass: "local-file",
        args: {
          operation: {
            kind: "search",
            command: "glob",
            args: { pattern: "*.ts" },
            routing: { zone: "current", turnId: "turn", agentId: "agent" },
          },
          allowedRoots: ["/tmp"],
        },
      }),
      guard: createWorkspaceGuard({ workspaceRoot: "/tmp" }),
      signal: new AbortController().signal,
      authority: undefined,
      sandbox: borrowed,
      getRipgrepRuntime: async () => ({ ok: false as const, error: "missing" }),
    });
    expect(result).toMatchObject({ handled: true, result: { status: "ok" } });
    expect(closed).toBe(0);
  });

  test("carries a successful apply_patch result through the extracted direct route", async () => {
    const workspace = root();
    const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
    const prepared = prepareRelayApplyPatchDispatch({
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch,
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    let executed = false;
    const result = await handlers({
      getLocalWorkspacePath: () => workspace,
      protectedPathPolicy: { check: () => ({ allowed: true }) } as never,
      resolveApplyPatchRuntime: async () => readyRuntime(),
      resolveApplyPatchTrustedIdentity: () => ({
        ownerId: "owner",
        agentId: "agent",
        turnId: "turn",
      }),
      executeApplyPatchDispatch: async (options) => {
        executed = true;
        expect(options.preparation).toBe(prepared.preparation);
        expect(options.sandboxEnvelope.workspace).toBe(workspace);
        expect(options.trustedIdentity).toEqual({
          ownerId: "owner",
          agentId: "agent",
          turnId: "turn",
        });
        const changedFile = {
          operation: "add" as const,
          path: "hello.txt",
          status: "applied" as const,
          revisionId: "revision-1",
        };
        return {
          ok: true,
          result: {
            status: "applied",
            partial: false,
            operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
            pathResults: [changedFile],
            changedFiles: [changedFile],
            revisionIds: ["revision-1"],
            unifiedDiff: "diff",
            runtimeVersion: "0.1.0",
            turnId: "turn",
          },
        };
      },
    }).dispatchDirect({
      request: request({
        toolName: "local-file",
        executionClass: "local-file",
        impact: "destructive",
        sandboxProfile: envelope(workspace),
        args: {
          operation: {
            kind: "apply_patch",
            version: 1,
            patch,
            routing: { zone: "current", turnId: "turn", agentId: "agent" },
          },
          expectedCurrentFolder: workspace,
        },
      }),
      guard: createWorkspaceGuard({ workspaceRoot: workspace }),
      signal: undefined,
      authority: undefined,
      applyPatchPreparation: prepared.preparation,
    });

    expect(executed).toBe(true);
    expect(result).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: {
          status: "applied",
          changedFiles: [{ path: "hello.txt", revisionId: "revision-1" }],
        },
      },
    });
  });

  test("keeps apply_patch stale/protected and runtime refusals local", async () => {
    const workspace = root();
    const prepared = prepareRelayApplyPatchDispatch({
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const relayRequest = request({
      toolName: "local-file",
      executionClass: "local-file",
      impact: "destructive",
      sandboxProfile: envelope(workspace),
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    const stale = await handlers({ getLocalWorkspacePath: () => "/tmp/other", protectedPathPolicy: { check: () => ({ allowed: true }) } as never })
      .dispatchDirect({ request: relayRequest, guard: createWorkspaceGuard({ workspaceRoot: workspace }), signal: undefined, authority: undefined, applyPatchPreparation: prepared.preparation });
    expect(stale).toMatchObject({ handled: true, result: { errorCode: "stale_context" } });

    const protectedResult = await handlers({ getLocalWorkspacePath: () => workspace, protectedPathPolicy: { check: () => ({ allowed: false }) } as never })
      .dispatchDirect({ request: relayRequest, guard: createWorkspaceGuard({ workspaceRoot: workspace }), signal: undefined, authority: undefined, applyPatchPreparation: prepared.preparation });
    expect(protectedResult).toMatchObject({ handled: true, result: { errorCode: "denied_path" } });

    const unavailable = await handlers({ getLocalWorkspacePath: () => workspace, protectedPathPolicy: { check: () => ({ allowed: true }) } as never })
      .dispatchDirect({ request: relayRequest, guard: createWorkspaceGuard({ workspaceRoot: workspace }), signal: undefined, authority: undefined, applyPatchPreparation: prepared.preparation });
    expect(unavailable).toEqual({
      handled: true,
      result: { status: "error", errorCode: "runtime_unavailable", error: "runtime unavailable" },
    });
  });

  test("uses exact Current Folder identity for apply_patch commit reauthorization", async () => {
    const workspace = root();
    const prepared = prepareRelayApplyPatchDispatch({
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const relayRequest = request({
      toolName: "local-file",
      executionClass: "local-file",
      impact: "destructive",
      sandboxProfile: envelope(workspace),
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
          routing: { zone: "current", turnId: "turn", agentId: "agent" },
        },
        expectedCurrentFolder: workspace,
      },
    });
    let resolvedCurrentFolder: string | undefined;
    const family = handlers({
      getLocalWorkspacePath: () => workspace,
      protectedPathPolicy: { check: () => ({ allowed: true }) } as never,
      resolveApplyPatchRuntime: async () => readyRuntime(),
      buildApplyPatchEnvelope: (input) => {
        resolvedCurrentFolder = input.currentFolder;
        throw new Error("stop before native execution");
      },
    });

    expect(await family.dispatchDirect({
      request: relayRequest,
      guard: createWorkspaceGuard({ workspaceRoot: workspace }),
      signal: undefined,
      authority: undefined,
      applyPatchPreparation: prepared.preparation,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "denied_path",
        error: "apply_patch local sandbox envelope is unavailable",
      },
    });
    expect(resolvedCurrentFolder).toBe(realpathSync(workspace));

    expect(await handlers({
      getLocalWorkspacePath: () => workspace,
      protectedPathPolicy: { check: () => ({ allowed: false }) } as never,
    }).dispatchDirect({
      request: relayRequest,
      guard: createWorkspaceGuard({ workspaceRoot: workspace }),
      signal: undefined,
      authority: undefined,
      applyPatchPreparation: prepared.preparation,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "denied_path",
        error: "Current Folder is protected",
      },
    });
  });
});
