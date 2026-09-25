/**
 * Simulated native Computer Use graph characterization.
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
import type { NativeExecutionReply } from "../../src/graph/native-execution";

const actualDb = await import("@nautilo/db");
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
type CatalogModule = typeof import("../../src/config/model-catalog/runtime-catalog");

let createNautiloGraph: AgentModule["createNautiloGraph"];
let setStubModel: UniversalModule["__setStubModelForTests"];
let deriveComputerUseInvocationId: AdmissionModule["deriveComputerUseInvocationId"];
let setOrdinaryHostResolver: HostResolverModule["setOrdinaryHostResolver"];
let setRelayRegistry: ToolsModule["setRelayRegistry"];
let registerAllTools: RegisterModule["registerAllTools"];
let configureRuntimeModelCatalog: CatalogModule["configureRuntimeModelCatalog"];
let resetRuntimeModelCatalog: CatalogModule["resetRuntimeModelCatalog"];
let getActiveModelCatalogSync: CatalogModule["getActiveModelCatalogSync"];
let hydrateRuntimeModelCatalog: CatalogModule["hydrateRuntimeModelCatalog"];
let ToolCatalog: typeof import("@nautilo/catalog")["ToolCatalog"];
let initToolCatalog: typeof import("@nautilo/catalog")["initToolCatalog"];
let clearToolCatalog: typeof import("@nautilo/catalog")["clearToolCatalog"];
let AIMessage: typeof import("@langchain/core/messages")["AIMessage"];
let HumanMessage: typeof import("@langchain/core/messages")["HumanMessage"];
let ToolMessage: typeof import("@langchain/core/messages")["ToolMessage"];
let MemorySaver: typeof import("@langchain/langgraph")["MemorySaver"];
let nativeContracts: typeof import("@nautilo/computer-use-contracts/native")["COMPUTER_USE_NATIVE_CONTRACTS"];
let nativeSchemas: typeof import("@nautilo/computer-use-contracts/native")["NATIVE_CONTRACT_SCHEMAS"];
let automationBindingVersion: typeof import("@nautilo/relay")["RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION"];
const previousTestMode = process.env["NAUTILO_TEST_MODE"];
const previousKey = process.env["OPENROUTER_API_KEY"];

beforeAll(async () => {
  ({ createNautiloGraph } = await import("../../src/agent/graph"));
  ({ __setStubModelForTests: setStubModel } = await import("../../src/providers/universal"));
  ({ deriveComputerUseInvocationId } = await import("../../src/runtime/computer-use-admission"));
  ({ setOrdinaryHostResolver } = await import("../../src/runtime/ordinary-host-resolver"));
  ({ setRelayRegistry } = await import("../../src/nodes/tools"));
  ({ registerAllTools } = await import("../../src/tools/register-all"));
  ({ configureRuntimeModelCatalog, resetRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog } =
    await import("../../src/config/model-catalog/runtime-catalog"));
  ({ ToolCatalog, initToolCatalog, clearToolCatalog } = await import("@nautilo/catalog"));
  ({ AIMessage, HumanMessage, ToolMessage } = await import("@langchain/core/messages"));
  ({ MemorySaver } = await import("@langchain/langgraph"));
  ({ COMPUTER_USE_NATIVE_CONTRACTS: nativeContracts, NATIVE_CONTRACT_SCHEMAS: nativeSchemas } =
    await import("@nautilo/computer-use-contracts/native"));
  ({ RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION: automationBindingVersion } = await import("@nautilo/relay"));
});

afterAll(() => {
  setRelayRegistry?.(null);
  setOrdinaryHostResolver?.(null);
  setStubModel?.(null);
  clearToolCatalog?.();
  resetRuntimeModelCatalog?.();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = previousKey;
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
  const envelope = {
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
  };
  nativeSchemas.observe.result.parse(envelope.result);
  return JSON.stringify(envelope);
}

for (const mode of ["ordinary prompt", "delegated CUA", "compose then execute", "ordinary chat with acceleration available",
  "delegated CUA without Middle"]) test(`${mode} crosses the production graph and semantic Computer Use lane`, async () => {
  const chat = mode === "ordinary chat with acceleration available";
  const fast = mode !== "ordinary prompt" && !chat;
  const compose = mode === "compose then execute";
  resetRuntimeModelCatalog();
  process.env["NAUTILO_TEST_MODE"] = "stub";
  if (fast || chat) process.env["OPENROUTER_API_KEY"] = "synthetic-fast-graph";
  else delete process.env["OPENROUTER_API_KEY"];
  if (mode === "delegated CUA without Middle") {
    const modelCatalog = structuredClone(getActiveModelCatalogSync().catalog);
    for (const entry of modelCatalog.entries) if (entry.id === "openrouter:deepseek/deepseek-v4.1-flash") entry.defaultEnabled = false;
    configureRuntimeModelCatalog({ loader: {
      get: async () => ({ catalog: modelCatalog, source: "remote-fresh", stale: false, fetchedAt: "2026-09-25T00:00:00.000Z",
        originUrl: "https://catalog.invalid/native-test.json", reason: "", catalogVersion: modelCatalog.catalogVersion }),
      refresh: async () => {}, clearCache: () => {},
    } });
    await hydrateRuntimeModelCatalog();
  }
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
  const windowTarget = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
  const appTarget = { ...windowTarget, reference: `datgt_${"c".repeat(43)}` };
  const elementTarget = { ...windowTarget, reference: `detgt_${"d".repeat(43)}` };
  const poem = "Reality 🌊\nAn exact, authored line.\n";
  let documentText = "";
  let fastCalls = 0;
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
      if (fast && evidence.modelCalls > 0) throw new Error("Unexpected additional Genie call in delegated workflow");
      modelInvocations.push(messages);
      evidence.modelCalls += 1;
      if (chat) return new AIMessage("Friendship grows through trust and shared experience.");
      if (fast) return new AIMessage({ content: "", tool_calls: [{ id: "delegate-once", name: "computer_observe",
        args: { operation: "desktop_state", decisionPlan: { execution: "workflow", goal: compose ? "Open Sketchpad, insert the authored poem, and verify its exact text" : "Open Sketchpad", values: compose ? { poem } : {} } } }] });
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
    getUserId: () => ids.human,
    getDesktopSessionId: () => ids.desktopSession,
    getPairingGeneration: () => ids.pairing,
    findByCapabilityForUser: () => [ids.relay],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canUseComputer: true,
      canControlDesktop: true,
      computerUseHostContracts: Object.values(nativeContracts),
      desktopAutomation: { enabled: true, agentId: ids.agent, installationEpoch: ids.installation,
        grantGeneration: 1, provider: "cua", providerGeneration: ids.providerGeneration },
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
      if (fast) {
        if (request.args["operation"] === "desktop_state") return { status: "ok", result: simulatedHostResult() };
        const operation = request.args["operation"] as Record<string, unknown>;
        const mutate = request.toolName === "computer_do";
        const insert = operation?.["kind"] === "type_text";
        if (insert) {
          expect(operation["text"]).toBe(poem);
          expect(operation["target"]).toEqual(elementTarget);
          documentText += String(operation["text"]);
        }
        const envelope = {
          kind: "result", protocol: { major: 3, minor: 0 }, requestId: `fixture-${evidence.toolCalls}`,
          fence: { hostGeneration: "host-fixture", driverGeneration: ids.providerGeneration, cancellationGeneration: 1 },
          contract: mutate ? nativeContracts.do : nativeContracts.observe, settlement: "completed",
          result: insert ? { version: 1, timing: "immediate", action: "type_text", target: elementTarget,
            resolvedTarget: { kind: "element", role: "text_area", action: "type_text", enabled: true },
            provider: "cua", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
            unexecutedRemainder: { count: 0, reason: "none" },
            textDelivery: { requestedCharacters: [...poem].length, deliveredCharacters: [...poem].length },
            providerAction: { effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidenceKinds: ["value_readback"], escalation: null },
            outcome: { version: 1, phase: "post_effect_verification", retrySafety: "never", stateChangeCertainty: "changed", recovery: [] },
          } : mutate ? { version: 1, timing: "immediate", action: "launch_app", app: { name: "Sketchpad", target: appTarget },
            window: windowTarget, launchProgress: { requested: true, processRunning: true, windowReady: true },
            windowSelection: "unique", completionCertainty: "completed", verification: "required",
            outcome: { version: 1, phase: "post_effect_verification", retrySafety: "never", stateChangeCertainty: "changed", recovery: ["observe_again"] },
          } : { version: 1, operation: "window_state", target: windowTarget,
            evidence: { kind: "window", appLabel: "Sketchpad", windowLabel: "Draft" }, completeness: "partial", degraded: false, verification: "indeterminate",
            controlCollection: { completeness: "partial", received: 1, omitted: 0, controls: [
              { id: "c0", role: "text_area", label: "Body", target: elementTarget, state: { completeness: "partial", value: documentText } },
            ] },
            outcome: { version: 1, phase: "observe", retrySafety: "safe", stateChangeCertainty: "not_applicable", recovery: ["retry_same_request"] },
          },
        };
        nativeSchemas[mutate ? "do" : "observe"].result.parse(envelope.result);
        return { status: "ok", result: JSON.stringify(envelope) };
      }
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
    fullEncryptionOnlyForState: () => false,
    interpretNative: async input => {
      fastCalls += 1;
      const reference = (source: string, path: (string | number)[], slice?: { start: number; end: number }) => ({ $valueRef: { source, path, ...(slice ? { slice } : {}) } });
      let decision: NativeExecutionReply;
      if (fastCalls === 1) {
        expect(input.state["request"]).toBe(compose ? "Open Sketchpad, insert the authored poem, and verify its exact text" : "Open Sketchpad");
        if (compose) expect(input.state["values"]).toEqual({ poem });
        decision = { kind: "call", tool: "computer_do", arguments: { operation: { kind: "launch_app", app: { name: reference("request", [], { start: 5, end: 14 }) } } } };
      } else if (compose && fastCalls === 2) {
        decision = { kind: "call", tool: "computer_do", arguments: { operation: { kind: "type_text",
          target: reference("observation", ["controlCollection", "controls", 0, "target"]), text: reference("values", ["poem"]) } } };
      } else if (compose) {
        expect(fastCalls).toBe(3);
        expect(input.completion?.checks.some(check => check.comparison === "appends")).toBe(true);
        decision = { kind: "complete", summary: "The poem is written and verified.", checks: [{ path: ["controlCollection", "controls", 0, "state", "value"], comparison: "appends", appendBefore: "",
          expected: { $valueRef: { source: "values", path: ["poem"] } } }] };
      } else {
        expect(fastCalls).toBe(2);
        decision = { kind: "complete", summary: "Sketchpad is open.", checks: [{ path: ["evidence", "appLabel"], comparison: "equals",
          expected: { $valueRef: { source: "request", path: [], slice: { start: 5, end: 14 } } } }] };
      }
      return { decision, modelId: input.modelId, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } };
    },
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
  const graphConfig = { configurable: { thread_id: `simulated-native-graph-${mode}` }, signal: new AbortController().signal, recursionLimit: 100 };
  const result = await graph.invoke({
    turnId: "foreground-turn-fixture",
    messages: [new HumanMessage(chat ? "What makes a good friendship?" : compose ? "Open Sketchpad and write a poem about reality" : fast ? "Open Sketchpad" : "Observe the current desktop and summarize what is available.")],
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
      toolPolicy: { computer_observe: "allow", computer_do: "allow" },
    },
  }, graphConfig) as NautiloState;

  if (chat) {
    expect(evidence.modelCalls).toBe(1);
    expect(fastCalls).toBe(0);
    expect(evidence.toolCalls).toBe(0);
    expect(result.nativeDecision).toBeNull();
    return;
  }
  if (fast) {
    expect(evidence.modelCalls).toBe(1);
    expect(fastCalls).toBe(compose ? 3 : 2);
    expect(evidence.toolCalls).toBe(compose ? 5 : 3);
    expect(requests.map(request => request["toolName"])).toEqual(compose
      ? ["computer_observe", "computer_do", "computer_observe", "computer_do", "computer_observe"] : ["computer_observe", "computer_do", "computer_observe"]);
    expect(requests[1]?.["args"]).toEqual({ operation: { kind: "launch_app", app: { name: "Sketchpad" } } });
    expect(requests[2]?.["args"]).toEqual({ operation: "window_state", target: windowTarget });
    if (compose) expect(documentText).toBe(poem);
    expect(result.nativeDecision?.phase).toBe("complete");
    expect(result.messages.at(-1)?.content).toBe(compose ? "The poem is written and verified." : "Sketchpad is open.");
    const calls = result.messages.filter(AIMessage.isInstance).flatMap(message => message.tool_calls ?? []);
    const receipts = result.messages.filter(ToolMessage.isInstance);
    expect(calls.map(call => call.id)).toEqual(receipts.map(message => message.tool_call_id));
    expect((await graph.getState(graphConfig))?.values?.["nativeDecision"]).toMatchObject({ phase: "complete", pending: null });
    return;
  }

  expect(evidence).toMatchObject({
    evidenceMode: "simulated_scripted_model_mocked_db_client",
    modelCalls: 2,
    toolCalls: 1,
  });
  expect(fastCalls).toBe(0);
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
