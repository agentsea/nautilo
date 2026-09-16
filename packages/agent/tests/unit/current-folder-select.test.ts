import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { AIMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode, setRelayRegistry, type ToolRelayRegistry } from "../../src/nodes/tools";
import {
  createSelectCurrentFolderTool,
  selectCurrentFolderSchema,
} from "../../src/tools/current-folder/select-current-folder";

type DispatchRequest = {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly impact: string;
  readonly approvalObtained: boolean;
  readonly executionClass?: string;
};

function resultContent(output: Partial<NautiloState>): string {
  const message = output.messages?.at(-1);
  return typeof message?.content === "string" ? message.content : "";
}

function currentFolderState(
  args: Record<string, unknown> = {
    sourceRootKind: "workspace",
    relativePath: "projects/demo",
  },
  overrides: Partial<NautiloState> = {},
): NautiloState {
  return {
    messages: [new AIMessage({
      content: "",
      tool_calls: [{ id: "select-call", name: "select_current_folder", args }],
    })],
    approvedToolCalls: [{ id: "select-call", name: "select_current_folder", args, type: "tool_call" }],
    requiredHostRelays: { "select-call": "exact-local" },
    actorRole: "owner",
    userId: "owner",
    personaId: "owner",
    turnId: "turn",
    agentId: "agent",
    roomId: "room",
    activatedToolNames: ["select_current_folder"],
    activatedToolLeases: [],
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: { canRunShell: true },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "owner",
      actorId: "actor",
      relayId: "exact-local",
      desktopSessionId: "desktop-session",
      pairingGeneration: "pairing-generation",
      requestId: "request",
    },
    suppressToolLifecycleEvents: true,
    ...overrides,
  } as unknown as NautiloState;
}

function relayRegistry(
  relayIds: readonly string[],
  dispatch: (relayId: string, request: DispatchRequest) => Promise<unknown>,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => [...relayIds],
    getCapabilities: () => ({ canControlDesktop: true }),
    dispatch: async (relayId: string, request: unknown) =>
      await dispatch(relayId, request as DispatchRequest),
  } as unknown as ToolRelayRegistry;
}

beforeEach(() => {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "select_current_folder",
    factory: () => createSelectCurrentFolderTool(),
    category: "files",
    executor: "relay",
    trustTier: "standard",
    impact: "high",
    exposure: "discoverable",
    tags: ["filesystem", "folder"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["control_desktop"],
    relayCapabilities: ["canRunShell"],
    resultScanPolicy: "on-suspicious",
  });
  initToolCatalog(catalog);
});

afterEach(() => {
  setRelayRegistry(null);
  clearToolCatalog();
});

describe("D497 select_current_folder", () => {
  test("schema admits only bounded source-relative paths", () => {
    expect(selectCurrentFolderSchema.safeParse({
      sourceRootKind: "workspace",
      relativePath: "projects/demo",
    }).success).toBe(true);

    for (const relativePath of [
      "/Users/owner/private",
      "C:\\Users\\owner",
      "../sibling",
      "projects/../sibling",
      ".",
      "projects//demo",
      "projects/\0demo",
      "a".repeat(1_025),
    ]) {
      expect(selectCurrentFolderSchema.safeParse({
        sourceRootKind: "workspace",
        relativePath,
      }).success).toBe(false);
    }
    expect(selectCurrentFolderSchema.safeParse({
      sourceRootKind: "workspace",
      relativePath: "projects/demo",
      unexpected: "authority",
    }).success).toBe(false);
  });

  test("requires the exact connected local Electron relay", async () => {
    const calls: DispatchRequest[] = [];
    setRelayRegistry(relayRegistry(["other-relay"], async (_relayId, request) => {
      calls.push(request);
      return { status: "ok", result: { ok: true } };
    }));

    const output = await toolsNode(currentFolderState());

    expect(calls).toEqual([]);
    expect(JSON.parse(resultContent(output))).toEqual({ ok: false, code: "relay_unavailable" });
  });

  test("does not resolve or fall back from a paired-mobile request", async () => {
    const calls: DispatchRequest[] = [];
    setRelayRegistry(relayRegistry(["exact-local", "paired-mobile-choice"], async (_relayId, request) => {
      calls.push(request);
      return { status: "ok", result: { ok: true } };
    }));

    const output = await toolsNode(currentFolderState(undefined, {
      verifiedOrdinaryOrigin: {
        kind: "paired_mobile",
        serverInstanceId: "server",
        serverBindingGeneration: 1,
        userId: "owner",
        actorId: "actor",
        controllerInstallationId: "controller",
        installationGeneration: 1,
        requestId: "request",
      },
    } as Partial<NautiloState>));

    expect(calls).toEqual([]);
    expect(JSON.parse(resultContent(output))).toEqual({ ok: false, code: "local_electron_required" });
  });

  test("does not dispatch malformed raw relay args", async () => {
    const calls: DispatchRequest[] = [];
    setRelayRegistry(relayRegistry(["exact-local"], async (_relayId, request) => {
      calls.push(request);
      return { status: "ok", result: { ok: true } };
    }));

    const output = await toolsNode(currentFolderState({
      sourceRootKind: "workspace",
      relativePath: "/Users/owner/private",
    }));

    expect(calls).toEqual([]);
    expect(JSON.parse(resultContent(output))).toEqual({ ok: false, code: "invalid_request" });
  });

  test("stops after a prepare failure and omits raw host data", async () => {
    const calls: DispatchRequest[] = [];
    setRelayRegistry(relayRegistry(["exact-local"], async (_relayId, request) => {
      calls.push(request);
      return {
        status: "ok",
        result: {
          ok: false,
          code: "target_protected",
          message: "Denied: /Users/owner/.ssh must not reach the model",
        },
      };
    }));

    const output = await toolsNode(currentFolderState());
    const content = resultContent(output);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("nautilo_current_folder_prepare");
    expect(JSON.parse(content)).toEqual({ ok: false, code: "target_protected" });
    expect(content).not.toContain("/Users/owner/.ssh");
  });

  test("returns a typed commit failure without leaking relay error details", async () => {
    const calls: DispatchRequest[] = [];
    setRelayRegistry(relayRegistry(["exact-local"], async (_relayId, request) => {
      calls.push(request);
      if (request.toolName === "nautilo_current_folder_prepare") {
        return {
          status: "ok",
          result: {
            ok: true,
            preparationId: "opaque-preparation-7",
            label: "demo",
            currentFolderRevision: 4,
          },
        };
      }
      return {
        status: "ok",
        result: {
          ok: false,
          code: "target_stale",
          message: "Target /Users/owner/projects/demo changed",
        },
      };
    }));

    const output = await toolsNode(currentFolderState());
    const content = resultContent(output);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(content)).toEqual({ ok: false, code: "target_stale" });
    expect(content).not.toContain("/Users/owner/projects/demo");
  });

  test("uses one exact relay for ordered prepare then opaque-id-only commit", async () => {
    const calls: Array<{ relayId: string; request: DispatchRequest }> = [];
    setRelayRegistry(relayRegistry(["exact-local", "other-relay"], async (relayId, request) => {
      calls.push({ relayId, request });
      if (request.toolName === "nautilo_current_folder_prepare") {
        return {
          status: "ok",
          result: {
            ok: true,
            preparationId: "opaque-preparation-7",
            label: "demo",
            currentFolderRevision: 4,
          },
        };
      }
      return {
        status: "ok",
        result: { ok: true, label: "demo", currentFolderRevision: 5 },
      };
    }));

    const output = await toolsNode(currentFolderState());

    expect(calls.map((call) => call.relayId)).toEqual(["exact-local", "exact-local"]);
    expect(calls.map((call) => call.request.toolName)).toEqual([
      "nautilo_current_folder_prepare",
      "nautilo_current_folder_commit",
    ]);
    expect(calls[0]?.request).toMatchObject({
      args: { sourceRootKind: "workspace", relativePath: "projects/demo" },
      impact: "high",
      approvalObtained: true,
      executionClass: "desktop",
    });
    expect(calls[1]?.request).toMatchObject({
      args: { preparationId: "opaque-preparation-7" },
      impact: "high",
      approvalObtained: true,
      executionClass: "desktop",
    });
    expect(Object.keys(calls[1]?.request.args ?? {})).toEqual(["preparationId"]);
    expect(JSON.parse(resultContent(output))).toEqual({ ok: true, label: "demo", revision: 5 });
  });
});
