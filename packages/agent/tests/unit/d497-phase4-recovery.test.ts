/**
 * D497 Phase 4.2/4.3 — keep the explicit Git/GitHub workstation projection
 * narrow and make its existing recovery seam truthful. The projection now
 * includes only the bounded Current Folder selector needed before shell use;
 * it does not introduce a new grant or relay authority.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { clearToolCatalog, ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import {
  setRelayRegistry,
  setWorkstationDispatchPlanRegistry,
  toolsNode,
  type ToolRelayRegistry,
  type WorkstationDispatchPlanRegistry,
  type WorkstationDispatchPlanView,
  type WorkstationRelayFingerprintView,
} from "../../src/nodes/tools";
import { registerAllTools } from "../../src/tools/register-all";

const USER = "d497-owner";
const RELAY = "d497-relay";
const PROJECT = "/Users/d497/nautilo";

beforeEach(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

afterEach(() => {
  setRelayRegistry(null);
  setWorkstationDispatchPlanRegistry(null);
  clearToolCatalog();
});

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: USER,
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
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: PROJECT,
    currentFolderRelayId: "",
    workspacePath: PROJECT,
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: { use_high_impact_tools: true, canRunShell: true },
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
    ...overrides,
  };
}

function shellInvocation(
  callId: string,
  args: Record<string, unknown> = { command: "git status --short" },
): NautiloState {
  return state({
    messages: [new AIMessage({ content: "", tool_calls: [{ id: callId, name: "run_shell", args }] })],
    approvedToolCalls: [{ id: callId, name: "run_shell", args, type: "tool_call" }],
    requiredHostRelays: { [callId]: RELAY },
    activatedToolNames: ["run_shell"],
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: USER,
      actorId: "actor-1",
      relayId: RELAY,
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      requestId: callId,
    },
  });
}

function contentOf(output: Partial<NautiloState>): string {
  const message = output.messages?.at(-1);
  return typeof message?.content === "string"
    ? message.content
    : JSON.stringify(message?.content ?? "");
}

function assertSingleToolResult(output: Partial<NautiloState>, expected: string): void {
  // toolsNode preserves the admitted AI tool-call message and appends exactly
  // one ToolMessage; “one result” must not be confused with one total message.
  expect(output.messages).toHaveLength(2);
  const content = contentOf(output);
  expect(content).toContain(expected);
  expect(content).not.toContain("discover_tools");
  expect(content).not.toContain("activate_tools");
}

function plan(callId: string): WorkstationDispatchPlanView {
  return {
    toolCallId: callId,
    userId: USER,
    relayId: RELAY,
    instanceId: "instance-1",
    desktopSessionId: "desktop-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    profileId: "developer-workstation",
    profileRevision: 4,
    grantIds: ["profile-tools"],
    capabilityRevision: 12,
    currentFolder: PROJECT,
    grantRevision: 8,
    protectedPolicyVersion: 3,
  };
}

function workstationRelay(opts: {
  readonly dispatched: string[];
  readonly eligible?: boolean;
  readonly fullWorkstation?: boolean;
  readonly result?: { status: "ok" | "error"; result?: unknown; error?: string };
}): ToolRelayRegistry {
  const fullWorkstation = opts.fullWorkstation !== false;
  return {
    findByCapabilityForUser: () => opts.eligible === false ? [] : [RELAY],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canRunShell: true,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      allowedRoots: [PROJECT],
    }),
    getUserId: () => USER,
    getDesktopSessionId: () => "desktop-1",
    getCapabilityRevision: () => 12,
    getPairingGeneration: () => "pairing-1",
    getWorkstationProfileSnapshot: () => fullWorkstation ? ({
        profileId: "developer-workstation",
        profileRevision: 4,
        grantIds: ["profile-tools"],
        protectedPolicyVersion: 3,
        networkMode: "isolated",
        capabilities: [],
      }) : null,
    getDesktopFilesystemGrantSnapshot: () => ({
      revision: 8,
      instanceId: "instance-1",
      agentScope: "all_owned_agents",
      grants: [],
    }),
    getActiveWorkstationSession: () => fullWorkstation ? ({
        userId: USER,
        relayId: RELAY,
        desktopSessionId: "desktop-1",
        capabilityRevision: 12,
      }) : null,
    dispatch: async () => {
      opts.dispatched.push(RELAY);
      return opts.result ?? { status: "ok", result: "unexpected success" };
    },
  } as unknown as ToolRelayRegistry;
}

function planRegistry(
  value: WorkstationDispatchPlanView | null,
  revalidate: (candidate: WorkstationDispatchPlanView, fingerprint: WorkstationRelayFingerprintView) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: "capability_revision_mismatch"; readonly detail: string },
): WorkstationDispatchPlanRegistry {
  return { get: () => value, revalidate };
}

describe("D497 Phase 4 — Git/GitHub shell exposure and recovery", () => {
  test("projects shell plus bounded folder adoption for an authorized GitHub request", async () => {
    const patch = await preModelNode(state({
      messages: [new HumanMessage("List open GitHub issues for this repository.")],
    }));

    expect(patch.activatedToolNames).toContain("run_shell");
    expect(patch.toolNames).toContain("run_shell");
    expect(patch.activatedToolNames).toContain("select_current_folder");
    expect(patch.toolNames).toContain("select_current_folder");
    expect(patch.toolNames).not.toContain("file");
    expect(patch.activatedToolNames).not.toContain("file");
  });

  test("keeps unrelated turns deferred without granting shell, filesystem, or Current Folder access", async () => {
    const patch = await preModelNode(state({
      messages: [new HumanMessage("Summarize the sprint note.")],
    }));

    expect(patch.toolNames).not.toContain("run_shell");
    expect(patch.toolNames).not.toContain("file");
    expect(patch.toolNames).not.toContain("select_current_folder");
    expect(patch.activatedToolNames).not.toContain("run_shell");
    expect(patch.activatedToolNames).not.toContain("file");
    expect(patch.activatedToolNames).not.toContain("select_current_folder");
  });

  test("returns one actionable result when the admitted shell relay capability is unavailable", async () => {
    // A missing registry is the server-side equivalent of no authorized
    // workstation being online; it must fail before any fallback dispatch.
    setRelayRegistry(null);

    const output = await toolsNode(shellInvocation("d497-missing-relay"));

    assertSingleToolResult(output, "requires a connected relay");
  });

  test("returns one typed re-authorization result for a stale workstation binding", async () => {
    const dispatched: string[] = [];
    setRelayRegistry(workstationRelay({ dispatched }));
    setWorkstationDispatchPlanRegistry(planRegistry(plan("d497-stale-binding"), () => ({
      ok: false,
      reason: "capability_revision_mismatch",
      detail: "capability revision changed",
    })));

    const output = await toolsNode(shellInvocation("d497-stale-binding"));

    expect(dispatched).toEqual([]);
    assertSingleToolResult(output, "[NAUTILO_WORKSTATION_DISPOSITION]");
    const content = contentOf(output);
    expect(content).toContain("kind=approval_required");
    expect(content).toContain("driftReason=capability_revision_mismatch");
    expect(content).toContain("action=re_authorize");
  });

  test("surfaces a denied workstation consent once without a fallback setup or filesystem grant", async () => {
    const dispatched: string[] = [];
    setRelayRegistry(workstationRelay({
      dispatched,
      result: {
        status: "error",
        error: "WORKSTATION_CONSENT_REQUIRED: Workstation execution was not allowed for this Current Folder.",
      },
    }));

    const output = await toolsNode(shellInvocation(
      "d497-consent-denied",
      { command: "gh issue list", execution: "workstation" },
    ));

    expect(dispatched).toEqual([RELAY]);
    assertSingleToolResult(output, "WORKSTATION_CONSENT_REQUIRED");
    expect(contentOf(output)).toContain("was not allowed for this Current Folder");
  });
});
