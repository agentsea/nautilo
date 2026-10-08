import { AIMessage } from "@langchain/core/messages";
import type { PolicyResolver } from "@nautilo/trust";
import { createPostModelNode } from "../../src/nodes/post-model";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";
import { afterEach, describe, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { type RelayLocalExecutionBinding } from "@nautilo/relay";
import { setAgentEventSink } from "../../src/runtime-hooks";
import type { NautiloState } from "../../src/agent/state";
import { createToolsNode } from "../../src/nodes/tools";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createExecCommandTool, createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { setOrdinaryHostResolver(null); setAgentEventSink(null); setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); clearToolCatalog(); });
function fixture(protocol = 21, search = false) {
  const catalog = new ToolCatalog();
  for (const factory of [createExecCommandTool, createWriteStdinTool]) {
    catalog.register({ name: factory().name, factory, exposure: "core", category: "development", trustTier: "admin",
      impact: "read-only", executor: "cloud", resultScanPolicy: "never" });
  }
  initToolCatalog(catalog);
  let binding: RelayLocalExecutionBinding | null = null;
  let dispatchError: Error | null = null;
  let pairing = "pairing-fixture";
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  setRelayRegistry({
    findByCapabilityForUser: (_capability: string, userId: string) => userId === "human-fixture" ? ["relay-fixture"] : [],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: false, canReadLocalExecutionHistory: true, canSearchLocalExecutionOutput: search,
      localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, capacity: 1 } }),
    getUserId: () => "human-fixture", getDesktopSessionId: () => "desktop-fixture", getProtocolVersion: () => protocol,
    getPairingGeneration: () => pairing,
    getLocalExecutionPairingGeneration: () => `opaque-${pairing}`,
    getLocalExecutionBinding: (_relayId: string, executionId: string) => binding?.executionId === executionId ? binding : null,
    dispatch: async (_relayId, request) => { sent.push(request); if (request.localExecutionBinding?.operation === "start") binding = request.localExecutionBinding;
      if (dispatchError !== null) throw dispatchError;
      return { status: "ok", result: { session_id: "execution-old", generation: "generation-old", state: "completed", exitCode: 7, historical: true, output: { data: "final" } } }; },
  } as ToolRelayRegistry);
  const state = (name: string, args: Record<string, unknown>, overrides: Partial<NautiloState> = {}) => ({
    messages: [], approvedToolCalls: [{ id: `call-${name}`, name, args, type: "tool_call" }], actorRole: "owner",
    userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true },
    requiredHostRelays: { [`call-${name}`]: "relay-fixture" }, trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { sent, state, binding: (value: RelayLocalExecutionBinding) => { binding = value; }, pairing: (value: string) => { pairing = value; }, failWith: (error: Error | null) => { dispatchError = error; } };
}


describe("model execution history recovery", () => {
  function node() { return createToolsNode({ localExecutionHistoryPortForState: () => ({ withReference: async (executionId, read) => read({ executionId, generation: "generation-old", sourceMessageId: 42 }) }) }); }
  test("lost registry becomes a new final ToolMessage, with no live binding or replay", async () => {
    const f = fixture(); const result = await node()(f.state("write_stdin", { session_id: "execution-old" }));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ toolName: "write_stdin", impact: "read-only", localExecutionHistoryBinding: { generation: "generation-old", sourceMessageId: 42, reader: { humanUserId: "human-fixture", agentId: "agent-fixture", conversationId: "conversation-fixture" } } });
    expect(f.sent[0]).not.toHaveProperty("localExecutionBinding");
    expect(JSON.parse(result.messages!.at(-1)!.content as string)).toMatchObject({ historical: true, state: "completed", exitCode: 7 });
  });
  test("Desktop restart recovers even when server retained an old live binding", async () => {
    const f = fixture(); f.binding({ version: 1, executionId: "execution-old", generation: "generation-old", invocationId: "old", operation: "start", owner: { instanceId: "", humanUserId: "human-fixture", agentId: "agent-fixture", runId: "old-run", conversationId: "conversation-fixture", relayId: "relay-fixture", desktopSessionId: "old-desktop", pairingGeneration: "pairing-fixture", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } });
    await node()(f.state("write_stdin", { session_id: "execution-old" }));
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.localExecutionHistoryBinding?.generation).toBe("generation-old");
  });
  test("old locators never grant input or cancellation", async () => {
    const f = fixture(); for (const extra of [{ chars: "once" }, { cancel: true }]) await node()(f.state("write_stdin", { session_id: "execution-old", ...extra }));
    expect(f.sent).toHaveLength(0);
  });
  test("replaced pairing or missing transcript capability denies before dispatch", async () => {
    const f = fixture(); f.pairing("replacement"); await node()(f.state("write_stdin", { session_id: "execution-old" }));
    expect(f.sent).toHaveLength(0); f.pairing("pairing-fixture");
    await createToolsNode({})(f.state("write_stdin", { session_id: "execution-old" })); expect(f.sent).toHaveLength(0);
  });
  test("denied or revoked source admission withholds recovered bytes", async () => {
    const f = fixture(); const denied = createToolsNode({ localExecutionHistoryPortForState: () => ({ withReference: async (_id, read) => { await read({ executionId: "execution-old", generation: "generation-old", sourceMessageId: 42 }); throw new Error("revoked"); } }) });
    const result = await denied(f.state("write_stdin", { session_id: "execution-old" }));
    expect(f.sent).toHaveLength(1); expect(result.messages!.at(-1)!.content).not.toContain('"historical":true'); expect(result.messages!.at(-1)!.content).toContain("No command was restarted");
  });
});

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


for (const searching of [false, true]) for (const available of [true, false]) {
  test(`real post-model ${searching ? "search" : "read"} admission ${available ? "selects history-only Desktop before PIN" : "rejects a stale discovery hint"}`, async () => {
    const f = fixture(searching ? 26 : 21, searching); const capabilities: string[] = [];
    setOrdinaryHostResolver({ resolve: async request => {
      capabilities.push(request.relayCapability);
      return available && request.relayCapability === "canReadLocalExecutionHistory"
        ? { status: "selected", host: { relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", capabilityRevision: 1 } }
        : { status: "unavailable" };
    } });
    const state = f.state("write_stdin", { session_id: "execution-old", ...(searching ? { search: "final", cursor: 0 } : {}) });
    state.relayCapabilities = { canReadLocalExecutionHistory: true, canObserveLocalExecution: true, canExecuteLocal: false, canSearchLocalExecutionOutput: searching };
    state.messages = [new AIMessage({ content: "", tool_calls: state.approvedToolCalls })];
    const approved = await createPostModelNode(makeMockResolver(), { matchCommandApproval: async () => null, createCommandApproval: async () => ({ id: "unused", created: true }) })(state);
    expect(capabilities).toEqual(["canReadLocalExecutionHistory"]);
    expect(approved.approvedToolCalls).toHaveLength(available ? 1 : 0);
    const node = createToolsNode({ localExecutionHistoryPortForState: () => ({ withReference: async (executionId, read) => read({ executionId, generation: "generation-old", sourceMessageId: 42 }) }) });
    const result = await node({ ...state, ...approved });
    expect(f.sent).toHaveLength(available ? 1 : 0);
    if (available) expect(result.messages!.at(-1)!.content).toContain('"historical":true');
  });
}

test("historical search requires supported fresh capability and retains canonical transcript admission", async () => {
  for (const [protocol, supported] of [[25, true], [26, false], [26, true]] as const) {
    const f = fixture(protocol, supported); let admissions = 0;
    const node = createToolsNode({ localExecutionHistoryPortForState: () => ({ withReference: async (executionId, read) => {
      admissions++; return read({ executionId, generation: "generation-old", sourceMessageId: 42 });
    } }) });
    await node(f.state("write_stdin", { session_id: "execution-old", search: "final", cursor: 0 }));
    const eligible = protocol === 26 && supported;
    expect(admissions).toBe(eligible ? 1 : 0); expect(f.sent).toHaveLength(eligible ? 1 : 0);
    if (eligible) expect(f.sent[0]).toMatchObject({ toolName: "write_stdin", args: { search: "final", cursor: 0 }, impact: "read-only",
      localExecutionHistoryBinding: { generation: "generation-old", sourceMessageId: 42 } });
  }
});
