import { beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { bundledComputerUseContractCatalogue } from "../../src/config/computer-use-catalogue/catalog";
import { preModelNode } from "../../src/nodes/pre-model";
import { registerAllTools } from "../../src/tools/register-all";

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

function stateFor(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("inspect the current desktop")],
    threadId: 0,
    langgraphThreadId: "",
    model: "openai:gpt-5.6-luna",
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
    turnId: "computer-guidance-turn",
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
    relayCapabilities: {
      canUseComputer: true,
      canComputerDo: true,
      canComputerVerify: true,
      canComputerFocus: true,
    },
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

function leadingSystem(patch: Partial<NautiloState>): SystemMessage {
  const message = patch.preparedMessages?.[0];
  if (!(message instanceof SystemMessage)) {
    throw new Error(`expected leading SystemMessage, received ${message?.constructor.name ?? "nothing"}`);
  }
  return message as unknown as SystemMessage;
}

function messageText(message: SystemMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => block && typeof block === "object" && "text" in block
    ? String(block.text)
    : "").join("");
}

describe("D516 signed Computer Use family guidance", () => {
  test("injects the exact signed guidance once when active Computer Use tools are bound", async () => {
    const patch = await preModelNode(stateFor());
    const guidance = bundledComputerUseContractCatalogue.modelGuidance;
    if (guidance === undefined) throw new Error("bundled Computer Use guidance missing");
    const prompt = messageText(leadingSystem(patch));

    expect(patch.toolNames).toContain("computer_observe");
    expect(prompt.split(guidance)).toHaveLength(2);
    expect(prompt).toContain("use returned opaque targets directly");
    expect(prompt).toContain("the requested scope changes, or fresh evidence is needed");
    expect(prompt).toContain("Trust Host-verified postconditions");
    expect(prompt).toContain("finish when they establish the requested outcome");
    expect(prompt).toContain("after an uncertain effect, observe without replaying the mutation");
  });

  test("does not inject guidance when no Computer Use tool is bound", async () => {
    const patch = await preModelNode(stateFor({ toolWhitelist: [] }));
    const guidance = bundledComputerUseContractCatalogue.modelGuidance;
    if (guidance === undefined) throw new Error("bundled Computer Use guidance missing");

    expect(patch.toolNames).not.toContain("computer_observe");
    expect(messageText(leadingSystem(patch))).not.toContain(guidance);
  });

  test("keeps eager tools and guidance on a later prepared turn without skill discovery", async () => {
    const first = await preModelNode(stateFor());
    const later = await preModelNode(stateFor({ turnId: "computer-guidance-later-turn" }));
    const guidance = bundledComputerUseContractCatalogue.modelGuidance;
    if (guidance === undefined) throw new Error("bundled Computer Use guidance missing");

    expect(first.toolNames).toContain("computer_observe");
    expect(later.toolNames).toContain("computer_observe");
    expect(messageText(leadingSystem(later))).toContain(guidance);
    expect(stateFor().engagedSkillNames).toEqual([]);
  });

  test("places guidance inside the Anthropic stable cache block", async () => {
    const patch = await preModelNode(stateFor({ model: "anthropic:claude-sonnet-4-6" }));
    const message = leadingSystem(patch);
    const guidance = bundledComputerUseContractCatalogue.modelGuidance;
    if (guidance === undefined) throw new Error("bundled Computer Use guidance missing");
    if (!Array.isArray(message.content)) throw new Error("expected Anthropic content blocks");
    const firstBlock = message.content[0] as unknown as Record<string, unknown>;

    expect(firstBlock["type"]).toBe("text");
    expect(firstBlock["text"]).toBeTypeOf("string");
    expect(firstBlock["text"] as string).toContain(guidance);
    expect(firstBlock["cache_control"]).toEqual({ type: "ephemeral" });
    expect(patch.preparedStableSystemPrefixLength).toBeGreaterThanOrEqual(guidance.length);
  });
});
