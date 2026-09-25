import { expect, test } from "bun:test";
import { processStreamEvent } from "../../src/executors/langgraph-executor";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";
import { SentenceDetector } from "../../src/utils/sentence-detector";
import { bindModelAttemptProgressSinkByKey, _resetAgentTurnContextsForTests } from "@nautilo/agent";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";

test("private decisions report progress but never enter chat, speech or persistence", () => {
  _resetAgentTurnContextsForTests();
  const progress: string[] = [];
  const context = { turnContextId: "fixture::selector" };
  bindModelAttemptProgressSinkByKey(context.turnContextId, {
    attemptId: "private-attempt", reportMeaningfulProgress: id => { progress.push(id); return true; },
  });
  const tokens = new TokenBatcher({ laneKey: "app:fixture", maxChars: 1 });
  const speech = new SentenceDetector({ leadMinChars: 0 });
  const tracker = new ToolCallTracker();
  const result = processStreamEvent({ event: "on_chat_model_stream",
    metadata: { model_attempt_id: "private-attempt", nautilo_output_visibility: "internal_decision" },
    data: { chunk: { content: "a12_181. completion_ready." } },
  }, tokens, tracker, context, speech);
  tokens.completeMessage(); speech.complete();
  expect(result.events).toEqual([]);
  expect(result.messagesToPersist).toEqual([]);
  expect(tokens.drain()).toEqual([]);
  expect(speech.drain()).toEqual([]);
  expect(progress).toEqual(["private-attempt"]);
  const visible = processStreamEvent({ event: "on_chat_model_stream",
    data: { chunk: { content: "Your document is ready. " } },
  }, tokens, tracker, context, speech);
  tokens.completeMessage(); speech.complete();
  expect(JSON.stringify([...visible.events, ...tokens.drain(), ...speech.drain()])).toContain("Your document is ready.");
  _resetAgentTurnContextsForTests();
});

test("nested model events carry private metadata without hiding later Genie prose", async () => {
  const selector = new FakeListChatModel({ responses: ["a12_181"] });
  const genie = new FakeListChatModel({ responses: ["Document ready."] });
  const graph = RunnableLambda.from(async () => {
    await selector.invoke("Select", { metadata: { nautilo_output_visibility: "internal_decision" } });
    return genie.invoke("Report");
  });
  const tokens = new TokenBatcher({ laneKey: "app:fixture", maxChars: 1 });
  const tracker = new ToolCallTracker();
  const output: unknown[] = [];
  let privateChunks = 0;
  for await (const event of graph.streamEvents("start", { version: "v2" })) {
    if (event.event !== "on_chat_model_stream") continue;
    if (event.metadata["nautilo_output_visibility"] === "internal_decision") privateChunks++;
    output.push(...processStreamEvent(event, tokens, tracker).events, ...tokens.drain());
  }
  tokens.completeMessage(); output.push(...tokens.drain());
  expect(privateChunks).toBeGreaterThan(0);
  const visible = output.map(event => (event as { content?: string }).content ?? "").join("");
  expect(visible).toBe("Document ready.");
});
