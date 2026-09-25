import { expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import { ModelOutputLimitError, modelResponseReachedOutputLimit } from "../../src/graph/model-output-limit";
import { toFriendlyError } from "../../src/utils/friendly-errors";
import type { NautiloState } from "../../src/agent/state";

for (const metadata of [
  { finish_reason: "length" },
  { stop_reason: "max_tokens" },
  { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
]) {
  test(`output limit ${JSON.stringify(metadata)} preserves partial output and stops tool execution`, () => {
    const message = new AIMessage({ content: "Partial answer", response_metadata: metadata,
      tool_calls: [{ id: "partial-call", name: "file", args: {} }] });
    const state = { messages: [message] } as unknown as NautiloState;
    expect(modelResponseReachedOutputLimit(message)).toBe(true);
    expect(() => modelOutputPreflightNode(state)).toThrow(ModelOutputLimitError);
    expect(state.messages).toEqual([message]);
    expect(toFriendlyError(new ModelOutputLimitError())).toMatchObject({
      category: "unknown", code: "MDL007", detailsForLog: "model_output_limit",
    });
    expect(toFriendlyError(new ModelOutputLimitError()).message).toContain("Ask it to continue");
  });
}
test("ordinary completion and unrelated incomplete reasons are not output limits", () => {
  for (const metadata of [{}, { finish_reason: "stop" }, { stop_reason: "end_turn" },
    { status: "incomplete", incomplete_details: { reason: "content_filter" } }]) {
    expect(modelResponseReachedOutputLimit(new AIMessage({ content: "Done", response_metadata: metadata }))).toBe(false);
  }
});
