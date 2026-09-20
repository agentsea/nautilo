import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseUpdateBodyForTests,
  serverModelsRoutes,
  toWire,
  type ServerModelsRouteDeps,
} from "../../src/routes/server-models";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog, listResolvedCatalogModels, resolveRetainedModels } from "@nautilo/agent";
import {
  __resetServerModelConfigCache,
  primeServerModelConfigCache,
  type ResolvedServerModelConfig,
} from "@nautilo/db";

const KNOWN_MODEL = "anthropic:claude-sonnet-4-6";
const REPAIR_MODEL = "openai:gpt-5.6-terra";
const MEDIA_MODELS = {
  image: [{ id: "venice:gpt-image-2", displayName: "GPT Image 2", provider: "venice", available: true }],
  music: [{ id: "venice:sonilo-v1-1-music", displayName: "Sonilo", provider: "venice", available: true }],
  video: [
    { id: "venice:seedance-2-5-text-to-video-basic", displayName: "Seedance", provider: "venice", available: true },
    { id: "venice:minimax-h3-enhanced-text-to-video", displayName: "MiniMax H3", provider: "venice", available: false, unavailableReason: "Venice credential is not configured" },
  ],
} as const;
const listMediaModels = (kind: keyof typeof MEDIA_MODELS) => [...MEDIA_MODELS[kind]];
let previousAnthropicKey: string | undefined;

beforeEach(() => {
  previousAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "test-key";
});

afterEach(() => {
  if (previousAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = previousAnthropicKey;
});

type Handler = (
  request: {
    sessionUserId?: string;
    body?: unknown;
    ip: string;
    headers: Record<string, string>;
  },
  reply: {
    code(status: number): unknown;
    send(body: unknown): unknown;
  },
) => Promise<unknown>;

function routeHarness(deps: ServerModelsRouteDeps) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  };
  serverModelsRoutes(app as never, deps);

  return async (method: "GET" | "POST", request: Parameters<Handler>[0]) => {
    let status = 200;
    let body: unknown;
    const reply = {
      code(next: number) {
        status = next;
        return this;
      },
      send(next: unknown) {
        body = next;
        return next;
      },
    };
    await handlers.get(`${method} /api/admin/server-models`)!(request, reply);
    return { status, body };
  };
}

const requestBase = { ip: "127.0.0.1", headers: {} };
const modelConfig: ResolvedServerModelConfig = {
  defaultChatModel: KNOWN_MODEL,
  conductorModel: "google:gemini-3.1-flash-lite-preview",
  stenographerModel: "openai:gpt-5.4-mini",
  reflectionModel: "anthropic:claude-haiku-4-5",
  memoryReviewModel: null,
  embeddingModel: null,
  imageModel: null,
  musicModel: null,
  videoModel: null, speechModel: null,
  fallbackChain: ["openai:gpt-5.4-mini"],
  reasoningOutput: { [KNOWN_MODEL]: true },
  reasoningPolicy: { defaultEffort: null, overrides: {} },
};

describe("server-models parseUpdateBody — reasoningOutput", () => {
  test("accepts every server model-policy field in one patch", () => {
    expect(parseUpdateBodyForTests({
      defaultChatModel: KNOWN_MODEL,
      conductorModel: KNOWN_MODEL,
      stenographerModel: KNOWN_MODEL,
      reflectionModel: KNOWN_MODEL,
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [KNOWN_MODEL],
      reasoningOutput: { [KNOWN_MODEL]: false },
      reasoningPolicy: { defaultEffort: null, overrides: {} },
    })).toEqual({
      ok: true,
      patch: {
        defaultChatModel: KNOWN_MODEL,
        conductorModel: KNOWN_MODEL,
        stenographerModel: KNOWN_MODEL,
        reflectionModel: KNOWN_MODEL,
        memoryReviewModel: null,
        embeddingModel: null,
        imageModel: null,
        musicModel: null,
        videoModel: null, speechModel: null,
        fallbackChain: [KNOWN_MODEL],
        reasoningOutput: { [KNOWN_MODEL]: false },
        reasoningPolicy: { defaultEffort: null, overrides: {} },
      },
    });
  });

  test("accepts a valid model-id → boolean map", () => {
    const parsed = parseUpdateBodyForTests({
      reasoningOutput: { [KNOWN_MODEL]: false },
      reasoningPolicy: { defaultEffort: null, overrides: {} },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.reasoningOutput).toEqual({ [KNOWN_MODEL]: false });
  });

  test("accepts a compact scoped reasoning-effort policy", () => {
    const parsed = parseUpdateBodyForTests({
      reasoningPolicy: {
        defaultEffort: "medium",
        overrides: { [KNOWN_MODEL]: "high" },
      },
    });
    expect(parsed).toEqual({
      ok: true,
      patch: {
        reasoningPolicy: {
          defaultEffort: "medium",
          overrides: { [KNOWN_MODEL]: "high" },
        },
      },
    });
  });

  test("rejects non-object reasoningOutput", () => {
    const parsed = parseUpdateBodyForTests({ reasoningOutput: ["bad"] });
    expect(parsed).toEqual({
      ok: false,
      error: "reasoningOutput must be an object",
    });
  });

  test("rejects non-boolean values", () => {
    const parsed = parseUpdateBodyForTests({
      reasoningOutput: { [KNOWN_MODEL]: "off" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(`reasoningOutput.${KNOWN_MODEL} must be a boolean`);
  });

  test("rejects unknown model ids", () => {
    const parsed = parseUpdateBodyForTests({
      reasoningOutput: { "unknown:fake-model": false },
    });
    expect(parsed).toEqual({
      ok: false,
      error:
        "model unavailable in reasoningOutput: unknown:fake-model " +
        "(model is not present in the current signed catalog)",
    });
  });

  test("rejects empty body with no recognized fields", () => {
    const parsed = parseUpdateBodyForTests({});
    expect(parsed).toEqual({
      ok: false,
      error: "no recognized fields to update",
    });
  });
});

describe("server-models toWire", () => {
  test("includes reasoningOutput on the wire shape", () => {
    const config: ResolvedServerModelConfig = {
      defaultChatModel: KNOWN_MODEL,
      conductorModel: "",
      stenographerModel: "",
      reflectionModel: "",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [],
      reasoningOutput: { [KNOWN_MODEL]: false },
      reasoningPolicy: { defaultEffort: null, overrides: { [KNOWN_MODEL]: "off" } },
    };
    expect(toWire(config)).toEqual({
      defaultChatModel: KNOWN_MODEL,
      conductorModel: "",
      stenographerModel: "",
      reflectionModel: "",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [],
      reasoningOutput: { [KNOWN_MODEL]: false },
      reasoningPolicy: { defaultEffort: null, overrides: { [KNOWN_MODEL]: "off" } },
    });
  });

  test("accepts a known Stenographer model and blank inheritance", () => {
    expect(parseUpdateBodyForTests({ stenographerModel: KNOWN_MODEL })).toEqual({
      ok: true,
      patch: { stenographerModel: KNOWN_MODEL },
    });
    expect(parseUpdateBodyForTests({ stenographerModel: "" })).toEqual({
      ok: true,
      patch: { stenographerModel: null },
    });
  });

  test("rejects an unknown Stenographer model", () => {
    expect(parseUpdateBodyForTests({
      stenographerModel: "unknown:fake-model",
    })).toEqual({
      ok: false,
      error:
        "model unavailable: unknown:fake-model " +
        "(model is not present in the current signed catalog)",
    });
  });

  test("accepts a known Reflection model and blank Stenographer inheritance", () => {
    expect(parseUpdateBodyForTests({ reflectionModel: KNOWN_MODEL })).toEqual({
      ok: true,
      patch: { reflectionModel: KNOWN_MODEL },
    });
    expect(parseUpdateBodyForTests({ reflectionModel: "" })).toEqual({
      ok: true,
      patch: { reflectionModel: null },
    });
  });
});

describe("server-models route authorization, partial writes, and audit", () => {
  test("catalog visibility uses read permission and returns no metadata to unauthenticated viewers", async () => {
    const call = routeHarness({ getCapabilities: async () => [] });
    expect(await call("GET", requestBase)).toEqual({ status: 401, body: { error: "Authentication required" } });
    expect(await call("GET", { ...requestBase, sessionUserId: "viewer" }))
      .toEqual({ status: 403, body: { error: "admin only" } });
  });

  test("catalog inventory includes decision models and live missing-credential reasons without admitting them for chat", async () => {
    const previous = process.env["OPENROUTER_API_KEY"];
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
    try {
      delete process.env["OPENROUTER_API_KEY"];
      const call = routeHarness({
        getCapabilities: async () => ["read_server_settings"],
        getDb: () => ({}) as never,
        getDefaults: () => ({ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }),
        getConfig: async () => modelConfig,
        refreshConfigCache: async () => null,
        getEffectiveEmbeddingModel: () => null,
        getActiveEmbeddingSelection: () => null,
        listMediaModels,
        getEffectiveMediaModel: () => null,
      });
      const read = async () => {
        const result = await call("GET", { ...requestBase, sessionUserId: "viewer" });
        expect(result.status).toBe(200);
        return (result.body as { catalogModels: Array<Record<string, unknown>> }).catalogModels;
      };
      const rows = await read();
      expect(rows.map((row) => row["id"]))
        .toEqual(listResolvedCatalogModels({ includeUnavailable: true }).map((row) => row.id));
      const decision = rows.find((row) => row["id"] === "openrouter:typesafe/jev-1.13");
      expect(decision).toMatchObject({
        provider: "openrouter", workload: "decision", availability: "missing_credentials",
        unavailableReason: "OpenRouter credential is not configured",
        decision: { operations: ["choice"] },
        features: { visualGrounding: null },
      });
      expect(Object.keys(decision!).sort()).toEqual([
        "id", "displayName", "provider", "workload", "availability", "unavailableReason",
        "input", "output", "features", "decision",
      ].sort());
      const grounded = listResolvedCatalogModels({ includeUnavailable: true }).find((row) => row.features.visualGrounding === true);
      expect(grounded).toBeDefined();
      expect(rows.find((row) => row["id"] === grounded!.id)).toMatchObject({ features: { visualGrounding: true } });

      process.env["OPENROUTER_API_KEY"] = "synthetic-catalog-test";
      expect((await read()).find((row) => row["id"] === decision!["id"]))
        .toMatchObject({ availability: "selectable" });
      expect(resolveRetainedModels([String(decision!["id"])], { purpose: "chat-tools" })[0]?.availability)
        .not.toBe("selectable");
      delete process.env["OPENROUTER_API_KEY"];
      expect((await read()).find((row) => row["id"] === decision!["id"]))
        .toMatchObject({ availability: "missing_credentials" });
    } finally {
      if (previous === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previous;
      resetRuntimeModelCatalog();
    }
  });

  test("requires manage_server_operations even when the caller is not an Agent owner", async () => {
    const call = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
    });
    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "admin-not-agent-owner",
      body: { reasoningOutput: { [KNOWN_MODEL]: false } },
    })).toEqual({ status: 403, body: { error: "admin only" } });
  });

  test("persists a reasoning-output partial write, refreshes consumers, and audits only changed fields", async () => {
    const patches: unknown[] = [];
    const refreshes: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_operations"],
      getDb: () => ({}) as never,
      getDefaults: () => ({ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }),
      getConfig: async () => modelConfig,
      upsertConfig: async (_db, patch) => {
        patches.push(patch);
        return {
          defaultChatModel: patch.defaultChatModel ?? modelConfig.defaultChatModel,
          conductorModel: patch.conductorModel ?? modelConfig.conductorModel,
          stenographerModel: patch.stenographerModel ?? modelConfig.stenographerModel,
          reflectionModel: patch.reflectionModel ?? modelConfig.reflectionModel,
          memoryReviewModel: null,
          embeddingModel: null,
          imageModel: null,
          musicModel: null,
          videoModel: null, speechModel: null,
          fallbackChain: patch.fallbackChain ?? modelConfig.fallbackChain,
          reasoningOutput: patch.reasoningOutput ?? modelConfig.reasoningOutput,
          reasoningPolicy: patch.reasoningPolicy ?? modelConfig.reasoningPolicy,
        };
      },
      refreshConfigCache: async (force) => {
        refreshes.push(force);
        return null;
      },
      auditEvent: (_request, event) => {
        events.push(event);
      },
    });

    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "admin-not-agent-owner",
      body: { reasoningOutput: { [KNOWN_MODEL]: false } },
    })).toMatchObject({
      status: 200,
      body: { ...modelConfig, reasoningOutput: { [KNOWN_MODEL]: false } },
    });
    expect(patches).toEqual([{ reasoningOutput: { [KNOWN_MODEL]: false } }]);
    expect(refreshes).toEqual([true]);
    expect(events).toEqual([{
      kind: "server_model_config_changed",
      actorId: "admin-not-agent-owner",
      before: modelConfig,
      after: { ...modelConfig, reasoningOutput: { [KNOWN_MODEL]: false } },
      changes: {
        reasoningOutput: {
          before: { [KNOWN_MODEL]: true },
          after: { [KNOWN_MODEL]: false },
        },
      },
    }]);
  });

  test("reads a persisted unavailable default so an operator can repair it", async () => {
    const previousProviderKeys = Object.fromEntries(
      ["NAUTILO_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
        .map((name) => [name, process.env[name]]),
    );
    try {
      delete process.env["NAUTILO_MODEL"];
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["OPENROUTER_API_KEY"];
      delete process.env["VENICE_API_KEY"];
      delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
      delete process.env["OPENAI_API_KEY"];
      primeServerModelConfigCache({
        id: "server",
        defaultChatModel: KNOWN_MODEL,
        conductorModel: null,
        stenographerModel: null,
        reflectionModel: null,
        memoryReviewModel: null,
        embeddingModel: null,
        imageModel: null,
        musicModel: null,
        videoModel: null, speechModel: null,
        fallbackChain: null,
        reasoningOutput: null,
        reasoningPolicy: null,
        updatedAt: new Date(),
      });
      const seenDefaults: unknown[] = [];
      const call = routeHarness({
        getCapabilities: async () => ["read_server_settings"],
        getDb: () => ({}) as never,
        getConfig: async (_db, defaults) => {
          seenDefaults.push(defaults);
          return modelConfig;
        },
        refreshConfigCache: async () => null,
        getEffectiveEmbeddingModel: () => null,
        getActiveEmbeddingSelection: () => null,
        listMediaModels,
        getEffectiveMediaModel: () => null,
      });

      const result = await call("GET", { ...requestBase, sessionUserId: "viewer" });

      expect(result).toMatchObject({ status: 200, body: { defaultChatModel: KNOWN_MODEL } });
      expect(seenDefaults).toEqual([{
        defaultChatModel: "openrouter:minimax/minimax-m3",
        fallbackChain: [],
      }]);
      expect(resolveRetainedModels([KNOWN_MODEL], { purpose: "chat-tools" })).toMatchObject([{
        id: KNOWN_MODEL,
        availability: "missing-key",
        unavailableReason: "Anthropic credential is not configured",
      }]);
    } finally {
      __resetServerModelConfigCache();
      for (const [name, value] of Object.entries(previousProviderKeys)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("keeps metadata readable when the operator host pin is unavailable", async () => {
    const previousModel = process.env["NAUTILO_MODEL"];
    const previousAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    try {
      process.env["NAUTILO_MODEL"] = KNOWN_MODEL;
      delete process.env["ANTHROPIC_API_KEY"];
      const seenDefaults: unknown[] = [];
      const call = routeHarness({
        getCapabilities: async () => ["read_server_settings"],
        getDb: () => ({}) as never,
        getConfig: async (_db, defaults) => {
          seenDefaults.push(defaults);
          return modelConfig;
        },
        refreshConfigCache: async () => null,
        getEffectiveEmbeddingModel: () => null,
        getActiveEmbeddingSelection: () => null,
        listMediaModels,
        getEffectiveMediaModel: () => null,
      });

      expect(await call("GET", { ...requestBase, sessionUserId: "viewer" })).toMatchObject({
        status: 200,
        body: { defaultChatModel: KNOWN_MODEL },
      });
      expect(seenDefaults).toEqual([{ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }]);
    } finally {
      if (previousModel === undefined) delete process.env["NAUTILO_MODEL"];
      else process.env["NAUTILO_MODEL"] = previousModel;
      if (previousAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previousAnthropicKey;
    }
  });

  test("replaces an unavailable persisted default with a runnable model", async () => {
    const previousProviderKeys = Object.fromEntries(
      ["NAUTILO_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
        .map((name) => [name, process.env[name]]),
    );
    try {
      delete process.env["NAUTILO_MODEL"];
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["OPENROUTER_API_KEY"];
      delete process.env["VENICE_API_KEY"];
      delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "test-key";
      primeServerModelConfigCache({
        id: "server",
        defaultChatModel: KNOWN_MODEL,
        conductorModel: null,
        stenographerModel: null,
        reflectionModel: null,
        memoryReviewModel: null,
        embeddingModel: null,
        imageModel: null,
        musicModel: null,
        videoModel: null, speechModel: null,
        fallbackChain: null,
        reasoningOutput: null,
        reasoningPolicy: null,
        updatedAt: new Date(),
      });
      const writes: unknown[] = [];
      const call = routeHarness({
        getCapabilities: async () => ["manage_server_operations"],
        getDb: () => ({}) as never,
        getConfig: async () => modelConfig,
        upsertConfig: async (_db, patch, defaults) => {
          writes.push({ patch, defaults });
          return { ...modelConfig, defaultChatModel: REPAIR_MODEL };
        },
        refreshConfigCache: async () => null,
        auditEvent: () => undefined,
        getEffectiveEmbeddingModel: () => null,
        getActiveEmbeddingSelection: () => null,
        listMediaModels,
        getEffectiveMediaModel: () => null,
      });

      expect(parseUpdateBodyForTests({ defaultChatModel: KNOWN_MODEL })).toMatchObject({
        ok: false,
        error: `model unavailable: ${KNOWN_MODEL} (Anthropic credential is not configured)`,
      });

      const result = await call("POST", {
        ...requestBase,
        sessionUserId: "operator",
        body: { defaultChatModel: REPAIR_MODEL },
      });

      expect(result).toMatchObject({ status: 200, body: { defaultChatModel: REPAIR_MODEL } });
      expect(writes).toEqual([{
        patch: { defaultChatModel: REPAIR_MODEL },
        defaults: { defaultChatModel: REPAIR_MODEL, fallbackChain: [] },
      }]);
    } finally {
      __resetServerModelConfigCache();
      for (const [name, value] of Object.entries(previousProviderKeys)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});


test("Memory model preserves inheritance and rejects invalid overrides", () => {
  expect(parseUpdateBodyForTests({ memoryReviewModel: null })).toEqual({ ok: true, patch: { memoryReviewModel: null } });
  expect(parseUpdateBodyForTests({ memoryReviewModel: "" })).toEqual({ ok: true, patch: { memoryReviewModel: null } });
  expect(parseUpdateBodyForTests({ memoryReviewModel: KNOWN_MODEL })).toEqual({ ok: true, patch: { memoryReviewModel: KNOWN_MODEL } });
  expect(parseUpdateBodyForTests({ memoryReviewModel: false }).ok).toBe(false);
  expect(parseUpdateBodyForTests({ memoryReviewModel: "missing:model" }).ok).toBe(false);
});

test("embedding selection distinguishes inheritance, automatic, and qualified credentials", () => {
  const previous = process.env["VENICE_API_KEY"];
  try {
    delete process.env["VENICE_API_KEY"];
    expect(parseUpdateBodyForTests({ embeddingModel: null })).toEqual({ ok: true, patch: { embeddingModel: null } });
    expect(parseUpdateBodyForTests({ embeddingModel: "" })).toEqual({ ok: true, patch: { embeddingModel: "" } });
    expect(parseUpdateBodyForTests({ embeddingModel: "venice:text-embedding-qwen3-8b" }).ok).toBe(true);
    process.env["VENICE_API_KEY"] = "synthetic-key";
    expect(parseUpdateBodyForTests({ embeddingModel: "venice:text-embedding-qwen3-8b" })).toEqual({ ok: true, patch: { embeddingModel: "venice:text-embedding-qwen3-8b" } });
    expect(parseUpdateBodyForTests({ embeddingModel: "openrouter:qwen/qwen3-embedding-8b" })).toEqual({ ok: true, patch: { embeddingModel: "openrouter:qwen/qwen3-embedding-8b" } });
    expect(parseUpdateBodyForTests({ embeddingModel: "venice:text-embedding-3-small" })).toEqual({ ok: true, patch: { embeddingModel: "venice:text-embedding-3-small" } });
    for (const embeddingModel of [false, "venice:bge-m3", KNOWN_MODEL, "text-embedding-3-small"]) {
      expect(parseUpdateBodyForTests({ embeddingModel }).ok).toBe(false);
    }
  } finally {
    if (previous === undefined) delete process.env["VENICE_API_KEY"];
    else process.env["VENICE_API_KEY"] = previous;
  }
});

test("embedding GET reports actual runtime selection and pending state after a failed refresh", async () => {
  let refreshCount = 0;
  const call = routeHarness({
    getCapabilities: async () => ["read_server_settings"],
    getDb: () => ({}) as never,
    getDefaults: () => ({ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }),
    getConfig: async () => ({ ...modelConfig, embeddingModel: "" }),
    refreshConfigCache: async () => { refreshCount++; return null; },
    getActiveEmbeddingSelection: () => "openai:text-embedding-3-small",
    getEffectiveEmbeddingModel: () => "openai:text-embedding-3-small",
  });
  const result = await call("GET", { ...requestBase, sessionUserId: "viewer" });
  expect(result).toMatchObject({ status: 200, body: {
    embeddingModel: "", effectiveEmbeddingModel: "openai:text-embedding-3-small", embeddingSelectionPending: true,
  } });
  const body = result.body as { embeddingModels: { id: string; displayName: string }[] };
  expect(body.embeddingModels.map((entry) => entry.id)).toEqual([
    "venice:text-embedding-qwen3-8b", "openrouter:qwen/qwen3-embedding-8b",
    "venice:text-embedding-3-small", "openrouter:openai/text-embedding-3-small",
    "openai:text-embedding-3-small",
  ]);
  expect(body.embeddingModels.map((entry) => entry.displayName)).toEqual([
    "Venice — text-embedding-qwen3-8b (1,536 dimensions)",
    "OpenRouter — qwen/qwen3-embedding-8b (1,536 dimensions)",
    "Venice — text-embedding-3-small (1,536 dimensions)",
    "OpenRouter — openai/text-embedding-3-small (1,536 dimensions)",
    "OpenAI — text-embedding-3-small (1,536 dimensions)",
  ]);
  expect(refreshCount).toBe(1);
});

test("media selections distinguish inheritance, automatic, supported, and unavailable values", () => {
  expect(parseUpdateBodyForTests({ imageModel: null }, listMediaModels)).toEqual({
    ok: true, patch: { imageModel: null },
  });
  expect(parseUpdateBodyForTests({ musicModel: "" }, listMediaModels)).toEqual({
    ok: true, patch: { musicModel: "" },
  });
  expect(parseUpdateBodyForTests({ videoModel: "venice:seedance-2-5-text-to-video-basic" }, listMediaModels)).toEqual({
    ok: true, patch: { videoModel: "venice:seedance-2-5-text-to-video-basic" },
  });
  expect(parseUpdateBodyForTests({ videoModel: "venice:minimax-h3-enhanced-text-to-video" }, listMediaModels)).toEqual({
    ok: false,
    error: "video generation model unavailable: venice:minimax-h3-enhanced-text-to-video (Venice credential is not configured)",
  });
  expect(parseUpdateBodyForTests({ videoModel: "venice:seedance-2-5-reference-to-video-basic" }, listMediaModels)).toEqual({
    ok: false, error: "Unsupported video generation model",
  });
});

test("media GET returns supported options and effective selections", async () => {
  const call = routeHarness({
    getCapabilities: async () => ["read_server_settings"],
    getDb: () => ({}) as never,
    getDefaults: () => ({ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }),
    getConfig: async () => ({ ...modelConfig, imageModel: "", musicModel: null, videoModel: "" }),
    refreshConfigCache: async () => null,
    listMediaModels,
    getEffectiveMediaModel: (kind) => ({
      image: "venice:gpt-image-2",
      music: "venice:sonilo-v1-1-music",
      video: "venice:seedance-2-5-text-to-video-basic",
    })[kind],
  });
  const result = await call("GET", { ...requestBase, sessionUserId: "viewer" });
  expect(result).toMatchObject({ status: 200, body: {
    imageModel: "",
    musicModel: null,
    videoModel: "",
    imageModels: MEDIA_MODELS.image,
    musicModels: MEDIA_MODELS.music,
    videoModels: MEDIA_MODELS.video,
    effectiveImageModel: "venice:gpt-image-2",
    effectiveMusicModel: "venice:sonilo-v1-1-music",
    effectiveVideoModel: "venice:seedance-2-5-text-to-video-basic",
  } });
});

test("speech selection validates catalog membership and credentials", () => {
  const previous = process.env["ELEVENLABS_API_KEY"];
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  try {
    process.env["ELEVENLABS_API_KEY"] = "synthetic-test-key";
    expect(parseUpdateBodyForTests({ speechModel: "elevenlabs:eleven_v3" })).toEqual({ ok: true, patch: { speechModel: "elevenlabs:eleven_v3" } });
    expect(parseUpdateBodyForTests({ speechModel: null })).toEqual({ ok: true, patch: { speechModel: null } });
    expect(parseUpdateBodyForTests({ speechModel: "anthropic:claude-sonnet-4-6" }).ok).toBe(false);
    expect(parseUpdateBodyForTests({ speechModel: "elevenlabs:unknown" }).ok).toBe(false);
    delete process.env["ELEVENLABS_API_KEY"];
    expect(parseUpdateBodyForTests({ speechModel: "elevenlabs:eleven_v3" }).ok).toBe(false);
  } finally {
    if (previous === undefined) delete process.env["ELEVENLABS_API_KEY"]; else process.env["ELEVENLABS_API_KEY"] = previous;
    resetRuntimeModelCatalog();
  }
});

test("speech GET reports the active runtime model when saved configuration refresh fails", async () => {
  const call = routeHarness({
    getCapabilities: async () => ["read_server_settings"],
    getDb: () => ({}) as never,
    getDefaults: () => ({ defaultChatModel: KNOWN_MODEL, fallbackChain: [] }),
    getConfig: async () => ({ ...modelConfig, speechModel: "elevenlabs:eleven_v3" }),
    refreshConfigCache: async () => null,
    getEffectiveSpeechModel: () => "elevenlabs:eleven_v3_conversational",
  });
  expect(await call("GET", { ...requestBase, sessionUserId: "viewer" })).toMatchObject({ status: 200, body: {
    speechModel: "elevenlabs:eleven_v3", effectiveSpeechModel: "elevenlabs:eleven_v3_conversational",
  } });
});
