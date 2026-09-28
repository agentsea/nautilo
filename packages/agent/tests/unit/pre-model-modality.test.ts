import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { sanitizeImagesForModel } from "../../src/nodes/pre-model";

describe("pre-model modality sanitization", () => {
  test("strips historical image parts for text-only models without mutating source history", () => {
    const historical = new HumanMessage({
      content: [
        { type: "text", text: "Earlier image:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
    const current = new HumanMessage("continue in text");
    const messages = [historical, new AIMessage("noted"), current];

    const result = sanitizeImagesForModel(messages, "fireworks:accounts/fireworks/models/minimax-m2p7");

    expect(result.stripped).toBe(1);
    expect(messages[0]).toBe(historical);
    expect((historical.content as Array<{ type: string }>)[1]?.type).toBe("image_url");
    expect(result.messages[0]).not.toBe(historical);
    expect(JSON.stringify(result.messages[0]!.content)).toContain("Historical image omitted");
  });

  test("blocks current-turn images for text-only models", () => {
    const current = new HumanMessage({
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });

    expect(() => sanitizeImagesForModel([current], "fireworks:accounts/fireworks/models/minimax-m2p7")).toThrow(
      /does not support image/,
    );
    expect(() => sanitizeImagesForModel([current], "fireworks:accounts/fireworks/models/glm-5p3")).toThrow(
      /does not support image/,
    );
  });

  test("leaves images intact for vision-capable models", () => {
    const current = new HumanMessage({
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });

    const result = sanitizeImagesForModel([current], "anthropic:claude-sonnet-4-6");

    expect(result.stripped).toBe(0);
    expect(result.messages[0]).toBe(current);
  });

  test("leaves images intact for Fireworks Gemma 4 (multimodal)", () => {
    const current = new HumanMessage({
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });

    const result = sanitizeImagesForModel([current], "fireworks:accounts/fireworks/models/gemma-4-31b-it");

    expect(result.stripped).toBe(0);
    expect(result.messages[0]).toBe(current);
  });

  test("leaves images intact for Fireworks MiniMax M3 (multimodal)", () => {
    const current = new HumanMessage({
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });

    const result = sanitizeImagesForModel([current], "fireworks:accounts/fireworks/models/minimax-m3");

    expect(result.stripped).toBe(0);
    expect(result.messages[0]).toBe(current);
  });
});
