/**
 * D440 Phase 0 tasks 0.1.1 / 0.1.3 — the server/agent side of the third
 * authority state: Developer Workstation is active and the exact durable
 * project grant is advertised, but the tool call has no current exact plan.
 *
 * Reused D418 builders are intentionally local: ToolCatalog + NautiloState,
 * a relay-registry view, and a transient WorkstationDispatchPlan registry.
 * No shared helper change is needed to reproduce the live failure.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import {
  setRelayRegistry,
  setWorkstationDispatchPlanRegistry,
  toolsNode,
  type ToolRelayRegistry,
  type WorkstationDispatchPlanRegistry,
  type WorkstationDispatchPlanView,
  type WorkstationRelayFingerprintView,
} from "../../src/nodes/tools";

const USER = "d440-user";
const RELAY = "d440-relay";
const PROJECT = "/Users/d440/exact-project";

function catalog(): ToolCatalog {
  const result = new ToolCatalog();
  result.register({
    name: "run_shell",
    factory: () =>
      new DynamicStructuredTool({
        name: "run_shell",
        description: "D440 relay shell",
        schema: z.object({ command: z.string() }),
        func: async () => {
          throw new Error("relay-only test tool");
        },
      }),
    category: "development",
    trustTier: "admin",
    executor: "relay",
    impact: "destructive",
    requiredCapabilities: ["use_high_impact_tools"],
    tags: [],
    resultScanPolicy: "on-suspicious",
  });
  return result;
}

beforeAll(() => initToolCatalog(catalog()));

afterEach(() => {
  setRelayRegistry(null);
  setWorkstationDispatchPlanRegistry(null);
});

function state(toolCallId: string): NautiloState {
  const args = { command: "git status --short" };
  return {
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ id: toolCallId, name: "run_shell", args }],
      }),
    ],
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
    approvedToolCalls: [
      { id: toolCallId, name: "run_shell", args, type: "tool_call" },
    ],
    requiredHostRelays: { [toolCallId]: RELAY },
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "",
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
    activatedToolNames: ["run_shell"],
    relayCapabilities: { use_high_impact_tools: true },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: USER,
      actorId: "actor-1",
      relayId: RELAY,
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      requestId: toolCallId,
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

function relayRegistry(capabilityRevision = 12) {
  const dispatched: string[] = [];
  const registry = {
    findByCapabilityForUser: () => [RELAY],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canRunShell: true,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      allowedRoots: [PROJECT],
      desktopFilesystemGrantSnapshot: {
        revision: 8,
        instanceId: "instance-1",
        agentScope: "all_owned_agents",
        grants: [
          {
            id: "durable-project",
            canonicalRoot: PROJECT,
            access: ["read", "create_modify", "delete", "execute"],
            policyVersion: 3,
            lifetime: "durable",
          },
        ],
      },
    }),
    getUserId: () => USER,
    getDesktopSessionId: () => "desktop-1",
    getCapabilityRevision: () => capabilityRevision,
    getPairingGeneration: () => "pairing-1",
    getWorkstationProfileSnapshot: () => ({
      profileId: "developer-workstation",
      profileRevision: 4,
      grantIds: ["profile-tools"],
      protectedPolicyVersion: 3,
      networkMode: "isolated",
      capabilities: [],
    }),
    getActiveWorkstationSession: () => ({
      userId: USER,
      relayId: RELAY,
      desktopSessionId: "desktop-1",
      capabilityRevision: 12,
    }),
    dispatch: async () => {
      dispatched.push(RELAY);
      return { status: "ok", result: "unexpected" };
    },
  } as unknown as ToolRelayRegistry;
  return { registry, dispatched };
}

function plan(toolCallId: string): WorkstationDispatchPlanView {
  return {
    toolCallId,
    userId: USER,
    relayId: RELAY,
    instanceId: "instance-1",
    desktopSessionId: "desktop-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    profileId: "developer-workstation",
    profileRevision: 4,
    grantIds: ["profile-tools"],
    capabilityRevision: 11,
  };
}

function planRegistry(value: WorkstationDispatchPlanView | null): WorkstationDispatchPlanRegistry {
  return {
    get: () => value,
    revalidate: (
      candidate: WorkstationDispatchPlanView,
      fingerprint: WorkstationRelayFingerprintView,
    ) =>
      candidate.capabilityRevision === fingerprint.capabilityRevision
        ? { ok: true }
        : {
            ok: false,
            reason: "capability_revision_mismatch",
            detail: "D440 stale capability revision",
          },
  };
}

function messageContent(output: Partial<NautiloState>): string {
  const last = output.messages?.at(-1);
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content ?? "");
}

describe("D440 exact durable grant with missing/stale plan", () => {
  test("missing plan fails before relay dispatch despite the exact durable project grant", async () => {
    const relay = relayRegistry();
    setRelayRegistry(relay.registry);
    setWorkstationDispatchPlanRegistry(planRegistry(null));

    const output = await toolsNode(state("d440-missing-plan"));
    const content = messageContent(output);

    expect(relay.dispatched).toEqual([]);
    expect(content).toContain("missing or stale plan");
    expect(content).toContain("Re-approve the operation");
  });

  test("stale plan capability revision fails exact-binding revalidation before relay dispatch", async () => {
    const relay = relayRegistry(12);
    setRelayRegistry(relay.registry);
    setWorkstationDispatchPlanRegistry(planRegistry(plan("d440-stale-plan")));

    const output = await toolsNode(state("d440-stale-plan"));
    const content = messageContent(output);

    expect(relay.dispatched).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).toContain("capability_revision_mismatch");
  });
});
