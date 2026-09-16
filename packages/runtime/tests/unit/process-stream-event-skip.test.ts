/**
 * D128 — `skip` tool suppresses fallback emission + agent-text persistence.
 *
 * After the `skip` tool flips the per-turn `skipFlag`, `processStreamEvent`
 * must:
 *   - Drop every `on_chat_model_stream` token (no `message.tokens` event).
 *   - Drop pure-text AIMessages from `messagesToPersist` (no transcript row).
 *   - Preserve tool-call AIMessages + ToolMessages (graph + tool lifecycle
 *     stay consistent).
 *
 * Tests written against the public `processStreamEvent` + `getOrCreateAgentTurnContext`
 * helpers — no executor process / LLM stub required.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  processStreamEvent,
  type StreamProcessorContext,
} from "../../src/executors/langgraph-executor";
import { SentenceDetector } from "../../src/utils/sentence-detector";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";
import {
  _resetAgentTurnContextsForTests,
  getOrCreateAgentTurnContext,
} from "@nautilo/agent";

function tokenStreamEvent(text: string): Record<string, unknown> {
  // Mirrors LangChain's on_chat_model_stream shape — chunk with string content.
  return {
    event: "on_chat_model_stream",
    name: "ChatModel",
    data: { chunk: { content: text } },
  };
}

function nodeEnd(
  name: string,
  input: { messages?: BaseMessage[] },
  output: Record<string, unknown>,
): Record<string, unknown> {
  return { event: "on_chain_end", name, data: { input, output } };
}

const TURN_ID = "turn-skip-test";

describe("processStreamEvent — D128 skip suppression", () => {
  let batcher: TokenBatcher;
  let tracker: ToolCallTracker;
  let ctx: StreamProcessorContext;

  beforeEach(() => {
    _resetAgentTurnContextsForTests();
    batcher = new TokenBatcher({ laneKey: "test", turnId: TURN_ID, maxChars: 1, maxDelayMs: 1 });
    tracker = new ToolCallTracker();
    ctx = { jobId: "j-1", turnId: TURN_ID };
  });

  afterEach(() => {
    _resetAgentTurnContextsForTests();
  });

  test("control: no skipFlag → tokens flow + AIMessage persists", () => {
    const stream = processStreamEvent(tokenStreamEvent("hello"), batcher, tracker, ctx);
    expect(stream.events.length).toBeGreaterThan(0);
    expect(stream.events.some((e) => e.type === "message.tokens")).toBe(true);

    const human = new HumanMessage("hi");
    const ai = new AIMessage("hello back");
    const end = processStreamEvent(
      nodeEnd("agent", { messages: [human] }, { messages: [human, ai] }),
      batcher,
      tracker,
      ctx,
    );
    expect(end.messagesToPersist.length).toBe(1);
    expect(end.messagesToPersist[0]).toBe(ai);
  });

  test("quiet supervision keeps inspection chatter internal but publishes a final answer", () => {
    ctx.quietSupervision = true;
    const speech = new SentenceDetector({ userId: "owner", agentId: "genie", roomId: "room" });
    const human = new HumanMessage("Inspect the operation quietly");
    const call = new AIMessage({ content: "I will inspect again.", tool_calls: [
      { id: "inspection-1", name: "manage_connected_web_operation", args: { operation: "inspect" }, type: "tool_call" },
    ] });
    expect(processStreamEvent(tokenStreamEvent("I will inspect again."), batcher, tracker, ctx, speech).events).toEqual([]);
    const inspection = processStreamEvent(nodeEnd("agent", { messages: [human] }, { messages: [human, call] }), batcher, tracker, ctx, speech);
    expect(inspection.events).toEqual([]);
    expect(inspection.messagesToPersist).toEqual([call]);
    expect(processStreamEvent(tokenStreamEvent("Finished: the evidence is available."), batcher, tracker, ctx, speech).events).toEqual([]);
    const answer = new AIMessage("Finished: the evidence is available.");
    const final = processStreamEvent(nodeEnd("agent", { messages: [human, call] }, { messages: [human, call, answer] }), batcher, tracker, ctx, speech);
    expect(final.messagesToPersist).toEqual([answer]);
    expect(final.events.flatMap(e => e.type === "message.tokens" && "content" in e ? [e.content] : []).join("")).toBe("Finished: the evidence is available.");
    expect(final.events.some(e => e.type === "message.tokens" && e.done)).toBe(true);
    expect(final.assistantMessageKey).toBeDefined();
    const sentences = final.events.filter(e => e.type === "voice.sentence");
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({ text: "Finished: the evidence is available.", userId: "owner", agentId: "genie", roomId: "room" });
  });

  test("inspect then skip produces no visible reply and retains both tool records", () => {
    ctx.quietSupervision = true;
    const call = new AIMessage({ content: "No useful change.", tool_calls: [
      { id: "skip-1", name: "skip", args: {}, type: "tool_call" },
    ] });
    expect(processStreamEvent(tokenStreamEvent("No useful change."), batcher, tracker, ctx).events).toEqual([]);
    expect(processStreamEvent(nodeEnd("agent", { messages: [] }, { messages: [call] }), batcher, tracker, ctx).events).toEqual([]);
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;
    const result = new ToolMessage({ content: '{"skipped":true}', tool_call_id: "skip-1", name: "skip" });
    const quiet = processStreamEvent(nodeEnd("tools", { messages: [call] }, { messages: [call, result] }), batcher, tracker, ctx);
    expect(quiet.events).toEqual([]);
    expect(quiet.messagesToPersist).toEqual([result]);
    expect(processStreamEvent(nodeEnd("agent", { messages: [] }, { messages: [new AIMessage("Unwanted fallback")] }), batcher, tracker, ctx).messagesToPersist).toEqual([]);
    batcher.completeMessage();
    expect(batcher.drain()).toEqual([]);
  });

  test("quiet supervision persists a projection rejection without emitting it directly", () => {
    ctx.quietSupervision = true;
    ctx.publishProjectionPreflightLifecycle = true;
    const proposed = new AIMessage({
      content: "",
      tool_calls: [{ id: "rejected-project", name: "share_memory", args: { mode: "project" }, type: "tool_call" }],
    });
    const rejected = new ToolMessage({
      content: JSON.stringify({ error: "Choose a Room first." }),
      tool_call_id: "rejected-project",
      name: "share_memory",
      status: "error",
      additional_kwargs: { nautilo_tool_status: "error" },
    });

    const result = processStreamEvent(
      nodeEnd("projection_preflight", { messages: [proposed] }, { messages: [proposed, rejected] }),
      batcher,
      tracker,
      ctx,
    );

    expect(result.events).toEqual([]);
    expect(result.messagesToPersist).toEqual([rejected]);
  });

  test("skip suppression preserves a projection rejection for graph integrity", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;
    ctx.publishProjectionPreflightLifecycle = true;
    const proposed = new AIMessage({
      content: "",
      tool_calls: [{ id: "rejected-project", name: "share_memory", args: { mode: "project" }, type: "tool_call" }],
    });
    const rejected = new ToolMessage({
      content: JSON.stringify({ error: "Choose a Room first." }),
      tool_call_id: "rejected-project",
      name: "share_memory",
      status: "error",
      additional_kwargs: { nautilo_tool_status: "error" },
    });

    const result = processStreamEvent(
      nodeEnd("projection_preflight", { messages: [proposed] }, { messages: [proposed, rejected] }),
      batcher,
      tracker,
      ctx,
    );

    expect(result.events).toEqual([]);
    expect(result.messagesToPersist).toEqual([rejected]);
  });

  test("non-opted-in executor callers never publish projection lifecycle", () => {
    const proposed = new AIMessage({
      content: "",
      tool_calls: [{ id: "rejected-project", name: "share_memory", args: { sourceIds: ["private-source"] }, type: "tool_call" }],
    });
    const rejected = new ToolMessage({
      content: JSON.stringify({ error: "Choose a Room first." }),
      tool_call_id: "rejected-project",
      name: "share_memory",
      status: "error",
      additional_kwargs: { nautilo_tool_status: "error" },
    });

    const result = processStreamEvent(
      nodeEnd("projection_preflight", { messages: [proposed] }, { messages: [proposed, rejected] }),
      batcher,
      tracker,
      ctx,
    );

    expect(result.events).toEqual([]);
    expect(result.messagesToPersist).toEqual([rejected]);
  });

  test("skipFlag set → on_chat_model_stream emits zero events", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;

    const stream = processStreamEvent(tokenStreamEvent("fallback text"), batcher, tracker, ctx);
    expect(stream.events).toEqual([]);
    expect(stream.messagesToPersist).toEqual([]);
  });

  test("skipFlag set → agent on_chain_end drops pure-text AIMessage from persist", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;

    const human = new HumanMessage("ping");
    const ai = new AIMessage("fallback that should not persist");
    const end = processStreamEvent(
      nodeEnd("agent", { messages: [human] }, { messages: [human, ai] }),
      batcher,
      tracker,
      ctx,
    );
    expect(end.messagesToPersist).toEqual([]);
    expect(end.events.some((e) => e.type === "message.tokens")).toBe(false);
  });

  test("skipFlag set → tool-call AIMessage AND ToolMessage still persist (graph integrity)", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;

    const human = new HumanMessage("ping");
    const toolCallAi = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc-skip", name: "skip", args: {}, type: "tool_call" }],
    });
    const toolMsg = new ToolMessage({
      content: JSON.stringify({ skipped: true, reason: null }),
      tool_call_id: "tc-skip",
      name: "skip",
    });
    const end = processStreamEvent(
      nodeEnd(
        "tools",
        { messages: [human, toolCallAi] },
        { messages: [human, toolCallAi, toolMsg] },
      ),
      batcher,
      tracker,
      ctx,
    );
    expect(end.messagesToPersist.length).toBe(1);
    expect(end.messagesToPersist[0]).toBe(toolMsg);
  });

  test("skipFlag set → mixed delta drops pure-text AIMessage, keeps tool-call AIMessage", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;

    const human = new HumanMessage("ping");
    const aiText = new AIMessage("trailing fallback");
    const aiTool = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc-x", name: "skip", args: {}, type: "tool_call" }],
    });
    const end = processStreamEvent(
      nodeEnd(
        "agent",
        { messages: [human] },
        { messages: [human, aiText, aiTool] },
      ),
      batcher,
      tracker,
      ctx,
    );
    expect(end.messagesToPersist).toEqual([aiTool]);
  });

  test("no turnId on ctx → suppression is inert (legacy/background callers)", () => {
    getOrCreateAgentTurnContext(TURN_ID).skipFlag = true;
    const noTurnCtx: StreamProcessorContext = { jobId: "j-2" };

    const stream = processStreamEvent(tokenStreamEvent("hello"), batcher, tracker, noTurnCtx);
    expect(stream.events.some((e) => e.type === "message.tokens")).toBe(true);
  });
});

const AUTHOR_AGENT_ID = "agent-d300-test";

describe("processStreamEvent — D300 authorAgentId on assistant tokens", () => {
  let tracker: ToolCallTracker;
  let ctx: StreamProcessorContext;

  beforeEach(() => {
    _resetAgentTurnContextsForTests();
    tracker = new ToolCallTracker();
    ctx = { jobId: "j-d300", turnId: "turn-d300" };
  });

  afterEach(() => {
    _resetAgentTurnContextsForTests();
  });

  test("message.tokens carries authorAgentId when batcher is configured", () => {
    const batcher = new TokenBatcher({
      laneKey: "room:test",
      authorAgentId: AUTHOR_AGENT_ID,
      maxChars: 1,
      maxDelayMs: 1,
    });

    const stream = processStreamEvent(tokenStreamEvent("hi"), batcher, tracker, ctx);
    const tokenEvents = stream.events.filter((e) => e.type === "message.tokens");
    expect(tokenEvents.length).toBeGreaterThan(0);
    for (const event of tokenEvents) {
      if (event.type === "message.tokens") {
        expect(event.authorAgentId).toBe(AUTHOR_AGENT_ID);
      }
    }
  });

  test("message.tokens omits authorAgentId when batcher has none (legacy callers)", () => {
    const batcher = new TokenBatcher({ laneKey: "test", maxChars: 1, maxDelayMs: 1 });

    const stream = processStreamEvent(tokenStreamEvent("hi"), batcher, tracker, ctx);
    const tokenEvents = stream.events.filter((e) => e.type === "message.tokens");
    expect(tokenEvents.length).toBeGreaterThan(0);
    for (const event of tokenEvents) {
      if (event.type === "message.tokens") {
        expect(event.authorAgentId).toBeUndefined();
      }
    }
  });
});
