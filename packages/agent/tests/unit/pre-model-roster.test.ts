import { describe, test, expect, beforeAll } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import {
  preModelNode,
  reconcileLiveTerminalHandoffCapabilities,
} from "../../src/nodes/pre-model";
import { ROOM_PARTICIPANTS_HEADER } from "../../src/prompts/templates";
import { registerAllTools } from "../../src/tools/register-all";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import type { RoomParticipant } from "@nautilo/trust";

/**
 * M042B — pre_model roster injection.
 *
 * Two assertions both cheap and zero-DB:
 *
 *  1. When the state carries a non-empty `roomRoster` and the actor is
 *     not a guest, pre_model injects a "Room participants" block into
 *     the system prompt with one line per participant.
 *
 *  2. Guest turns skip the block entirely — it's owner/shared-room
 *     context, not something we want a stranger seeing.
 *
 * We inspect the prepared system message (first message in
 * `preparedMessages`) rather than running the LLM. The node is
 * synchronous and deterministic given state + catalog; no mocks
 * needed beyond a minimal state.
 */

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

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

async function systemPromptOf(state: NautiloState): Promise<string> {
  const patch = await preModelNode(state);
  const prepared = patch.preparedMessages ?? [];
  const first = prepared[0];
  if (!first || !(first instanceof SystemMessage)) {
    throw new Error(
      `expected first prepared message to be SystemMessage, got ${first?.constructor.name ?? "undefined"}`,
    );
  }
  // D407 — for `anthropic:` models the system message is split into cached +
  // volatile text blocks. Reconstruct the full prompt text from the blocks
  // (concatenation is byte-identical to the single-string form).
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    return first.content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return JSON.stringify(first.content);
}

// ===========================================================================
// Roster injection — owner path
// ===========================================================================

describe("preModelNode — roster injection (M042B)", () => {
  test("injects participants block when roomRoster is populated", async () => {
    const roster: RoomParticipant[] = [
      {
        actorId: "actor-owner",
        kind: "user",
        displayName: "Room Admin",
        roomRole: "admin",
      },
      {
        actorId: "actor-genie",
        kind: "agent",
        displayName: "Genie",
        agentId: "agent-genie",
        roomRole: "member",
      },
    ];

    const prompt = await systemPromptOf(makeState({ roomRoster: roster }));

    // The header lives in prompts/templates so test + impl agree on
    // the exact string. If the header changes, this test remembers.
    expect(prompt).toContain(ROOM_PARTICIPANTS_HEADER);
    expect(prompt).toContain("- Room Admin (user, admin)");
    expect(prompt).toContain("- Genie (agent)");
    expect(prompt).not.toContain("Genie (agent, admin)");
  });

  test("M134: two same-named bots get @handles + the current agent is marked 'this is you'", async () => {
    const roster: RoomParticipant[] = [
      { actorId: "actor-owner", kind: "user", displayName: "Room Admin", handle: "room-admin", roomRole: "admin" },
      { actorId: "actor-a", kind: "agent", displayName: "Genie", handle: "genie", agentId: "agent-genie", roomRole: "member" },
      { actorId: "actor-b", kind: "agent", displayName: "Genie", handle: "genie_test006", agentId: "agent-test006", roomRole: "member" },
    ];

    // Current agent is the SECOND "Genie" (handle genie_test006).
    const prompt = await systemPromptOf(
      makeState({ agentId: "agent-test006", roomRoster: roster }),
    );

    // Both bots disambiguated by @handle; only the current agent is "you".
    expect(prompt).toContain("- Genie @genie (agent)");
    expect(prompt).toContain("- Genie @genie_test006 (agent) — this is you");
    // The OTHER bot must NOT be marked as self.
    expect(prompt).not.toContain("@genie (agent) — this is you");
  });

  test("marks exactly the causal Human as the current speaker in a multi-Human Room", async () => {
    const roster: RoomParticipant[] = [
      { actorId: "actor-alice", kind: "user", displayName: "Alice", handle: "alice", userId: "user-alice", roomRole: "admin" },
      { actorId: "actor-bob", kind: "user", displayName: "Bob", handle: "bob", userId: "user-bob", roomRole: "member" },
      { actorId: "actor-genie", kind: "agent", displayName: "Genie", handle: "genie", agentId: "agent-genie", roomRole: "member" },
    ];

    const prompt = await systemPromptOf(makeState({
      causalHumanUserId: "user-bob",
      roomRoster: roster,
    }));

    expect(prompt).toContain("- Alice @alice (user, admin)");
    expect(prompt).not.toContain("- Alice @alice (user, admin) — current speaker");
    expect(prompt).toContain(
      "- Bob @bob (user) — current speaker; authored the final user message",
    );
    expect(prompt).toContain("- Genie @genie (agent) — this is you");
    expect(prompt.match(/current speaker; authored the final user message/g)).toHaveLength(1);
  });

  test("does not guess a current speaker when causal Human identity is missing or unmatched", async () => {
    const roster: RoomParticipant[] = [
      { actorId: "actor-alice", kind: "user", displayName: "Alice", handle: "alice", userId: "user-alice", roomRole: "admin" },
      { actorId: "actor-bob", kind: "user", displayName: "Bob", handle: "bob", userId: "user-bob", roomRole: "member" },
    ];

    const missing = await systemPromptOf(makeState({ roomRoster: roster }));
    const unmatched = await systemPromptOf(makeState({
      causalHumanUserId: "user-not-in-room",
      roomRoster: roster,
    }));

    expect(missing).not.toContain("current speaker");
    expect(unmatched).not.toContain("current speaker");
  });

  test("omits participants block when roomRoster is empty", async () => {
    const prompt = await systemPromptOf(makeState({ roomRoster: [] }));
    expect(prompt).not.toContain(ROOM_PARTICIPANTS_HEADER);
  });

  test("guest turns skip the participants block even with a non-empty roster", async () => {
    const roster: RoomParticipant[] = [
      {
        actorId: "actor-owner",
        kind: "user",
        displayName: "Qz9RosterOnlyParticipant",
        roomRole: "admin",
      },
    ];
    const prompt = await systemPromptOf(
      makeState({ actorRole: "guest", roomRoster: roster }),
    );
    expect(prompt).not.toContain(ROOM_PARTICIPANTS_HEADER);
    expect(prompt).not.toContain("Qz9RosterOnlyParticipant");
    expect(prompt).not.toContain("## Interactive artifacts (workspace)");
  });

  test("does not expose deferred file guidance before filesystem activation", async () => {
    const prompt = await systemPromptOf(makeState({}));
    expect(prompt).toContain("Some authorized tools are not listed until needed.");
    expect(prompt).not.toContain("## Interactive artifacts (workspace)");
    expect(prompt).not.toContain("## Editing workspace HTML artifacts (block tools; never re-emit)");
  });

  test("eager rollback restores eligible schemas but retains policy filtering", async () => {
    setConfigOverrides({ nautilo_tool_exposure_mode: "eager" });
    try {
      const patch = await preModelNode(makeState({
        memoryAccessEnvelope: {
          ownerId: "owner-1",
          actorId: "actor-1",
          agentId: "agent-genie",
          roomId: "room-1",
          readableNamespaces: [],
          mutableNamespaces: [],
          writableNamespaces: [],
          toolPolicy: { run_shell: "forbidden" },
        },
      }));

      expect(patch.toolNames).toContain("file");
      expect(patch.toolNames).not.toContain("run_shell");
    } finally {
      setConfigOverrides({});
    }
  });

  test("activating file keeps prompt descriptions and tool names in parity", async () => {
    const patch = await preModelNode(makeState({ activatedToolNames: ["file"] }));
    const prompt = await systemPromptOf(makeState({ activatedToolNames: ["file"] }));

    expect(patch.toolNames).toContain("file");
    expect(prompt).toContain("**file**:");
  });

  test("D419 keeps every authorized core schema represented in the system prompt", async () => {
    const state = makeState({});
    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);
    const toolNames = patch.toolNames ?? [];

    expect(toolNames).toContain("discover_tools");
    expect(toolNames).toContain("activate_tools");
    for (const name of toolNames) {
      expect(prompt).toContain(`**${name}**:`);
    }
    expect(toolNames).not.toContain("file");
    expect(prompt).not.toContain("**file**:");
  });

  test("Let Genie drive auto-binds terminal and injects authoritative handoff guidance", async () => {
    const state = makeState({
      messages: [new HumanMessage("Continue the repository inspection.")],
      relayCapabilities: {
        canUseTerminal: true,
        hasPendingTerminalHandoff: true,
      },
      memoryAccessEnvelope: {
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-genie",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { terminal: "allow" },
      },
    });
    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);

    expect(patch.activatedToolNames).toContain("terminal");
    expect(patch.toolNames).toContain("terminal");
    expect(prompt).toContain("## Human terminal handoff");
    expect(prompt).toContain("`terminal` tool is already callable");
    expect(prompt).toContain("may be omitted while Genie retains control");
    expect(prompt).toContain("terminal discovery, activation, listing, and spawning are unnecessary");
  });

  test("an in-flight turn gains and later drops the live terminal handoff token", () => {
    const gained = reconcileLiveTerminalHandoffCapabilities(
      { canRunShell: true },
      { canUseTerminal: true, hasPendingTerminalHandoff: true },
    );
    expect(gained).toEqual({
      canRunShell: true,
      canUseTerminal: true,
      hasPendingTerminalHandoff: true,
    });

    const cleared = reconcileLiveTerminalHandoffCapabilities(gained, {
      canUseTerminal: true,
    });
    expect(cleared).toEqual({ canRunShell: true, canUseTerminal: true });
  });

  test("explicit file editing pre-activates filesystem with prompt/schema parity", async () => {
    const state = makeState({
      messages: [new HumanMessage("Edit the README file in my workspace.")],
    });
    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);

    expect(patch.activatedToolNames).toContain("file");
    expect(patch.toolNames).toContain("file");
    expect(prompt).toContain("**file**:");
  });

  test("D497 projects an already-authorized shell for an explicit GitHub request without filesystem access", async () => {
    const state = makeState({
      messages: [new HumanMessage("List open GitHub issues for this repo.")],
      relayCapabilities: { use_high_impact_tools: true, canRunShell: true },
    });
    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);

    expect(patch.activatedToolNames).toContain("run_shell");
    expect(patch.toolNames).toContain("run_shell");
    expect(prompt).toContain("**run_shell**:");
    // Shell selection only reuses the existing catalog entry. It never
    // projects the filesystem family or grants Current Folder authority.
    expect(patch.toolNames).not.toContain("file");
    expect(patch.activatedToolNames).not.toContain("file");
  });

  test("D497 keeps shell deferred for unrelated turns and denied/missing authorization", async () => {
    const unrelated = await preModelNode(makeState({
      messages: [new HumanMessage("Summarize the sprint note.")],
      relayCapabilities: { use_high_impact_tools: true, canRunShell: true },
    }));
    expect(unrelated.toolNames).not.toContain("run_shell");

    const missingRelayAuthorization = await preModelNode(makeState({
      messages: [new HumanMessage("List open GitHub issues for this repo.")],
      relayCapabilities: {},
    }));
    expect(missingRelayAuthorization.toolNames).not.toContain("run_shell");

    const policyDenied = await preModelNode(makeState({
      messages: [new HumanMessage("List open GitHub issues for this repo.")],
      relayCapabilities: { use_high_impact_tools: true, canRunShell: true },
      memoryAccessEnvelope: {
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-genie",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { run_shell: "forbidden" },
      },
    }));
    expect(policyDenied.toolNames).not.toContain("run_shell");
  });

  test("an explicit whitelist still withholds an intent-pack tool", async () => {
    const patch = await preModelNode(makeState({
      messages: [new HumanMessage("Edit the README file in my workspace.")],
      toolWhitelist: ["discover_tools"],
    }));

    expect(patch.toolNames).not.toContain("file");
  });

  test("tool policy still withholds an intent-pack tool", async () => {
    const patch = await preModelNode(makeState({
      messages: [new HumanMessage("Edit the README file in my workspace.")],
      memoryAccessEnvelope: {
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-genie",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { file: "forbidden" },
      },
    }));

    expect(patch.toolNames).not.toContain("file");
  });
});
