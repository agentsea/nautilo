import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { PolicyResolver, ToolAccessDecision } from "@nautilo/trust";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import type { PostModelDeps } from "../../src/nodes/post-model";
import { createPostModelNode } from "../../src/nodes/post-model";
import { preModelNode } from "../../src/nodes/pre-model";
import {
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
} from "../../src/tools/invocation-service";
import { registerAllTools } from "../../src/tools/register-all";

const originalTavilyKey = process.env["TAVILY_API_KEY"];

const NO_APPROVAL_MATCH: PostModelDeps = {
  matchCommandApproval: async () => null,
  createCommandApproval: async () => ({ id: "unused", created: true }),
};

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("Research this topic thoroughly.")],
    threadId: 0,
    // Keep the durable graph identity on currentThreadId so preModelNode does
    // not attempt the unrelated session-notification DB drain in this unit test.
    langgraphThreadId: "",
    model: null,
    userId: "owner-1",
    causalHumanUserId: "human-1",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "room:room-1",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-1",
    roomId: "room-1",
    approvalLaneKey: "room:room-1",
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
    activatedToolNames: ["run_deep_research"],
    activatedToolLeases: [],
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
    trustedExecutionEntrypoint: "foreground.main",
    ...overrides,
  };
}

function resolver(decision: ToolAccessDecision): PolicyResolver {
  return {
    resolveContext: async () => ({
      laneKey: "room:room-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      roomType: "private",
      graphThreadId: "room:room-1",
      actorLabel: "Owner",
      actorFederatedId: "actor-1",
      agentFederatedId: "agent-1",
      speakerTrust: "verified" as const,
      laneScope: "private" as const,
      actorRole: "owner",
      memoryAccess: {
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-1",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    }),
    buildEnvelope: async () => ({
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    }),
    checkToolAccess: async () => decision,
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}

function registerBuiltins(): ToolCatalog {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  return catalog;
}

function researchCall(id = "research-call") {
  return {
    id,
    name: "run_deep_research",
    args: { research_brief: "A bounded fixture that must never execute." },
    type: "tool_call" as const,
  };
}

beforeEach(() => {
  process.env["TAVILY_API_KEY"] = "unit-test-tavily-key";
});

afterEach(() => {
  clearToolCatalog();
  if (originalTavilyKey === undefined) delete process.env["TAVILY_API_KEY"];
  else process.env["TAVILY_API_KEY"] = originalTavilyKey;
});

describe("built-in deep research contextual availability", () => {
  test("a valid main turn remains eligible after activation and through dispatch recomputation", async () => {
    const catalog = registerBuiltins();
    const mainContext = { deepResearchForegroundAvailable: true };
    const activated = catalog.resolveProgressiveTools({
      context: mainContext,
      activatedToolNames: ["run_deep_research"],
    });

    expect(activated.snapshot.entries.map((entry) => entry.name)).toContain(
      "run_deep_research",
    );
    expect(catalog.getUnavailableReasonForExposure("run_deep_research", {
      context: mainContext,
      activatedToolNames: ["run_deep_research"],
    })).toBeNull();

    const preModel = await preModelNode(state());
    expect(preModel.toolNames).toContain("run_deep_research");

    // Empty args fail the real tool schema before its function can reach model,
    // provider, database, or Task runtime code. Seeing schema validation here
    // proves the invocation service recomputed the tool as available.
    const dispatch = await createNautiloToolInvocationSession(
      createServerToolInvocationContext(state(), () => ({ status: "allowed" })),
    ).invoke({
      callId: "research-schema-probe",
      toolName: "run_deep_research",
      args: {},
      authorityRef: "approved-research-schema-probe",
    });
    const content = typeof dispatch.content === "string"
      ? dispatch.content
      : JSON.stringify(dispatch.content);
    expect(dispatch.status).toBe("error");
    expect(content).not.toContain("cannot start from this turn");
    expect(content).not.toContain("Unknown tool");
  });

  test.each([
    ["foreground fork", { trustedExecutionEntrypoint: "foreground.fork" as const }],
    ["background task", { trustedExecutionEntrypoint: "background.task" as const }],
    ["missing causal Human", { causalHumanUserId: "" }],
    ["missing trusted entrypoint", { trustedExecutionEntrypoint: null }],
    ["mismatched approval lane", { approvalLaneKey: "room:other" }],
  ])("%s excludes the schema and refuses a stale call before approval", async (_label, overrides) => {
    registerBuiltins();
    const staleState = state(overrides);

    const preModel = await preModelNode(staleState);
    expect(preModel.toolNames).not.toContain("run_deep_research");

    const call = researchCall();
    const postModel = await createPostModelNode(
      resolver({ type: "require_approval", route: { type: "prove_it", approvers: ["owner-1"] } }),
      NO_APPROVAL_MATCH,
    )({ ...staleState, messages: [new AIMessage({ content: "", tool_calls: [call] })] });

    expect(postModel.approvedToolCalls).toEqual([]);
    expect(postModel.pendingApproval).toEqual([]);
    const refusal = postModel.messages?.at(-1) as ToolMessage;
    expect(refusal.content).toContain("cannot start from this turn");
    expect(refusal.content).toContain("send a new request");
    expect(refusal.content).toContain("No research was started");
    expect(refusal.status).toBe("error");

    const dispatch = await createNautiloToolInvocationSession(
      createServerToolInvocationContext(staleState, () => ({ status: "allowed" })),
    ).invoke({
      callId: "stale-research-dispatch",
      toolName: "run_deep_research",
      args: call.args,
      authorityRef: "previously-approved-research-call",
    });
    const dispatchContent = typeof dispatch.content === "string"
      ? dispatch.content
      : JSON.stringify(dispatch.content);
    expect(dispatch.status).toBe("error");
    expect(dispatchContent).toContain("cannot start from this turn");
    expect(dispatchContent).toContain("No research was started");
  });

  test("a forbidden actor receives no contextual prerequisite details", async () => {
    registerBuiltins();
    const call = researchCall("research-forbidden");
    const result = await createPostModelNode(
      resolver({ type: "forbidden", reason: "actor policy denied research" }),
      NO_APPROVAL_MATCH,
    )({
      ...state({ trustedExecutionEntrypoint: "foreground.fork" }),
      messages: [new AIMessage({ content: "", tool_calls: [call] })],
    });

    expect(result.pendingApproval).toEqual([]);
    const refusal = result.messages?.at(-1) as ToolMessage;
    expect(refusal.content).toContain("do not have permission");
    expect(refusal.content).not.toContain("cannot start from this turn");
    expect(refusal.content).not.toContain("current reply");
    expect(refusal.content).not.toContain("No research was started");
  });

  test("main-turn availability cannot bypass a forbidden tool policy", async () => {
    const catalog = registerBuiltins();
    const toolPolicy = { run_deep_research: "forbidden" } as const;
    const mainState = state({
      memoryAccessEnvelope: {
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-1",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy,
      },
    });

    expect(catalog.resolveProgressiveTools({
      context: { deepResearchForegroundAvailable: true },
      toolPolicy,
      activatedToolNames: ["run_deep_research"],
    }).snapshot.entries.map((entry) => entry.name)).not.toContain("run_deep_research");
    expect((await preModelNode(mainState)).toolNames).not.toContain("run_deep_research");

    const call = researchCall("research-policy-forbidden");
    const postModel = await createPostModelNode(
      resolver({ type: "forbidden", reason: "tool policy denied research" }),
      NO_APPROVAL_MATCH,
    )({ ...mainState, messages: [new AIMessage({ content: "", tool_calls: [call] })] });
    expect(postModel.approvedToolCalls).toEqual([]);
    expect(postModel.pendingApproval).toEqual([]);
  });
});
