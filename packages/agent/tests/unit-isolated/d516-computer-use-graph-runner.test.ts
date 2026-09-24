/**
 * D516 3.6.11 simulated graph characterization.
 *
 * This file owns process-global module/runtime fixtures and therefore runs in
 * its own Bun process. It uses the real graph, nodes, catalogue registration,
 * admission, and relay execution path. Only persisted model preferences and
 * the external computer client are deterministic doubles. It is not evidence
 * of live persistence, a real model, signed Host authority, or product bytes.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { NautiloState } from "../../src/agent/state";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import type { ChatModel } from "../../src/providers/types";

const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));
let roomPreferenceReads = 0;
let profilePreferenceReads = 0;
const getRoomAgentModelControlSelection = async () => { roomPreferenceReads += 1; return null; };
const getProfileDefaultModelControlSelection = async () => { profilePreferenceReads += 1; return null; };
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getRoomAgentModelControlSelection,
  getProfileDefaultModelControlSelection,
  getCachedServerModelConfigRow: () => null,
}));

type AgentModule = typeof import("../../src/agent/graph");
type UniversalModule = typeof import("../../src/providers/universal");
type AdmissionModule = typeof import("../../src/runtime/computer-use-admission");
type HostResolverModule = typeof import("../../src/runtime/ordinary-host-resolver");
type ToolsModule = typeof import("../../src/nodes/tools");
type RegisterModule = typeof import("../../src/tools/register-all");

let createNautiloGraph: AgentModule["createNautiloGraph"];
let setStubModel: UniversalModule["__setStubModelForTests"];
let deriveComputerUseInvocationId: AdmissionModule["deriveComputerUseInvocationId"];
let setOrdinaryHostResolver: HostResolverModule["setOrdinaryHostResolver"];
let setRelayRegistry: ToolsModule["setRelayRegistry"];
let registerAllTools: RegisterModule["registerAllTools"];
let ToolCatalog: typeof import("@nautilo/catalog")["ToolCatalog"];
let initToolCatalog: typeof import("@nautilo/catalog")["initToolCatalog"];
let clearToolCatalog: typeof import("@nautilo/catalog")["clearToolCatalog"];
let AIMessage: typeof import("@langchain/core/messages")["AIMessage"];
let HumanMessage: typeof import("@langchain/core/messages")["HumanMessage"];
let ToolMessage: typeof import("@langchain/core/messages")["ToolMessage"];
let MemorySaver: typeof import("@langchain/langgraph")["MemorySaver"];
let nativeContracts: typeof import("@nautilo/computer-use-contracts/native")["COMPUTER_USE_NATIVE_CONTRACTS"];
let automationBindingVersion: typeof import("@nautilo/relay")["RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION"];
const previousTestMode = process.env["NAUTILO_TEST_MODE"];

beforeAll(async () => {
  ({ createNautiloGraph } = await import("../../src/agent/graph"));
  ({ __setStubModelForTests: setStubModel } = await import("../../src/providers/universal"));
  ({ deriveComputerUseInvocationId } = await import("../../src/runtime/computer-use-admission"));
  ({ setOrdinaryHostResolver } = await import("../../src/runtime/ordinary-host-resolver"));
  ({ setRelayRegistry } = await import("../../src/nodes/tools"));
  ({ registerAllTools } = await import("../../src/tools/register-all"));
  ({ ToolCatalog, initToolCatalog, clearToolCatalog } = await import("@nautilo/catalog"));
  ({ AIMessage, HumanMessage, ToolMessage } = await import("@langchain/core/messages"));
  ({ MemorySaver } = await import("@langchain/langgraph"));
  ({ COMPUTER_USE_NATIVE_CONTRACTS: nativeContracts } = await import("@nautilo/computer-use-contracts/native"));
  ({ RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION: automationBindingVersion } = await import("@nautilo/relay"));
});

afterAll(() => {
  setRelayRegistry?.(null);
  setOrdinaryHostResolver?.(null);
  setStubModel?.(null);
  clearToolCatalog?.();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  mock.restore();
});

const ids = {
  human: "human-fixture",
  agent: "agent-fixture",
  relay: "relay-fixture",
  desktopSession: "desktop-session-fixture",
  pairing: "pairing-fixture",
  request: "request-fixture",
  run: "run-fixture",
  lineage: "lineage-fixture",
  installation: "installation-fixture",
  providerGeneration: "provider-generation-fixture",
  context: "computer-context-fixture",
  call: "computer-call-fixture",
} as const;

function simulatedHostResult(): string {
  return JSON.stringify({
    kind: "result",
    protocol: { major: 3, minor: 0 },
    requestId: "host-request-fixture",
    fence: {
      hostGeneration: "host-generation-fixture",
      driverGeneration: ids.providerGeneration,
      cancellationGeneration: 1,
    },
    contract: nativeContracts.observe,
    settlement: "completed",
    result: {
      version: 1,
      operation: "desktop_state",
      context: `dctx_${"a".repeat(43)}`,
      completeness: "complete",
      discovered: 0,
      returned: 0,
      omitted: 0,
      boundary: { kind: "none", retryable: false },
      uninspected: null,
      continuation: null,
      alternatives: [],
      targets: [],
      applicationTargets: { discovered: 0, returned: 0, omitted: 0, targets: [] },
      outcome: {
        version: 1,
        phase: "observe",
        retrySafety: "safe",
        stateChangeCertainty: "not_applicable",
        providerCondition: "ready",
        targetCondition: "current",
        recovery: ["retry_same_request"],
      },
    },
  });
}

test("ordinary prompt crosses the production graph and semantic Computer Use lane", async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { officeCliAvailable: () => false, mediaGenerationAvailable: () => false });
  initToolCatalog(catalog);

  const evidence = {
    evidenceMode: "simulated_scripted_model_mocked_db_client" as const,
    modelCalls: 0,
    toolCalls: 0,
    firstModelToolNames: [] as string[],
  };
  const requests: Array<Record<string, unknown>> = [];
  const modelInvocations: Array<Parameters<ChatModel["invoke"]>[0]> = [];
  const model: ChatModel = {
    bindTools(tools) {
      if (evidence.modelCalls === 0) {
        evidence.firstModelToolNames = tools.flatMap((tool) => (
          tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
            ? [tool.name]
            : []
        ));
      }
      return model;
    },
    async invoke(messages) {
      modelInvocations.push(messages);
      evidence.modelCalls += 1;
      return evidence.modelCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: ids.call, name: "computer_observe", args: { operation: "desktop_state" } }],
          })
        : new AIMessage("The simulated desktop observation completed.");
    },
  };
  setStubModel(model);
  setOrdinaryHostResolver({
    resolve: async () => ({
      status: "selected",
      host: {
        relayId: ids.relay,
        pairingGeneration: ids.pairing,
        desktopSessionId: ids.desktopSession,
        capabilityRevision: 1,
      },
    }),
  });
  setRelayRegistry({
    findByCapabilityForUser: () => [ids.relay],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canUseComputer: true,
      workspaceRoot: "/fixture/workspace",
      allowedRoots: ["/fixture/workspace"],
      dataDir: "/fixture/data",
      toolsBin: "/fixture/tools",
      userHome: "/fixture",
    }),
    dispatch: async (
      _relayId: Parameters<ToolRelayRegistry["dispatch"]>[0],
      request: Parameters<ToolRelayRegistry["dispatch"]>[1],
    ) => {
      evidence.toolCalls += 1;
      requests.push(request as unknown as Record<string, unknown>);
      return { status: "ok", result: simulatedHostResult() };
    },
  } as unknown as NonNullable<Parameters<ToolsModule["setRelayRegistry"]>[0]>);

  const policyResolver = {
    resolveContext: async () => { throw new Error("unused in direct graph fixture"); },
    buildEnvelope: async () => { throw new Error("unused in direct graph fixture"); },
    checkToolAccess: async () => ({ type: "allow" as const }),
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
  const checkpointSaver = new MemorySaver();
  const graph = createNautiloGraph(checkpointSaver, policyResolver, {
    resolveComputerUseAdmission: (request) => ({
      status: "admitted",
      binding: {
        version: automationBindingVersion,
        computerUseContextId: ids.context,
        computerUseInvocationId: deriveComputerUseInvocationId(ids.context, request.toolCall)!,
        relayId: ids.relay,
        pairingGeneration: ids.pairing,
        desktopSessionId: ids.desktopSession,
        originHumanId: ids.human,
        originRunId: ids.run,
        originAgentId: ids.agent,
        lineageId: ids.lineage,
        installationEpoch: ids.installation,
        grantGeneration: 1,
        provider: "cua",
        providerGeneration: ids.providerGeneration,
      },
    }),
  });
  const graphConfig = { configurable: { thread_id: "d516-simulated-graph-fixture" } };
  const result = await graph.invoke({
    messages: [new HumanMessage("Observe the current desktop and summarize what is available.")],
    model: "openai:gpt-5.5-2026-04-23",
    userId: ids.human,
    agentId: ids.agent,
    actorRole: "owner",
    causalHumanUserId: ids.human,
    trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: ids.human,
      actorId: ids.human,
      relayId: ids.relay,
      desktopSessionId: ids.desktopSession,
      pairingGeneration: ids.pairing,
      requestId: ids.request,
    },
    desktopAutomationProvenance: {
      originHumanId: ids.human,
      originRunId: ids.run,
      originAgentId: ids.agent,
      lineageId: ids.lineage,
      installationEpoch: ids.installation,
      grantGeneration: 1,
    },
    desktopAutomationRouteBinding: {
      version: 2,
      provider: "cua",
      providerGeneration: ids.providerGeneration,
      grantGeneration: 1,
    },
    relayCapabilities: { canUseComputer: true },
    memoryAccessEnvelope: {
      ownerId: ids.human,
      actorId: ids.human,
      agentId: ids.agent,
      roomId: "room-fixture",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { computer_observe: "allow" },
    },
  }, graphConfig) as NautiloState;

  expect(evidence).toMatchObject({
    evidenceMode: "simulated_scripted_model_mocked_db_client",
    modelCalls: 2,
    toolCalls: 1,
  });
  expect(evidence.firstModelToolNames).toContain("computer_observe");
  expect(roomPreferenceReads).toBe(0);
  expect(profilePreferenceReads).toBe(2);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    toolName: "computer_observe",
    executionClass: "computer_use",
    args: { operation: "desktop_state" },
    computerUseRequest: {
      contract: nativeContracts.observe,
      arguments: { operation: "desktop_state" },
    },
    desktopAutomationBinding: {
      originHumanId: ids.human,
      provider: "cua",
      providerGeneration: ids.providerGeneration,
    },
    sandboxProfile: {
      workspace: "/fixture/workspace",
      dataDir: "/fixture/data",
      toolsBin: "/fixture/tools",
    },
  });
  const toolMessages = result.messages.filter((message) => ToolMessage.isInstance(message));
  expect(toolMessages).toHaveLength(1);
  expect(toolMessages.map((message) => message.name)).toEqual(["computer_observe"]);
  expect(JSON.parse(toolMessages[0]!.content as string)).toMatchObject({
    ok: true,
    settlement: "completed",
    result: { operation: "desktop_state", completeness: "complete" },
  });
  const secondToolCall = modelInvocations[1]?.find((message) => ToolMessage.isInstance(message));
  expect(secondToolCall).toBeInstanceOf(ToolMessage);
  expect((secondToolCall as InstanceType<typeof ToolMessage>).tool_call_id).toBe(ids.call);
  expect(JSON.parse((secondToolCall as InstanceType<typeof ToolMessage>).content as string)).toMatchObject({
    ok: true,
    settlement: "completed",
    result: { operation: "desktop_state" },
  });
  const checkpoint = await graph.getState(graphConfig);
  const checkpointMessages = (checkpoint?.values["messages"] ?? []) as unknown[];
  const checkpointTool = checkpointMessages.find((message) => ToolMessage.isInstance(message));
  expect(checkpointTool).toBeInstanceOf(ToolMessage);
  expect((checkpointTool as InstanceType<typeof ToolMessage>).tool_call_id).toBe(ids.call);
  expect(JSON.parse((checkpointTool as InstanceType<typeof ToolMessage>).content as string)).toMatchObject({
    ok: true,
    settlement: "completed",
    result: { operation: "desktop_state" },
  });
  expect(result.messages.at(-1)).toBeInstanceOf(AIMessage);
  expect(result.messages.at(-1)?.content).toBe("The simulated desktop observation completed.");
});
