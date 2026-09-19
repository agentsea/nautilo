import { describe, expect, test } from "bun:test";
import {
  hasRunnableChatProviderCredentials,
  modelHasRunnableCredentials,
} from "../../src/chat/model-runtime-credentials";

describe("hasRunnableChatProviderCredentials", () => {
  test("accepts credentials for every chat provider implemented by the runtime", () => {
    const environments: NodeJS.ProcessEnv[] = [
      { ANTHROPIC_API_KEY: "x" },
      { OPENAI_API_KEY: "x" },
      { OPENROUTER_API_KEY: "x" },
      {
        NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
        NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1",
      },
      {
        NAUTILO_GATEWAY_API_KEY: "x",
        NAUTILO_GATEWAY_BASE_URL: "https://example.com/v1",
      },
      { GOOGLE_API_KEY: "x" },
      { GOOGLE_GENERATIVE_AI_API_KEY: "x" },
      { GEMINI_API_KEY: "x" },
      { XAI_API_KEY: "x" },
      { FIREWORKS_API_KEY: "x" },
      { TOGETHER_API_KEY: "x" },
      { VENICE_API_KEY: "x" },
    ];

    for (const env of environments) {
      expect(hasRunnableChatProviderCredentials(env)).toBe(true);
    }
  });

  test("rejects empty, partial gateway, and non-chat credentials", () => {
    expect(hasRunnableChatProviderCredentials({})).toBe(false);
    expect(
      hasRunnableChatProviderCredentials({
        NAUTILO_GATEWAY_API_KEY: "x",
      }),
    ).toBe(false);
    expect(
      hasRunnableChatProviderCredentials({
        OPENROUTER_API_KEY: "  ",
        ELEVENLABS_API_KEY: "voice-only",
        TAVILY_API_KEY: "search-only",
      }),
    ).toBe(false);
  });
});

describe("modelHasRunnableCredentials", () => {
  test("openrouter requires OPENROUTER_API_KEY", () => {
    expect(
      modelHasRunnableCredentials("openrouter:anthropic/claude-sonnet-4", {
        ...process.env,
        OPENROUTER_API_KEY: "",
      }),
    ).toBe(false);
    expect(
      modelHasRunnableCredentials("openrouter:anthropic/claude-sonnet-4", {
        ...process.env,
        OPENROUTER_API_KEY: "sk-test",
      }),
    ).toBe(true);
  });

  test("managed Gateway admits signed OpenRouter routes and malformed config blocks BYOK", () => {
    expect(modelHasRunnableCredentials("openrouter:anthropic/claude-sonnet-4", {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "http://localhost:4010/v1",
    })).toBe(true);
    expect(modelHasRunnableCredentials("openrouter:anthropic/claude-sonnet-4", {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      OPENROUTER_API_KEY: "sk-or-v1-direct-must-not-be-used",
    })).toBe(false);
  });

  test("gateway requires key and base URL", () => {
    expect(
      modelHasRunnableCredentials("gateway:some-model", {
        NAUTILO_GATEWAY_API_KEY: "x",
        NAUTILO_GATEWAY_BASE_URL: "",
      }),
    ).toBe(false);
    expect(
      modelHasRunnableCredentials("gateway:some-model", {
        NAUTILO_GATEWAY_API_KEY: "x",
        NAUTILO_GATEWAY_BASE_URL: "https://example.com/v1",
      }),
    ).toBe(true);
  });

  test("unknown explicit prefixes fail closed", () => {
    expect(
      modelHasRunnableCredentials("newprovider:vision-model", {
        OPENAI_API_KEY: "x",
        ANTHROPIC_API_KEY: "x",
      }),
    ).toBe(false);
  });

  test("D429 Phase 1 — venice requires VENICE_API_KEY (mirrors createUniversalModel venice branch)", () => {
    expect(
      modelHasRunnableCredentials("venice:zai-org-glm-5-1", {
        VENICE_API_KEY: "",
        OPENAI_API_KEY: "x",
      }),
    ).toBe(false);
    expect(
      modelHasRunnableCredentials("venice:zai-org-glm-5-1", {
        VENICE_API_KEY: "vk-test",
      }),
    ).toBe(true);
  });
});
