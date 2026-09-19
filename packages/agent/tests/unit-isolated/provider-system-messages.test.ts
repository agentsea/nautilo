import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  collapseNonLeadingSystemMessages,
  projectSystemMessagesForProvider,
} from "../../src/utils/provider-system-messages";

function history() {
  const leading = new SystemMessage({
    id: "leading",
    content: "stable authority",
    additional_kwargs: { scope: "owner" },
    response_metadata: { source: "prepared" },
  });
  return [
    leading,
    new HumanMessage("act"),
    new AIMessage({ content: "", tool_calls: [{ id: "call-1", name: "browser_snapshot", args: {} }] }),
    new ToolMessage({ content: "snapshot", tool_call_id: "call-1" }),
    new SystemMessage("Inspect the completed tool result before continuing."),
    new HumanMessage("continue"),
  ];
}

describe("per-provider system-message projection", () => {
  test("preserves chronological late authority for direct OpenAI without mutation", () => {
    const source = history();
    const projected = projectSystemMessagesForProvider(source, "openai:gpt-5.6-sol");

    expect(projected).toEqual({ messages: source, collapsed: 0 });
    expect(projected.messages[4]).toBe(source[4]);
    expect(source[0]?.content).toBe("stable authority");
  });

  test("folds late authority for Anthropic fallback after a complete tool cycle", () => {
    const source = history();
    const projected = projectSystemMessagesForProvider(source, "anthropic:claude-sonnet-4-6");

    expect(projected.collapsed).toBe(1);
    expect(projected.messages.map((message) => message.constructor.name)).toEqual([
      "SystemMessage", "HumanMessage", "AIMessage", "ToolMessage", "HumanMessage",
    ]);
    expect(projected.messages[2]).toBe(source[2]);
    expect(projected.messages[3]).toBe(source[3]);
    expect(projected.messages[0]?.content).toContain(
      "[Additional system context recovered from history]\nInspect the completed tool result before continuing.",
    );
    expect(source).toHaveLength(6);
    expect(source[0]?.content).toBe("stable authority");
  });

  test("retains leading metadata and existing behavior for other routes", () => {
    const source = history();
    for (const modelId of ["google:gemini-2.5-pro", "openrouter:openai/gpt-5.6-sol"]) {
      const projected = projectSystemMessagesForProvider(source, modelId);
      const leading = projected.messages[0] as SystemMessage;
      expect(projected.collapsed).toBe(1);
      expect(leading.id).toBe("leading");
      expect(leading.additional_kwargs).toEqual({ scope: "owner" });
      expect(leading.response_metadata).toEqual({ source: "prepared" });
    }
  });

  test("exports the exact collapse operation for pre-model reuse", () => {
    const source = history();
    expect(collapseNonLeadingSystemMessages(source).collapsed).toBe(1);
  });
});
