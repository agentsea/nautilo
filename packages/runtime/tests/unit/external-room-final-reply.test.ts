import { expect, test } from "bun:test";
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { confirmedExternalRoomFinalReply, externalRoomFinalReplyText, processStreamEvent } from "../../src/executors/langgraph-executor";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";

const reference = { turnId: "fixture-turn", agentId: "fixture-agent" };
const visible = "Synthetic visible reply";
function checkpoint(final: BaseMessage) { return { tasks: [], values: { ...reference, messages: [final] } }; }
function harvest(final: BaseMessage): BaseMessage | null {
  const human = new HumanMessage("Synthetic input");
  const { messagesToPersist } = processStreamEvent({ event: "on_chain_end", name: "agent",
    data: { input: { messages: [human] }, output: { messages: [human, final] } } },
  new TokenBatcher({ laneKey: "fixture" }), new ToolCallTracker());
  expect(messagesToPersist).toHaveLength(1);
  return messagesToPersist.at(-1)!;
}

test("external completion compares canonical visible text from real stream harvesting and checkpoint representations", () => {
  for (const final of [
    new AIMessage(visible), new AIMessageChunk(visible),
    new AIMessage({ content: [{ type: "text", text: visible }] }),
    new AIMessageChunk({ content: [{ type: "text", text: visible }] }),
    new AIMessage({ content: [{ type: "reasoning", text: "Never publish private reasoning" },
      { type: "thinking", thinking: "Never publish private thinking" }, { type: "redacted_thinking", data: "hidden" },
      { type: "text", text: "Synthetic " }, { type: "text", text: "visible reply" }] }),
  ]) {
    const candidate = harvest(final);
    expect(externalRoomFinalReplyText(candidate)).toBe(visible);
    expect(confirmedExternalRoomFinalReply({ checkpoint: checkpoint(final), reference, candidate,
      signal: new AbortController().signal })).toBe(visible);
  }
});

test("unknown, malformed, media and reasoning-only content cannot publish a partial reply", () => {
  for (const content of [
    [{ type: "text", text: visible }, { type: "image_url", image_url: { url: "https://example.com/fixture.png" } }],
    [{ type: "text", text: visible }, { type: "unknown", text: "Unsupported content" }],
    [{ type: "text", text: visible }, { type: "text", text: 42 }],
    [{ type: "reasoning", text: "Private reasoning" }],
    [{ type: "text", text: "  " }], [],
  ]) {
    const final = new AIMessage({ content: content as AIMessage["content"] });
    expect(externalRoomFinalReplyText(final)).toBeNull();
    expect(() => confirmedExternalRoomFinalReply({ checkpoint: checkpoint(final), reference, candidate: harvest(final),
      signal: new AbortController().signal })).toThrow("external_room_final_reply_unavailable");
  }
});

test("final reply still requires exact turn, Genie, terminal checkpoint and current harvested tool-free AI text", () => {
  const final = new AIMessage({ content: [{ type: "text", text: visible }] });
  const base = { checkpoint: checkpoint(final), reference, candidate: harvest(final), signal: new AbortController().signal };
  const toolCall = new AIMessage({ content: visible, tool_calls: [{ name: "forbidden", args: {}, id: "fixture-tool" }] });
  for (const input of [
    { ...base, candidate: null },
    { ...base, candidate: new AIMessage("Different visible text") },
    { ...base, candidate: toolCall },
    { ...base, candidate: new HumanMessage(visible) },
    { ...base, checkpoint: checkpoint(toolCall) },
    { ...base, checkpoint: checkpoint(new HumanMessage(visible)) },
    { ...base, reference: { ...reference, turnId: "other-turn" } },
    { ...base, reference: { ...reference, agentId: "other-agent" } },
    { ...base, checkpoint: { ...base.checkpoint, tasks: [{ interrupts: [{}] }] } },
    { ...base, checkpoint: { values: base.checkpoint.values } },
    { ...base, checkpoint: undefined },
  ]) expect(() => confirmedExternalRoomFinalReply(input)).toThrow("external_room_final_reply_unavailable");
  const aborted = new AbortController(); aborted.abort(new Error("fixture-aborted"));
  expect(() => confirmedExternalRoomFinalReply({ ...base, signal: aborted.signal })).toThrow("fixture-aborted");
});
