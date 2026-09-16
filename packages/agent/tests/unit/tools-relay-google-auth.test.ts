/** D513 — relay Google authentication failures become typed semantic recovery. */

import { describe, test, expect, beforeAll } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  toolsNode,
  setRelayRegistry,
  formatGoogleAuthRequiredRelayError,
  type ToolRelayRegistry,
} from "../../src/nodes/tools";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

type RelayDispatchRequest = {
  toolName: string;
  args: Record<string, unknown>;
  impact: "read-only" | "low" | "high" | "destructive";
  approvalObtained: boolean;
};
type RelayDispatchResult = {
  status: "ok" | "error";
  result?: unknown;
  error?: string;
  errorCode?: string;
};

function makeMockRelayRegistry(
  onDispatch: (req: RelayDispatchRequest) => Promise<RelayDispatchResult>,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["mock-relay-1"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canUseGoogleWorkspace: true,
      allowedRoots: ["/tmp"],
      securityLevel: "standard",
    }),
    dispatch: (_relayId: string, req: RelayDispatchRequest) => onDispatch(req),
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    updatePresence: () => {},
    resolveDispatch: () => {},
    cancelDispatch: () => {},
    listConnected: () => Promise.resolve(["mock-relay-1"]),
    findByCapability: () => ["mock-relay-1"],
    start: () => {},
    stop: () => {},
  } as unknown as ToolRelayRegistry;
}

function contentOf(msg: { content: unknown } | undefined): string {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  return JSON.stringify(c);
}

function makeGoogleWorkspaceState(toolName = "google_workspace"): NautiloState {
  const toolCallId = `tc-${toolName}`;
  return {
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: toolCallId,
            name: toolName,
            args: { command: "drive.ls", max: 5 },
          },
        ],
      }),
    ],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "test-owner",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [
      {
        id: toolCallId,
        name: toolName,
        args: { command: "drive.ls", max: 5 },
        type: "tool_call",
      },
    ],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "test-owner",
      actorId: "actor-1",
      relayId: "mock-relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "generation-1",
      requestId: "request-1",
    },
    requiredHostRelays: { [toolCallId]: "mock-relay-1" },
    toolWhitelist: undefined,
    // toolsNode executes only the progressive set. Direct execution fixtures
    // must model the earlier activation step explicitly.
    activatedToolNames: [toolName],
    relayCapabilities: {
      use_google_workspace: true,
    },
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
  };
}

function buildTestCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  for (const name of ["google_workspace", "other_relay_tool"] as const) catalog.register({
    name,
    factory: () =>
      new DynamicStructuredTool({
        name,
        description: "stub",
        schema: z.object({ command: z.string() }),
        func: () => Promise.reject(new Error("relay tool")),
      }),
    category: "documents",
    trustTier: "standard",
    executor: "relay",
    impact: "low",
    requiredCapabilities: ["use_google_workspace"],
    tags: name === "google_workspace" ? ["google"] : ["test"],
    resultScanPolicy: "on-suspicious",
  });
  return catalog;
}

beforeAll(() => {
  initToolCatalog(buildTestCatalog());
});

describe("M196 — google_auth_required relay mapping", () => {
  test("formatGoogleAuthRequiredRelayError returns bounded typed recovery without relay detail", () => {
    const formatted = formatGoogleAuthRequiredRelayError(
      "Google Workspace isn't connected on this device.",
    );
    expect(JSON.parse(formatted)).toMatchObject({
      version: 1,
      recovery: { target: "connections.google", requirement: "login", domainTool: "google_workspace" },
    });
    expect(formatted).not.toContain("Google Workspace isn't connected on this device.");
  });

  test("toolsNode maps google_workspace google_auth_required to typed recovery", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({
        status: "error",
        errorCode: "google_auth_required",
        error: "Google Workspace isn't connected on this device.",
      }),
    );
    setRelayRegistry(registry);

    const out = await toolsNode(makeGoogleWorkspaceState());
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(JSON.parse(content)).toMatchObject({ recovery: { target: "connections.google", requirement: "login" } });
  });

  test("other relay errors keep generic Error from relay prefix", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({
        status: "error",
        error: "gog timed out",
      }),
    );
    setRelayRegistry(registry);

    const out = await toolsNode(makeGoogleWorkspaceState());
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(content).not.toContain("NAUTILO_ACTION:");
    expect(content).toContain("Error from relay: gog timed out");
  });

  test("the same relay error code from a non-Google tool stays generic", async () => {
    setRelayRegistry(makeMockRelayRegistry(() => Promise.resolve({
      status: "error",
      errorCode: "google_auth_required",
      error: "not a Google authentication flow",
    })));

    const out = await toolsNode(makeGoogleWorkspaceState("other_relay_tool"));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(() => { void JSON.parse(content); }).toThrow();
    expect(content).toContain("Error from relay: not a Google authentication flow");
  });
});
