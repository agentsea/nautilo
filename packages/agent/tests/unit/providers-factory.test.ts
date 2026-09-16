import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessageLike } from "@langchain/core/messages";
import {
  createFireworks,
  createTogetherWithDependencies,
  resolveFireworksWireModel,
  stripProviderPrefix,
} from "../../src/providers/factory";
import type { ChatModel } from "../../src/providers/types";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => activateModelCatalogForTests([
  "together:test-model",
  "fireworks:accounts/fireworks/models/deepseek-v4-flash",
]));
afterAll(() => resetRuntimeModelCatalog());

function model(): ChatModel<BaseMessageLike, unknown> {
  return { invoke: async () => "ok", bindTools: () => model() };
}

describe("provider factory helpers", () => {
  test("strips direct-provider prefixes without changing model slug bodies", () => {
    expect(stripProviderPrefix("openai:gpt-5")).toBe("gpt-5");
    expect(stripProviderPrefix("anthropic:claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(stripProviderPrefix("google:gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(stripProviderPrefix("xai:grok-4")).toBe("grok-4");
    expect(stripProviderPrefix("fireworks:accounts/fireworks/models/kimi-k2p5")).toBe("accounts/fireworks/models/kimi-k2p5");
    expect(stripProviderPrefix("together:meta-llama/Llama-4-Maverick")).toBe("meta-llama/Llama-4-Maverick");
  });

  test("strips only the outer OpenRouter prefix", () => {
    expect(stripProviderPrefix("openrouter:openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
    expect(stripProviderPrefix("openrouter:anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(stripProviderPrefix("openrouter:moonshotai/kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
  });

  test("strips only the outer generic gateway prefix", () => {
    expect(stripProviderPrefix("gateway:openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    expect(stripProviderPrefix("gateway:local-model")).toBe("local-model");
  });

  test("resolves the stable Fireworks DeepSeek V4 Flash alias to its deployed model", async () => {
    expect(resolveFireworksWireModel("accounts/fireworks/models/deepseek-v4-flash")).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );
    expect(resolveFireworksWireModel("accounts/fireworks/models/deepseek-v4-flash-0731")).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );

    const llm = await createFireworks({
      modelId: "fireworks:accounts/fireworks/models/deepseek-v4-flash",
      apiKey: "test-key",
      maxTokens: 8192,
    });
    expect((llm as unknown as Record<string, unknown>)["model"]).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );
  });
});

describe("D563 supervised wrapper timeout contract", () => {
  test("null omits the wrapper timeout while ordinary utility callers retain 120s", async () => {
    const fields: Record<string, unknown>[] = [];
    const dependencies = { createClient: (next: Record<string, unknown>) => { fields.push(next); return model(); } };
    await createTogetherWithDependencies({ modelId: "together:test-model", timeoutMs: null }, dependencies);
    await createTogetherWithDependencies({ modelId: "together:test-model" }, dependencies);

    expect(fields[0]).not.toHaveProperty("timeout");
    expect(fields[1]?.["timeout"]).toBe(120_000);
  });
});
