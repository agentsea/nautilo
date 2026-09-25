import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage, type BaseMessageLike } from "@langchain/core/messages";
import {
  createOpenAI,
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
  "openrouter:moonshotai/kimi-k2.6",
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

  test("resolves the stable Fireworks DeepSeek V4 Flash alias to its replacement", async () => {
    expect(resolveFireworksWireModel("accounts/fireworks/models/deepseek-v4-flash")).toBe(
      "accounts/fireworks/models/deepseek-v4p1-flash",
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
      "accounts/fireworks/models/deepseek-v4p1-flash",
    );
  });

  test("managed OpenRouter options reach the SDK retry and redirect controls", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:moonshotai/kimi-k2.6",
      apiKey: `ngw_${"a".repeat(43)}`,
      baseUrl: "https://gateway.qa.example/v1",
      maxRetries: 0,
      forbidRedirects: true,
      maxTokens: 1024,
    });
    const sdk = llm as unknown as {
      caller: { maxRetries: number };
      clientConfig: { baseURL?: string; fetch?: typeof fetch };
    };
    expect(sdk.caller.maxRetries).toBe(0);
    expect(sdk.clientConfig.baseURL).toBe("https://gateway.qa.example/v1");
    expect(sdk.clientConfig.fetch).toBeFunction();

    const originalFetch = globalThis.fetch;
    let redirect: NonNullable<Parameters<typeof fetch>[1]>["redirect"];
    globalThis.fetch = (async (_input, init) => {
      redirect = init?.redirect;
      return new Response("", { status: 204 });
    }) as typeof fetch;
    try {
      await sdk.clientConfig.fetch?.("https://gateway.qa.example/v1/chat/completions", {
        redirect: "follow",
      });
      expect(redirect).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("managed OpenRouter SDK invocation sends one credentialed request without HTTP retries", async () => {
    const apiKey = `ngw_${"b".repeat(43)}`;
    const llm = await createOpenAI({
      modelId: "openrouter:moonshotai/kimi-k2.6",
      apiKey,
      baseUrl: "https://gateway.qa.example/v1",
      maxRetries: 0,
      forbidRedirects: true,
      maxTokens: 1024,
    });
    const originalFetch = globalThis.fetch;

    try {
      for (const status of [429, 502]) {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (input, init) => {
          requests.push({
            url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            ...(init === undefined ? {} : { init }),
          });
          return Response.json(
            { error: { message: `synthetic ${status}`, type: "gateway_test_error" } },
            { status },
          );
        }) as typeof fetch;

        const caught: unknown = await llm.invoke([new HumanMessage("hello")])
          .catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(Error);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("https://gateway.qa.example/v1/chat/completions");
        expect(requests[0]?.init?.redirect).toBe("error");
        expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("supervised wrapper timeout contract", () => {
  test("null omits the wrapper timeout while ordinary utility callers retain 120s", async () => {
    const fields: Record<string, unknown>[] = [];
    const dependencies = { createClient: (next: Record<string, unknown>) => { fields.push(next); return model(); } };
    await createTogetherWithDependencies({ modelId: "together:test-model", timeoutMs: null }, dependencies);
    await createTogetherWithDependencies({ modelId: "together:test-model" }, dependencies);

    expect(fields[0]).not.toHaveProperty("timeout");
    expect(fields[1]?.["timeout"]).toBe(120_000);
  });
});
