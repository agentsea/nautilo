import { describe, expect, test } from "bun:test";
import { discoverModelOutputTokenLimit, getDescriptiveModelContextTokens, resolveModelClass, getModelTokenLimit, modelSupportsInput } from "../../src/providers/models";
import { createUniversalModel } from "../../src/providers/universal";
import { getModelById, getProviderFromModelId } from "../../src/config/assistant-models";

/** Introspect LangChain `ChatOpenAI` private fields in unit tests (no `any`). */
function lcModelFields(model: unknown): Record<string, unknown> {
  return model as Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// resolveModelClass — July-2026 curated 13 (see ASSISTANT_MODELS + D462 audit)
// ──────────────────────────────────────────────────────────────────────────────
describe("resolveModelClass — venice: curated 13", () => {
  const cases: Array<[string, string]> = [
    ["venice:zai-org-glm-5-1", "200K"],
    ["venice:e2ee-deepseek-v4-flash", "1M"],
    ["venice:google-gemma-3-27b-it", "200K"],
    ["venice:google-gemma-4-26b-a4b-it", "256K"],
    ["venice:google-gemma-4-31b-it", "256K"],
    ["venice:kimi-k3", "1M"],
    ["venice:deepseek-v4-pro", "1M"],
    ["venice:minimax-m27", "200K"],
    ["venice:claude-sonnet-4-6", "1M"],
    ["venice:claude-opus-4-7", "1M"],
    ["venice:gemini-3-1-pro-preview", "1M"],
    ["venice:openai-gpt-55-pro", "1M"],
    ["venice:qwen-3-6-plus", "1M"],
  ];

  for (const [id, expected] of cases) {
    test(`${id} → "${expected}"`, () => {
      expect(resolveModelClass(id)).toBe(expected as never);
    });
  }

  test("unrecognized venice:* falls back to conservative 128K", () => {
    expect(resolveModelClass("venice:some-brand-new-model-we-havent-seen")).toBe("128K");
  });
});

describe("assistant-models — Venice routing on catalog rows", () => {
  test("western-anonymized vs china-anonymized vs hosted", () => {
    expect(getModelById("venice:deepseek-v4-pro")?.routing).toBe("western-anonymized");
    expect(getModelById("venice:qwen-3-6-plus")?.routing).toBe("china-anonymized");
    expect(getModelById("venice:zai-org-glm-5-1")?.routing).toBe("venice-hosted");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Ordering-trap tests — specific-before-generic (regression guards)
// ──────────────────────────────────────────────────────────────────────────────
describe("resolveModelClass — venice: ordering is specific-before-generic", () => {
  test("GLM 5.1 (200K) routes before GLM 5 (200K)", () => {
    expect(resolveModelClass("venice:zai-org-glm-5-1")).toBe("200K");
    expect(resolveModelClass("venice:zai-org-glm-5")).toBe("200K");
  });

  test("DeepSeek V4 (1M) does NOT get shadowed by DeepSeek V3 (128K)", () => {
    expect(resolveModelClass("venice:deepseek-v4-pro")).toBe("1M");
    expect(resolveModelClass("venice:deepseek-v3")).toBe("128K");
  });

  test("DeepSeek V3.2 (160K) does NOT get shadowed by DeepSeek V3 (128K)", () => {
    expect(resolveModelClass("venice:deepseek-v3.2")).toBe("160K");
    expect(resolveModelClass("venice:deepseek-v3")).toBe("128K");
  });

  test("GLM 4.7 flash (128K) does NOT get shadowed by GLM 4.7 (200K)", () => {
    expect(resolveModelClass("venice:zai-org-glm-4.7-flash")).toBe("128K");
    expect(resolveModelClass("venice:zai-org-glm-4.7")).toBe("200K");
  });

  test("Kimi K2 Thinking (256K) does NOT get shadowed by generic k2- substring", () => {
    expect(resolveModelClass("venice:kimi-k2-thinking")).toBe("256K");
  });

  test("E2EE GLM 4.7 flash (200K) does NOT get shadowed by E2EE GLM 4.7 (128K)", () => {
    expect(resolveModelClass("venice:e2ee-glm-4-7-flash-p")).toBe("200K");
    expect(resolveModelClass("venice:e2ee-glm-4-7-p")).toBe("128K");
  });

  test("venice-uncensored-1-2 (128K) does NOT get shadowed by legacy venice-uncensored (32K)", () => {
    expect(resolveModelClass("venice:venice-uncensored-1-2")).toBe("128K");
    expect(resolveModelClass("venice:venice-uncensored")).toBe("32K");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 160K ModelClass — DeepSeek V3.2
// ──────────────────────────────────────────────────────────────────────────────
describe("ModelClass 160K — DeepSeek V3.2", () => {
  test("getModelTokenLimit for deepseek-v3.2 is 160000", () => {
    expect(getDescriptiveModelContextTokens("venice:deepseek-v3.2")).toBe(160000);
  });

  test("128K is strictly less than 160K in the class hierarchy", () => {
    const v3 = getDescriptiveModelContextTokens("venice:deepseek-v3");
    const v32 = getDescriptiveModelContextTokens("venice:deepseek-v3.2");
    expect(v3).toBe(131072);
    expect(v32).toBe(160000);
    expect(v32).toBeGreaterThan(v3);
  });
});

describe("Venice curated metadata corrections", () => {
  test("qwen-3-8-max uses the Venice-reported 1M context window", () => {
    expect(getModelTokenLimit("venice:qwen-3-8-max")).toBe(1_000_000);
  });

  test("kimi-k3 uses the Venice-reported 1M context window and 131072 completion budget", async () => {
    expect(getModelTokenLimit("venice:kimi-k3")).toBe(1_000_000);
    expect((await discoverModelOutputTokenLimit("venice:kimi-k3")).limit).toBe(131_072);
  });

  test("curated Venice vision models are not treated as text-only", () => {
    expect(modelSupportsInput("venice:kimi-k3", "image")).toBe(true);
    expect(modelSupportsInput("venice:minimax-m3-preview", "image")).toBe(true);
    expect(modelSupportsInput("venice:claude-sonnet-4-6", "image")).toBe(true);
  });

  test("known text-only Venice models stay text-only", () => {
    expect(modelSupportsInput("venice:deepseek-v4-pro", "image")).toBe(false);
    expect(modelSupportsInput("venice:e2ee-deepseek-v4-flash", "image")).toBe(false);
    expect(modelSupportsInput("venice:qwen-3-6-plus", "image")).toBe(false);
    // Removed catalog identities do not retain capability through the old
    // provider-name heuristic.
    expect(modelSupportsInput("venice:google-gemma-4-31b-it", "image")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getModelMaxOutputTokens — Venice rules (prefix-isolated)
// ──────────────────────────────────────────────────────────────────────────────
describe("getModelMaxOutputTokens — Venice", () => {
  test("venice:venice-uncensored-1-2 resolves to 8192 (standard private)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:venice-uncensored-1-2");
    expect(limit).toBe(8_192);
  });

  test("venice:zai-org-glm-5-1 resolves to 16384 (reasoning-capable)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:zai-org-glm-5-1");
    expect(limit).toBe(16_384);
  });

  test("venice:grok-4-20 resolves to 16384 (large-context)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:grok-4-20");
    expect(limit).toBe(16_384);
  });

  test("venice:e2ee-deepseek-v4-flash resolves to 8192 (E2EE with tools and reasoning, no vision)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:e2ee-deepseek-v4-flash");
    expect(limit).toBe(8_192);
  });

  test("venice:e2ee-venice-uncensored-24b-p resolves to 4096 (E2EE chat-only)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:e2ee-venice-uncensored-24b-p");
    expect(limit).toBe(4_096);
  });

  test("venice:e2ee-gpt-oss-120b-p does NOT match the gpt-5 rule (8192 not 128000)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:e2ee-gpt-oss-120b-p");
    expect(limit).toBe(8_192);
  });

  test("venice:deepseek-v4-pro resolves to Venice-reported completion budget", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:deepseek-v4-pro");
    expect(limit).toBe(32_768);
  });

  test("unknown venice: SKU falls back to 8192 (conservative default)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:some-brand-new-model-xyz");
    expect(limit).toBe(8_192);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// universal.ts — venice routes correctly; safety default non-overridable
// ──────────────────────────────────────────────────────────────────────────────
describe("createUniversalModel — venice case", () => {
  test("returns a ChatModel for venice:zai-org-glm-5-2", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
    });
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe("function");
  });

  test("throws (does NOT leak OPENAI_API_KEY) when no Venice credential is available", async () => {
    const origVenice = process.env["VENICE_API_KEY"];
    const origOpenai = process.env["OPENAI_API_KEY"];
    delete process.env["VENICE_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-proj-FAKE-OPENAI-DO-NOT-LEAK";
    try {
      let threw = false;
      try {
        await createUniversalModel("venice:zai-org-glm-5-2");
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain("VENICE_API_KEY not set");
        expect(msg).toContain("refuse to fall back to OPENAI_API_KEY");
      }
      expect(threw).toBe(true);
    } finally {
      if (origVenice !== undefined) process.env["VENICE_API_KEY"] = origVenice;
      else delete process.env["VENICE_API_KEY"];
      if (origOpenai !== undefined) process.env["OPENAI_API_KEY"] = origOpenai;
      else delete process.env["OPENAI_API_KEY"];
    }
  });

  test("reads VENICE_API_KEY from env when caller doesn't pass apiKey", async () => {
    const orig = process.env["VENICE_API_KEY"];
    process.env["VENICE_API_KEY"] = "env-venice-key-long-enough-to-pass-any-length-check-xyz";
    try {
      const model = await createUniversalModel("venice:zai-org-glm-5-2");
      expect(model).toBeDefined();
      const cfg = lcModelFields(model)["clientConfig"] as Record<string, unknown> | undefined;
      expect(cfg?.["apiKey"]).toBe("env-venice-key-long-enough-to-pass-any-length-check-xyz");
    } finally {
      if (orig !== undefined) process.env["VENICE_API_KEY"] = orig;
      else delete process.env["VENICE_API_KEY"];
    }
  });

  test("include_venice_system_prompt safety default is hardcoded false (non-overridable)", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
      veniceParameters: { include_venice_system_prompt: true, enable_web_search: "auto" },
    });
    const internalKwargs = lcModelFields(model)["modelKwargs"] as Record<string, unknown> | undefined;
    expect(internalKwargs).toBeDefined();
    const vp = internalKwargs?.["venice_parameters"] as Record<string, unknown>;
    expect(vp).toBeDefined();
    expect(vp["include_venice_system_prompt"]).toBe(false);
    expect(vp["enable_web_search"]).toBe("auto");
  });

  test("caller's modelKwargs.venice_parameters and veniceParameters are merged, not silently dropped", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
      modelKwargs: { venice_parameters: { character_slug: "from-modelKwargs", enable_web_search: "off" } },
      veniceParameters: { enable_web_search: "auto" },
    });
    const vp = (lcModelFields(model)["modelKwargs"] as Record<string, unknown>)["venice_parameters"] as Record<string, unknown>;
    expect(vp["enable_web_search"]).toBe("auto");
    expect(vp["character_slug"]).toBe("from-modelKwargs");
    expect(vp["include_venice_system_prompt"]).toBe(false);
  });

  test("caller's non-venice modelKwargs fields are preserved (not dropped)", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
      modelKwargs: { some_other_openai_field: "passthrough" },
      veniceParameters: { enable_web_search: "auto" },
    });
    const kwargs = lcModelFields(model)["modelKwargs"] as Record<string, unknown>;
    expect(kwargs["some_other_openai_field"]).toBe("passthrough");
    expect((kwargs["venice_parameters"] as Record<string, unknown>)["enable_web_search"]).toBe("auto");
  });

  test("venice: prefix is stripped from the model name handed to ChatOpenAI", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
    });
    const wireModelName = lcModelFields(model)["model"] as string | undefined;
    expect(wireModelName).toBe("zai-org-glm-5-2");
    expect(wireModelName?.startsWith("venice:")).toBe(false);
  });

  test("venice: case accepts caller-supplied baseUrl (e.g. for test servers) without error", async () => {
    const model = await createUniversalModel("venice:zai-org-glm-5-2", {
      apiKey: "test-fake-key-long-enough-to-pass-any-length-check",
      baseURL: "http://localhost:9999/v1",
    });
    expect(model).toBeDefined();
    const vp = (lcModelFields(model)["modelKwargs"] as Record<string, unknown> | undefined)?.["venice_parameters"] as Record<string, unknown>;
    expect(vp["include_venice_system_prompt"]).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Cross-provider isolation — Venice rules must NOT leak to other providers
// ──────────────────────────────────────────────────────────────────────────────
describe("cross-provider isolation (Venice output short-circuit)", () => {
  test("fireworks:kimi-k2-thinking does NOT pick up Venice's 16K reasoning rule", async () => {
    const { limit } = await discoverModelOutputTokenLimit("fireworks:accounts/fireworks/models/kimi-k2-thinking");
    expect(limit).toBe(8_192);
    expect(limit).not.toBe(16_384);
  });

  test("fireworks:minimax-m27 does NOT pick up Venice's 16K rule", async () => {
    const { limit } = await discoverModelOutputTokenLimit("fireworks:minimax-m27");
    expect(limit).not.toBe(16_384);
    expect(limit).toBe(8_192);
  });

  test("openai:gpt-5.4-codex is NOT confused with venice:openai-gpt-oss", async () => {
    const originalOpenAiKey = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      const { limit } = await discoverModelOutputTokenLimit("openai:gpt-5.4-2026-03-05");
      expect(limit).toBe(128_000);
    } finally {
      if (originalOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = originalOpenAiKey;
    }
  });

  test("anthropic:claude-opus-4-7 uses shared Anthropic static rule (128k)", async () => {
    const { limit } = await discoverModelOutputTokenLimit("anthropic:claude-opus-4-7");
    expect(limit).toBe(128_000);
  });

  test("venice: short-circuit fires BEFORE the shared rule table", async () => {
    const { limit } = await discoverModelOutputTokenLimit("venice:deepseek-v3.2");
    expect(limit).toBe(8_192);
    expect(limit).not.toBe(12_288);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getProviderFromModelId — venice: prefix splits correctly
// ──────────────────────────────────────────────────────────────────────────────
describe("getProviderFromModelId — venice:", () => {
  test("venice:zai-org-glm-5-1 → 'venice'", () => {
    expect(getProviderFromModelId("venice:zai-org-glm-5-1")).toBe("venice");
  });

  test("venice:e2ee-deepseek-v4-flash → 'venice'", () => {
    expect(getProviderFromModelId("venice:e2ee-deepseek-v4-flash")).toBe("venice");
  });
});
