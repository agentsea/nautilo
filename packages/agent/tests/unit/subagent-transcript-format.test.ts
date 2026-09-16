import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  formatSubagentTranscriptForParent,
  messageContentToPlainString,
} from "../../src/subagents/scope-subagent/run";

describe("subagent transcript for parent (M084)", () => {
  test("messageContentToPlainString handles OpenAI-style text blocks", () => {
    expect(
      messageContentToPlainString([{ type: "text", text: "hello" }]),
    ).toBe("hello");
    expect(
      messageContentToPlainString([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  test("formatSubagentTranscriptForParent includes user, assistant (blocks), and tool", () => {
    const messages = [
      new HumanMessage("Brief here"),
      new AIMessage({
        content: [{ type: "text", text: "Thinking out loud" }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            type: "tool_call",
            id: "c1",
            name: "discover_tools",
            args: { query: "x" },
          },
        ],
      }),
      new ToolMessage({
        content: "tool output line",
        tool_call_id: "c1",
        name: "discover_tools",
      }),
      new AIMessage({
        content: [{ type: "text", text: "Final answer for parent" }],
      }),
    ];
    const out = formatSubagentTranscriptForParent(messages);
    expect(out).toContain("full transcript for parent model");
    expect(out).toContain("[user]");
    expect(out).toContain("Brief here");
    expect(out).toContain("[assistant]");
    expect(out).toContain("Thinking out loud");
    expect(out).toContain("tool_calls requested: discover_tools");
    expect(out).toContain("[tool:discover_tools]");
    expect(out).toContain("tool output line");
    expect(out).toContain("Final answer for parent");
  });
});
