import { AIMessage } from "@langchain/core/messages";
import { createPostModelNode, resolveApprovalForToolCall } from "../../src/nodes/post-model";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";
import type { PolicyResolver } from "@nautilo/trust";
import { afterEach, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { type RelayLocalExecutionBinding } from "@nautilo/relay";
import { setAgentEventSink } from "../../src/runtime-hooks";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode } from "../../src/nodes/tools";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createExecCommandTool, createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { setOrdinaryHostResolver(null); setAgentEventSink(null); setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); clearToolCatalog(); });
function fixture() {
  let protocol = 29; let admitted = true;
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
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true,
      basicExecution: { version: 1, currentFolder: "/tmp/fixture", serverBindingId: "server-fixture", protectedPolicyVersion: 1 },
      localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } }),
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
  const state = (name: string, args: Record<string, unknown>, overrides: Partial<NautiloState> = {}) => ({
    currentFolder: "/tmp/fixture", messages: [], approvedToolCalls: [{ id: `call-${name}`, name, args, type: "tool_call" }], actorRole: "owner",
    userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", langgraphThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true },
    requiredHostRelays: { [`call-${name}`]: "relay-fixture" }, trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { sent, state, protocol: (value: number) => { protocol = value; }, admitted: (value: boolean) => { admitted = value; }, failWith: (error: Error | null) => { dispatchError = error; } };
}


test("Basic starts have no Development binding and continuations retain original authority after folder change", async () => {
  const f = fixture(); await toolsNode(f.state("exec_command", { cmd: "printf fixture" }));
  expect(f.sent).toHaveLength(1);
  const original = f.sent[0]!.localExecutionBinding!;
  expect(original).toMatchObject({ version: 2, authority: { kind: "basic", currentFolder: "/tmp/fixture" }, owner: { profileId: null, profileRevision: null, grantIds: [], grantRevision: null } });
  expect(f.sent[0]!.workstationShellBinding).toBeUndefined();
  f.admitted(false);
  await toolsNode(f.state("write_stdin", { session_id: original.executionId, chars: "once\n" }, { currentFolder: "/tmp/new-selection" }));
  expect(f.sent).toHaveLength(2); expect(f.sent[1]!.localExecutionBinding).toMatchObject({ version: 2, authority: { currentFolder: "/tmp/fixture" } });
  for (const override of [{ agentId: "foreign" }, { currentThreadId: "foreign" }, { roomId: "foreign" }]) {
    await toolsNode(f.state("write_stdin", { session_id: original.executionId, chars: "denied" }, override));
  }
  expect(f.sent).toHaveLength(2);
});
test("Basic requires explicit current plan, protocol and foreground owner", async () => {
  const f = fixture(); f.admitted(false); await toolsNode(f.state("exec_command", { cmd: "printf fixture" }));
  f.admitted(true); f.protocol(22); await toolsNode(f.state("exec_command", { cmd: "printf fixture" }));
  f.protocol(29); await toolsNode(f.state("exec_command", { cmd: "printf fixture" }, { agentId: "foreign" }));
  await toolsNode(f.state("exec_command", { cmd: "printf fixture" }, { verifiedOrdinaryOrigin: null }));
  expect(f.sent).toHaveLength(0);
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

test("post-model exact Basic plan suppresses PIN then tools node serializes only Basic authority", async () => {
  const f = fixture(); f.admitted(false);
  setOrdinaryHostResolver({ resolve: async () => ({ status: "selected", host: { relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", capabilityRevision: 1 } }) });
  const state = f.state("exec_command", { cmd: "printf fixture" }); state.messages = [new AIMessage({ content: "", tool_calls: state.approvedToolCalls })];
  const admitted = await createPostModelNode(makeMockResolver(), {
    matchCommandApproval: async () => null, createCommandApproval: async () => ({ id: "unused", created: true }),
    resolveWorkstationApprovalOverride: async request => {
      expect(request).toMatchObject({ userId: "human-fixture", agentId: "agent-fixture", roomId: "room-fixture", conversationId: "conversation-fixture", requiredRelayId: "relay-fixture", verifiedOrdinaryOrigin: { kind: "local_electron" } });
      f.admitted(true); return { override: "auto", executionClass: "basic_sandbox" };
    },
  })(state);
  expect(admitted.approvedToolCalls).toHaveLength(1);
  await toolsNode({ ...state, ...admitted }); expect(f.sent).toHaveLength(1); expect(f.sent[0]!.localExecutionBinding?.version).toBe(2);
});

test("contained PTY input retains ordinary review without requesting Development activation", () => {
  fixture();
  expect(resolveApprovalForToolCall({ name: "write_stdin", args: { session_id: "execution", chars: "printf fixture\n" } }, "standard").verb).toBe("ask");
  expect(resolveApprovalForToolCall({ name: "write_stdin", args: { session_id: "execution", chars: "rm -rf /\n" } }, "standard").verb).toBe("block");
});
