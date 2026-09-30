import { afterEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import type { PolicyResolver } from "@nautilo/trust";
import { z } from "zod";
import { MAX_SUBAGENT_DEPTH, type NautiloState } from "../../src/agent/state";
import { createPostModelNode } from "../../src/nodes/post-model";
import { preModelNode } from "../../src/nodes/pre-model";
import {
  createToolsNode,
  PERSONAL_FUNDING_TOOL_UNSUPPORTED_RESULT,
} from "../../src/nodes/tools";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";

afterEach(() => {
  clearToolCatalog();
  setConfigOverrides({});
});

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("Answer with text")],
    threadId: 0,
    langgraphThreadId: "thread-personal",
    model: null,
    userId: "human-1",
    causalHumanUserId: "human-1",
    personaId: "owner",
    voiceMode: false,
    source: "web",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "Remembered context remains available.",
    memoryDelta: "",
    currentThreadId: "thread-personal",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-1",
    roomId: "room-1",
    roomRoster: [],
    approvalDenied: false,
    turnId: "turn-1",
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
    activatedToolNames: ["paid_fixture"],
    activatedToolLeases: [],
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: true,
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

function registerPaidFixture(invoke: () => void): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "paid_fixture",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    factory: () => new DynamicStructuredTool({
      name: "paid_fixture",
      description: "A paid side effect fixture that personal chat must never expose or execute.",
      schema: z.object({}),
      func: async () => {
        invoke();
        return "paid fixture executed";
      },
    }),
  });
  initToolCatalog(catalog);
}

function fundingSession(kind: "personal" | "server"): ForegroundChatFundingSession {
  return {
    kind,
    runAttempt: async () => { throw new Error("funding attempt is outside this node test"); },
    recheckAttempt: async () => {},
  };
}

function promptText(message: SystemMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) =>
    block && typeof block === "object" && "text" in block
      ? String(block.text)
      : "",
  ).join("");
}

describe("personal-funded foreground tool fence", () => {
  test("pre-model exposes no tool schemas or stale activation handles", async () => {
    registerPaidFixture(() => {
      throw new Error("pre-model must not execute tools");
    });
    setConfigOverrides({ nautilo_tool_exposure_mode: "eager" });

    const patch = await preModelNode(
      state(),
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      true,
    );

    expect(patch.toolNames).toEqual([]);
    expect(patch.activatedToolNames).toEqual([]);
    const system = patch.preparedMessages?.[0];
    expect(system).toBeInstanceOf(SystemMessage);
    expect(promptText(system as SystemMessage)).toContain("You have access to 0 tools");
    expect(promptText(system as SystemMessage)).not.toContain("paid_fixture");
    expect(promptText(system as SystemMessage)).toContain("Remembered context remains available.");
  });

  test("post-model rejects injected calls before policy or approval work", async () => {
    let policyChecks = 0;
    let approvalReads = 0;
    const resolver = {
      checkToolAccess: async () => {
        policyChecks++;
        return { type: "allow" as const };
      },
    } as unknown as PolicyResolver;
    const call = { id: "injected-call", name: "paid_fixture", args: { secret: "must-not-echo" }, type: "tool_call" as const };
    const current = state({
      messages: [new HumanMessage("Answer"), new AIMessage({ content: "", tool_calls: [call] })],
    });

    const patch = await createPostModelNode(resolver, {
      foregroundChatFundingSession: fundingSession("personal"),
      matchCommandApproval: async () => {
        approvalReads++;
        return null;
      },
    })(current);

    expect(policyChecks).toBe(0);
    expect(approvalReads).toBe(0);
    expect(patch.approvedToolCalls).toEqual([]);
    expect(patch.approvalDenied).toBe(true);
    const denial = patch.messages?.at(-1);
    expect(denial).toBeInstanceOf(ToolMessage);
    expect(denial?.content).toBe(PERSONAL_FUNDING_TOOL_UNSUPPORTED_RESULT);
    expect(typeof denial?.content === "string" ? denial.content : JSON.stringify(denial?.content))
      .not.toContain("must-not-echo");
  });

  test("post-model preserves earlier preflight rejections without duplicating receipts", async () => {
    const rejected = { id: "preflight-rejected", name: "paid_fixture", args: {}, type: "tool_call" as const };
    const stale = { id: "stale-live", name: "paid_fixture", args: {}, type: "tool_call" as const };
    const assistant = new AIMessage({ content: "", tool_calls: [rejected, stale] });
    const priorDenial = new ToolMessage({
      content: "rejected before post-model",
      tool_call_id: rejected.id,
      name: rejected.name,
      status: "error",
    });

    const patch = await createPostModelNode({} as PolicyResolver, {
      foregroundChatFundingSession: fundingSession("personal"),
    })(state({
      messages: [new HumanMessage("Answer"), assistant, priorDenial],
      modelRejectedToolCallIds: [rejected.id],
    }));

    const receipts = patch.messages?.filter((message) => ToolMessage.isInstance(message)) ?? [];
    expect(receipts.map((message) => message.tool_call_id)).toEqual([rejected.id, stale.id]);
    expect(receipts[0]?.content).toBe("rejected before post-model");
    expect(receipts[1]?.content).toBe(PERSONAL_FUNDING_TOOL_UNSUPPORTED_RESULT);
  });

  test("tools node refuses checkpointed approvals before resolving ports or invoking", async () => {
    let invocations = 0;
    let portResolutions = 0;
    registerPaidFixture(() => { invocations++; });
    const call = { id: "stale-approved", name: "paid_fixture", args: {}, type: "tool_call" as const };
    const current = state({
      messages: [new HumanMessage("Answer"), new AIMessage({ content: "", tool_calls: [call] })],
      approvedToolCalls: [call],
    });

    const patch = await createToolsNode({
      personalFunding: true,
      ordinaryContentAccessForState: async () => {
        portResolutions++;
        return { mode: "unchanged" };
      },
    })(current);

    expect(portResolutions).toBe(0);
    expect(invocations).toBe(0);
    expect(patch.approvedToolCalls).toEqual([]);
    expect(patch.approvalDenied).toBe(true);
    expect(patch.messages?.at(-1)?.content).toBe(PERSONAL_FUNDING_TOOL_UNSUPPORTED_RESULT);
  });

  test("ordinary server-funded tools retain their existing execution path", async () => {
    let invocations = 0;
    registerPaidFixture(() => { invocations++; });
    const call = { id: "server-approved", name: "paid_fixture", args: {}, type: "tool_call" as const };
    const current = state({
      messages: [new HumanMessage("Use the fixture"), new AIMessage({ content: "", tool_calls: [call] })],
      approvedToolCalls: [call],
      activatedToolNames: [],
    });

    const patch = await createToolsNode()(current);

    expect(invocations).toBe(1);
    expect(patch.approvedToolCalls).toEqual([]);
    expect(patch.messages?.at(-1)?.content).toBe("paid fixture executed");
  });

  test("server funding does not trigger the post-model personal fence", async () => {
    registerPaidFixture(() => {});
    setConfigOverrides({ nautilo_tool_exposure_mode: "eager" });
    let policyChecks = 0;
    const resolver = {
      checkToolAccess: async () => {
        policyChecks++;
        return { type: "allow" as const };
      },
    } as unknown as PolicyResolver;
    const call = { id: "server-call", name: "paid_fixture", args: {}, type: "tool_call" as const };

    const patch = await createPostModelNode(resolver, {
      foregroundChatFundingSession: fundingSession("server"),
      matchCommandApproval: async () => null,
    })(state({ messages: [new HumanMessage("Use it"), new AIMessage({ content: "", tool_calls: [call] })] }));

    expect(policyChecks).toBe(1);
    expect(patch.approvedToolCalls).toEqual([call]);
    expect(patch.approvalDenied).toBe(false);
  });
});
