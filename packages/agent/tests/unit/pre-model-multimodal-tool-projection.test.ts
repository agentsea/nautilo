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
      { type: "text", text: "PDF: report.pdf" },
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
