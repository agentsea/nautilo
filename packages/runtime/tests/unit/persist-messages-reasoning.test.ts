import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { sanitizeMessageForTranscript } from "../../src/executors/persist-messages";

describe("persist-messages reasoning sanitization", () => {
  test("reasoning-only AIMessage becomes empty content for transcript", () => {
    const msg = new AIMessage({
      content: [{ type: "reasoning", text: "do not persist me" }],
    });
    const sanitized = sanitizeMessageForTranscript(msg);
    expect(sanitized.content).toBe("");
  });

  test("mixed reasoning + text keeps only visible text blocks", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning", text: "internal" },
        { type: "text", text: "hello" },
      ],
    });
    const sanitized = sanitizeMessageForTranscript(msg);
    expect(Array.isArray(sanitized.content)).toBe(true);
    expect(JSON.stringify(sanitized.content)).not.toContain("internal");
    expect(JSON.stringify(sanitized.content)).toContain("hello");
  });
});
