import { describe, expect, test } from "bun:test";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { transcriptToolNameForRow } from "../../src/store/transcript-tool-name";

describe("transcriptToolNameForRow", () => {
  test("returns trimmed name for ToolMessage", () => {
    expect(
      transcriptToolNameForRow(
        new ToolMessage({ content: "x", tool_call_id: "c1", name: "run_shell" }),
      ),
    ).toBe("run_shell");
  });

  test("returns null for non-tool messages", () => {
    expect(transcriptToolNameForRow(new HumanMessage("hi"))).toBeNull();
  });

  test("returns null when name missing or whitespace-only", () => {
    expect(
      transcriptToolNameForRow(new ToolMessage({ content: "x", tool_call_id: "c1", name: "" })),
    ).toBeNull();
    expect(
      transcriptToolNameForRow(new ToolMessage({ content: "x", tool_call_id: "c1", name: "  " })),
    ).toBeNull();
  });
});
