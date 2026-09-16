import { describe, expect, test } from "bun:test";
import {
  resolveUnderlyingModelFamily,
  usesOpenAICompatibleChatTransport,
} from "../../src/providers/model-route";

describe("routed model family and transport", () => {
  test.each([
    ["openrouter:openai/gpt-5.5", "openai"],
    ["openrouter:anthropic/claude-sonnet-4.6", "anthropic"],
    ["openrouter:google/gemini-3.1-pro-preview", "google"],
    ["venice:openai-gpt-55-pro", "openai"],
    ["venice:claude-sonnet-4-6", "anthropic"],
    ["venice:gemini-3-1-pro-preview", "google"],
  ] as const)("resolves %s independently of its route", (id, family) => {
    expect(resolveUnderlyingModelFamily(id)).toBe(family);
  });

  test("recognizes routed providers using OpenAI-compatible chat transport", () => {
    expect(usesOpenAICompatibleChatTransport("openrouter:anthropic/claude-sonnet-4.6")).toBe(true);
    expect(usesOpenAICompatibleChatTransport("venice:gemini-3-1-pro-preview")).toBe(true);
    expect(usesOpenAICompatibleChatTransport("anthropic:claude-sonnet-4-6")).toBe(false);
  });
});
