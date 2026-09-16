import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { sanitizeMessageForTranscript, transcriptMetadataForMessage } from "../../src/store/session-store";

describe("session transcript reasoning sanitization", () => {
  test("internal supervision tags tool audit without hiding the Human or final answer", () => {
    const metadata = { originatedBy: "connected_web_operation", operationId: "op-1", controlEpoch: 1 };
    const options = { internalToolMetadata: metadata };
    const call = new AIMessage({ content: "Inspecting.", tool_calls: [{ id: "tc1", name: "manage_connected_web_operation", args: { operation: "inspect" } }] });
    const result = new ToolMessage({ content: '{"lifecycle":"running"}', tool_call_id: "tc1", name: "manage_connected_web_operation" });
    expect(transcriptMetadataForMessage(call, options)).toEqual(metadata);
    expect(transcriptMetadataForMessage(result, options)).toEqual({ ...metadata, nautilo_tool_result: { toolCallId: "tc1" } });
    expect(transcriptMetadataForMessage(new AIMessage("Here is the completed answer."), options)).toBeNull();
    expect(transcriptMetadataForMessage(new HumanMessage("What happened?"), options)).toBeNull();
    expect(transcriptMetadataForMessage(call, {})).toBeNull();
    expect(transcriptMetadataForMessage(new HumanMessage("internal wake"), { metadata })).toEqual(metadata);
  });
  test("strips reasoning blocks from AIMessage content arrays", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning", text: "hidden chain of thought" },
        { type: "text", text: "visible answer" },
      ],
    });
    const sanitized = sanitizeMessageForTranscript(msg);
    expect(Array.isArray(sanitized.content)).toBe(true);
    expect((sanitized.content as unknown[]).length).toBe(1);
    expect((sanitized.content as Array<{ type?: string; text?: string }>)[0]?.type).toBe("text");
  });

  test("preserves tool-call rows when reasoning is the only text block", () => {
    const msg = new AIMessage({
      content: [{ type: "reasoning", text: "planning tool use" }],
      tool_calls: [{ id: "tc1", name: "search", args: { q: "x" } }],
    });
    const sanitized = sanitizeMessageForTranscript(msg);
    expect(AIMessage.isInstance(sanitized)).toBe(true);
    expect((sanitized as AIMessage).tool_calls?.length).toBe(1);
    expect(sanitized.content).toBe("");
  });
});
