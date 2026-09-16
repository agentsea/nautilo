/**
 * D440 Phase 1 — same-authority refresh + structured disposition at the
 * agent dispatch seam.
 *
 * Pins the Phase 1 behavior added to `packages/agent/src/nodes/tools.ts`:
 *   - a missing / TTL-expired plan is re-admitted ONCE under the exact same
 *     authority tuple (side effects known not started — the refresh runs
 *     before any relay dispatch) and the dispatch retries;
 *   - authority drift (capability revision, grant-store revision, protected
 *     policy, Current Folder) fails closed with a structured
 *     `NAUTILO_WORKSTATION_DISPOSITION` block carrying cause / retry-safety
 *     / recovery action, appended to the stable human-readable copy;
 *   - the human copy still contains the "missing or stale plan" /
 *     "no longer the exact bound relay" / "Re-approve the operation"
 *     substrings so existing readers stay compatible.
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
  type WorkstationPlanRevalidationReasonView,
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

function state(toolCallId: string, currentFolder = PROJECT): NautiloState {
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
    currentFolder,
    currentFolderRelayId: "",
    workspacePath: currentFolder,
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

function planView(toolCallId: string, currentFolder = PROJECT): WorkstationDispatchPlanView {
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
    capabilityRevision: 12,
    currentFolder,
    grantRevision: 8,
    protectedPolicyVersion: 3,
  };
}

function relayRegistry(opts: {
  dispatched: string[];
  activeSession?: { relayId: string; capabilityRevision: number } | null;
}): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => [RELAY],
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
    getWorkstationProfileSnapshot: () => ({
      profileId: "developer-workstation",
      profileRevision: 4,
      grantIds: ["profile-tools"],
      protectedPolicyVersion: 3,
      networkMode: "isolated",
      capabilities: [],
    }),
    getDesktopFilesystemGrantSnapshot: () => ({
      revision: 8,
      instanceId: "instance-1",
      agentScope: "all_owned_agents",
      grants: [
        {
          id: "profile-tools",
          canonicalRoot: PROJECT,
          access: ["read", "create_modify", "delete", "execute"],
          policyVersion: 3,
          lifetime: "durable",
        },
      ],
    }),
    getActiveWorkstationSession: () =>
      opts.activeSession === null || opts.activeSession === undefined
        ? null
        : {
            userId: USER,
            relayId: opts.activeSession.relayId,
            desktopSessionId: "desktop-1",
            capabilityRevision: opts.activeSession.capabilityRevision,
          },
    dispatch: async () => {
      opts.dispatched.push(RELAY);
      return { status: "ok", result: "refreshed-dispatch" };
    },
  } as unknown as ToolRelayRegistry;
}

function planRegistry(opts: {
  get: (id: string) => WorkstationDispatchPlanView | null;
  revalidate: (
    plan: WorkstationDispatchPlanView,
    fp: WorkstationRelayFingerprintView,
  ) =>
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: WorkstationPlanRevalidationReasonView;
        readonly detail: string;
      };
  readmit?: (input: {
    toolCallId: string;
    userId: string;
  currentFolder: string;
  currentFolderRelayId: string;
    executionClass: "profile_bound_sandbox";
    fingerprint: WorkstationRelayFingerprintView;
  }) => WorkstationDispatchPlanView | null;
}): WorkstationDispatchPlanRegistry {
  return {
    get: opts.get,
    revalidate: (plan, fingerprint) => opts.revalidate(plan, fingerprint),
    ...(opts.readmit !== undefined ? { readmit: opts.readmit } : {}),
  };
}

function messageContent(output: Partial<NautiloState>): string {
  const last = output.messages?.at(-1);
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content ?? "");
}

describe("D440 Phase 1 — same-authority refresh and structured disposition", () => {
  test("missing plan is re-admitted under the same authority and dispatch retries once", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({
      dispatched,
      activeSession: { relayId: RELAY, capabilityRevision: 12 },
    });
    setRelayRegistry(relay);
    let readmitCalled = 0;
    const plans = planRegistry({
      get: () => null,
      revalidate: () => ({ ok: true }),
      readmit: (input) => {
        readmitCalled += 1;
        expect(input.currentFolder).toBe(PROJECT);
        return planView(input.toolCallId);
      },
    });
    setWorkstationDispatchPlanRegistry(plans);

    const output = await toolsNode(state("d440-refresh"));

    expect(readmitCalled).toBe(1);
    expect(dispatched).toEqual([RELAY]);
    expect(messageContent(output)).toContain("refreshed-dispatch");
  });

  test("missing plan with authority drift fails closed with a structured approval_required disposition", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({
      dispatched,
      activeSession: { relayId: RELAY, capabilityRevision: 12 },
    });
    setRelayRegistry(relay);
    const plans = planRegistry({
      get: () => null,
      revalidate: () => ({ ok: true }),
      readmit: () => null, // authority drift — readmit refuses
    });
    setWorkstationDispatchPlanRegistry(plans);

    const output = await toolsNode(state("d440-drift"));
    const content = messageContent(output);

    expect(dispatched).toEqual([]);
    // Stable human fallback copy is preserved.
    expect(content).toContain("missing or stale plan");
    expect(content).toContain("Re-approve the operation");
    // Structured disposition block carries cause / retry-safety / action.
    expect(content).toContain("[NAUTILO_WORKSTATION_DISPOSITION]");
    expect(content).toContain("kind=approval_required");
    expect(content).toContain("retrySafe=false");
    expect(content).toContain("action=re_authorize");
    expect(content).toContain("driftReason=no_plan");
    expect(content).toContain(`currentFolder=${PROJECT}`);
  });

  test("missing plan identifies a replacement Relay revision rollback before dispatch", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({ dispatched, activeSession: { relayId: RELAY, capabilityRevision: 12 } });
    relay.getCapabilityRevision = () => 0;
    setRelayRegistry(relay);
    setWorkstationDispatchPlanRegistry(planRegistry({
      get: () => null, revalidate: () => ({ ok: true }), readmit: () => null,
    }));
    const output = await toolsNode(state("relay-rollback"));
    const content = messageContent(output);
    expect(dispatched).toEqual([]);
    expect(content).toContain("capability revision reset (12 → 0)");
    expect(content).toContain("approving the same command again cannot repair this binding");
    expect(content).toContain("driftReason=capability_revision_mismatch");
    expect(content).toContain("retrySafe=false");
  });

  test("stale plan (capability_revision_mismatch) surfaces a structured approval_required disposition", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({
      dispatched,
      activeSession: { relayId: RELAY, capabilityRevision: 12 },
    });
    setRelayRegistry(relay);
    const plans = planRegistry({
      get: (id) => (id === "d440-stale" ? planView(id) : null),
      revalidate: () => ({
        ok: false,
        reason: "capability_revision_mismatch",
        detail: "D440 stale capability revision",
      }),
    });
    setWorkstationDispatchPlanRegistry(plans);

    const output = await toolsNode(state("d440-stale"));
    const content = messageContent(output);

    expect(dispatched).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).toContain("capability_revision_mismatch");
    expect(content).toContain("Re-approve the operation");
    expect(content).toContain("[NAUTILO_WORKSTATION_DISPOSITION]");
    expect(content).toContain("kind=approval_required");
    expect(content).toContain("driftReason=capability_revision_mismatch");
    expect(content).toContain("action=re_authorize");
  });

  test("Current Folder drift fails closed with a current_folder_drift disposition (no silent re-bind)", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({
      dispatched,
      activeSession: { relayId: RELAY, capabilityRevision: 12 },
    });
    setRelayRegistry(relay);
    const plans = planRegistry({
      // Plan admitted for /old-folder; live state is the exact project.
      get: (id) => (id === "d440-folder-drift" ? planView(id, "/Users/d440/old-folder") : null),
      revalidate: () => ({ ok: true }),
    });
    setWorkstationDispatchPlanRegistry(plans);

    const output = await toolsNode(state("d440-folder-drift", PROJECT));
    const content = messageContent(output);

    expect(dispatched).toEqual([]);
    expect(content).toContain("was approved for Current Folder");
    expect(content).toContain("/Users/d440/old-folder");
    expect(content).toContain(PROJECT);
    expect(content).toContain("[NAUTILO_WORKSTATION_DISPOSITION]");
    expect(content).toContain("kind=approval_required");
    expect(content).toContain("driftReason=current_folder_drift");
    expect(content).toContain("action=re_authorize");
  });

  test("missing plan with no readmit wired stays byte-for-byte pre-D440 (fail closed, no dispatch)", async () => {
    const dispatched: string[] = [];
    const relay = relayRegistry({
      dispatched,
      activeSession: { relayId: RELAY, capabilityRevision: 12 },
    });
    setRelayRegistry(relay);
    const plans = planRegistry({
      get: () => null,
      revalidate: () => ({ ok: true }),
      // readmit intentionally NOT wired.
    });
    setWorkstationDispatchPlanRegistry(plans);

    const output = await toolsNode(state("d440-no-readmit"));
    const content = messageContent(output);

    expect(dispatched).toEqual([]);
    expect(content).toContain("missing or stale plan");
    expect(content).toContain("Re-approve the operation");
  });
});
