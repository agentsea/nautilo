import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  replaceActiveModelCapabilityCatalog,
  resetModelCapabilitiesCacheForTests,
  setModelCapabilitiesCacheForTests,
} from "@nautilo/model-capabilities";
import { createDiscoverModelsTool } from "../../src/tools/meta/discover-models";
import { listResolvedCatalogModels } from "../../src/config/resolved-catalog";
import { getActiveModelCatalogSync } from "../../src/config/model-catalog/runtime-catalog";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";

const NO_ENV: NodeJS.ProcessEnv = {};

function fullEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    OPENROUTER_API_KEY: "x",
    GOOGLE_API_KEY: "x",
    FIREWORKS_API_KEY: "x",
    XAI_API_KEY: "x",
    TOGETHER_API_KEY: "x",
    VENICE_API_KEY: "x",
  };
}

interface ListSearchResponse {
  items: Array<{
    id: string;
    displayName: string;
    provider: string;
    availability: string;
    features: {
      tools: boolean | null;
      structuredOutputs: boolean | null;
      reasoning: boolean | null;
      visualGrounding: boolean | null;
      webSearch: boolean | null;
      e2ee: boolean | null;
    };
    input: readonly string[];
    output: readonly string[];
    workload: "chat" | "generation" | "decision";
    generation: { family: string; references: unknown; constraints: unknown } | null;
    decision: { operations: readonly ["choice"]; inputTokens: number; maxChoices: number } | null;
  }>;
  totalMatched: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset: number | null;
}

interface GetModelRow {
  id: string;
  availability: string;
  features: {
    tools: boolean | null;
    reasoning: boolean | null;
    visualGrounding: boolean | null;
  };
  input: readonly string[];
  [k: string]: unknown;
}

interface GetResponse {
  found: boolean;
  model_id?: string;
  reason?: string;
  model?: GetModelRow;
}

function parseList(raw: string): ListSearchResponse {
  return JSON.parse(raw) as ListSearchResponse;
}

function parseGet(raw: string): GetResponse {
  return JSON.parse(raw) as GetResponse;
}

type DiscoverModelsInput = Parameters<ReturnType<typeof createDiscoverModelsTool>["invoke"]>[0];

async function invoke(
  tool: ReturnType<typeof createDiscoverModelsTool>,
  input: DiscoverModelsInput,
): Promise<string> {
  return (await tool.invoke(input)) as string;
}

describe("discover_models (the current implementation)", () => {
  beforeEach(() => {
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  });
  afterEach(() => {
    delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
  });

  test("schema is a flat z.object with the documented fields", () => {
    const tool = createDiscoverModelsTool();
    const schema = tool.schema as { shape?: Record<string, unknown> };
    const keys = Object.keys(schema.shape ?? {});
    expect(keys.sort()).toEqual(
      [
        "command",
        "limit",
        "model_id",
        "offset",
        "output",
        "provider",
        "query",
        "generation_family",
        "decision_operation",
        "requires_reference_role",
        "requires_file_input",
        "requires_reasoning",
        "requires_tools",
        "requires_vision",
        "requires_visual_grounding",
        "runnable_only",
        "workload",
      ].sort(),
    );
    expect(tool.name).toBe("discover_models");
    expect(tool.description.length).toBeGreaterThan(10);
  });

  test("list returns the bounded response shape with all curated rows", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", limit: 5 }));

    expect(res.items.length).toBeLessThanOrEqual(5);
    expect(res.limit).toBe(5);
    expect(res.offset).toBe(0);
    expect(res.totalMatched).toBe(
      listResolvedCatalogModels({ env: fullEnv(), allowChinaUpstream: true, includeUnavailable: true }).length,
    );
    expect(res.truncated).toBe(res.totalMatched > 5);
    expect(res.nextOffset).toBe(res.truncated ? 5 : null);
    for (const item of res.items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.displayName).toBe("string");
      expect(typeof item.provider).toBe("string");
    }
  });

  test("list is sorted deterministically by priority then id (matches )", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const expected = listResolvedCatalogModels({
      env: fullEnv(),
      allowChinaUpstream: true,
      includeUnavailable: true,
    }).map((r) => r.id);
    const res = parseList(await invoke(tool, { command: "list", limit: 50 }));
    // limit is capped to MAX_LIMIT (20).
    expect(res.limit).toBe(20);
    expect(res.items.map((i) => i.id)).toEqual(expected.slice(0, res.items.length));
    expect(res.truncated).toBe(expected.length > 20);
  });

  test("get returns one curated row by exact id", async () => {
    const tool = createDiscoverModelsTool({ env: { ANTHROPIC_API_KEY: "x" } });
    const res = parseGet(await invoke(tool, { command: "get", model_id: "anthropic:claude-sonnet-4-6" }));
    expect(res.found).toBe(true);
    expect(res.model?.id).toBe("anthropic:claude-sonnet-4-6");
    expect(res.model?.availability).toBe("selectable");
    expect(res.model?.features?.tools).toBe(true);
    expect(res.model?.features?.reasoning).toBe(true);
    expect(res.model?.input).toContain("image");
    expect(res.model?.input).toContain("file");
  });

  test("list, search, and get expose safe workload-isolated media facts", async () => {
    const tool = createDiscoverModelsTool({ env: { VENICE_API_KEY: "vk-test" } });
    const videos = parseList(await invoke(tool, { command: "list", output: "video" }));
    expect(videos.items.map((item) => item.id)).toEqual([
      "venice:seedance-2-5-text-to-video-basic",
      "venice:minimax-h3-enhanced-text-to-video",
      "venice:seedance-2-5-reference-to-video-basic",
    ]);
    expect(videos.items.every((item) => item.workload === "generation")).toBe(true);
    expect(videos.items.every((item) => item.generation?.family === "video")).toBe(true);
    expect(
      videos.items
        .filter((item) => item.id !== "venice:seedance-2-5-reference-to-video-basic")
        .every((item) => item.generation?.references === null),
    ).toBe(true);
    expect(
      videos.items.find((item) => item.id === "venice:seedance-2-5-reference-to-video-basic"),
    ).toMatchObject({
      input: ["text", "image"],
      generation: {
        family: "video",
        references: {
          roles: ["image", "audio"],
        },
      },
    });

    const music = parseList(await invoke(tool, {
      command: "search",
      query: "venice",
      output: "audio",
      generation_family: "music",
    }));
    expect(music.items.map((item) => item.id)).toEqual([
      "venice:sonilo-v1-1-music",
      "venice:minimax-music-v26",
    ]);

    const exact = parseGet(await invoke(tool, {
      command: "get",
      model_id: "venice:seedance-2-5-text-to-video-basic",
    }));
    expect(exact.model).toMatchObject({
      workload: "generation",
      output: ["video"],
      generation: { family: "video", references: null },
      contextTokens: null,
      maxOutputTokens: null,
    });
  });

  test("workload filter returns typed decisions while preserving chat and generation rows", async () => {
    const tool = createDiscoverModelsTool({
      env: { OPENROUTER_API_KEY: "or-test", VENICE_API_KEY: "vk-test" },
      allowChinaUpstream: true,
    });

    const decisions = parseList(await invoke(tool, { command: "list", workload: "decision" }));
    expect(decisions.items).toHaveLength(3);
    expect(decisions.items[0]).toMatchObject({
      id: "openrouter:typesafe/jev-1.13",
      workload: "decision",
      input: ["text"],
      output: ["text"],
      generation: null,
      decision: {
        operations: ["choice", "noul", "score"],
        inputTokens: 32_000,
        maxChoices: 255,
      },
      contextTokens: null,
      maxOutputTokens: null,
    });
    expect(decisions.totalMatched).toBe(3);

    const chat = parseList(await invoke(tool, { command: "list", workload: "chat" }));
    expect(chat.items.length).toBeGreaterThan(0);
    expect(chat.items.every((item) => item.workload === "chat")).toBe(true);
    expect(chat.items.some((item) => item.id === "openrouter:typesafe/jev-1.13")).toBe(false);

    const generation = parseList(await invoke(tool, { command: "list", workload: "generation" }));
    expect(generation.items.length).toBeGreaterThan(0);
    expect(generation.items.every((item) => item.workload === "generation")).toBe(true);
  });

  test("a positive reference-role filter excludes unknown capabilities and returns the known model", async () => {
    const tool = createDiscoverModelsTool({ env: { VENICE_API_KEY: "vk-test" } });
    const res = parseList(await invoke(tool, {
      command: "list",
      output: "video",
      requires_reference_role: "image",
    }));
    expect(res.items.map((item) => item.id)).toEqual([
      "venice:seedance-2-5-reference-to-video-basic",
    ]);
    expect(res.totalMatched).toBe(1);
  });

  test("get rejects arbitrary dynamic openrouter: ids as not-found", async () => {
    const tool = createDiscoverModelsTool({ env: { OPENROUTER_API_KEY: "x" } });
    const res = parseGet(
      await invoke(tool, { command: "get", model_id: "openrouter:somevendor/unknown-model-v1" }),
    );
    expect(res.found).toBe(false);
    expect(res.model_id).toBe("openrouter:somevendor/unknown-model-v1");
    expect(res.reason).toContain("curated");
  });

  test("get rejects arbitrary dynamic gateway: ids as not-found", async () => {
    const tool = createDiscoverModelsTool({ env: NO_ENV });
    const res = parseGet(await invoke(tool, { command: "get", model_id: "gateway:arbitrary-id" }));
    expect(res.found).toBe(false);
  });

  test("get on a truly unknown id returns not-found", async () => {
    const tool = createDiscoverModelsTool({ env: NO_ENV });
    const res = parseGet(await invoke(tool, { command: "get", model_id: "newprovider:vortex-99" }));
    expect(res.found).toBe(false);
  });

  test("get on a curated but unkeyed model returns the row with its availability", async () => {
    const tool = createDiscoverModelsTool({ env: NO_ENV });
    const res = parseGet(await invoke(tool, { command: "get", model_id: "anthropic:claude-sonnet-4-6" }));
    expect(res.found).toBe(true);
    expect(res.model?.availability).toBe("missing_credentials");
  });

  test("get without model_id is malformed", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv() });
    const raw = await invoke(tool, { command: "get" });
    expect(raw).toContain("malformed_input");
    expect(raw).toContain("model_id");
  });

  test("search matches id, displayName, and provider case-insensitively", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const byId = parseList(await invoke(tool, { command: "search", query: "CLAUDE-SONNET-4-6" }));
    expect(byId.items.map((i) => i.id)).toContain("anthropic:claude-sonnet-4-6");

    const byDisplay = parseList(await invoke(tool, { command: "search", query: "sonnet" }));
    expect(byDisplay.items.length).toBeGreaterThan(0);
    expect(
      byDisplay.items.every(
        (i) => i.displayName.toLowerCase().includes("sonnet") || i.id.toLowerCase().includes("sonnet"),
      ),
    ).toBe(true);

    const byProvider = parseList(await invoke(tool, { command: "search", query: "anthropic" }));
    expect(byProvider.items.length).toBeGreaterThan(0);
    // Query matches id + displayName + provider (case-insensitive), so e.g. a
    // venice-routed "Claude (Venice → Anthropic)" row can match on displayName
    // without its provider being "anthropic". Assert the query term appears in
    // each row's searchable text rather than pinning provider equality.
    expect(
      byProvider.items.every(
        (i) =>
          i.id.toLowerCase().includes("anthropic") ||
          i.displayName.toLowerCase().includes("anthropic") ||
          i.provider.toLowerCase().includes("anthropic"),
      ),
    ).toBe(true);
  });

  test("search without query is malformed", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv() });
    const raw = await invoke(tool, { command: "search" });
    expect(raw).toContain("malformed_input");
    expect(raw).toContain("query");
  });

  test("provider filter is an exact (case-insensitive) match", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", provider: "OpenAI" }));
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => i.provider === "openai")).toBe(true);
  });

  test("runnable_only filters to selectable rows", async () => {
    const tool = createDiscoverModelsTool({ env: NO_ENV });
    const res = parseList(await invoke(tool, { command: "list", runnable_only: true }));
    expect(res.items.every((i) => i.availability === "selectable")).toBe(true);
    expect(res.items.length).toBe(0);
  });

  test("requires_tools excludes unknown (null) and false features", async () => {
    setModelCapabilitiesCacheForTests({
      fetchedAt: new Date().toISOString(),
      models: {
        "moonshotai/kimi-k2.6": {
          input: ["text"],
          output: ["text"],
          features: { tools: false, structuredOutputs: false, reasoning: true },
        },
      },
    });
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", requires_tools: true }));
    expect(res.items.every((i) => i.features.tools === true)).toBe(true);
    expect(res.items.map((i) => i.id)).toContain("anthropic:claude-sonnet-4-6");
    expect(res.items.map((i) => i.id)).not.toContain("openrouter:moonshotai/kimi-k2.6");
  });

  test("requires_vision filters on image input modality", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", requires_vision: true }));
    expect(res.items.every((i) => i.input.includes("image"))).toBe(true);
    expect(res.items.map((i) => i.id)).toContain("anthropic:claude-sonnet-4-6");
  });

  test("requires_file_input filters on file input modality", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", requires_file_input: true }));
    expect(res.items.every((i) => i.input.includes("file"))).toBe(true);
  });

  test("requires_reasoning excludes unknown (null) and false features", async () => {
    setModelCapabilitiesCacheForTests({
      fetchedAt: new Date().toISOString(),
      models: {
        "moonshotai/kimi-k2.6": {
          input: ["text"],
          output: ["text"],
          features: { tools: true, structuredOutputs: false, reasoning: false },
        },
      },
    });
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(await invoke(tool, { command: "list", requires_reasoning: true }));
    expect(res.items.every((i) => i.features.reasoning === true)).toBe(true);
    expect(res.items.map((i) => i.id)).not.toContain("openrouter:moonshotai/kimi-k2.6");
  });

  test("requires_visual_grounding matches only explicit support and composes as metadata", async () => {
    const entries = getActiveModelCatalogSync().catalog.entries;
    const original = entries.map((entry) => ({
      id: entry.id,
      ...(entry.modalities ? { modalities: entry.modalities } : {}),
      ...(entry.features ? { features: entry.features } : {}),
      ...(entry.capabilityProvenance
        ? { capabilityProvenance: entry.capabilityProvenance }
        : {}),
    }));
    replaceActiveModelCapabilityCatalog(original.map((entry) => {
      if (entry.id === "anthropic:claude-sonnet-4-6" && entry.features) {
        return { ...entry, features: { ...entry.features, visualGrounding: true } };
      }
      if (entry.id === "openrouter:moonshotai/kimi-k2.6" && entry.features) {
        return { ...entry, features: { ...entry.features, visualGrounding: false } };
      }
      return entry;
    }));
    try {
      const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
      const res = parseList(await invoke(tool, {
        command: "list",
        requires_visual_grounding: true,
      }));
      expect(res.items.every((item) => item.features.visualGrounding === true)).toBe(true);
      expect(res.items.map((item) => item.id)).toContain("anthropic:claude-sonnet-4-6");
      expect(res.items.map((item) => item.id)).not.toContain("openrouter:moonshotai/kimi-k2.6");

      const exact = parseGet(await invoke(tool, {
        command: "get",
        model_id: "anthropic:claude-sonnet-4-6",
      }));
      expect(exact.model?.features.visualGrounding).toBe(true);
    } finally {
      replaceActiveModelCapabilityCatalog(original);
    }
  });

  test("capability filters combine with AND semantics", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(
      await invoke(tool, { command: "list", requires_tools: true, requires_vision: true, requires_reasoning: true }),
    );
    expect(
      res.items.every(
        (i) => i.features.tools === true && i.input.includes("image") && i.features.reasoning === true,
      ),
    ).toBe(true);
  });

  test("query + provider + capability combine with AND semantics", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const res = parseList(
      await invoke(tool, { command: "search", query: "claude", provider: "anthropic", requires_tools: true }),
    );
    expect(res.items.length).toBeGreaterThan(0);
    expect(
      res.items.every(
        (i) =>
          i.provider === "anthropic" &&
          i.features.tools === true &&
          (i.id.toLowerCase().includes("claude") || i.displayName.toLowerCase().includes("claude")),
      ),
    ).toBe(true);
  });

  test("pagination: offset + limit + truncation + nextOffset are consistent", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const total = listResolvedCatalogModels({
      env: fullEnv(),
      allowChinaUpstream: true,
      includeUnavailable: true,
    }).length;
    const page1 = parseList(await invoke(tool, { command: "list", limit: 3, offset: 0 }));
    expect(page1.items).toHaveLength(Math.min(3, total));
    expect(page1.truncated).toBe(total > 3);
    expect(page1.nextOffset).toBe(total > 3 ? 3 : null);

    if (total > 3) {
      const page2 = parseList(await invoke(tool, { command: "list", limit: 3, offset: page1.nextOffset! }));
      expect(page2.offset).toBe(3);
      expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    }
  });

  test("limit is capped to MAX_LIMIT (20) and offset is non-negative", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const oversized = parseList(await invoke(tool, { command: "list", limit: 1000 }));
    expect(oversized.limit).toBe(20);
    expect(oversized.items.length).toBeLessThanOrEqual(20);

    const negative = parseList(await invoke(tool, { command: "list", offset: -5 }));
    expect(negative.offset).toBe(0);
  });

  test("no match returns an empty items array (not an error)", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv() });
    const res = parseList(await invoke(tool, { command: "search", query: "zzz-no-such-model-zzz" }));
    expect(res.items).toEqual([]);
    expect(res.totalMatched).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.nextOffset).toBe(null);
  });

  test("response contains no env key names with values, fingerprints, or cache payloads", async () => {
    const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
    const listRaw = await invoke(tool, { command: "list", limit: 20 });
    const getRaw = await invoke(tool, { command: "get", model_id: "anthropic:claude-sonnet-4-6" });
    for (const raw of [listRaw, getRaw]) {
      expect(raw).not.toContain("ANTHROPIC_API_KEY");
      expect(raw).not.toContain("OPENAI_API_KEY");
      expect(raw).not.toContain("OPENROUTER_API_KEY");
      expect(raw).not.toContain("VENICE_API_KEY");
      expect(raw).not.toContain("x-test");
      expect(raw).not.toContain('models":{');
    }
  });

  test("list never performs a network fetch ", async () => {
    const original = globalThis.fetch;
    let called = 0;
    (globalThis as { fetch: unknown }).fetch = () => {
      called++;
      throw new Error("fetch must not be called during discover_models");
    };
    try {
      const tool = createDiscoverModelsTool({ env: fullEnv(), allowChinaUpstream: true });
      await invoke(tool, { command: "list" });
      await invoke(tool, { command: "search", query: "claude" });
      await invoke(tool, { command: "get", model_id: "anthropic:claude-sonnet-4-6" });
      expect(called).toBe(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });
});

test("operation discovery finds runnable classifiers and excludes chat, speech, and missing keys", async () => {
  resetVeniceCatalogCacheModuleForTests();
  const tool = createDiscoverModelsTool({ env: { TYPESAFE_API_KEY: "synthetic-key" } });
  const result = parseList(await invoke(tool, { command: "list", decision_operation: "score", runnable_only: true }));
  expect(result.items.map((row) => row.id)).toEqual(["typesafe:jev-1.13.0"]);
  expect(result.items[0]).toMatchObject({ workload: "decision", input: ["text"], decision: { operations: ["choice", "noul", "score"] } });
});
