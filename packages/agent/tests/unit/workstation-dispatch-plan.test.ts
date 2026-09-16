/**
 * D418 task 3.1.2 — `WorkstationDispatchPlan` consumption in the tools node.
 *
 * These tests pin the admission → dispatch pinning contract:
 *   - relay A selected at admission: a plan pinning relay-A makes the tools
 *     node dispatch to relay-A even when relay-B is the first eligible relay;
 *   - relay B cannot be dispatched: with a plan pinning relay-A, relay-B is
 *     never chosen (the plan overrides the first-eligible selection);
 *   - stale profile / capability binding rejection: a plan whose bound relay
 *     has drifted (capabilityRevision / profileRevision / desktopSessionId
 *     mismatch) or whose relay is gone fails CLOSED — the dispatch is NOT
 *     re-routed to a different first-eligible relay;
 *   - no plan never weakens the exact launch-bound host selection;
 *   - no client Auto-Approve bypass: a tool call with workstation-ish args
 *     but NO plan admitted remains pinned to the verified Electron host — a
 *     client flag in tool args can never self-authorize a plan (the plan
 *     store is server-side and admitted only by the override resolver).
 *
 * The plan is admission metadata only: these tests also assert the dispatch
 * `allowedRoots` are computed from the relay caps / sandbox profile exactly
 * as before (the plan never widens `allowedRoots`).
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  toolsNode,
  setRelayRegistry,
  setWorkstationDispatchPlanRegistry,
  type ToolRelayRegistry,
  type WorkstationDispatchPlanRegistry,
  type WorkstationDispatchPlanView,
  type WorkstationRelayFingerprintView,
  type WorkstationPlanRevalidationResultView,
} from "../../src/nodes/tools";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";

// ---------------------------------------------------------------------------
// Mock relay registry — supports multiple relays with per-relay binding
// fingerprints, so the plan pinning + stale-binding paths can be exercised.
// ---------------------------------------------------------------------------

type RelayDispatchRequest = {
  toolName: string;
  args: Record<string, unknown>;
  impact: "read-only" | "low" | "high" | "destructive";
  approvalObtained: boolean;
  allowedRoots?: string[] | undefined;
  sandboxProfile?: { workspace: string } | undefined;
  timeout?: number;
};
type RelayDispatchResult = { status: "ok" | "error"; result?: unknown; error?: string };

interface RelayMockState {
  userId: string;
  desktopSessionId: string;
  capabilityRevision: number;
  pairingGeneration: string;
  profileId: string;
  profileRevision: number;
  /** When false, the relay is treated as disconnected (fingerprint all null). */
  connected: boolean;
  /**
   * When false, the relay advertises NO Workstation Profile snapshot — a
   * non-Full-Mode relay that legitimately dispatches generic run_shell
   * through the server sandbox (byte-for-byte pre-D418). Default true
   * (profile-bound / Full Workstation eligible).
   */
  profileBound?: boolean;
}

function makeMultiRelayRegistry(config: {
  eligibleOrder: string[];
  states: Record<string, RelayMockState>;
  onDispatch?: (relayId: string, req: RelayDispatchRequest) => Promise<RelayDispatchResult>;
}): ToolRelayRegistry & {
  dispatchedTo: string[];
  lastRequest?: RelayDispatchRequest;
} {
  const eligibleOrder = [...config.eligibleOrder];
  const states: Record<string, RelayMockState> = { ...config.states };
  const dispatchedTo: string[] = [];
  const self = {
    findByCapabilityForUser: () => [...eligibleOrder],
    getCapabilities: (rid: string) => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: [`/roots/${rid}`],
      securityLevel: "standard",
    }),
    getUserId: (rid: string) => states[rid]?.connected ? states[rid].userId : null,
    getDesktopSessionId: (rid: string) => states[rid]?.connected ? states[rid].desktopSessionId : null,
    getCapabilityRevision: (rid: string) => states[rid]?.connected ? states[rid].capabilityRevision : null,
    getPairingGeneration: (rid: string) => states[rid]?.connected ? states[rid].pairingGeneration : null,
    getWorkstationProfileSnapshot: (rid: string) =>
      states[rid]?.connected && (states[rid].profileBound ?? true)
        ? ({
            profileId: states[rid].profileId,
            profileRevision: states[rid].profileRevision,
            grantIds: ["grant-1"],
            protectedPolicyVersion: 1,
            networkMode: "isolated",
            capabilities: [],
          } as never)
        : null,
    dispatch: (relayId: string, req: RelayDispatchRequest) => {
      dispatchedTo.push(relayId);
      self.lastRequest = req;
      return config.onDispatch
        ? config.onDispatch(relayId, req)
        : Promise.resolve({ status: "ok", result: "ok" });
    },
    dispatchedTo,
    lastRequest: undefined as RelayDispatchRequest | undefined,
  };
  return self as never;
}

// ---------------------------------------------------------------------------
// Mock plan registry — satisfies the structural `WorkstationDispatchPlanRegistry`
// interface. `revalidate` mirrors the runtime `revalidatePlanAgainstRelay`
// logic so the agent consumption path is tested in isolation.
// ---------------------------------------------------------------------------

function revalidate(
  plan: WorkstationDispatchPlanView,
  fp: WorkstationRelayFingerprintView,
): WorkstationPlanRevalidationResultView {
  if (
    fp.userId === null ||
    fp.desktopSessionId === null ||
    fp.capabilityRevision === null ||
    fp.profileId === null ||
    fp.profileRevision === null ||
    fp.pairingGeneration === null
  ) {
    return { ok: false, reason: "relay_not_connected", detail: "relay not connected" };
  }
  if (fp.userId !== plan.userId) return { ok: false, reason: "user_mismatch", detail: "user mismatch" };
  if (fp.desktopSessionId !== plan.desktopSessionId)
    return { ok: false, reason: "desktop_session_mismatch", detail: "desktop session mismatch" };
  if (fp.pairingGeneration !== plan.pairingGeneration)
    return { ok: false, reason: "pairing_generation_mismatch", detail: "pairing generation mismatch" };
  if (fp.capabilityRevision !== plan.capabilityRevision)
    return { ok: false, reason: "capability_revision_mismatch", detail: "capability revision mismatch" };
  if (fp.profileId !== plan.profileId || fp.profileRevision !== plan.profileRevision)
    return { ok: false, reason: "profile_binding_mismatch", detail: "profile binding mismatch" };
  return { ok: true };
}

function makeMockPlanRegistry(): WorkstationDispatchPlanRegistry & {
  store: Map<string, WorkstationDispatchPlanView>;
  admit(plan: WorkstationDispatchPlanView): void;
  clear(): void;
} {
  const store = new Map<string, WorkstationDispatchPlanView>();
  return {
    store,
    get(id: string) {
      return store.get(id) ?? null;
    },
    revalidate,
    admit(plan: WorkstationDispatchPlanView) {
      store.set(plan.toolCallId, plan);
    },
    clear() {
      store.clear();
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = "test-owner";
const RELAY_A = "relay-A";
const RELAY_B = "relay-B";
const DESKTOP_A = "desktop-A";
const PROFILE_A = "profile-A";
const PAIRING_A = "pairing-1";

function planView(overrides: Partial<WorkstationDispatchPlanView> = {}): WorkstationDispatchPlanView {
  return {
    toolCallId: "tc-run_shell",
    userId: USER,
    relayId: RELAY_A,
    instanceId: "instance-A",
    desktopSessionId: DESKTOP_A,
    serverBindingId: "server-binding-A",
    pairingGeneration: PAIRING_A,
    profileId: PROFILE_A,
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    currentFolder: "/workspace",
    grantRevision: 8,
    protectedPolicyVersion: 1,
    ...overrides,
  };
}

function makeState(toolCallId: string, args: Record<string, unknown>): NautiloState {
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
    approvedToolCalls: [{ id: toolCallId, name: "run_shell", args, type: "tool_call" }],
    requiredHostRelays: { [toolCallId]: RELAY_A },
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "/workspace",
    currentFolderRelayId: "",
    workspacePath: "",
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
      relayId: RELAY_A,
      desktopSessionId: DESKTOP_A,
      pairingGeneration: PAIRING_A,
      requestId: "request-1",
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
  catalog.register({
    name: "run_shell",
    factory: () =>
      new DynamicStructuredTool({
        name: "run_shell",
        description: "stub",
        schema: z.object({ command: z.string() }),
        func: () => Promise.reject(new Error("relay tool — should not invoke locally")),
      }),
    category: "development",
    trustTier: "admin",
    executor: "relay",
    impact: "destructive",
    requiredCapabilities: ["use_high_impact_tools"],
    tags: [],
    resultScanPolicy: "on-suspicious",
  });
  return catalog;
}

beforeAll(() => {
  initToolCatalog(buildTestCatalog());
  setOrdinaryHostResolver({ resolve: async () => ({
    status: "selected",
    host: {
      relayId: RELAY_A,
      pairingGeneration: PAIRING_A,
      desktopSessionId: DESKTOP_A,
      capabilityRevision: 10,
    },
  }) });
});

afterEach(() => {
  setRelayRegistry(null);
  setWorkstationDispatchPlanRegistry(null);
});

function contentOf(msg: { content: unknown } | undefined): string {
  if (!msg) return "";
  const c = msg.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D418 task 3.1.2 — WorkstationDispatchPlan relay pinning", () => {
  test("relay A selected at admission: plan pins dispatch to relay-A even when relay-B is first eligible", async () => {
    const registry = makeMultiRelayRegistry({
      // relay-B is FIRST in the eligible list — without a plan, relay-B would
      // be chosen. The plan must override that and pin to relay-A.
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);

    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    // relay-B was never dispatched to.
    expect(registry.dispatchedTo).not.toContain(RELAY_B);
    expect(plans.store.size).toBe(1);
  });

  test("relay B cannot be dispatched: a plan pinning relay-A never falls back to relay-B", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    // Successful dispatch to relay-A; relay-B never contacted.
    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(content).toBe("ok");
  });

  test("stale capability binding: plan relay-A capabilityRevision drifted → fail closed, no fallback to relay-B", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          // Drifted from the plan's 10 → the bound relay is no longer exact.
          capabilityRevision: 11,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView({ capabilityRevision: 10 }));
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    // No dispatch happened at all — fail closed, NOT re-routed to relay-B.
    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).not.toContain(RELAY_B);
  });

  test("stale profile binding: plan relay-A profileRevision drifted → fail closed, no fallback", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          // Drifted from the plan's 1 → profile re-compile.
          profileRevision: 2,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView({ profileRevision: 1 }));
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
  });

  test("bound relay gone (disconnected): plan relay-A not connected → fail closed, no fallback to relay-B", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: false,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    // relay-A is gone; the dispatch must NOT silently re-route to relay-B.
    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).not.toContain(RELAY_B);
  });

  test("no plan remains pinned to the verified Electron host", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
          // Non-Full-Mode relay: no advertised profile snapshot, so a generic
          // run_shell dispatches through the server sandbox byte-for-byte
          // pre-D418 (no plan-bound binding required).
          profileBound: false,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
          profileBound: false,
        },
      },
    });
    setRelayRegistry(registry);
    // No plan registry installed ⇒ tools node skips plan pinning entirely.
    setWorkstationDispatchPlanRegistry(null);

    await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
  });

  test("no client Auto-Approve bypass: workstation-ish args cannot change the verified host", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
          // Non-Full-Mode relays: a client flag cannot self-authorize a plan,
          // and the generic shell path stays valid (byte-for-byte pre-D418).
          profileBound: false,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
          profileBound: false,
        },
      },
    });
    setRelayRegistry(registry);
    // An empty plan store — a client flag in the tool args can never
    // self-authorize a plan. The plan store is server-side and admitted only
    // by the override resolver (which reads the live session registry).
    const plans = makeMockPlanRegistry();
    setWorkstationDispatchPlanRegistry(plans);

    // Tool args carry a "client auto-approve" style flag — it must be ignored.
    await toolsNode(
      makeState("tc-run_shell", {
        command: "echo hello",
        auto_approve: true,
        workstation_full_mode: true,
      }),
    );

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(plans.store.size).toBe(0);
  });

  test("Full Workstation eligible relay, no plan ⇒ fail closed (no unprotected generic shell)", async () => {
    // A profile-bound relay is Full Workstation eligible: protectedPaths
    // only enter the sandbox through the plan-bound binding path. With no
    // plan admitted (missing/stale session), a generic run_shell MUST fail
    // closed rather than dispatch an unprotected shell to either relay.
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
          // Profile-bound (default) — Full Workstation eligible.
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    // No dispatch to either relay — fail closed, NOT a generic shell.
    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("cannot run on Full Workstation relay");
  });

  test("plan never widens allowedRoots: dispatch roots come from relay caps / sandbox, not the plan", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    // allowedRoots are the relay-A caps roots (`/roots/relay-A`), NOT any
    // root the plan might have smuggled (the plan carries no roots at all).
    expect(registry.lastRequest?.allowedRoots).toEqual(["/roots/relay-A"]);
  });

  test("desktop session mismatch (app-restart identity change) → fail closed, no fallback", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          // New Electron main-process launch → different desktop session id.
          desktopSessionId: "desktop-A-restarted",
          capabilityRevision: 10,
          pairingGeneration: PAIRING_A,
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView({ desktopSessionId: DESKTOP_A }));
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
  });

  test("pairing generation mismatch (relay re-paired, desktopSessionId reused) → fail closed, no fallback", async () => {
    const registry = makeMultiRelayRegistry({
      eligibleOrder: [RELAY_B, RELAY_A],
      states: {
        [RELAY_A]: {
          userId: USER,
          desktopSessionId: DESKTOP_A,
          capabilityRevision: 10,
          pairingGeneration: "pairing-re-paired",
          profileId: PROFILE_A,
          profileRevision: 1,
          connected: true,
        },
        [RELAY_B]: {
          userId: USER,
          desktopSessionId: "desktop-B",
          capabilityRevision: 20,
          pairingGeneration: "pairing-B",
          profileId: "profile-B",
          profileRevision: 1,
          connected: true,
        },
      },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView({ pairingGeneration: PAIRING_A }));
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(makeState("tc-run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).toContain("pairing_generation_mismatch");
  });
});
