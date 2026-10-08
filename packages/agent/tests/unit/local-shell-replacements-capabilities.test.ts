import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import { toolsNode } from "../../src/nodes/tools";
import { buildRuntimeCapabilityTokens } from "../../src/runtime/relay-capabilities";
import { registerAllTools } from "../../src/tools/register-all";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";

const humanId = "human-fixture";
const selectedRelayId = "desktop-selected";
const origin = {
  kind: "local_electron",
  userId: humanId,
  actorId: "actor-fixture",
  relayId: selectedRelayId,
  desktopSessionId: "desktop-session-fixture",
  pairingGeneration: "pairing-fixture",
  requestId: "request-fixture",
} as const;

type RelayFixture = {
  owner: string;
  protocol: number;
  capabilities: Record<string, unknown>;
};

function makeRegistry(entries: Record<string, RelayFixture>): ToolRelayRegistry {
  return {
    dispatch: async () => { throw new Error("Discovery cannot dispatch effects"); },
    findByCapabilityForUser: (_capability, userId) => Object.entries(entries)
      .filter(([, entry]) => entry.owner === userId)
      .map(([relayId]) => relayId),
    getUserId: (relayId) => entries[relayId]?.owner,
    getCapabilities: (relayId) => entries[relayId]?.capabilities as never,
    getProtocolVersion: (relayId) => entries[relayId]?.protocol,
  } as ToolRelayRegistry;
}

const replacementCapabilities = {
  profile: "desktop-agent",
  canUseLocalGit: true,
  localGit: { version: 1 },
  canReadShellOutput: true,
  canReadLocalExecutionHistory: true,
};

function stateWithPermittedWorkstationPolicy(): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "conversation-fixture",
    model: null,
    userId: "agent-owner-fixture",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "conversation-fixture",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: {
      ownerId: humanId,
      actorId: origin.actorId,
      agentId: "agent-genie",
      roomId: "room-fixture",
      readableNamespaces: [],
      writableNamespaces: [],
      mutableNamespaces: [],
      // These are the tool-policy results for an actor granted use_workstation:
      // mutation asks for prove_it, while the output read is read-only.
      toolPolicy: { local_git: "require_prove_it", read_shell_output: "read_only" },
    } as unknown as NautiloState["memoryAccessEnvelope"],
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "room-fixture",
    roomRoster: [],
    approvalDenied: false,
    turnId: "turn-fixture",
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
    verifiedOrdinaryOrigin: origin,
    causalHumanUserId: humanId,
    trustedExecutionEntrypoint: "foreground.main",
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

beforeEach(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { decisionModelsAvailable: () => true });
  initToolCatalog(catalog);
});
afterEach(() => {
  setRelayRegistry(null);
  clearToolCatalog();
});

describe("Local Git and retained shell output capability projection", () => {
  test("requires the exact selected owner, protocol, and strict Local Git marker", () => {
    const selected = { owner: humanId, protocol: 22, capabilities: replacementCapabilities };
    const sibling = {
      owner: humanId,
      protocol: 22,
      capabilities: { profile: "desktop-agent", canUseLocalGit: true, localGit: { version: 1 }, canReadShellOutput: true },
    };
    const registry = makeRegistry({ [selectedRelayId]: selected, "desktop-sibling": sibling });
    expect(buildRuntimeCapabilityTokens(registry, humanId, undefined, selectedRelayId)).toMatchObject({
      canUseLocalGit: true,
      canReadShellOutput: true,
    });

    expect(buildRuntimeCapabilityTokens(registry, humanId, undefined, "desktop-sibling"))
      .toMatchObject({ canUseLocalGit: true, canReadShellOutput: true });
    expect(buildRuntimeCapabilityTokens(registry, "another-human", undefined, selectedRelayId)).toBeUndefined();

    const siblingOnlyRegistry = makeRegistry({
      [selectedRelayId]: {
        owner: humanId,
        protocol: 22,
        capabilities: { profile: "desktop-agent" },
      },
      "desktop-sibling": sibling,
    });
    const selectedWithoutReplacement = buildRuntimeCapabilityTokens(
      siblingOnlyRegistry,
      humanId,
      undefined,
      selectedRelayId,
    );
    expect(selectedWithoutReplacement).not.toHaveProperty("canUseLocalGit");
    expect(selectedWithoutReplacement).not.toHaveProperty("canReadShellOutput");

    const oldPeer = makeRegistry({ [selectedRelayId]: { ...selected, protocol: 21 } });
    expect(buildRuntimeCapabilityTokens(oldPeer, humanId, undefined, selectedRelayId))
      .not.toHaveProperty("canUseLocalGit");
    expect(buildRuntimeCapabilityTokens(oldPeer, humanId, undefined, selectedRelayId))
      .not.toHaveProperty("canReadShellOutput");

    for (const marker of [undefined, { version: 1, extra: true }, { version: "1" }, [1]]) {
      const malformedRegistry = makeRegistry({ [selectedRelayId]: {
        owner: humanId,
        protocol: 22,
        capabilities: { ...replacementCapabilities, localGit: marker },
      } });
      expect(buildRuntimeCapabilityTokens(malformedRegistry, humanId, undefined, selectedRelayId))
        .not.toHaveProperty("canUseLocalGit");
    }
    const missingReadFlag = makeRegistry({ [selectedRelayId]: {
      ...selected,
      capabilities: { ...replacementCapabilities, canReadShellOutput: false },
    } });
    expect(buildRuntimeCapabilityTokens(missingReadFlag, humanId, undefined, selectedRelayId))
      .not.toHaveProperty("canReadShellOutput");
  });

  test("flows exact Desktop tokens through pre-model discovery and activation", async () => {
    const registry = makeRegistry({
      [selectedRelayId]: { owner: humanId, protocol: 22, capabilities: replacementCapabilities },
      "desktop-sibling": {
        owner: humanId,
        protocol: 22,
        capabilities: { profile: "desktop-agent", canUseLocalGit: true, localGit: { version: 1 }, canReadShellOutput: true },
      },
    });
    setRelayRegistry(registry);
    const initial = stateWithPermittedWorkstationPolicy();
    const projected = { ...initial, ...await preModelNode(initial) };
    expect(projected.relayCapabilities).toMatchObject({ canUseLocalGit: true, canReadShellOutput: true });

    const discovery = await toolsNode({ ...projected, approvedToolCalls: [{
      id: "discover-shell-replacements",
      type: "tool_call",
      name: "discover_tools",
      args: { query: "local_git read_shell_output" },
    }] });
    const discoveredText = discovery.messages?.at(-1)?.content;
    if (typeof discoveredText !== "string") throw new Error("Expected tool discovery response");
    const discovered = (JSON.parse(discoveredText) as { name: string }[]).map(({ name }) => name);
    expect(discovered).toContain("local_git");
    expect(discovered).toContain("read_shell_output");

    const activation = await toolsNode({ ...projected, approvedToolCalls: [{
      id: "activate-shell-replacements",
      type: "tool_call",
      name: "activate_tools",
      args: { names: ["local_git", "read_shell_output"] },
    }] });
    const activationText = activation.messages?.at(-1)?.content;
    if (typeof activationText !== "string") throw new Error("Expected tool activation response");
    expect((JSON.parse(activationText) as { accepted: string[] }).accepted)
      .toEqual(["local_git", "read_shell_output"]);
  });
});
