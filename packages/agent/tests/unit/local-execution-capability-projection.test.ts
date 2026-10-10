import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog, getToolCatalog } from "@nautilo/catalog";
import { MAX_SUBAGENT_DEPTH, type NautiloState } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import { toolsNode } from "../../src/nodes/tools";
import { registerAllTools } from "../../src/tools/register-all";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { runWithLocalExecutionDelegation, type DelegatedLocalExecutionPort } from "../../src/runtime/local-execution-delegation";

beforeEach(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { decisionModelsAvailable: () => true });
  initToolCatalog(catalog);
});
afterEach(() => { setRelayRegistry(null); clearToolCatalog(); });

function makeState(overrides: Partial<NautiloState>): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "owner-1",
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
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: undefined,
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
    ...overrides,
  };
}

const origin = {
  kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
  desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", requestId: "request-fixture",
} as const;

function relayFixture() {
  const live = { connected: true, owner: origin.userId as string, protocol: 29, managed: true, history: false, search: false,
    shellOutput: false, delegation: false };
  setRelayRegistry({
    findByCapabilityForUser: (_capability: string, userId: string) => live.connected && userId === live.owner ? [origin.relayId] : [],
    getUserId: (id: string) => live.connected && id === origin.relayId ? live.owner : undefined,
    getCapabilities: (id: string) => live.connected && id === origin.relayId ? {
      profile: "desktop-agent", canRunShell: true, canExecuteLocal: live.managed, canReadLocalExecutionHistory: live.history, canSearchLocalExecutionOutput: live.search,
      canReadShellOutput: live.shellOutput, canDelegateLocalExecution: live.delegation,
      ...(live.managed ? { localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } } : {}),
    } : undefined,
    getProtocolVersion: () => live.protocol,
    getDesktopSessionId: () => origin.desktopSessionId,
    getPairingGeneration: () => origin.pairingGeneration,
    getLocalExecutionPairingGeneration: () => origin.pairingGeneration,
    dispatch: () => { throw new Error("Discovery and activation must not dispatch execution"); },
  } as ToolRelayRegistry);
  return live;
}

function executionState(overrides: Partial<NautiloState> = {}): NautiloState {
  return makeState({ userId: "agent-owner-fixture", causalHumanUserId: origin.userId,
    verifiedOrdinaryOrigin: origin, trustedExecutionEntrypoint: "foreground.main", turnId: "turn-fixture",
    relayCapabilities: { canRunShell: true }, ...overrides });
}

async function project(state: NautiloState): Promise<NautiloState> {
  // LangGraph replaces each returned state field before invoking the tools node.
  return { ...state, ...await preModelNode(state) };
}

function projectedPrompt(state: NautiloState): string {
  const content = state.preparedMessages[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Expected prepared system prompt");
  return content.map(block => typeof block === "string" ? block : "text" in block ? block.text : "").join("");
}

async function discover(state: NautiloState): Promise<string[]> {
  const result = await toolsNode({ ...state, approvedToolCalls: [{ id: "discover-fixture", type: "tool_call",
    name: "discover_tools", args: { query: "exec_command write_stdin" } }] });
  const content = result.messages?.at(-1)?.content;
  if (typeof content !== "string") throw new Error("Expected discovery receipt");
  const entries = JSON.parse(content) as { name: string }[];
  return entries.map((entry) => entry.name);
}

async function activate(state: NautiloState): Promise<string[]> {
  const result = await toolsNode({ ...state, approvedToolCalls: [{ id: "activate-fixture", type: "tool_call",
    name: "activate_tools", args: { names: ["exec_command", "write_stdin"] } }] });
  const content = result.messages?.at(-1)?.content;
  if (typeof content !== "string") throw new Error("Expected activation receipt");
  return (JSON.parse(content) as { accepted: string[] }).accepted;
}

describe("managed execution capability projection through graph state", () => {
  test("auxiliary guidance follows the fresh exact Desktop capabilities", async () => {
    const live = relayFixture(); live.protocol = 29; live.shellOutput = true;
    let state = await project(executionState());
    expect(projectedPrompt(state)).toContain("Use read_shell_output for earlier retained shell output.");
    expect(projectedPrompt(state)).not.toContain("Use human_terminal for the exact Human terminal handoff.");
    expect(projectedPrompt(state)).toContain("Use ordinary command-line tools, including git and gh, through exec_command");
    live.shellOutput = false;
    state = await project(state);
    expect(projectedPrompt(state)).not.toContain("Use read_shell_output for earlier retained shell output.");
  });

  test("delegated worker guidance names only its admitted managed tools and preserves the original Mac", async () => {
    const live = relayFixture(); live.protocol = 29; live.shellOutput = true; live.delegation = true;
    const signal = new AbortController().signal;
    const port: DelegatedLocalExecutionPort = { taskId: "task-fixture", taskRunId: "run-fixture", signal,
      withAdmission: async (_operation, work) => work({ taskId: "task-fixture", taskRunId: "run-fixture", signal,
        delegation: { version: 1, humanUserId: origin.userId, agentId: "agent-genie", sourceRoomId: "room-fixture",
          sourceConversationId: "thread-fixture", rootTaskId: "task-fixture", projectGrantId: "grant-fixture", ceiling: "basic", profile: null,
          target: { instanceId: "instance-fixture", relayId: origin.relayId, pairingGeneration: origin.pairingGeneration,
            serverOrigin: "https://server.example", serverFingerprint: "fingerprint-fixture" } } }) };
    const state = await runWithLocalExecutionDelegation(port, () => project(executionState({
      verifiedOrdinaryOrigin: null, trustedExecutionEntrypoint: "background.task", currentTaskId: port.taskId, currentTaskRunId: port.taskRunId })));
    expect(state.relayCapabilities?.["canExecuteLocal"]).toBeTrue();
    expect(state.relayCapabilities?.["canReplaceLegacyShellTools"]).toBeTrue();
    expect(state.relayCapabilities?.["canReadShellOutput"]).toBeFalse();
    expect(await discover(state)).toContain("exec_command");
    const prompt = projectedPrompt(state);
    expect(prompt).toContain("original Human's saved Mac and project");
    expect(prompt).toContain("never inherits Full Mac or a Human terminal handoff");
    expect(prompt).not.toContain("Use read_shell_output for earlier retained shell output.");
    expect(prompt).not.toContain("Use human_terminal for the exact Human terminal handoff.");
    live.connected = false;
    const disconnected = await runWithLocalExecutionDelegation(port, () => project(state));
    expect(projectedPrompt(disconnected)).not.toContain("For contained build, diagnostics, and dev-server commands");
    expect(await discover(disconnected)).not.toContain("exec_command");
  });

  test("exact local Human origin reaches discovery and activation without Computer Use", async () => {
    relayFixture();
    const initial = executionState();
    expect(await discover(initial)).not.toContain("exec_command");
    const projected = await project(initial);
    const discovered = await discover(projected);
    expect(discovered).toContain("exec_command");
    expect(discovered).toContain("write_stdin");
    expect(await activate(projected)).toEqual(["exec_command", "write_stdin"]);
    expect(projected.relayCapabilities?.["canRunShell"]).toBe(true);
    expect(projected.relayCapabilities?.["canUseComputer"]).not.toBe(true);
  });

  for (const loss of ["disconnect", "managed capability removed", "old protocol"] as const) {
    test(`stale checkpoint availability is removed after ${loss}`, async () => {
      const live = relayFixture();
      const state = executionState({ relayCapabilities: { canRunShell: true, canExecuteLocal: true } });
      expect(await discover(state)).toContain("exec_command");
      if (loss === "disconnect") live.connected = false;
      else if (loss === "managed capability removed") live.managed = false;
      else live.protocol = 19;
      const projected = await project(state);
      expect(await discover(projected)).not.toContain("exec_command");
      expect(await discover(projected)).not.toContain("write_stdin");
      expect(await activate(projected)).toEqual([]);
    });
  }

  for (const mismatch of ["no origin", "paired mobile origin", "foreign causal Human", "foreign Relay owner", "other Relay"] as const) {
    test(`does not borrow local execution availability with ${mismatch}`, async () => {
      const live = relayFixture();
      const state = executionState({ relayCapabilities: { canExecuteLocal: true } });
      if (mismatch === "no origin") state.verifiedOrdinaryOrigin = null;
      else if (mismatch === "paired mobile origin") state.verifiedOrdinaryOrigin = {
        kind: "paired_mobile", userId: origin.userId, actorId: origin.actorId, requestId: origin.requestId,
        serverInstanceId: "server-fixture", serverBindingGeneration: 1,
        controllerInstallationId: "mobile-fixture", installationGeneration: 1,
      };
      else if (mismatch === "foreign causal Human") state.causalHumanUserId = "other-human-fixture";
      else if (mismatch === "foreign Relay owner") live.owner = "other-human-fixture";
      else state.verifiedOrdinaryOrigin = { ...origin, relayId: "other-relay-fixture" };
      const projected = await project(state);
      expect(await discover(projected)).not.toContain("exec_command");
      expect(await activate(projected)).toEqual([]);
    });
  }
});


test("history discovery remains available with Workstation off on a compatible exact Desktop", async () => {
  const live = relayFixture(); live.protocol = 21; live.managed = false; live.history = true;
  const state = await project(executionState());
  expect(await discover(state)).toContain("write_stdin");
  expect(await discover(state)).not.toContain("exec_command");
  expect(await activate(state)).toEqual(["write_stdin"]);
  live.protocol = 20;
  expect(await discover(await project(state))).not.toContain("write_stdin");
});

test("search readiness is exact-peer versioned and stale true is cleared by pre-model projection", async () => {
  const live = relayFixture(); live.search = true; live.history = true; live.protocol = 26;
  let state = await project(executionState());
  expect(state.relayCapabilities?.["canSearchLocalExecutionOutput"]).toBeTrue();
  const schemaFor = (projected: NautiloState) => {
    const catalog = getToolCatalog();
    if (!catalog) throw new Error("Expected initialized catalog");
    const schema = catalog.getToolsForActor(
      { relayCapabilities: projected.relayCapabilities, actorRole: "owner" }, undefined, projected.relayCapabilities, ["write_stdin"])[0]!.schema;
    if (!(schema instanceof z.ZodType)) throw new Error("Expected registered write_stdin Zod schema");
    return schema;
  };
  expect(schemaFor(state).safeParse({ session_id: "execution", search: "needle" }).success).toBeTrue();
  expect(await activate(state)).toContain("write_stdin");
  live.protocol = 25; state = await project(state);
  expect(state.relayCapabilities?.["canSearchLocalExecutionOutput"]).toBeFalse();
  expect(schemaFor(state).safeParse({ session_id: "execution", search: "needle" }).success).toBeFalse();
  expect(await activate(state)).toContain("write_stdin");
  live.protocol = 26; live.connected = false; state = await project(state);
  expect(state.relayCapabilities?.["canSearchLocalExecutionOutput"]).toBeFalse();
});
