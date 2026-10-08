import { defaultPostModelDeps } from "../../src/agent/post-model-deps";
import { Command, MemorySaver, entrypoint } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { createPostModelNode } from "../../src/nodes/post-model";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";
import type { PolicyResolver } from "@nautilo/trust";
import { afterEach, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { type RelayLocalExecutionBinding } from "@nautilo/relay";
import { setAgentEventSink } from "../../src/runtime-hooks";
import type { NautiloState } from "../../src/agent/state";
import { createToolsNode } from "../../src/nodes/tools";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createExecCommandTool, createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { delete defaultPostModelDeps.resolveUncontainedHostCommandsDispatch; setOrdinaryHostResolver(null); setAgentEventSink(null); setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); clearToolCatalog(); });
let sourceAllowed = true; let postSourceAllowed = true;
const toolsNode = createToolsNode({ humanTerminalAdmissionPortForState: () => ({ async withAdmission(work) {
  if (!sourceAllowed) throw new Error("revoked"); const result = await work(new AbortController().signal);
  if (!postSourceAllowed) throw new Error("revoked"); return result;
} }) });
function fixture() {
  sourceAllowed = true; postSourceAllowed = true;
  let protocol = 25; let admitted = false; let activationId = "activation"; const activation = new AbortController();
  const catalog = new ToolCatalog();
  for (const factory of [createExecCommandTool, createWriteStdinTool]) {
    catalog.register({ name: factory().name, factory, exposure: "core", category: "development", trustTier: "admin",
      impact: "destructive", executor: "cloud", resultScanPolicy: "never", requiresApproval: true, approvalLevel: "prove_it", requiredCapabilities: ["use_workstation"] });
  }
  initToolCatalog(catalog);
  let binding: RelayLocalExecutionBinding | null = null;
  let dispatchError: Error | null = null;
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  setRelayRegistry({
    findByCapabilityForUser: (_capability: string, userId: string) => userId === "human-fixture" ? ["relay-fixture"] : [],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true, canExecuteFullMacOneShot: true,
      basicExecution: { version: 1, currentFolder: "/tmp/fixture", serverBindingId: "server-fixture", protectedPolicyVersion: 1 },
      localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, capacity: 1 } }),
    getUserId: () => "human-fixture", getDesktopSessionId: () => "desktop-fixture", getProtocolVersion: () => protocol,
    getPairingGeneration: () => "pairing-fixture",
    getLocalExecutionPairingGeneration: () => "pairing-fixture",
    getLocalExecutionWorkstationBinding: () => sent[0]?.workstationShellBinding ?? null,
    getLocalExecutionBinding: (_relayId: string, executionId: string) => binding?.executionId === executionId ? binding : null,
    dispatch: async (_relayId, request) => { sent.push(request); if (request.localExecutionBinding?.operation === "start") binding = request.localExecutionBinding;
      if (dispatchError !== null) throw dispatchError;
      return { status: "ok", result: { session_id: binding?.executionId, state: "running" } }; },
  } as ToolRelayRegistry);
  setWorkstationDispatchPlanRegistry({
    get: () => admitted ? ({ toolCallId: "call-exec_command", userId: "human-fixture", relayId: "relay-fixture", instanceId: "",
      desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", pairingGeneration: "pairing-fixture",
      agentId: "agent-fixture", roomId: "room-fixture", conversationId: "conversation-fixture", profileId: null, profileRevision: null, grantIds: [], capabilityRevision: 1,
      executionClass: "basic_sandbox", currentFolder: "/tmp/fixture", grantRevision: null, protectedPolicyVersion: 1 }) : null,
    revalidate: () => ({ ok: true }),
  });
  defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async () => ({ admitted: true, executionClass: "real_workstation", activationId, activationSignal: activation.signal });
  const state = (name: string, args: Record<string, unknown>, overrides: Partial<NautiloState> = {}) => ({
    fullMacInvocationBindings: { "call-exec_command": { activationId: "activation", relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", humanUserId: "human-fixture", agentId: "agent-fixture", roomId: "room-fixture", conversationId: "conversation-fixture" } },
    currentFolder: "/tmp/fixture", messages: [], approvedToolCalls: [{ id: `call-${name}`, name, args, type: "tool_call" }], actorRole: "owner",
    userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", langgraphThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true },
    requiredHostRelays: { [`call-${name}`]: "relay-fixture" }, trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { sent, state, activation, replace: () => { activationId = "replacement"; }, protocol: (value: number) => { protocol = value; }, admitted: (value: boolean) => { admitted = value; }, failWith: (error: Error | null) => { dispatchError = error; } };
}
function makeMockResolver(

): PolicyResolver {
  return {
    resolveContext: async () => ({
      laneKey: "", actorId: "", agentId: "", roomId: "", roomType: "", graphThreadId: "",
      actorLabel: "", actorFederatedId: "", agentFederatedId: "",
      speakerTrust: "verified" as const,
      laneScope: "private" as const, actorRole: "owner",
      memoryAccess: { ownerId: "", actorId: "", agentId: "", roomId: "", readableNamespaces: [],
        mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
    }),
    buildEnvelope: async () => ({
      toolPolicy: {} as Record<string, "allow" | "read_only" | "require_prove_it" | "forbidden">,
      ownerId: "", actorId: "", agentId: "", roomId: "", readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
    }),
    checkToolAccess: async () =>
      ({ type: "allow" as const }),
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}

test("Full Mac uses only the pinned activation, refuses PTY/input, and reads original execution after reactivation", async () => {
  const f = fixture();
  await toolsNode(f.state("exec_command", { cmd: "printf fixture" })); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ executionClass: "real_workstation", uncontainedHostCommandsSession: true,
    localExecutionBinding: { version: 3, authority: { kind: "full_mac", activationId: "activation", roomId: "room-fixture" } } });
  expect(f.sent[0]!.localExecutionActivationSignal).toBe(f.activation.signal); expect(f.sent[0]!.workstationShellBinding).toBeUndefined();
  const id = f.sent[0]!.localExecutionBinding!.executionId;
  await toolsNode(f.state("write_stdin", { session_id: id, chars: "again" })); expect(f.sent).toHaveLength(1);
  f.replace(); await toolsNode(f.state("exec_command", { cmd: "printf fixture" })); expect(f.sent).toHaveLength(1);
  await toolsNode(f.state("write_stdin", { session_id: id })); expect(f.sent).toHaveLength(2);
  expect(f.sent[1]!.localExecutionBinding).toMatchObject({ version: 3, authority: { activationId: "activation" } });
});
test("old peers, foreign Room, PTY, and missing queued activation cannot start Full Mac", async () => {
  const f = fixture(); f.protocol(24); await toolsNode(f.state("exec_command", { cmd: "printf fixture" }));
  f.protocol(25); await toolsNode(f.state("exec_command", { cmd: "printf fixture", tty: true }));
  await toolsNode(f.state("exec_command", { cmd: "printf fixture" }, { fullMacInvocationBindings: {} }));
  await toolsNode(f.state("exec_command", { cmd: "printf fixture" }, { roomId: "foreign-room" }));
  expect(f.sent).toHaveLength(0);
});
test("approval checkpoint keeps the original activation across a regrant and never invokes contained approval override", async () => {
  const f = fixture(); let overrides = 0;
  setOrdinaryHostResolver({ resolve: async () => ({ status: "selected", host: { relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", capabilityRevision: 1 } }) });
  const state = f.state("exec_command", { cmd: "printf fixture" }, { fullMacInvocationBindings: {} });
  state.messages = [new AIMessage({ content: "", tool_calls: state.approvedToolCalls })];
  const node = createPostModelNode(makeMockResolver(), { matchCommandApproval: async () => null,
    createCommandApproval: async () => ({ id: "unused", created: true }),
    resolveUncontainedHostCommandsDispatch: defaultPostModelDeps.resolveUncontainedHostCommandsDispatch!,
    resolveWorkstationApprovalOverride: async () => { overrides++; return { override: "auto", executionClass: "profile_bound_sandbox" }; } });
  const workflow = entrypoint({ name: "full-mac-approval", checkpointer: new MemorySaver() }, async () => node(state));
  const config = { configurable: { thread_id: "full-mac-approval" } };
  const parked: unknown = await workflow.invoke({}, config);
  expect(parked).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
  f.replace();
  const result = await workflow.invoke(new Command({ resume: { approved: true, verb: "once" } }), config);
  expect(result.fullMacInvocationBindings?.["call-exec_command"]?.activationId).toBe("activation");
  expect(overrides).toBe(0); await toolsNode({ ...state, ...result }); expect(f.sent).toHaveLength(0);
});

test("a contained selection checkpoint cannot adopt Full Mac activated while its ordinary approval was pending", async () => {
  const f = fixture();
  let active = false;
  const resolver: NonNullable<typeof defaultPostModelDeps.resolveUncontainedHostCommandsDispatch> = async () => active
    ? { admitted: true, executionClass: "real_workstation", activationId: "new-activation", activationSignal: f.activation.signal }
    : { admitted: false, reason: "session_inactive" };
  defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = resolver;
  setOrdinaryHostResolver({ resolve: async () => ({ status: "selected", host: { relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", capabilityRevision: 1 } }) });
  const state = f.state("exec_command", { cmd: "printf fixture" }, { fullMacInvocationBindings: {} });
  state.messages = [new AIMessage({ content: "", tool_calls: state.approvedToolCalls })];
  const node = createPostModelNode(makeMockResolver(), { matchCommandApproval: async () => null,
    createCommandApproval: async () => ({ id: "unused", created: true }), resolveUncontainedHostCommandsDispatch: resolver });
  const workflow = entrypoint({ name: "contained-approval", checkpointer: new MemorySaver() }, async () => node(state));
  const config = { configurable: { thread_id: "contained-approval" } };
  expect(await workflow.invoke({}, config)).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
  active = true; f.admitted(true);
  const result = await workflow.invoke(new Command({ resume: { approved: true, verb: "once" } }), config);
  expect(result.fullMacInvocationBindings?.["call-exec_command"]?.activationId).toBeNull();
  await toolsNode({ ...state, ...result }); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.localExecutionBinding?.version).toBe(2); expect(f.sent[0]!.uncontainedHostCommandsSession).toBeUndefined();
});

test("fresh source denial prevents dispatch and post-effect revocation suppresses command output without replay", async () => {
  const f = fixture(); sourceAllowed = false;
  await toolsNode(f.state("exec_command", { cmd: "printf fixture" })); expect(f.sent).toHaveLength(0);
  sourceAllowed = true; postSourceAllowed = false;
  const result = await toolsNode(f.state("exec_command", { cmd: "printf fixture" })); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.signal?.aborted).toBeTrue();
  expect(JSON.stringify(result.messages)).toContain("unknown");
  expect(JSON.stringify(result.messages)).not.toContain('"state":"running"');
});

test("a lost observation response does not turn a Full Mac command into a timed execution", async () => {
  const f = fixture(); const timeout = Object.assign(new Error("observation timeout"), { runShellOutcome: "unknown" }); f.failWith(timeout);
  const result = await toolsNode(f.state("exec_command", { cmd: "printf fixture" }));
  expect(f.sent).toHaveLength(1); expect(f.sent[0]!.signal?.aborted).toBeFalse();
  expect(JSON.stringify(result.messages)).toContain("unknown"); expect(JSON.stringify(result.messages)).not.toContain("source_authority_changed");
});
