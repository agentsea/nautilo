import { expect, test } from "bun:test";
import { getCurrentLocalExecutionDelegation, runWithLocalExecutionDelegation,
  type DelegatedLocalExecutionPort } from "../../src/runtime/local-execution-delegation";
const port: DelegatedLocalExecutionPort = { taskId: "task", taskRunId: "run", signal: new AbortController().signal,
  withAdmission: async () => { throw new Error("not admitted by fixture"); } };
test("a missing invocation port clears ambient Task authority and restores its caller afterwards", async () => {
  await runWithLocalExecutionDelegation(port, async () => {
    expect(getCurrentLocalExecutionDelegation()).toBe(port);
    await runWithLocalExecutionDelegation(undefined, async () => {
      await Promise.resolve();
      expect(getCurrentLocalExecutionDelegation()).toBeUndefined();
    });
    expect(getCurrentLocalExecutionDelegation()).toBe(port);
  });
  expect(getCurrentLocalExecutionDelegation()).toBeUndefined();
});

import { bindDelegatedLocalExecution } from "../../src/tools/local-execution/admission";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import type { DelegatedLocalExecutionAdmission } from "../../src/runtime/local-execution-delegation";
const source: DelegatedLocalExecutionAdmission = { taskId: "task", taskRunId: "run", signal: new AbortController().signal,
  delegation: { version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "original-room", sourceConversationId: "original-thread",
    rootTaskId: "task", projectGrantId: "grant", ceiling: "basic", profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } } };
const state = { currentTaskId: "task", currentTaskRunId: "run", agentId: "agent", roomId: "task-room", currentThreadId: "task-thread",
  langgraphThreadId: "task-thread", causalHumanUserId: "human", trustedExecutionEntrypoint: "background.task" as const };
test("approval pins retain the original generation and never borrow a new recurrence", () => {
  let generation = "generation-a";
  let pairing = "raw-pairing";
  const registry = { getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true, canDelegateLocalExecution: true,
    localExecution: { version: 1, generation, pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } }),
    getDesktopSessionId: () => "desktop", getLocalExecutionPairingGeneration: () => "opaque-pairing",
    getPairingGeneration: () => pairing, getProtocolVersion: () => 29, getUserId: () => "human",
  } as unknown as ToolRelayRegistry;
  const input = { registry, source, state, invocationId: "call", operation: "start" as const };
  const pinned = bindDelegatedLocalExecution(input)!;
  expect(pinned.owner.pairingGeneration).toBe("opaque-pairing");
  expect(pinned.authority.delegation.target.pairingGeneration).toBe("raw-pairing");
  expect(bindDelegatedLocalExecution({ ...input, previous: pinned })).toEqual(pinned);
  generation = "generation-b";
  expect(bindDelegatedLocalExecution({ ...input, previous: pinned })).toBeNull();
  generation = "generation-a"; pairing = "replacement-pairing";
  expect(bindDelegatedLocalExecution({ ...input, previous: pinned })).toBeNull();
  pairing = "raw-pairing";
  expect(bindDelegatedLocalExecution({ ...input, source: { ...source, taskRunId: "next-run" },
    state: { ...state, currentTaskRunId: "next-run" }, operation: "input", executionId: pinned.executionId, previous: pinned })).toBeNull();
});

import { HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { MAX_SUBAGENT_DEPTH, type NautiloState } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import { registerAllTools } from "../../src/tools/register-all";
import { setRelayRegistry } from "../../src/tools/invocation-service";
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

test("qualified delegated catalog uses managed commands without borrowing foreground authority", async () => {
  const catalog = new ToolCatalog(); registerAllTools(catalog, { decisionModelsAvailable: () => true }); initToolCatalog(catalog);
  let protocol = 29;
  const registry = { findByCapabilityForUser: () => ["relay"], getUserId: () => "human",
    getCapabilities: () => ({ profile: "desktop-agent", canRunShell: true, canUseTerminal: true,
      canExecuteLocal: true, canDelegateLocalExecution: true, canReadShellOutput: true,
      localExecution: { version: 1, generation: "generation", pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } }),
    getProtocolVersion: () => protocol, getPairingGeneration: () => "raw-pairing", getDesktopSessionId: () => "desktop",
    getLocalExecutionPairingGeneration: () => "opaque", dispatch: async () => { throw new Error("No execution in discovery test"); },
  } as ToolRelayRegistry;
  setRelayRegistry(registry);
  const livePort: DelegatedLocalExecutionPort = { ...port, withAdmission: async (_operation, work) => work(source) };
  const input = makeState({ ...state, userId: "agent-owner", taskRun: true, currentThreadId: "", langgraphThreadId: "",
    activatedToolNames: ["exec_command", "write_stdin", "run_shell", "terminal"], verifiedOrdinaryOrigin: null });
  try {
    const next = await runWithLocalExecutionDelegation(livePort, () => preModelNode(input));
    expect(next.relayCapabilities?.["canReplaceLegacyShellTools"]).toBe(true);
    expect(next.toolNames).toContain("exec_command"); expect(next.toolNames).not.toContain("run_shell"); expect(next.toolNames).not.toContain("terminal");
    protocol = 27;
    const old = await runWithLocalExecutionDelegation(livePort, () => preModelNode(input));
    expect(old.relayCapabilities?.["canExecuteLocal"]).toBe(false);
    expect(old.relayCapabilities?.["canReplaceLegacyShellTools"]).toBe(false);
  } finally { setRelayRegistry(null); clearToolCatalog(); }
});
