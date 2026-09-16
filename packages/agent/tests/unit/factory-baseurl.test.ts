import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  createOpenAI,
  createAnthropic,
  createAnthropicWithLongContext,
  createFireworks,
  createTogether,
} from "../../src/providers/factory";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => {
  await activateModelCatalogForTests([
    "gateway:test-model",
    "together:test-model",
  ]);
});

afterAll(() => resetRuntimeModelCatalog());

// Regression: `@langchain/openai` only forwards `configuration.baseURL` into
// the underlying OpenAI SDK client. Passing `baseURL` at the top level was
// silently dropped, causing Venice / OpenRouter / Gateway / Together
// requests to be misrouted to `https://api.openai.com/v1`.

function getBaseURL(llm: unknown): string | undefined {
  const cfg = (llm as { clientConfig?: { baseURL?: string } }).clientConfig;
  return cfg?.baseURL ? String(cfg.baseURL) : undefined;
}

function getApiUrl(llm: unknown): string | undefined {
  const v = (llm as { apiUrl?: string }).apiUrl;
  return v ? String(v) : undefined;
}

function hasInvoke(llm: unknown): boolean {
  return typeof (llm as { invoke?: unknown }).invoke === "function";
}

describe("factory baseURL routing — ChatOpenAI-based providers", () => {
  it("routes Venice baseUrl into the OpenAI client", async () => {
    const llm = await createOpenAI({
      modelId: "venice:zai-org-glm-5-2",
      apiKey: "test-key",
      baseUrl: "https://api.venice.ai/api/v1",
    });
    expect(getBaseURL(llm)).toContain("api.venice.ai");
  });

  it("routes OpenRouter baseUrl into the OpenAI client", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:openai/gpt-5.5",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(getBaseURL(llm)).toContain("openrouter.ai");
  });

  it("routes a custom Gateway baseUrl into the OpenAI client", async () => {
    const llm = await createOpenAI({
      modelId: "gateway:test-model",
      apiKey: "test-key",
      baseUrl: "https://gateway.example.com/v1",
    });
    expect(getBaseURL(llm)).toContain("gateway.example.com");
  });

  it("does NOT misroute to api.openai.com when baseUrl is provided", async () => {
    const llm = await createOpenAI({
      modelId: "venice:zai-org-glm-5-2",
      apiKey: "test-key",
      baseUrl: "https://api.venice.ai/api/v1",
    });
    expect(getBaseURL(llm) ?? "").not.toContain("api.openai.com");
  });

  it("leaves baseURL undefined when no baseUrl is provided (default OpenAI)", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.6-luna",
      apiKey: "test-key",
    });
    // The OpenAI SDK will fill the default endpoint lazily; clientConfig should
    // not carry a custom baseURL.
    expect(getBaseURL(llm)).toBeFalsy();
  });
});

describe("factory baseURL routing — Together", () => {
  it("routes the default Together client to api.together.xyz", async () => {
    const llm = await createTogether({
      modelId: "together:test-model",
      apiKey: "test-key",
    });
    expect(getBaseURL(llm)).toBe("https://api.together.xyz/v1");
    expect(getBaseURL(llm)).not.toContain("api.openai.com");
  });

  it("routes Together baseUrl through configuration.baseURL", async () => {
    const llm = await createTogether({
      modelId: "together:test-model",
      apiKey: "test-key",
      baseUrl: "https://together-proxy.example/v1",
    });
    expect(getBaseURL(llm)).toBe("https://together-proxy.example/v1");
    expect(getBaseURL(llm)).not.toContain("api.openai.com");
  });
});

describe("factory baseURL routing — Fireworks fallback", () => {
  it("constructs the primary ChatFireworks client without throwing", async () => {
    const llm = await createFireworks({
      modelId: "fireworks:accounts/fireworks/models/kimi-k3",
      apiKey: "test-key",
    });
    expect(hasInvoke(llm)).toBe(true);
  });
});

describe("factory baseURL routing — Anthropic", () => {
  it("forwards baseUrl as anthropicApiUrl (NOT top-level baseURL)", async () => {
    const llm = await createAnthropic({
      modelId: "anthropic:claude-sonnet-4-6",
      apiKey: "test-key",
      baseUrl: "https://anthropic.proxy.example.com",
    });
    expect(getApiUrl(llm) ?? "").toContain("anthropic.proxy.example.com");
  });

  // D086 Phase 4 review blocker #2 — long-context variant must honor
  // anthropicApiUrl exactly the same way the standard variant does, so a
  // proxy / regional endpoint isn't silently dropped on the long-context path.
  it("createAnthropicWithLongContext also forwards baseUrl as anthropicApiUrl", async () => {
    const llm = await createAnthropicWithLongContext({
      modelId: "anthropic:claude-sonnet-4-6",
      apiKey: "test-key",
      baseUrl: "https://anthropic-longctx.proxy.example.com",
    });
    expect(getApiUrl(llm) ?? "").toContain("anthropic-longctx.proxy.example.com");
  });
});

describe("factory headers forwarding — OpenRouter attribution + generic", () => {
  // D086 Phase 4 review blocker #3 — `buildOpenRouterCreateModelOptions` builds
  // `HTTP-Referer` / `X-OpenRouter-Title` headers, but `createOpenAI` was
  // ignoring `options.headers`. Headers must land in
  // `clientConfig.defaultHeaders` so the OpenAI SDK forwards them on every
  // request to api.openrouter.ai.
  it("forwards options.headers into ChatOpenAI clientConfig.defaultHeaders", async () => {
    const llm = await createOpenAI({
      modelId: "openrouter:openai/gpt-5.5",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://nautilo.example",
        "X-OpenRouter-Title": "Nautilo",
      },
    });
    const cfg = (llm as { clientConfig?: { defaultHeaders?: Record<string, string> } }).clientConfig;
    expect(cfg?.defaultHeaders).toBeDefined();
    expect(cfg?.defaultHeaders?.["HTTP-Referer"]).toBe("https://nautilo.example");
    expect(cfg?.defaultHeaders?.["X-OpenRouter-Title"]).toBe("Nautilo");
  });

  it("does NOT set defaultHeaders when no headers provided", async () => {
    const llm = await createOpenAI({
      modelId: "openai:gpt-5.6-luna",
      apiKey: "test-key",
    });
    const cfg = (llm as { clientConfig?: { defaultHeaders?: Record<string, string> } }).clientConfig;
    expect(cfg?.defaultHeaders).toBeUndefined();
  });
});
