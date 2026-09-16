import { describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  hasProjectableStableSystemPrefix,
  modelUsesOpenAIExplicitPromptCache,
  projectPreparedMessagesForModelCache,
} from "../../src/utils/model-context-cache";

describe("per-attempt model context cache projection", () => {
  const stable = "stable system and tool guidance";
  const volatile = "\nvolatile turn context";

  test("adds the Anthropic breakpoint to a plain prepared system message", () => {
    const projected = projectPreparedMessagesForModelCache(
      [new SystemMessage(stable + volatile), new HumanMessage("hello")],
      "anthropic:claude-sonnet-4-6",
      stable.length,
    );

    expect(projected[0]?.content).toEqual([
      {
        type: "text",
        text: stable,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: volatile },
    ]);
  });

  test("projects the stable span into OpenAI's explicit Responses breakpoint", () => {
    const projected = projectPreparedMessagesForModelCache(
      [new SystemMessage(stable + volatile), new HumanMessage("hello")],
      "openai:gpt-5.6-luna",
      stable.length,
      { openAIExplicitPromptCache: true },
    );

    expect(projected[0]?.content).toEqual([
      {
        type: "input_text",
        text: stable,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
      { type: "input_text", text: volatile },
    ]);
    expect(
      (projected[0]?.content as Array<{ text: string }>).map((block) => block.text).join(""),
    ).toBe(stable + volatile);
  });

  test("leaves direct OpenAI on the prior shape when explicit mode is not enabled", () => {
    const messages = [new SystemMessage(stable + volatile), new HumanMessage("hello")];
    expect(
      projectPreparedMessagesForModelCache(
        messages,
        "openai:gpt-5.6-luna",
        stable.length,
      ),
    ).toBe(messages);
  });

  test("removes an earlier provider projection when fallback selects Google", () => {
    const prepared = new SystemMessage({
      content: [
        {
          type: "text",
          text: stable,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: volatile },
      ],
    });
    const projected = projectPreparedMessagesForModelCache(
      [prepared, new HumanMessage("hello")],
      "google:gemini-2.5-flash",
      stable.length,
    );

    expect(projected[0]?.content).toBe(stable + volatile);
  });

  test("reprojects an OpenAI input_text shape cleanly when fallback selects Anthropic", () => {
    const openAIProjected = projectPreparedMessagesForModelCache(
      [new SystemMessage(stable + volatile), new HumanMessage("hello")],
      "openai:gpt-5.6-luna",
      stable.length,
      { openAIExplicitPromptCache: true },
    );
    const anthropicProjected = projectPreparedMessagesForModelCache(
      openAIProjected,
      "anthropic:claude-sonnet-4-6",
      stable.length,
    );

    expect(anthropicProjected[0]?.content).toEqual([
      {
        type: "text",
        text: stable,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: volatile },
    ]);
  });

  test("leaves messages unchanged when the supplied boundary is invalid", () => {
    const messages = [new SystemMessage(stable), new HumanMessage("hello")];
    expect(
      projectPreparedMessagesForModelCache(messages, "anthropic:claude-sonnet-4-6", 0),
    ).toBe(messages);
    expect(hasProjectableStableSystemPrefix(messages, 0)).toBe(false);
  });

  test("limits OpenAI explicit projection to direct GPT-5.6 routes", () => {
    expect(modelUsesOpenAIExplicitPromptCache("openai:gpt-5.6-sol")).toBe(true);
    expect(modelUsesOpenAIExplicitPromptCache("openrouter:openai/gpt-5.6-sol")).toBe(false);
    expect(modelUsesOpenAIExplicitPromptCache("openai:gpt-5.5-2026-04-23")).toBe(false);
  });
});
