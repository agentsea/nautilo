import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

const SAMPLE = {
  defaultChatModel: "anthropic:claude-sonnet-4-6",
  conductorModel: "google:gemini-3.1-flash-lite-preview",
  stenographerModel: "openai:gpt-5.4-mini",
  reflectionModel: "anthropic:claude-haiku-4-5",
  memoryReviewModel: null,
  embeddingModel: "",
  effectiveEmbeddingModel: "venice:text-embedding-3-small",
  embeddingSelectionPending: false,
  embeddingModels: [{
    id: "venice:text-embedding-3-small",
    displayName: "Text Embedding 3 Small (Venice)",
    available: true,
  }],
  imageModel: "",
  musicModel: null,
  videoModel: "venice:seedance-2-5-text-to-video-basic",
  effectiveImageModel: "venice:gpt-image-2",
  effectiveMusicModel: "venice:sonilo-v1-1-music",
  effectiveVideoModel: "venice:seedance-2-5-text-to-video-basic",
  imageModels: [{
    id: "venice:gpt-image-2", displayName: "GPT Image 2", provider: "venice", available: true,
  }],
  musicModels: [{
    id: "venice:sonilo-v1-1-music", displayName: "Sonilo", provider: "venice", available: true,
  }],
  videoModels: [{
    id: "venice:seedance-2-5-text-to-video-basic", displayName: "Seedance", provider: "venice", available: true,
  }],
  fallbackChain: ["openai:gpt-5.4-mini"],
  reasoningOutput: { "anthropic:claude-sonnet-4-6": false },
  reasoningPolicy: { defaultEffort: "high" as const, overrides: {} },
};

describe("admin.serverModels HTTP contract (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("get — GET /api/admin/server-models, parses response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(SAMPLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.serverModels.get();
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/server-models");
    expect(out).toEqual(SAMPLE);
  });

  test("get — defaults embedding fields for an older server response", async () => {
    const {
      embeddingModel: _embeddingModel,
      effectiveEmbeddingModel: _effectiveEmbeddingModel,
      embeddingSelectionPending: _embeddingSelectionPending,
      embeddingModels: _embeddingModels,
      imageModel: _imageModel,
      musicModel: _musicModel,
      videoModel: _videoModel,
      effectiveImageModel: _effectiveImageModel,
      effectiveMusicModel: _effectiveMusicModel,
      effectiveVideoModel: _effectiveVideoModel,
      imageModels: _imageModels,
      musicModels: _musicModels,
      videoModels: _videoModels,
      ...olderSample
    } = SAMPLE;
    globalThis.fetch = (async () => new Response(JSON.stringify(olderSample), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const out = await client.admin.serverModels.get();

    expect(out.embeddingModel).toBeNull();
    expect(out.effectiveEmbeddingModel).toBeNull();
    expect(out.embeddingSelectionPending).toBe(false);
    expect(out.embeddingModels).toEqual([]);
    expect(out.imageModel).toBeNull();
    expect(out.musicModel).toBeNull();
    expect(out.videoModel).toBeNull();
    expect(out.effectiveImageModel).toBeNull();
    expect(out.effectiveMusicModel).toBeNull();
    expect(out.effectiveVideoModel).toBeNull();
    expect(out.imageModels).toEqual([]);
    expect(out.musicModels).toEqual([]);
    expect(out.videoModels).toEqual([]);
  });

  test("set — POST /api/admin/server-models with body, parses response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown = null;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify(SAMPLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.serverModels.set({
      conductorModel: "google:gemini-3.1-flash-lite-preview",
      stenographerModel: "openai:gpt-5.4-mini",
      reflectionModel: "anthropic:claude-haiku-4-5",
      memoryReviewModel: null,
      embeddingModel: "openai:text-embedding-3-small",
      imageModel: "",
      musicModel: null,
      videoModel: "venice:seedance-2-5-text-to-video-basic",
      fallbackChain: ["openai:gpt-5.4-mini"],
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/server-models");
    expect(seenBody).toEqual({
      conductorModel: "google:gemini-3.1-flash-lite-preview",
      stenographerModel: "openai:gpt-5.4-mini",
      reflectionModel: "anthropic:claude-haiku-4-5",
      memoryReviewModel: null,
      embeddingModel: "openai:text-embedding-3-small",
      imageModel: "",
      musicModel: null,
      videoModel: "venice:seedance-2-5-text-to-video-basic",
      fallbackChain: ["openai:gpt-5.4-mini"],
    });
    expect(out).toEqual(SAMPLE);
  });
});
