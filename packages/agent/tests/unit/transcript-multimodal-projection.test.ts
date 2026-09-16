import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";

import { buildForegroundUserHumanMessage } from "../../src/chat/foreground-user-message";
import { visibleTranscriptContent } from "../../src/store/session-store";

describe("visible transcript multimodal projection", () => {
  test("keeps the image part for the model while persisting only human-authored text", () => {
    const message = buildForegroundUserHumanMessage({
      userText: "Can you see it?",
      attachmentTextBlocks: [],
      multimodalImages: [{
        type: "image",
        attachmentId: "image-1",
        filename: "screen.png",
        mimeType: "image/png",
        base64: "aGVsbG8=",
      }],
      modelId: "anthropic:claude-sonnet-4-6",
    });

    expect(Array.isArray(message.content)).toBe(true);
    const parts = message.content as Array<{ type?: string }>;
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
    expect(visibleTranscriptContent(message)).toBe("Can you see it?");
  });

  test("does not strip a literal [image] that a Human actually wrote", () => {
    const message = new HumanMessage({
      content: [
        { type: "text", text: "I literally typed [image]." },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    });

    expect(visibleTranscriptContent(message)).toBe("I literally typed [image].");
  });
});
