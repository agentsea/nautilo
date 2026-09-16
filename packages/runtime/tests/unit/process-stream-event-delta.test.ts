/**
 * Unit tests for `processStreamEvent`'s message-harvesting logic.
 *
 * BUG (current implementation): on every whitelisted `on_chain_end`
 * event, the executor pushes the FULL `data.output.messages` array
 * into `messagesToPersist`. For a 600-message session this means 600
 * rows enter the persist call every turn end, the partial-unique
 * index is asked to dedup all of them, and any single bad row in the
 * batch (size, FK, type) aborts the entire INSERT — losing the new
 * turn's actual rows alongside the historical noise.
 *
 * CONTRACT (what these tests assert): the executor must persist only
 * the DELTA — the messages this node added to its input. Specifically
 * `output.messages.slice(input.messages.length)`. A node that did not
 * add messages contributes nothing.
 *
 * These tests are written to FAIL against the current implementation
 * (which `push(...output.messages)` regardless of input length) and
 * to PASS after `processStreamEvent` is changed to slice by input
 * length.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import {
  processStreamEvent,
  shouldPublishProjectionPreflightLifecycle,
} from "../../src/executors/langgraph-executor";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";

function makePriorHistory(n: number): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 2 === 0 ? new HumanMessage(`prior-user-${i}`) : new AIMessage(`prior-ai-${i}`));
  }
  return out;
}

function nodeEnd(name: string, input: { messages?: BaseMessage[] }, output: Record<string, unknown>) {
  return { event: "on_chain_end", name, data: { input, output } };
}

describe("processStreamEvent — delta harvesting (M070 follow-up)", () => {
  let batcher: TokenBatcher;
  let tracker: ToolCallTracker;

  beforeEach(() => {
    batcher = new TokenBatcher({ laneKey: "test" });
    tracker = new ToolCallTracker();
  });

  test("agent end: persists only the new AI reply, NOT the entire prior history", () => {
    const prior = makePriorHistory(500);
    const userMsg = new HumanMessage("hello");
    const aiMsg = new AIMessage("hi back");
    const ev = nodeEnd(
      "agent",
      { messages: [...prior, userMsg] },
      { messages: [...prior, userMsg, aiMsg], model: "claude" },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(1);
    expect(messagesToPersist[0]).toBe(aiMsg);
  });

  test("returns the identity of the visible message completed with the durable delta", () => {
    const keyedBatcher = new TokenBatcher({ laneKey: "test", turnId: "turn-1" });
    keyedBatcher.addToken("hi back");
    const aiMsg = new AIMessage("hi back");
    const result = processStreamEvent(
      nodeEnd("agent", { messages: [] }, { messages: [aiMsg] }),
      keyedBatcher,
      tracker,
    );

    expect(result.assistantMessageKey).toBe("assistant:turn-1:0");
    expect(result.messagesToPersist).toEqual([aiMsg]);
  });

  test("tools end: persists only the new ToolMessage(s), not the historical prefix", () => {
    const prior = makePriorHistory(200);
    const userMsg = new HumanMessage("run the tool");
    const aiToolCall = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc-1", name: "list_dir", args: {}, type: "tool_call" }],
    });
    const toolResult = new ToolMessage({ content: "[]", tool_call_id: "tc-1" });
    const ev = nodeEnd(
      "tools",
      { messages: [...prior, userMsg, aiToolCall] },
      { messages: [...prior, userMsg, aiToolCall, toolResult], approvedToolCalls: [] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(1);
    expect(messagesToPersist[0]).toBe(toolResult);
  });

  test("projection preflight persists its rejected ToolMessage exactly once", () => {
    const prior = makePriorHistory(20);
    const proposed = new AIMessage({
      content: "",
      tool_calls: [
        { id: "valid-project", name: "share_memory", args: { mode: "project" }, type: "tool_call" },
        { id: "rejected-project", name: "share_memory", args: {
          mode: "project", sourceMemoryIds: ["private-source"],
        }, type: "tool_call" },
      ],
    });
    const rejected = new ToolMessage({
      content: JSON.stringify({ error: "Choose a Room first." }),
      tool_call_id: "rejected-project",
      name: "share_memory",
      status: "error",
      additional_kwargs: { nautilo_tool_status: "error" },
    });

    const ordinaryContext = {
      laneKey: "room:ordinary",
      publishProjectionPreflightLifecycle: true,
    };
    const preflight = processStreamEvent(nodeEnd(
      "projection_preflight",
      { messages: [...prior, proposed] },
      { messages: [...prior, proposed, rejected] },
    ), batcher, tracker, ordinaryContext);
    const postModel = processStreamEvent(nodeEnd(
      "post_model",
      { messages: [...prior, proposed, rejected] },
      { approvedToolCalls: [{ id: "valid-project", name: "share_memory", args: { mode: "project" } }] },
    ), batcher, tracker, ordinaryContext);

    expect(preflight.messagesToPersist).toEqual([rejected]);
    expect(postModel.messagesToPersist).toEqual([]);
    expect(mergeMessagesPreservingInvariants(
      preflight.messagesToPersist,
      postModel.messagesToPersist,
    )).toEqual([rejected]);
    const lifecycle = [...preflight.events, ...postModel.events];
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toEqual(
      {
        type: "tool.start",
        laneKey: "room:ordinary",
        toolCallId: "rejected-project",
        toolName: "share_memory",
        argsSummary: undefined,
      },
    );
    expect(lifecycle[1]).toMatchObject(
      {
        type: "tool.end",
        laneKey: "room:ordinary",
        toolCallId: "rejected-project",
        toolName: "share_memory",
        status: "error",
        error: "Choose a Room first.",
        result: JSON.stringify({ error: "Choose a Room first." }),
      },
    );
    expect(lifecycle[1]?.type === "tool.end" && typeof lifecycle[1].duration).toBe("number");
    expect(JSON.stringify(preflight.events)).not.toContain("private-source");
  });

  test.each(["share_memory", "share_artifact", "ask_peer"])("ordinary %s preparation rejection is persisted and has a terminal error lifecycle", (toolName) => {
    const proposed = new AIMessage({ content: "", tool_calls: [{ id: "ordinary-rejected", name: toolName,
      args: { private_source: "never-forward-model-args" }, type: "tool_call" }] });
    const rejected = new ToolMessage({ name: toolName, tool_call_id: "ordinary-rejected", status: "error",
      content: JSON.stringify({ error: "content_access_preparation_failed", recovery: "prepare_new_call", message: "Choose the exact Room." }),
      additional_kwargs: { nautilo_tool_status: "error" } });
    const result = processStreamEvent(nodeEnd("ordinary_content_access_preflight", { messages: [proposed] },
      { messages: [proposed, rejected] }), batcher, tracker,
    { laneKey: "room:ordinary", publishProjectionPreflightLifecycle: true });
    expect(result.messagesToPersist).toEqual([rejected]);
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({ type: "tool.end", toolCallId: "ordinary-rejected", toolName, status: "error" });
    expect(JSON.stringify(result.events)).not.toContain("never-forward-model-args");
  });

  test.each([
    ["ordinary", false, false, false, false, true],
    ["live Shadow protected", true, false, true, false, false],
    ["legacy protected turn", false, true, false, false, false],
    ["suppressed lifecycle", false, false, true, false, false],
    ["quiet supervision", false, false, false, true, false],
  ] as const)("derives projection lifecycle opt-in for %s", (
    _label,
    hasLiveShadowRuntime,
    hasProtectedTurn,
    suppressToolLifecycleEvents,
    quietSupervision,
    expected,
  ) => {
    expect(shouldPublishProjectionPreflightLifecycle({
      hasLiveShadowRuntime,
      hasProtectedTurn,
      suppressToolLifecycleEvents,
      quietSupervision,
    })).toBe(expected);
  });

  test("multi-message delta: tools end with two parallel tool results yields exactly those two", () => {
    const prior = makePriorHistory(50);
    const userMsg = new HumanMessage("multi tool");
    const aiToolCall = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "t1", args: {}, type: "tool_call" },
        { id: "b", name: "t2", args: {}, type: "tool_call" },
      ],
    });
    const tr1 = new ToolMessage({ content: "ok-1", tool_call_id: "a" });
    const tr2 = new ToolMessage({ content: "ok-2", tool_call_id: "b" });
    const ev = nodeEnd(
      "tools",
      { messages: [...prior, userMsg, aiToolCall] },
      { messages: [...prior, userMsg, aiToolCall, tr1, tr2], approvedToolCalls: [] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(2);
    expect(messagesToPersist[0]).toBe(tr1);
    expect(messagesToPersist[1]).toBe(tr2);
  });

  test("post_model end (no tool path): output has no messages key → persists nothing", () => {
    const prior = makePriorHistory(100);
    const ev = nodeEnd(
      "post_model",
      { messages: prior },
      { approvedToolCalls: [], pendingApproval: [], approvalDenied: false },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("agent end with no actual delta (output.messages.length === input.messages.length): persists nothing", () => {
    const prior = makePriorHistory(50);
    const ev = nodeEnd(
      "agent",
      { messages: prior },
      { messages: [...prior], model: "claude" },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("pre_model is NOT in the persist whitelist even if it returns messages", () => {
    const prior = makePriorHistory(50);
    const userMsg = new HumanMessage("hi");
    const ev = nodeEnd(
      "pre_model",
      { messages: [...prior, userMsg] },
      { messages: [...prior, userMsg], preparedMessages: [], toolNames: [] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("LangGraph (graph-level) end is NOT persisted — node ends are the source of truth", () => {
    const prior = makePriorHistory(100);
    const userMsg = new HumanMessage("hi");
    const aiMsg = new AIMessage("hello");
    const ev = nodeEnd(
      "LangGraph",
      { messages: [...prior, userMsg] },
      { messages: [...prior, userMsg, aiMsg] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("RunnableLambda intermediate end (output is a string, not a state object): no crash, persists nothing", () => {
    const ev = {
      event: "on_chain_end",
      name: "RunnableLambda",
      data: { input: { messages: [] }, output: "some-string-payload" },
    };

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("input.messages missing entirely: defensive — treat input length as 0 and persist whole output", () => {
    const userMsg = new HumanMessage("hi");
    const aiMsg = new AIMessage("hello");
    const ev = {
      event: "on_chain_end",
      name: "agent",
      data: { input: {}, output: { messages: [userMsg, aiMsg] } },
    };

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(2);
    expect(messagesToPersist[0]).toBe(userMsg);
    expect(messagesToPersist[1]).toBe(aiMsg);
  });

  test("output.messages.length < input.messages.length (defensive): persists nothing, does not throw", () => {
    const prior = makePriorHistory(10);
    const ev = nodeEnd(
      "agent",
      { messages: prior },
      { messages: prior.slice(0, 5), model: "claude" },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("other node names are NOT persisted (whitelist guard)", () => {
    const prior = makePriorHistory(10);
    const userMsg = new HumanMessage("hi");
    const aiMsg = new AIMessage("hello");
    const ev = nodeEnd(
      "some_other_node",
      { messages: [...prior, userMsg] },
      { messages: [...prior, userMsg, aiMsg] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });

  test("on_chain_start does not contribute to messagesToPersist", () => {
    const prior = makePriorHistory(10);
    const ev = {
      event: "on_chain_start",
      name: "agent",
      data: { input: { messages: prior }, output: undefined },
    };

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(0);
  });
});

describe("processStreamEvent — delta correctness across a full tool turn", () => {
  let batcher: TokenBatcher;
  let tracker: ToolCallTracker;

  beforeEach(() => {
    batcher = new TokenBatcher({ laneKey: "test" });
    tracker = new ToolCallTracker();
  });

  test("two identical tool results in a single turn (different tool_call_ids) both flow through the delta", () => {
    // Regression: same `list_memory` tool called twice in one turn
    // returns the exact same string. Each invocation has its own
    // tool_call_id from the LLM. The slice should yield BOTH
    // ToolMessages — the fingerprint module is responsible for
    // making them DB-distinct via tool_call_id.
    const prior = makePriorHistory(50);
    const userMsg = new HumanMessage("call it twice");
    const aiTwoCalls = new AIMessage({
      content: "",
      tool_calls: [
        { id: "call-A", name: "list_memory", args: {}, type: "tool_call" },
        { id: "call-B", name: "list_memory", args: {}, type: "tool_call" },
      ],
    });
    const sameContent = "Found 15 memories: ...";
    const tA = new ToolMessage({ content: sameContent, tool_call_id: "call-A" });
    const tB = new ToolMessage({ content: sameContent, tool_call_id: "call-B" });

    const ev = nodeEnd(
      "tools",
      { messages: [...prior, userMsg, aiTwoCalls] },
      { messages: [...prior, userMsg, aiTwoCalls, tA, tB], approvedToolCalls: [] },
    );

    const { messagesToPersist } = processStreamEvent(ev, batcher, tracker);

    expect(messagesToPersist.length).toBe(2);
    expect(messagesToPersist[0]).toBe(tA);
    expect(messagesToPersist[1]).toBe(tB);
  });

  test("simulated tool turn yields exactly [ai_with_tool_calls, tool_result, final_ai] across three node ends", () => {
    const prior = makePriorHistory(300);
    const userMsg = new HumanMessage("look at memories");

    const aiToolCall = new AIMessage({
      content: "",
      tool_calls: [{ id: "mem-1", name: "list_memory", args: {}, type: "tool_call" }],
    });
    const toolResult = new ToolMessage({
      content: "Found 3 memories: ...",
      tool_call_id: "mem-1",
    });
    const finalAi = new AIMessage("Here are your 3 memories.");

    // 1. agent end #1: emits the tool-calling AI message
    const r1 = processStreamEvent(
      nodeEnd(
        "agent",
        { messages: [...prior, userMsg] },
        { messages: [...prior, userMsg, aiToolCall] },
      ),
      batcher,
      tracker,
    );
    // 2. tools end: emits the tool result
    const r2 = processStreamEvent(
      nodeEnd(
        "tools",
        { messages: [...prior, userMsg, aiToolCall] },
        { messages: [...prior, userMsg, aiToolCall, toolResult] },
      ),
      batcher,
      tracker,
    );
    // 3. agent end #2: emits the final AI text reply
    const r3 = processStreamEvent(
      nodeEnd(
        "agent",
        { messages: [...prior, userMsg, aiToolCall, toolResult] },
        { messages: [...prior, userMsg, aiToolCall, toolResult, finalAi] },
      ),
      batcher,
      tracker,
    );

    const allPersisted = mergeMessagesPreservingInvariants(
      mergeMessagesPreservingInvariants(r1.messagesToPersist, r2.messagesToPersist),
      r3.messagesToPersist,
    );

    expect(allPersisted.length).toBe(3);
    expect(allPersisted[0]).toBe(aiToolCall);
    expect(allPersisted[1]).toBe(toolResult);
    expect(allPersisted[2]).toBe(finalAi);

    // Critical: the historical prefix is NEVER re-pushed. Total work
    // per turn is O(messages-this-turn), not O(conversation-length).
    expect(allPersisted).not.toContain(userMsg); // user is persisted via the pre-stream call, not from on_chain_end
    for (const p of prior) {
      expect(allPersisted).not.toContain(p);
    }
  });
});
