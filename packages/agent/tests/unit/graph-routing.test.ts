import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, test, expect } from "bun:test";
import { END } from "@langchain/langgraph";
import { shouldContinue, shouldContinueAfterTools } from "../../src/agent/graph";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

function makeState(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "",
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
    agentId: "",
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

describe("shouldContinue", () => {
  test("ordinary access preparation rejection returns to the model instead of ending silently", () => {
    expect(shouldContinue(makeState({ ordinaryContentAccessRejectedToolCallIds: ["rejected-share"] }))).toBe("pre_model");
  });
  test("routes to tools when approvedToolCalls is non-empty", () => {
    const state = makeState({
      approvedToolCalls: [{ id: "tc1", name: "run_shell", args: {}, type: "tool_call" }],
    });
    expect(shouldContinue(state)).toBe("tools");
  });

  test("routes to pre_model when approvalDenied is true", () => {
    const state = makeState({ approvalDenied: true });
    expect(shouldContinue(state)).toBe("pre_model");
  });

  test("routes a projection preflight rejection back to the model", () => {
    const state = makeState({
      projectionRejectedToolCallIds: ["rejected-project"],
    });
    expect(shouldContinue(state)).toBe("pre_model");
  });

  test("executes an approved sibling before correcting a projection rejection", () => {
    const state = makeState({
      approvedToolCalls: [{ id: "valid", name: "list_memory", args: {}, type: "tool_call" }],
      projectionRejectedToolCallIds: ["rejected-project"],
    });
    expect(shouldContinue(state)).toBe("tools");
  });

  test("routes to END when no approved tools and not denied", () => {
    const state = makeState();
    expect(shouldContinue(state)).toBe(END);
  });

  test("approvedToolCalls takes priority over approvalDenied", () => {
    const state = makeState({
      approvedToolCalls: [{ id: "tc1", name: "search_memory", args: {}, type: "tool_call" }],
      approvalDenied: true,
    });
    expect(shouldContinue(state)).toBe("tools");
  });

  test("empty approvedToolCalls with approvalDenied false goes to END", () => {
    const state = makeState({
      approvedToolCalls: [],
      approvalDenied: false,
      messages: [new AIMessage("Done")],
    });
    expect(shouldContinue(state)).toBe(END);
  });

  test("rejects a terminal model result with no visible content", () => {
    const state = makeState({
      messages: [new AIMessage({ content: [{ type: "reasoning", reasoning: "hidden" }] })],
    });
    expect(() => shouldContinue(state)).toThrow("without a visible response");
  });

  test("accepts intentional silence after a successful reaction", () => {
    const state = makeState({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc-react", name: "react", args: { emoji: "👍" } }],
        }),
        new ToolMessage({
          content: JSON.stringify({ ok: true, action: "add", created: true }),
          tool_call_id: "tc-react",
          name: "react",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage(""),
      ],
    });
    expect(shouldContinue(state)).toBe(END);
  });

  test("accepts intentional silence after a successful skip", () => {
    const state = makeState({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc-skip", name: "skip", args: {} }],
        }),
        new ToolMessage({
          content: JSON.stringify({ skipped: true, reason: null }),
          tool_call_id: "tc-skip",
          name: "skip",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage(""),
      ],
    });
    expect(shouldContinue(state)).toBe(END);
  });

  test("accepts intentional silence after a successful redirecting skip", () => {
    const state = makeState({
      messages: [
        new ToolMessage({
          content: JSON.stringify({ recorded: true, target_handle: "casey" }),
          tool_call_id: "tc-skip",
          name: "skip",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage(""),
      ],
    });
    expect(shouldContinue(state)).toBe(END);
  });

  test("rejects silence after an unsuccessful reaction", () => {
    const state = makeState({
      messages: [
        new ToolMessage({
          content: JSON.stringify({ ok: false, error: "message_not_found" }),
          tool_call_id: "tc-react",
          name: "react",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage(""),
      ],
    });
    expect(() => shouldContinue(state)).toThrow("without a visible response");
  });

  test("rejects silence after a rejected redirect", () => {
    const state = makeState({
      messages: [
        new ToolMessage({
          content: JSON.stringify({ recorded: false, reason: "invalid_target" }),
          tool_call_id: "tc-skip",
          name: "skip",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage(""),
      ],
    });
    expect(() => shouldContinue(state)).toThrow("without a visible response");
  });

  test("rejects silence after an explicitly failed reaction invocation", () => {
    const state = makeState({
      messages: [
        new ToolMessage({
          content: JSON.stringify({ ok: true, action: "add", created: true }),
          tool_call_id: "tc-react",
          name: "react",
          additional_kwargs: { nautilo_tool_status: "error" },
        }),
        new AIMessage(""),
      ],
    });
    expect(() => shouldContinue(state)).toThrow("without a visible response");
  });

  test("rejects an empty model result that requests another tool", () => {
    const state = makeState({
      messages: [
        new ToolMessage({
          content: JSON.stringify({ ok: true, action: "add", created: true }),
          tool_call_id: "tc-react",
          name: "react",
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc-next", name: "missing_tool", args: {} }],
        }),
      ],
    });
    expect(() => shouldContinue(state)).toThrow("without a visible response");
  });

  test("accepts a structured visible terminal response", () => {
    const state = makeState({
      messages: [new AIMessage({ content: [{ type: "text", text: "Done" }] })],
    });
    expect(shouldContinue(state)).toBe(END);
  });
});

describe("shouldContinueAfterTools", () => {
  test("routes a checkpointed remainder through another tools invocation", () => {
    expect(shouldContinueAfterTools(makeState({
      approvedToolCalls: [{ id: "tc-later", name: "run_shell", args: {}, type: "tool_call" }],
    }))).toBe("tools");
  });

  test("returns to pre_model after the final tool checkpoint", () => {
    expect(shouldContinueAfterTools(makeState())).toBe("pre_model");
  });
});
