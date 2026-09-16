import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";
import type { RelayDispatchRequest, RelayDispatchResult } from "@nautilo/relay";
import { RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION } from "@nautilo/relay";
import type { NautiloState } from "../../src/agent/state";
import { NautiloStateAnnotation } from "../../src/agent/state";
import type { ComputerUseInvocationBinding } from "../../src/runtime/computer-use-admission";

type ToolsModule = typeof import("../../src/nodes/tools");
type AdmissionModule = typeof import("../../src/runtime/computer-use-admission");

let toolsModule: ToolsModule | null = null;
let deriveInvocationId: AdmissionModule["deriveComputerUseInvocationId"] | null = null;
let clearCatalog: typeof import("@nautilo/catalog")["clearToolCatalog"] | null = null;
let previousTestMode: string | undefined;

const d516ReadFixtureIds = {
  human: "human-parallel",
  agent: "agent-parallel",
  relay: "relay-parallel",
  desktopSession: "desktop-session-parallel",
  pairing: "pairing-parallel",
  run: "run-parallel",
  lineage: "lineage-parallel",
  installation: "installation-parallel",
  providerGeneration: "provider-generation-parallel",
  context: "computer-context-parallel",
} as const;

export async function setupD516ProductionReadFixture(): Promise<void> {
  if (toolsModule !== null) return;
  previousTestMode = process.env["NAUTILO_TEST_MODE"];
  process.env["NAUTILO_TEST_MODE"] = "stub";
  toolsModule = await import("../../src/nodes/tools");
  const { registerAllTools } = await import("../../src/tools/register-all");
  ({ deriveComputerUseInvocationId: deriveInvocationId } = await import("../../src/runtime/computer-use-admission"));
  const catalogModule = await import("@nautilo/catalog");
  clearCatalog = catalogModule.clearToolCatalog;
  const catalog = new catalogModule.ToolCatalog();
  registerAllTools(catalog, {
    officeCliAvailable: () => false,
    mediaGenerationAvailable: () => false,
  });
  catalogModule.initToolCatalog(catalog);
}

export async function teardownD516ProductionReadFixture(): Promise<void> {
  toolsModule?.setRelayRegistry(null);
  clearCatalog?.();
  const { resetRuntimeComputerUseContractCatalogue } = await import(
    "../../src/config/computer-use-catalogue/runtime-catalogue"
  );
  resetRuntimeComputerUseContractCatalogue();
  if (previousTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = previousTestMode;
  toolsModule = null;
  deriveInvocationId = null;
  clearCatalog = null;
}

function requireFixture(): Readonly<{
  tools: ToolsModule;
  derive: AdmissionModule["deriveComputerUseInvocationId"];
}> {
  if (toolsModule === null || deriveInvocationId === null) {
    throw new Error("D516 production read fixture is not initialized");
  }
  return { tools: toolsModule, derive: deriveInvocationId };
}

export function d516ReadCall(
  id: string,
  name = "computer_observe",
  args: Record<string, unknown> = { operation: "desktop_state" },
): ToolCall {
  return { id, name, args, type: "tool_call" };
}

export function d516BindingFor(toolCall: ToolCall): ComputerUseInvocationBinding {
  const derive = requireFixture().derive;
  return {
    version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
    computerUseContextId: d516ReadFixtureIds.context,
    computerUseInvocationId: derive(d516ReadFixtureIds.context, toolCall)!,
    relayId: d516ReadFixtureIds.relay,
    pairingGeneration: d516ReadFixtureIds.pairing,
    desktopSessionId: d516ReadFixtureIds.desktopSession,
    originHumanId: d516ReadFixtureIds.human,
    originRunId: d516ReadFixtureIds.run,
    originAgentId: d516ReadFixtureIds.agent,
    lineageId: d516ReadFixtureIds.lineage,
    installationEpoch: d516ReadFixtureIds.installation,
    grantGeneration: 1,
    provider: "cua",
    providerGeneration: d516ReadFixtureIds.providerGeneration,
  };
}

export function d516StateFor(calls: readonly ToolCall[], bound = calls): NautiloState {
  return {
    messages: [new AIMessage({ content: "", tool_calls: [...calls] })],
    approvedToolCalls: [...calls],
    computerUseInvocationBindings: Object.fromEntries(bound.flatMap((item) =>
      item.id === undefined ? [] : [[item.id, d516BindingFor(item)]])),
    requiredHostRelays: Object.fromEntries(calls.flatMap((item) =>
      item.id === undefined ? [] : [[item.id, d516ReadFixtureIds.relay]])),
    userId: d516ReadFixtureIds.human,
    agentId: d516ReadFixtureIds.agent,
    actorRole: "owner",
    causalHumanUserId: d516ReadFixtureIds.human,
    trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: d516ReadFixtureIds.human,
      actorId: d516ReadFixtureIds.human,
      relayId: d516ReadFixtureIds.relay,
      desktopSessionId: d516ReadFixtureIds.desktopSession,
      pairingGeneration: d516ReadFixtureIds.pairing,
      requestId: "request-parallel",
    },
    desktopAutomationProvenance: {
      originHumanId: d516ReadFixtureIds.human,
      originRunId: d516ReadFixtureIds.run,
      originAgentId: d516ReadFixtureIds.agent,
      lineageId: d516ReadFixtureIds.lineage,
      installationEpoch: d516ReadFixtureIds.installation,
      grantGeneration: 1,
    },
    desktopAutomationRouteBinding: {
      version: 2,
      provider: "cua",
      providerGeneration: d516ReadFixtureIds.providerGeneration,
      grantGeneration: 1,
    },
    relayCapabilities: { canUseComputer: true },
    memoryAccessEnvelope: {
      ownerId: d516ReadFixtureIds.human,
      actorId: d516ReadFixtureIds.human,
      agentId: d516ReadFixtureIds.agent,
      roomId: "room-parallel",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { computer_observe: "allow", computer_do: "allow" },
    },
    engagedSkillNames: ["computer-use"],
    activatedToolNames: ["run_shell"],
    activatedToolLeases: [{ name: "run_shell", idleTurns: 2 }],
    activationLeasesInitialized: true,
  } as unknown as NautiloState;
}

export function d516HostResult(request: RelayDispatchRequest, marker: string): string {
  const contract = request.computerUseRequest?.contract as ComputerUseHostContract;
  return JSON.stringify({
    kind: "result",
    protocol: { major: 3, minor: 0 },
    requestId: `host:${marker}`,
    fence: {
      hostGeneration: "host-generation-parallel",
      driverGeneration: d516ReadFixtureIds.providerGeneration,
      cancellationGeneration: 1,
    },
    contract,
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

export function setD516RelayDispatch(
  dispatch: (request: RelayDispatchRequest) => Promise<RelayDispatchResult>,
): void {
  const { tools } = requireFixture();
  tools.setRelayRegistry({
    findByCapabilityForUser: () => [d516ReadFixtureIds.relay],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canUseComputer: true,
      workspaceRoot: "/fixture/workspace",
      allowedRoots: ["/fixture/workspace"],
      dataDir: "/fixture/data",
      toolsBin: "/fixture/tools",
      userHome: "/fixture",
    }),
    dispatch: async (_relayId: string, request: RelayDispatchRequest) => dispatch(request),
  } as unknown as NonNullable<Parameters<ToolsModule["setRelayRegistry"]>[0]>);
}

export function d516GraphFor(
  saver: BaseCheckpointSaver,
  boundary?: NonNullable<Parameters<ToolsModule["createToolsNode"]>[0]>["liveShadowToolBoundaryForState"],
  fullEncryptionOnly = false,
) {
  const { tools } = requireFixture();
  const node = tools.createToolsNode({
    ...(boundary === undefined ? {} : { liveShadowToolBoundaryForState: boundary }),
    fullEncryptionOnlyForState: () => fullEncryptionOnly,
  });
  return new StateGraph(NautiloStateAnnotation)
    .addNode("tools", node)
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile({ checkpointer: saver });
}
