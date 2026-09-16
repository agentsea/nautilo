import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildOpenRouterCreateModelOptions,
  withGatewayErrorLabel,
} from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";
import { classifyErrorSimple } from "../../src/utils/errors";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_TITLE",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("createUniversalModel OpenRouter routing", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
  });

  test("requires OPENROUTER_API_KEY and never falls back to OPENAI_API_KEY", async () => {
    process.env["OPENAI_API_KEY"] = "sk-proj-openai-key-that-must-not-be-used";

    expect(() => buildOpenRouterCreateModelOptions("openrouter:openai/gpt-5.4-mini", {})).toThrow(
      "OpenRouter credential is not configured",
    );
  });

  test("routes OpenRouter models through OpenAI-compatible base URL with attribution headers", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-test-key-for-routing";
    process.env["OPENROUTER_HTTP_REFERER"] = "https://nautilo.local";
    process.env["OPENROUTER_TITLE"] = "Nautilo Test";

    expect(buildOpenRouterCreateModelOptions("openrouter:anthropic/claude-sonnet-4.6", {})).toEqual({
      modelId: "openrouter:anthropic/claude-sonnet-4.6",
      apiKey: "sk-or-v1-test-key-for-routing",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://nautilo.local",
        "X-OpenRouter-Title": "Nautilo Test",
      },
    });
  });

  test("explicit OpenRouter apiKey option wins over environment", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-env-key";

    expect(buildOpenRouterCreateModelOptions("openrouter:openai/gpt-5.4-mini", {
      apiKey: "sk-or-v1-explicit-key",
    }).apiKey).toBe("sk-or-v1-explicit-key");
  });

  test("sends only a valid opaque Room UUID as session_id", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-env-key";
    const roomId = "22222222-2222-4222-8222-222222222222";

    expect(buildOpenRouterCreateModelOptions("openrouter:deepseek/deepseek-v4-pro", {
      openRouterSessionId: roomId,
    }).modelKwargs).toEqual({ session_id: roomId });
    expect(buildOpenRouterCreateModelOptions("openrouter:deepseek/deepseek-v4-pro", {
      openRouterSessionId: "room title or other mutable content",
    }).modelKwargs).toBeUndefined();
  });

  test("drops invalid attribution header values instead of forwarding raw config", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-env-key";

    expect(buildOpenRouterCreateModelOptions("openrouter:openai/gpt-5.4-mini", {
      openRouterReferer: "https://nautilo.local\r\nX-Bad: yes",
      openRouterTitle: "Nautilo\nBad",
    })).toEqual({
      modelId: "openrouter:openai/gpt-5.4-mini",
      apiKey: "sk-or-v1-env-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });
});

describe("OpenRouter error labeling", () => {
  test("prefixes invoke errors with OpenRouter label", () => {
    const model: ChatModel = {
      invoke: async () => {
        throw new Error("402 insufficient credits");
      },
    };

    expect(withGatewayErrorLabel(model, "OpenRouter").invoke([])).rejects.toThrow(
      "OpenRouter: 402 insufficient credits",
    );
  });

  test("preserves HTTP status fields when labeling OpenRouter errors", async () => {
    const model: ChatModel = {
      invoke: async () => {
        const error = new Error("rate limited") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };

    try {
      await withGatewayErrorLabel(model, "OpenRouter").invoke([]);
      throw new Error("expected invoke to throw");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(429);
      expect(classifyErrorSimple(error)).toBe("retriable");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("OpenRouter: rate limited");
    }
  });

  test("preserves labeling through tool binding", async () => {
    const bound: ChatModel = { invoke: async () => { throw new Error("tool request failed"); } };
    const model: ChatModel = { invoke: async () => "unused", bindTools: () => bound };
    const wrapped = withGatewayErrorLabel(model, "OpenRouter");
    expect(wrapped.bindTools?.([]).invoke([])).rejects.toThrow("OpenRouter: tool request failed");
  });

  test("labels stream failures and preserves retriable status", async () => {
    const model: ChatModel = {
      invoke: async () => "unused",
      stream: async function* () {
        yield "partial";
        const error = Object.assign(new Error("stream rate limited"), { status: 429 });
        throw error;
      },
    };
    const stream = withGatewayErrorLabel(model, "OpenRouter").stream?.([]);
    if (!stream) throw new Error("expected wrapped stream");
    try {
      for await (const _chunk of await stream) { /* consume until the provider fails */ }
      throw new Error("expected stream failure");
    } catch (error) {
      expect((error as Error).message).toBe("OpenRouter: stream rate limited");
      expect((error as { status?: number }).status).toBe(429);
      expect(classifyErrorSimple(error)).toBe("retriable");
    }
  });
});
