/**
 * D418 task 3.1.3b — `RelayWorkstationShellBinding` attachment in the tools node.
 *
 * These tests pin the agent-side of the generic `run_shell` vertical
 * enforcement slice:
 *   - a planned run_shell dispatch attaches the plan-bound shell-binding
 *     envelope, built from the pinned `WorkstationDispatchPlan`;
 *   - the envelope carries ONLY opaque ids / binding / operation metadata —
 *     no roots, no paths (it never widens `allowedRoots`);
 *   - no plan ⇒ no envelope (byte-for-byte non-Full-Mode behavior);
 *   - a planned non-run_shell dispatch does NOT attach the shell binding;
 *   - the plan never widens `allowedRoots` (computed from relay caps exactly
 *     as before; the binding is admission metadata only).
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
  buildWorkstationShellBindingFromPlan,
  type ToolRelayRegistry,
  type WorkstationDispatchPlanRegistry,
  type WorkstationDispatchPlanView,
  type WorkstationRelayFingerprintView,
  type WorkstationPlanRevalidationResultView,
} from "../../src/nodes/tools";
import {
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  type RelayWorkstationShellBinding,
} from "@nautilo/relay";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";

type RelayDispatchRequest = {
  toolName: string;
  args: Record<string, unknown>;
  impact: "read-only" | "low" | "high" | "destructive";
  approvalObtained: boolean;
  allowedRoots?: string[] | undefined;
  sandboxProfile?: { workspace: string } | undefined;
  timeout?: number;
  executionClass?: "desktop" | "fs" | "local-file" | "real_workstation";
  workstationShellBinding?: RelayWorkstationShellBinding | undefined;
  uncontainedHostCommandsSession?: true | undefined;
};
type RelayDispatchResult = { status: "ok" | "error"; result?: unknown; error?: string };

function makeRegistry(config: {
  relayId: string;
  /**
   * When false, the relay advertises NO Workstation Profile snapshot — a
   * non-Full-Mode relay that legitimately dispatches generic run_shell
   * through the server sandbox (byte-for-byte pre-D418). Default true
   * (profile-bound / Full Workstation eligible).
   */
  profileBound?: boolean;
  /**
   * D418 reconnect/session split-brain fix — when set, the registry exposes
   * `getActiveWorkstationSession` returning a session bound to the given
   * relay id (use a different id to model a session bound to ANOTHER relay).
   * `null` models no active session. Undefined (default) leaves the method
   * off the mock (byte-for-byte pre-fix tools behavior).
   */
  activeSession?: { relayId: string } | null;
  onDispatch?: (relayId: string, req: RelayDispatchRequest) => Promise<RelayDispatchResult>;
}): ToolRelayRegistry & {
  dispatchedTo: string[];
  lastRequest?: RelayDispatchRequest;
} {
  const relayId = config.relayId;
  const profileBound = config.profileBound ?? true;
  const activeSession = config.activeSession;
  const dispatchedTo: string[] = [];
  const self = {
    findByCapabilityForUser: () => [relayId],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: [`/roots/${relayId}`],
      securityLevel: "standard",
    }),
    getUserId: () => "test-owner",
    getDesktopSessionId: () => "desktop-A",
    getCapabilityRevision: () => 10,
    getPairingGeneration: () => "pairing-1",
    getWorkstationProfileSnapshot: () =>
      profileBound
        ? ({
            profileId: "profile-A",
            profileRevision: 1,
            grantIds: ["grant-1"],
            protectedPolicyVersion: 1,
            networkMode: "isolated",
            capabilities: [],
          } as never)
        : null,
    ...(activeSession !== undefined
      ? {
          getActiveWorkstationSession: () =>
            activeSession === null
              ? null
              : ({
                  userId: USER,
                  relayId: activeSession.relayId,
                  desktopSessionId: "desktop-A",
                  capabilityRevision: 10,
                } as never),
        }
      : {}),
    dispatch: (rid: string, req: RelayDispatchRequest) => {
      dispatchedTo.push(rid);
      self.lastRequest = req;
      return config.onDispatch
        ? config.onDispatch(rid, req)
        : Promise.resolve({ status: "ok", result: "ok" });
    },
    dispatchedTo,
    lastRequest: undefined as RelayDispatchRequest | undefined,
  };
  return self as never;
}

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
  } as never;
}

const USER = "test-owner";
const RELAY_A = "relay-A";

function planView(overrides: Partial<WorkstationDispatchPlanView> = {}): WorkstationDispatchPlanView {
  return {
    toolCallId: "tc-run_shell",
    userId: USER,
    relayId: RELAY_A,
    instanceId: "instance-A",
    desktopSessionId: "desktop-A",
    serverBindingId: "server-binding-A",
    pairingGeneration: "pairing-1",
    profileId: "profile-A",
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    currentFolder: "/workspace",
    grantRevision: 8,
    protectedPolicyVersion: 1,
    ...overrides,
  };
}

function makeState(toolCallId: string, name: string, args: Record<string, unknown>): NautiloState {
  return {
    messages: [
      new AIMessage({ content: "", tool_calls: [{ id: toolCallId, name, args }] }),
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
    approvedToolCalls: [{ id: toolCallId, name, args, type: "tool_call" }],
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
    workspacePath: "/workspace",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [name],
    relayCapabilities: { use_high_impact_tools: true },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: USER,
      actorId: "actor-1",
      relayId: RELAY_A,
      desktopSessionId: "desktop-A",
      pairingGeneration: "pairing-1",
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
      pairingGeneration: "pairing-1",
      desktopSessionId: "desktop-A",
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

describe("D418 task 3.1.3b — buildWorkstationShellBindingFromPlan", () => {
  test("builds the binding from the plan with opaque ids only — no roots", () => {
    const binding = buildWorkstationShellBindingFromPlan(planView(), "tc-run_shell");
    expect(binding).not.toBeNull();
    if (binding === null) throw new Error("expected protocol-v2 binding");
    expect(binding.version).toBe(RELAY_WORKSTATION_SHELL_BINDING_VERSION);
    expect(binding.operation).toBe("execute");
    expect(binding.executionClass).toBe(RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS);
    expect(binding.toolCallId).toBe("tc-run_shell");
    expect(binding.relayId).toBe(RELAY_A);
    expect(binding.desktopSessionId).toBe("desktop-A");
    expect(binding.serverBindingId).toBe("server-binding-A");
    expect(binding.pairingGeneration).toBe("pairing-1");
    expect(binding.profileId).toBe("profile-A");
    expect(binding.profileRevision).toBe(1);
    expect(binding.grantIds).toEqual(["grant-1", "grant-2"]);
    expect(binding.capabilityRevision).toBe(10);
    expect(binding.currentFolder).toBe("/workspace");
    expect(binding.grantRevision).toBe(8);
    expect(binding.protectedPolicyVersion).toBe(1);
    expect(binding.subject).toEqual({
      userId: USER,
      instanceId: "instance-A",
      relayId: RELAY_A,
      agentScope: "all_owned_agents",
    });
    // No roots / paths / filesystem identity on the binding.
    expect(binding).not.toHaveProperty("requestedRoot");
    expect(binding).not.toHaveProperty("roots");
  });

  test("falls back to the plan toolCallId when the live tool-call id is empty", () => {
    const binding = buildWorkstationShellBindingFromPlan(planView(), "");
    expect(binding).not.toBeNull();
    if (binding === null) throw new Error("expected protocol-v2 binding");
    expect(binding.toolCallId).toBe("tc-run_shell");
  });

  test("legacy plan missing protocol-v2 coherence fields fails closed", () => {
    const legacy = { ...planView() } as Record<string, unknown>;
    delete legacy["currentFolder"];
    delete legacy["grantRevision"];
    delete legacy["protectedPolicyVersion"];
    expect(
      buildWorkstationShellBindingFromPlan(
        legacy as unknown as WorkstationDispatchPlanView,
        "tc-run_shell",
      ),
    ).toBeNull();
  });
});

describe("D418 task 3.1.3b — tools node attaches the shell binding for planned run_shell", () => {
  test("a planned run_shell dispatch carries the plan-bound shell binding", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    const binding = registry.lastRequest?.workstationShellBinding;
    expect(binding).toBeDefined();
    expect(binding?.relayId).toBe(RELAY_A);
    expect(binding?.desktopSessionId).toBe("desktop-A");
    expect(binding?.profileId).toBe("profile-A");
    expect(binding?.pairingGeneration).toBe("pairing-1");
    expect(binding?.operation).toBe("execute");
    expect(binding?.executionClass).toBe("profile_bound_sandbox");
    expect(binding?.grantIds).toEqual(["grant-1", "grant-2"]);
  });

  test("a planned structured Git dispatch carries the same plan-bound binding", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(
      makeState("tc-run_shell", "run_shell", {
        git: { operation: "status" },
      }),
    );

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(registry.lastRequest?.args).toEqual({ git: { operation: "status" } });
    const binding = registry.lastRequest?.workstationShellBinding;
    expect(binding).toBeDefined();
    expect(binding?.toolCallId).toBe("tc-run_shell");
    expect(binding?.currentFolder).toBe("/workspace");
    expect(binding?.serverBindingId).toBe("server-binding-A");
  });

  test("the binding never widens allowedRoots — roots come from relay caps", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    // allowedRoots are the relay-A caps roots, unchanged by the binding.
    expect(registry.lastRequest?.allowedRoots).toEqual(["/roots/relay-A"]);
    // The binding itself carries no root/path field.
    const binding = registry.lastRequest?.workstationShellBinding;
    expect(binding).toBeDefined();
    expect(binding).not.toHaveProperty("requestedRoot");
    expect(binding).not.toHaveProperty("roots");
  });

  test("no plan ⇒ no shell binding (byte-for-byte non-Full-Mode behavior)", async () => {
    // A NON-Full-Mode relay (no advertised profile snapshot) legitimately
    // dispatches generic run_shell through the server sandbox with no
    // plan-bound binding — byte-for-byte pre-D418 behavior. A profile-bound
    // (Full Workstation eligible) relay without a plan is fail-closed
    // (covered by the dedicated test below).
    const registry = makeRegistry({ relayId: RELAY_A, profileBound: false });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(registry.lastRequest?.workstationShellBinding).toBeUndefined();
    // Normal allowedRoots still computed from relay caps.
    expect(registry.lastRequest?.allowedRoots).toEqual(["/roots/relay-A"]);
  });

  test("explicit workstation execution dispatches as real_workstation without a profile plan", async () => {
    const registry = makeRegistry({ relayId: RELAY_A, profileBound: true });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    await toolsNode(
      makeState("tc-run_shell", "run_shell", {
        command: "gh auth status",
        execution: "workstation",
      }),
    );

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(registry.lastRequest?.executionClass).toBe("real_workstation");
    expect(registry.lastRequest?.uncontainedHostCommandsSession).toBeUndefined();
    expect(registry.lastRequest?.workstationShellBinding).toBeUndefined();
  });

  test("an empty plan store ⇒ no shell binding (no client self-authorization)", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(
      makeState("tc-run_shell", "run_shell", {
        command: "echo hello",
        auto_approve: true,
        workstation_full_mode: true,
      }),
    );

    expect(registry.lastRequest?.workstationShellBinding).toBeUndefined();
  });

  test("Full Workstation eligible relay without a plan ⇒ fail closed (no unprotected shell)", async () => {
    // A profile-bound relay is Full Workstation eligible: protectedPaths
    // only enter the sandbox through the plan-bound binding path. With no
    // plan admitted (missing/stale session), a generic run_shell MUST fail
    // closed rather than dispatch an unprotected shell.
    const registry = makeRegistry({ relayId: RELAY_A, profileBound: true });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    const out = await toolsNode(
      makeState("tc-run_shell", "run_shell", { command: "echo hello" }),
    );
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(registry.lastRequest).toBeUndefined();
    expect(content).toContain("cannot run on Full Workstation relay");
    expect(content).toContain(RELAY_A);
  });

  test("Full Workstation eligible relay, empty plan store + client flag ⇒ fail closed (no self-authorization)", async () => {
    const registry = makeRegistry({ relayId: RELAY_A, profileBound: true });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    setWorkstationDispatchPlanRegistry(plans);

    const out = await toolsNode(
      makeState("tc-run_shell", "run_shell", {
        command: "echo hello",
        auto_approve: true,
        workstation_full_mode: true,
      }),
    );
    const content = contentOf(out.messages!.slice(-1)[0]);

    // A client flag can never self-authorize a plan; the profile-bound relay
    // refuses the generic shell path entirely.
    expect(registry.dispatchedTo).toEqual([]);
    expect(registry.lastRequest).toBeUndefined();
    expect(content).toContain("cannot run on Full Workstation relay");
    expect(plans.store.size).toBe(0);
  });

  test("stale plan binding (capabilityRevision drift) ⇒ fail closed, no binding dispatched", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    // Plan pins capabilityRevision 10, but the live relay fingerprint below
    // reports 11 → revalidation fails closed (no re-route, no dispatch).
    plans.admit(planView({ capabilityRevision: 10 }));
    setWorkstationDispatchPlanRegistry(plans);

    // Override the registry's live capabilityRevision to 11 (drifted).
    (registry as unknown as { getCapabilityRevision: () => number }).getCapabilityRevision = () => 11;

    const out = await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
  });

  test("stale plan binding (pairingGeneration drift) ⇒ fail closed, no binding dispatched", async () => {
    const registry = makeRegistry({ relayId: RELAY_A });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView({ pairingGeneration: "pairing-1" }));
    setWorkstationDispatchPlanRegistry(plans);

    (registry as unknown as { getPairingGeneration: () => string }).getPairingGeneration = () =>
      "pairing-re-paired";

    const out = await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(content).toContain("no longer the exact bound relay");
    expect(content).toContain("pairing_generation_mismatch");
  });
});

describe("D418 reconnect/session split-brain fix — session-aware missing-snapshot shell refusal", () => {
  test("an active session bound to the selected relay with NO advertised snapshot ⇒ fail closed (split-brain)", async () => {
    // The split-brain: the relay's profile snapshot was cleared (reconnect
    // with frozen caps / refresh while controller unavailable) but an
    // active Full Workstation session is still bound to this relay. The
    // gate MUST fail closed even though the snapshot is absent — the
    // session-aware check is the defense-in-depth behind the
    // snapshot-cleared invalidation seam. With profileBound:false the ONLY
    // reason the gate refuses is the session-aware check (the snapshot is
    // null), so the refusal itself proves the session-aware path fired.
    const registry = makeRegistry({
      relayId: RELAY_A,
      profileBound: false,
      activeSession: { relayId: RELAY_A },
    });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    const out = await toolsNode(
      makeState("tc-run_shell", "run_shell", { command: "echo hello" }),
    );
    const content = contentOf(out.messages!.slice(-1)[0]);

    expect(registry.dispatchedTo).toEqual([]);
    expect(registry.lastRequest).toBeUndefined();
    // The refusal surfaces the stable Full Workstation refusal + the relay
    // id; the split-brain reason is logged via warn (not in the user-facing
    // error, which stays byte-for-byte with the snapshot-present refusal).
    expect(content).toContain("cannot run on Full Workstation relay");
    expect(content).toContain(RELAY_A);
  });

  test("an active session bound to a DIFFERENT relay with no snapshot here ⇒ generic path (byte-for-byte non-Full-Mode)", async () => {
    // The user has a Full Workstation session, but it is bound to relay-B.
    // The selected relay-A has no snapshot and no session bound to it, so
    // generic run_shell through the server sandbox is the correct,
    // byte-for-byte pre-D418 behavior — the session-aware check must NOT
    // over-refuse on an unrelated relay.
    const registry = makeRegistry({
      relayId: RELAY_A,
      profileBound: false,
      activeSession: { relayId: "relay-B" },
    });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(registry.lastRequest?.workstationShellBinding).toBeUndefined();
    // Normal allowedRoots still computed from relay caps.
    expect(registry.lastRequest?.allowedRoots).toEqual(["/roots/relay-A"]);
  });

  test("no active session + no advertised snapshot ⇒ generic path (byte-for-byte non-Full-Mode)", async () => {
    // The pure non-Full-Mode baseline: no session, no snapshot. The
    // session-aware addition must not regress byte-for-byte generic
    // run_shell behavior.
    const registry = makeRegistry({
      relayId: RELAY_A,
      profileBound: false,
      activeSession: null,
    });
    setRelayRegistry(registry);
    setWorkstationDispatchPlanRegistry(null);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    expect(registry.lastRequest?.workstationShellBinding).toBeUndefined();
  });

  test("an active session bound here + a plan-bound binding ⇒ dispatches with the binding (Full Mode happy path)", async () => {
    // With a valid plan admitted, the shell binding is attached and the
    // dispatch proceeds to the bound relay even though a session is active
    // — the session-aware gate only applies to the NO-plan generic path.
    const registry = makeRegistry({
      relayId: RELAY_A,
      profileBound: true,
      activeSession: { relayId: RELAY_A },
    });
    setRelayRegistry(registry);
    const plans = makeMockPlanRegistry();
    plans.admit(planView());
    setWorkstationDispatchPlanRegistry(plans);

    await toolsNode(makeState("tc-run_shell", "run_shell", { command: "echo hello" }));

    expect(registry.dispatchedTo).toEqual([RELAY_A]);
    const binding = registry.lastRequest?.workstationShellBinding;
    expect(binding).toBeDefined();
    expect(binding?.relayId).toBe(RELAY_A);
  });
});
