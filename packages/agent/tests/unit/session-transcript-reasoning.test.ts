import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { sanitizeMessageForTranscript, transcriptMetadataForMessage, visibleTranscriptContent } from "../../src/store/session-store";

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

  test("persists only a compact marker for delegated browser observations", () => {
    const content = JSON.stringify({ observation: { snapshot: "x".repeat(20_000) } });
    const delegated = new ToolMessage({
      content,
      tool_call_id: "browser-choice:one",
      name: "browser_snapshot",
      status: "success",
      additional_kwargs: {
        nautilo_tool_status: "success",
        nautilo_browser_decision_observation: true,
      },
    });
    const ordinary = new ToolMessage({
      content,
      tool_call_id: "ordinary",
      name: "browser_snapshot",
      status: "success",
      additional_kwargs: { nautilo_tool_status: "success" },
    });

    expect(transcriptMetadataForMessage(delegated, {})).toEqual({
      nautilo_browser_decision_observation: true,
      nautilo_tool_result: { toolCallId: "browser-choice:one", toolStatus: "success" },
    });
    expect(sanitizeMessageForTranscript(delegated)).toBe(delegated);
    expect(visibleTranscriptContent(delegated)).toContain("delegatedObservationOmitted");
    expect(visibleTranscriptContent(delegated).length).toBeLessThan(200);
    expect(visibleTranscriptContent(ordinary)).toBe(content);
    const connected = new ToolMessage({
      content: JSON.stringify({ ok: true, execution: "executed", observation: { snapshot: "x".repeat(20_000) } }),
      tool_call_id: "browser-choice:connected",
      name: "control_connected_web_operation",
      status: "success",
      additional_kwargs: { nautilo_browser_decision_observation: true },
    });
    expect(visibleTranscriptContent(connected)).toContain('"execution":"executed"');
    expect(visibleTranscriptContent(connected)).not.toContain("x".repeat(20_000));
    expect(transcriptMetadataForMessage(ordinary, {})).toEqual({
      nautilo_tool_result: { toolCallId: "ordinary", toolStatus: "success" },
    });
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
