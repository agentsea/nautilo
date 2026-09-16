import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import {
  buildApplyPatchToolContext,
  createApplyPatchExecutionRouter,
  selectApplyPatchTarget,
  type ApplyPatchRouterContext,
} from "../../src/tools/apply-patch/execution-router";
import { createApplyPatchTool } from "../../src/tools/apply-patch/apply-patch-tool";
import { setLiveReviewWriteGuard, LiveReviewTargetResolutionError, type LiveReviewWriteGuardTarget } from "../../src/tools/file/live-review-write-guard";
import { runWithRequiredOrdinaryHostContext } from "../../src/runtime/ordinary-host-dispatch-context";

const ADD_PATCH = [
  "*** Begin Patch",
  "*** Add File: src/new.ts",
  "+new",
  "*** End Patch",
].join("\n");

function workspaceEnvelope(overrides: Partial<NamespaceMemoryEnvelope> = {}): NamespaceMemoryEnvelope {
  return {
    ownerId: "owner-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: ["namespace-1"],
    mutableNamespaces: ["namespace-1"],
    writableNamespaces: ["namespace-1"],
    toolPolicy: { apply_patch: "require_prove_it" },
    ...overrides,
  };
}

function currentContext(overrides: Partial<ApplyPatchRouterContext> = {}): ApplyPatchRouterContext {
  return {
    ownerId: "owner-1",
    actorRole: "owner",
    agentId: "agent-1",
    turnId: "turn-1",
    roomId: "room-1",
    memoryAccessEnvelope: null,
    currentFolder: "/repo",
    focusedResources: [{
      kind: "local-file",
      displayName: "new.ts",
      location: "relay",
      lifetime: "turn",
      capabilities: ["read", "edit"],
      toolTarget: { tool: "file", zone: "current", path: "src/new.ts" },
      locator: { relayId: "relay-1", path: "/repo/src/new.ts" },
    }],
    ...overrides,
  };
}

function relayResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "applied",
    partial: false,
    operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
    pathResults: [{ operation: "add", path: "src/new.ts", status: "applied", bytesTouched: 4, revisionId: "rev-1" }],
    changedFiles: [{ operation: "add", path: "src/new.ts", status: "applied", bytesTouched: 4, revisionId: "rev-1" }],
    revisionIds: ["rev-1"],
    unifiedDiff: "",
    runtimeVersion: "runtime-1",
    turnId: "turn-1",
    ...overrides,
  };
}

function registry(input: {
  onDispatch?: (request: unknown, options: unknown) => void;
  result?: Record<string, unknown>;
  dispatchErrorCode?: string;
  dispatchFailureReason?: string;
  relayIds?: string[];
  onFind?: (capability: string) => void;
} = {}): ToolRelayRegistry {
  return {
    findByCapabilityForUser: (capability: string) => {
      input.onFind?.(capability);
      return input.relayIds ?? ["relay-1"];
    },
    getCapabilities: () => ({
      profile: "desktop-agent",
      localFileExecution: true,
      applyPatchExecution: true,
      // D458 routes each Current Folder request through the exact paired
      // host's advertised roots. Keep this fixture's `/repo` turn binding
      // aligned with that host while preserving a distinct permanent
      // Workspace root.
      workspaceRoot: "/workspace",
      currentFolderRoot: "/repo",
      allowedRoots: ["/repo"],
      dataDir: "/data",
      toolsBin: "/tools",
      userHome: "/home/owner",
    }),
    getProtocolVersion: () => 9,
    getUserId: () => "owner-1",
    dispatch: async () => ({ status: "error", error: "not used" }),
    applyPatchDispatch: async (_relayId: string, request: unknown, options: unknown) => {
      input.onDispatch?.(request, options);
      if (input.dispatchErrorCode !== undefined) {
        const error = Object.assign(new Error("relay apply_patch rejected"), {
          applyPatchErrorCode: input.dispatchErrorCode,
          ...(input.dispatchFailureReason === undefined
            ? {}
            : { applyPatchFailureReason: input.dispatchFailureReason }),
        });
        throw error;
      }
      return relayResult(input.result);
    },
  } as unknown as ToolRelayRegistry;
}

describe("D448 trusted apply_patch target router", () => {
  beforeEach(() => {
    setLiveReviewWriteGuard(async () => false);
  });

  afterEach(() => {
    setLiveReviewWriteGuard(null);
  });

  test("an explicit Current Folder selector resolves only the trusted relay-pinned Current Folder", () => {
    const target = selectApplyPatchTarget(currentContext({ memoryAccessEnvelope: workspaceEnvelope() }), { relayRegistry: registry() }, "current");
    expect(target).toEqual({
      ok: true,
      context: { zone: "current", root: "/repo", relayId: "relay-1", agentId: "agent-1", turnId: "turn-1" },
    });
  });

  test("a selected Current Folder pins the sole paired Desktop without requiring a focused file", () => {
    const capabilities: string[] = [];
    const target = selectApplyPatchTarget(currentContext({ focusedResources: [] }), {
      relayRegistry: registry({ onFind: (capability) => capabilities.push(capability) }),
    });
    expect(target).toEqual({
      ok: true,
      context: { zone: "current", root: "/repo", relayId: "relay-1", agentId: "agent-1", turnId: "turn-1" },
    });
    expect(capabilities).toEqual(["localFileExecution"]);
  });

  test("uses an explicit authenticated Current Folder relay before fallback and requires focused resources to agree", () => {
    const explicit = selectApplyPatchTarget(currentContext({
      currentFolderRelayId: "relay-2",
      focusedResources: [],
    }), { relayRegistry: registry({ relayIds: ["relay-1", "relay-2"] }) });
    expect(explicit).toMatchObject({ ok: true, context: { relayId: "relay-2" } });

    const conflict = selectApplyPatchTarget(currentContext({
      currentFolderRelayId: "relay-2",
    }), { relayRegistry: registry({ relayIds: ["relay-1", "relay-2"] }) });
    expect(conflict).toMatchObject({ ok: false, error: { code: "stale_context" } });
  });

  test("Current Folder apply_patch does not consult a Full Mode workstation profile", async () => {
    let profileWasRead = false;
    let dispatched = false;
    const relay = registry({
      onDispatch: () => { dispatched = true; },
    });
    relay.getWorkstationProfileSnapshot = () => {
      profileWasRead = true;
      return null;
    };
    const port = createApplyPatchExecutionRouter(currentContext({ focusedResources: [] }), {
      relayRegistry: relay,
    });

    expect(await port.execute({ patch: ADD_PATCH })).toMatchObject({ status: "applied" });
    expect(dispatched).toBe(true);
    expect(profileWasRead).toBe(false);
  });

  test("rejects an open Writer target before Current Folder relay dispatch and checks every patch candidate", async () => {
    let dispatched = false;
    const guardedTargets: LiveReviewWriteGuardTarget[] = [];
    const relay = registry({ onDispatch: () => { dispatched = true; } });
    const patch = [
      "*** Begin Patch",
      // An Add may overwrite an existing file, so it is a Writer candidate.
      "*** Add File: existing.txt",
      "+replacement",
      "*** Update File: src/from.ts",
      "*** Move to: src/to.ts",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    setLiveReviewWriteGuard(async (target) => {
      guardedTargets.push(target);
      return target.surface === "currentFolder";
    });
    try {
      const result = await createApplyPatchExecutionRouter(currentContext(), {
        relayRegistry: relay,
      }).execute({ patch });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "human_edit_conflict", retryable: false },
      });
      expect(dispatched).toBe(false);
      expect(guardedTargets).toEqual([
        {
          surface: "currentFolder",
          ownerId: "owner-1",
          relayId: "relay-1",
          candidatePaths: [
            "/repo/existing.txt",
            "/repo/src/from.ts",
            "/repo/src/to.ts",
          ],
        },
      ]);
    } finally {
      setLiveReviewWriteGuard(null);
    }
  });

  test("fails closed before Current Folder relay dispatch when Writer-session authority is absent", async () => {
    let dispatched = false;
    const relay = registry({ onDispatch: () => { dispatched = true; } });
    setLiveReviewWriteGuard(null);
    const result = await createApplyPatchExecutionRouter(currentContext(), {
      relayRegistry: relay,
    }).execute({ patch: ADD_PATCH });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: true },
    });
    expect(dispatched).toBe(false);
  });

  test("fails closed before Current Folder relay dispatch when Writer-session authority throws", async () => {
    let dispatched = false;
    const relay = registry({ onDispatch: () => { dispatched = true; } });
    setLiveReviewWriteGuard(async () => { throw new Error("unavailable"); });
    const result = await createApplyPatchExecutionRouter(currentContext(), {
      relayRegistry: relay,
    }).execute({ patch: ADD_PATCH });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: true },
    });
    expect(dispatched).toBe(false);
  });

  test.each([
    ["local_target_forbidden", "denied_path", false],
    ["relay_unavailable", "runtime_unavailable", true],
  ] as const)("preserves %s from the document authority as %s", async (reason, code, retryable) => {
    let dispatched = false;
    setLiveReviewWriteGuard(async () => { throw new LiveReviewTargetResolutionError(reason); });
    const result = await createApplyPatchExecutionRouter(currentContext(), {
      relayRegistry: registry({ onDispatch: () => { dispatched = true; } }),
    }).execute({ patch: "*** Begin Patch\n*** Add File: ../Documents/Nautilo/report.md\n+Report\n*** End Patch" });
    expect(result).toMatchObject({ ok: false, error: { code, retryable } });
    expect(dispatched).toBe(false);
    if (reason === "local_target_forbidden") {
      expect(JSON.stringify(result)).toContain("Workspace report");
      expect(JSON.stringify(result)).not.toContain("Writer-session authority");
    }
  });

  test("preserves relay human-edit and reapply rejections as non-retryable reread contracts", async () => {
    for (const code of ["human_edit_conflict", "reapply_required"] as const) {
      const result = await createApplyPatchExecutionRouter(currentContext({ focusedResources: [] }), {
        relayRegistry: registry({ dispatchErrorCode: code }),
      }).execute({ patch: ADD_PATCH });
      expect(result).toMatchObject({
        ok: false,
        error: { code, retryable: false },
      });
      expect(JSON.stringify(result)).toContain("construct a new patch");
      expect(JSON.stringify(result)).toContain("do not resend");
    }
  });

  test("an unfocused Current Folder fails closed when multiple Desktops are eligible", () => {
    const target = selectApplyPatchTarget(currentContext({ focusedResources: [] }), {
      relayRegistry: registry({ relayIds: ["relay-1", "relay-2"] }),
    });
    expect(target).toMatchObject({ ok: false, error: { code: "stale_context" } });
  });

  test("workspace-only returns an actionable unsupported target without parsing or execution", async () => {
    const context = currentContext({
      currentFolder: "",
      focusedResources: [],
      memoryAccessEnvelope: workspaceEnvelope(),
    });
    const omitted = selectApplyPatchTarget(context, { relayRegistry: null });
    expect(omitted).toMatchObject({
      ok: false,
      error: { code: "unsupported_target", retryable: false },
    });
    expect(JSON.stringify(omitted)).toContain("file.str_replace");
    expect(selectApplyPatchTarget(context, { relayRegistry: null }, "workspace")).toEqual(omitted);
    expect(selectApplyPatchTarget(context, { relayRegistry: null }, "current"))
      .toMatchObject({ ok: false, error: { code: "missing_context" } });

    const malformed = await createApplyPatchExecutionRouter(context, {
      relayRegistry: null,
    }).execute({ patch: "not a patch", target: "workspace" });
    expect(malformed).toEqual(omitted);
  });

  test("current-only selects Current Folder when omitted or explicit and never falls back from explicit Workspace", () => {
    const context = currentContext();
    const omitted = selectApplyPatchTarget(context, { relayRegistry: registry() });
    expect(omitted).toMatchObject({ ok: true, context: { zone: "current", root: "/repo", relayId: "relay-1" } });
    expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, "current")).toEqual(omitted);
    expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
  });

  test("paired-mobile host context supplies the exact Current Folder to deferred apply_patch execution", async () => {
    let dispatched = false;
    const relay = registry({ onDispatch: () => { dispatched = true; } });
    const port = createApplyPatchExecutionRouter(currentContext({
      currentFolder: "",
      currentFolderRelayId: "",
      focusedResources: [],
    }), { relayRegistry: relay });

    const result = await runWithRequiredOrdinaryHostContext({
      relayId: "relay-1",
      currentFolderRoot: "/paired/project",
      workspaceRoot: "/paired/workspace",
    }, () => port.execute({ patch: ADD_PATCH, target: "current" }));

    expect(result).toMatchObject({ status: "applied" });
    expect(dispatched).toBe(true);
  });

  test("no eligible target fails closed for omitted and both explicit selectors", () => {
    const context = currentContext({
      currentFolder: "",
      focusedResources: [],
      memoryAccessEnvelope: null,
    });
    expect(selectApplyPatchTarget(context, { relayRegistry: null }))
      .toMatchObject({ ok: false, error: { code: "missing_context" } });
    expect(selectApplyPatchTarget(context, { relayRegistry: null }, "current"))
      .toMatchObject({ ok: false, error: { code: "missing_context" } });
    expect(selectApplyPatchTarget(context, { relayRegistry: null }, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
  });

  test("Current Folder wins when both Current Folder and Workspace are present", () => {
    const dual = currentContext({ memoryAccessEnvelope: workspaceEnvelope() });
    const dependencies = { relayRegistry: registry() };
    expect(selectApplyPatchTarget(dual, dependencies)).toMatchObject({
      ok: true,
      context: { zone: "current", root: "/repo", relayId: "relay-1" },
    });
    expect(selectApplyPatchTarget(dual, dependencies, "current"))
      .toMatchObject({ ok: true, context: { zone: "current" } });
    expect(selectApplyPatchTarget(dual, dependencies, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
  });

  test("buildApplyPatchToolContext exposes only a deferred execution port", () => {
    const toolContext = buildApplyPatchToolContext(currentContext(), { relayRegistry: registry() });
    expect(Object.keys(toolContext)).toEqual(["applyPatchExecutionPort"]);
    expect(typeof toolContext.applyPatchExecutionPort?.execute).toBe("function");
  });

  test("an explicit target never falls back, while omitted selection preserves grounded Current Folder denials", () => {
    const staleCurrentWithWorkspace = currentContext({
      currentFolder: "relative",
      focusedResources: [],
      memoryAccessEnvelope: workspaceEnvelope(),
    });
    expect(selectApplyPatchTarget(staleCurrentWithWorkspace, { relayRegistry: registry() }, "current"))
      .toMatchObject({ ok: false, error: { code: "stale_context" } });
    const dependencies = { relayRegistry: registry() };
    expect(selectApplyPatchTarget(staleCurrentWithWorkspace, dependencies, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
    expect(selectApplyPatchTarget(staleCurrentWithWorkspace, dependencies))
      .toMatchObject({ ok: false, error: { code: "stale_context" } });
    expect(selectApplyPatchTarget(currentContext({ currentFolder: "relative", focusedResources: [] }), { relayRegistry: registry() }))
      .toMatchObject({ ok: false, error: { code: "stale_context" } });
  });

  test("explicit Workspace selection does not query an eligible Current Folder lane", () => {
    const capabilities: string[] = [];
    const result = selectApplyPatchTarget(
      currentContext({ focusedResources: [], memoryAccessEnvelope: workspaceEnvelope() }),
      {
        relayRegistry: registry({ onFind: (capability) => capabilities.push(capability) }),
      },
      "workspace",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_target" } });
    expect(capabilities).toEqual([]);
  });

  test("guest context cannot use Current Folder while Workspace remains explicitly unsupported", () => {
    const context = currentContext({
      actorRole: "guest",
      memoryAccessEnvelope: workspaceEnvelope(),
    });
    for (const target of [undefined, "current"] as const) {
      expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, target))
        .toMatchObject({ ok: false, error: { code: "missing_context" } });
    }
    expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
  });

  test("missing authenticated identity fails closed for Current Folder", () => {
    const context = currentContext({
      ownerId: "",
      memoryAccessEnvelope: workspaceEnvelope(),
    });
    for (const target of [undefined, "current"] as const) {
      expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, target))
        .toMatchObject({ ok: false, error: { code: "missing_context" } });
    }
    expect(selectApplyPatchTarget(context, { relayRegistry: registry() }, "workspace"))
      .toMatchObject({ ok: false, error: { code: "unsupported_target" } });
  });

  test("omitted selection ignores an unauthorized Workspace when Current Folder is eligible", () => {
    const context = currentContext({
      memoryAccessEnvelope: workspaceEnvelope({ mutableNamespaces: [], writableNamespaces: [] }),
    });
    expect(selectApplyPatchTarget(context, { relayRegistry: registry() }))
      .toMatchObject({ ok: true, context: { zone: "current" } });
  });

  test("a missing, incompatible, or foreign Current Folder relay fails closed without Workspace fallback", () => {
    expect(selectApplyPatchTarget(currentContext({ focusedResources: [] }), { relayRegistry: registry({ relayIds: [] }) })).toMatchObject({ ok: false, error: { code: "stale_context" } });
    expect(selectApplyPatchTarget(currentContext(), { relayRegistry: registry() })).toMatchObject({ ok: true });
    expect(selectApplyPatchTarget(currentContext({ actorRole: "guest" }), { relayRegistry: registry() })).toMatchObject({ ok: false, error: { code: "missing_context" } });
  });

  test("deferred trusted selection preserves stale, runtime, and Desktop authority errors", async () => {
    const staleTool = createApplyPatchTool({
      applyPatchExecutionPort: createApplyPatchExecutionRouter(
        currentContext({ focusedResources: [] }),
        { relayRegistry: registry({ relayIds: [] }) },
      ),
    });
    expect(await staleTool.invoke({ patch: ADD_PATCH })).toContain('"code":"stale_context"');

    const unavailable = registry();
    unavailable.getCapabilities = () => ({ profile: "desktop-agent", localFileExecution: true, applyPatchExecution: false });
    const unavailableTool = createApplyPatchTool({
      applyPatchExecutionPort: createApplyPatchExecutionRouter(
        currentContext({ focusedResources: [] }),
        { relayRegistry: unavailable },
      ),
    });
    expect(await unavailableTool.invoke({ patch: ADD_PATCH })).toContain('"code":"runtime_unavailable"');

    const liveRejected = registry();
    liveRejected.applyPatchDispatch = async () => {
      throw Object.assign(new Error("relay rejected the path"), {
        applyPatchErrorCode: "denied_path",
      });
    };
    const liveRejectedTool = createApplyPatchTool({
      applyPatchExecutionPort: createApplyPatchExecutionRouter(currentContext(), { relayRegistry: liveRejected }),
    });
    expect(await liveRejectedTool.invoke({ patch: ADD_PATCH })).toContain('"code":"denied_path"');

    const staleFolderTool = createApplyPatchTool({
      applyPatchExecutionPort: createApplyPatchExecutionRouter(currentContext(), {
        relayRegistry: registry({
          dispatchErrorCode: "stale_context",
          dispatchFailureReason: "stale_current_folder",
        }),
      }),
    });
    const staleFolderResult = String(await staleFolderTool.invoke({ patch: ADD_PATCH }));
    expect(staleFolderResult).toContain('"code":"stale_context"');
    expect(staleFolderResult).toContain("Current Folder changed");
  });

  test("emits one strict relay request with only a stale-context folder assertion and preserves the redacted result", async () => {
    let captured: { request?: Record<string, unknown>; options?: Record<string, unknown> } = {};
    const port = createApplyPatchExecutionRouter(currentContext(), {
      relayRegistry: registry({
        onDispatch: (request, options) => { captured = { request: request as Record<string, unknown>, options: options as Record<string, unknown> }; },
        result: relayResult({
          pathResults: [{ operation: "add", path: "[authorized-root]/src/new.ts", status: "applied", bytesTouched: 4, revisionId: "rev-1" }],
          changedFiles: [{ operation: "add", path: "[authorized-root]/src/new.ts", status: "applied", bytesTouched: 4, revisionId: "rev-1" }],
          unifiedDiff: "--- [authorized-root]/src/new.ts\n+++ [authorized-root]/src/new.ts",
        }),
      }),
    });
    const result = await runWithRequiredOrdinaryHostContext({
      relayId: "relay-1",
      currentFolderRoot: "/repo",
      workspaceRoot: "/workspace",
      requiredRelaySessionId: "socket-1",
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    }, () => port.execute({ patch: ADD_PATCH }));
    expect(result).toMatchObject({
      status: "applied",
      partial: false,
      revisionIds: ["rev-1"],
      pathResults: [{ path: "[authorized-root]/src/new.ts" }],
    });
    if (result === null || typeof result !== "object" || !("unifiedDiff" in result) || typeof result.unifiedDiff !== "string") {
      throw new Error("expected the relay's canonical unified diff");
    }
    expect(result.unifiedDiff).toContain("[authorized-root]");
    expect(captured.request).toEqual({
      operation: expect.objectContaining({ kind: "apply_patch", version: 1, routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" } }),
      expectedCurrentFolder: "/repo",
    });
    expect(captured.request).not.toHaveProperty("allowedRoots");
    expect(captured.options).not.toHaveProperty("desktopFilesystemGrantRequest");
    expect(captured.options).toMatchObject({
      requiredRelaySessionId: "socket-1",
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    });
  });
});
