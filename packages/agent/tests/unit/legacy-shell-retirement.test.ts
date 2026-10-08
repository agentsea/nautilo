import { afterEach, beforeEach, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog, getToolCatalog } from "@nautilo/catalog";
import { MAX_SUBAGENT_DEPTH, type NautiloState } from "../../src/agent/state";
import { preModelNode, resolveToolsForExposure } from "../../src/nodes/pre-model";
import { toolsNode } from "../../src/nodes/tools";
import { registerAllTools } from "../../src/tools/register-all";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";

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

const origin = { kind: "local_electron", userId: "fixture-human", actorId: "fixture-actor",
  relayId: "fixture-desktop", desktopSessionId: "fixture-session", pairingGeneration: "fixture-pairing", requestId: "fixture-request" } as const;
function fixture() {
  const live = { protocol: 29, connected: true, managed: true, pty: true, history: false, localGit: true, retainedReader: true, humanConsent: true,
    profile: "desktop-agent" as "desktop-agent" | "headless-agent", owner: origin.userId as string };
  setRelayRegistry({
    findByCapabilityForUser: (_cap: string, human: string) => live.connected && human === live.owner ? [origin.relayId] : [],
    getUserId: (id: string) => live.connected && id === origin.relayId ? live.owner : undefined,
    getDesktopSessionId: () => origin.desktopSessionId,
    getPairingGeneration: () => origin.pairingGeneration,
    getLocalExecutionPairingGeneration: () => origin.pairingGeneration,
    getProtocolVersion: () => live.protocol,
    getCapabilities: (id: string) => live.connected && id === origin.relayId ? {
      profile: live.profile, canRunShell: true, canUseTerminal: true, hasPendingTerminalHandoff: true,
      canExecuteLocal: live.managed, canReadLocalExecutionHistory: live.history,
      localExecution: { version: 1, generation: "fixture-generation", pipe: true, pty: live.pty, capacity: 1,
        localNetworkPolicy: true },
      canUseLocalGit: live.localGit, localGit: { version: 1 }, canReadShellOutput: live.retainedReader,
      canUseHumanTerminal: live.humanConsent, humanTerminal: { version: 1, generation: "fixture-handoff",
        owner: { humanUserId: origin.userId, agentId: "fixture-agent", roomId: "fixture-room", relayId: origin.relayId,
          desktopSessionId: origin.desktopSessionId, pairingGeneration: origin.pairingGeneration,
          serverOrigin: "https://fixture.example", serverFingerprint: "fixture-fingerprint" } },
    } : undefined,
    dispatch: () => { throw new Error("Exposure tests cannot dispatch execution"); },
  } as ToolRelayRegistry);
  const state = makeState({ userId: "fixture-agent-owner", causalHumanUserId: origin.userId, agentId: "fixture-agent", roomId: "fixture-room",
    verifiedOrdinaryOrigin: origin, trustedExecutionEntrypoint: "foreground.main", turnId: "fixture-turn",
    activatedToolNames: ["run_shell", "terminal", "exec_command", "write_stdin", "local_git", "read_shell_output", "human_terminal"],
    relayCapabilities: { canRunShell: true, canUseTerminal: true, canReplaceLegacyShellTools: true } });
  return { live, state };
}
async function project(state: NautiloState): Promise<NautiloState> { return { ...state, ...await preModelNode(state) }; }
async function receipt(state: NautiloState, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await toolsNode({ ...state, approvedToolCalls: [{ id: `fixture-${name}`, type: "tool_call", name, args }] });
  const content = result.messages?.at(-1)?.content;
  if (typeof content !== "string") throw new Error("Expected real tool receipt");
  return JSON.parse(content);
}
async function discover(state: NautiloState): Promise<string[]> {
  return (await receipt(state, "discover_tools", { categories: ["development"] }) as { name: string }[]).map(value => value.name);
}
async function activateLegacy(state: NautiloState): Promise<string[]> {
  return (await receipt(state, "activate_tools", { names: ["run_shell", "terminal"] }) as { accepted: string[] }).accepted;
}
function prompt(state: NautiloState): string {
  return state.preparedMessages.map(value => typeof value.content === "string" ? value.content : JSON.stringify(value.content)).join("\n");
}

test("capable exact Desktop removes legacy schemas, discovery and activation while retaining replacements", async () => {
  const { state } = fixture(); const next = await project(state);
  expect(next.relayCapabilities?.["canReplaceLegacyShellTools"]).toBeTrue();
  const names = await discover(next);
  for (const name of ["run_shell", "terminal"]) {
    expect(next.toolNames).not.toContain(name); expect(next.activatedToolNames).not.toContain(name); expect(names).not.toContain(name);
  }
  for (const name of ["exec_command", "write_stdin", "local_git", "read_shell_output", "human_terminal"]) expect(names).toContain(name);
  expect(await activateLegacy(next)).toEqual([]);
  const again = await project({ ...next, activatedToolNames: ["run_shell", "terminal"] });
  expect(again.toolNames).not.toContain("terminal"); expect(again.activatedToolNames).not.toContain("run_shell");
  expect(prompt(next)).toContain("focused `exec_command` verification");
  expect(prompt(next)).not.toContain("focused `run_shell` verification");
  expect(prompt(next)).not.toContain("operations retain run_shell and terminal");
  expect(prompt(next)).not.toContain("Call `terminal` with");
  expect(getToolCatalog()?.has("run_shell")).toBeTrue(); expect(getToolCatalog()?.has("terminal")).toBeTrue();
  // Legacy-all schema binding shares the same catalog eligibility filter.
  const all = getToolCatalog()!.getToolsForActor({ relayCapabilities: next.relayCapabilities }, undefined, next.relayCapabilities);
  expect(all.map(value => value.name)).not.toContain("run_shell"); expect(all.map(value => value.name)).not.toContain("terminal");
});
test("a live legacy handoff hint cannot resurrect terminal on the managed Desktop", async () => {
  const { state } = fixture();
  const next = await project({ ...state, userId: origin.userId });
  expect(next.relayCapabilities?.["hasPendingTerminalHandoff"]).not.toBeTrue();
  expect(next.toolNames).not.toContain("terminal"); expect(next.activatedToolNames).not.toContain("terminal");
  expect(prompt(next)).not.toContain("Call `terminal` with");
});
test("retirement requires the supported contract rather than active Human terminal consent", async () => {
  const { state, live } = fixture(); live.humanConsent = false;
  const next = await project(state);
  expect(next.relayCapabilities?.["canReplaceLegacyShellTools"]).toBeTrue();
  expect(await discover(next)).not.toContain("human_terminal");
  expect(next.toolNames).not.toContain("terminal"); expect(next.toolNames).not.toContain("run_shell");
});
for (const loss of ["old protocol", "replacement protocol 20", "replacement protocol 23", "replacement protocol 25", "no typed Git", "no retained reader", "pipe only", "headless", "no managed execution", "history only", "foreign Human", "foreign Relay owner", "other Desktop", "stale Desktop session", "stale pairing", "no origin"] as const) {
  test(`${loss} cannot restore either retired local execution interface`, async () => {
    const { live, state } = fixture();
    if (loss === "old protocol") live.protocol = 19;
    else if (loss === "replacement protocol 20") live.protocol = 20;
    else if (loss === "replacement protocol 23") live.protocol = 23;
    else if (loss === "replacement protocol 25") live.protocol = 25;
    else if (loss === "no typed Git") live.localGit = false;
    else if (loss === "no retained reader") live.retainedReader = false;
    else if (loss === "pipe only") live.pty = false;
    else if (loss === "headless") live.profile = "headless-agent";
    else if (loss === "no managed execution") live.managed = false;
    else if (loss === "history only") { live.managed = false; live.history = true; }
    else if (loss === "foreign Human") state.causalHumanUserId = "foreign-human";
    else if (loss === "foreign Relay owner") live.owner = "foreign-human";
    else if (loss === "other Desktop") state.verifiedOrdinaryOrigin = { ...origin, relayId: "other-desktop" };
    else if (loss === "stale Desktop session") state.verifiedOrdinaryOrigin = { ...origin, desktopSessionId: "old-session" };
    else if (loss === "stale pairing") state.verifiedOrdinaryOrigin = { ...origin, pairingGeneration: "old-pairing" };
    else state.verifiedOrdinaryOrigin = null;
    const next = await project(state);
    expect(next.relayCapabilities?.["canReplaceLegacyShellTools"]).toBeFalse();
    const discovered = await discover(next);
    expect(discovered).not.toContain("run_shell"); expect(discovered).not.toContain("terminal");
    expect(await activateLegacy(next)).toEqual([]);
    expect(next.toolNames).not.toContain("run_shell"); expect(next.toolNames).not.toContain("terminal");
    expect(next.activatedToolNames).not.toContain("run_shell");
    expect(next.activatedToolNames).not.toContain("terminal");
    expect(prompt(next)).not.toContain("run_shell");
    expect(prompt(next)).not.toContain("Call `terminal` with");
  });
}

for (const mode of ["progressive", "eager"] as const) {
  test(`${mode} cannot restore run_shell through policy, whitelist, intent or activation`, () => {
    const { state } = fixture();
    const catalog = getToolCatalog()!;
    const resolution = resolveToolsForExposure(catalog, mode, {
      context: { relayCapabilities: { canRunShell: true } },
      relayCapabilities: { canRunShell: true },
      toolPolicy: { run_shell: "allow" },
      toolNameWhitelist: ["run_shell"],
      activatedToolNames: ["run_shell"],
      intentPackToolNames: ["run_shell"],
      skipRelayLiveCheck: true,
    });
    expect(resolution.eligible.entries.map(entry => entry.name)).not.toContain("run_shell");
    expect(resolution.tools).toEqual([]);
    expect(catalog.has("run_shell")).toBeTrue();
    expect(catalog.getToolsForActor({}, undefined, state.relayCapabilities).map(tool => tool.name)).not.toContain("run_shell");
  });
}

test("background Task continuation and persisted leases cannot restore run_shell", async () => {
  const { state } = fixture();
  const next = await project({ ...state, verifiedOrdinaryOrigin: null, taskRun: true,
    trustedExecutionEntrypoint: null,
    taskReportBackContinuation: { status: "available", relayId: origin.relayId,
      relaySessionId: "fixture-socket", desktopSessionId: origin.desktopSessionId,
      pairingGeneration: origin.pairingGeneration, currentFolder: "/fixture", workspacePath: "/fixture" },
    activatedToolNames: ["run_shell", "terminal"],
    activatedToolLeases: [{ name: "run_shell", idleTurns: 0 }],
    activationLeasesInitialized: true,
  });
  expect(next.toolNames).not.toContain("run_shell");
  expect(next.activatedToolNames).not.toContain("run_shell");
  expect(await discover(next)).not.toContain("run_shell");
  expect(await activateLegacy(next)).toEqual([]);
  const family = await receipt(next, "activate_tools", { families: ["shell"] }) as { accepted: string[] };
  expect(family.accepted).not.toContain("run_shell");
  expect(prompt(next)).not.toContain("run_shell");
});

test.each([
  ["run_shell", { command: "printf fixture" }],
  ["terminal", { action: "run", data: "printf fixture" }],
] as const)("a stale approved %s call reports an upgrade refusal without dispatch", async (name, args) => {
  const { state } = fixture();
  const result = await toolsNode({ ...state,
    approvedToolCalls: [{ id: `stale-${name}`, type: "tool_call", name, args }],
  });
  const rawContent = result.messages?.at(-1)?.content;
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
  expect(content).toContain("legacy local execution interface has been retired");
  expect(content).toContain("No command was run");
});
