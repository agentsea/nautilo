import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { projectOpenAIMultimodalToolResults } from "../../src/nodes/pre-model";

const pdfBlocks = [
  { type: "text", text: "PDF: report.pdf" },
  {
    type: "file",
    source_type: "base64",
    mime_type: "application/pdf",
    data: "JVBERi0xLjQ=",
    filename: "report.pdf",
  },
];

describe("OpenAI multimodal tool-result projection", () => {
  test("preserves the tool-call pair and follows it with a user-role PDF input", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call-pdf", name: "file", args: { command: "read" } }],
    });
    const tool = new ToolMessage({
      content: pdfBlocks,
      tool_call_id: "call-pdf",
      name: "file",
      additional_kwargs: { nautilo_tool_status: "success" },
    });

    const result = projectOpenAIMultimodalToolResults(
      [ai, tool],
      "openai:gpt-5.6-sol",
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(ai);
    expect(result[1]).toBeInstanceOf(ToolMessage);
    expect((result[1] as ToolMessage).tool_call_id).toBe("call-pdf");
    expect((result[1] as ToolMessage).content).toBe("PDF: report.pdf");
    expect((result[1] as ToolMessage).additional_kwargs["nautilo_tool_status"]).toBe("success");
    expect(result[2]).toBeInstanceOf(HumanMessage);
    expect((result[2] as HumanMessage).content).toEqual([
      { type: "text", text: "Attachments from tool call call-pdf (file). The tool result contains their text context." },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
        filename: "report.pdf",
      },
    ]);
    expect((result[2] as HumanMessage).additional_kwargs["nautilo_multimodal_tool_projection"]).toBe(true);
  });

  test("leaves non-OpenAI histories unchanged", () => {
    const tool = new ToolMessage({
      content: pdfBlocks,
      tool_call_id: "call-pdf",
      name: "file",
    });
    const messages = [tool];
    expect(projectOpenAIMultimodalToolResults(messages, "anthropic:claude-sonnet-4-6"))
      .toBe(messages);
  });

  test("does not resend a large screenshot result as user text or mutate durable evidence", () => {
    const text = JSON.stringify({ controls: Array.from({ length: 320 }, (_, id) => ({ id, label: `Control ${id}` })) });
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWxz" } };
    const tool = new ToolMessage({ id: "observation", name: "computer_observe", tool_call_id: "observe", content: [{ type: "text", text }, image], status: "error", response_metadata: { completion: "unknown" } });
    const before = JSON.stringify(tool);
    const projected = projectOpenAIMultimodalToolResults([tool], "openai:gpt-5.6-sol");
    expect(projected[0]!.content).toBe(text);
    expect(projected[0]!.id).toBe("observation");
    expect((projected[0] as ToolMessage).status).toBe("error");
    expect(projected[0]!.response_metadata).toEqual({ completion: "unknown" });
    expect(JSON.stringify(projected[1]!.content)).not.toContain("Control 319");
    expect(projected[1]!.content).toContainEqual(image);
    expect(JSON.stringify(tool)).toBe(before);
  });

  test("keeps parallel tool results adjacent before projecting their attachments", () => {
    const ai = new AIMessage({ content: "", tool_calls: [
      { id: "one", name: "file", args: {} }, { id: "two", name: "file", args: {} },
    ] });
    const one = new ToolMessage({ name: "file", tool_call_id: "one", content: pdfBlocks });
    const two = new ToolMessage({ name: "file", tool_call_id: "two", content: "Second result" });
    const next = new AIMessage("Read both results");
    const projected = projectOpenAIMultimodalToolResults([ai, one, two, next], "openai:gpt-5.6-sol");
    expect(projected.map(message => message.getType())).toEqual(["ai", "tool", "tool", "human", "ai"]);
    expect(projected[2]).toBe(two);
    expect(projected[4]).toBe(next);
  });

  test.each([
    "openrouter:anthropic/claude-sonnet-4.6",
    "venice:gemini-3-1-pro-preview",
  ])("projects multimodal tool results for %s's OpenAI-compatible route", (modelId) => {
    const tool = new ToolMessage({
      content: pdfBlocks,
      tool_call_id: "call-pdf",
      name: "file",
    });
    const result = projectOpenAIMultimodalToolResults([tool], modelId);
    expect(result).toHaveLength(2);
    expect(result[1]).toBeInstanceOf(HumanMessage);
  });
});
