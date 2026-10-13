import { afterEach, describe, expect, test } from "bun:test";
import type { ModelCatalog } from "@nautilo/types";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  deriveSurplusMediaModelId,
  findSurplusMediaModel,
} from "../../src/providers/surplus-media-route";

function row(
  id: string,
  output: string,
  supportedParameters: string[],
  supportedFeatures: string[] = [],
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    architecture: { output_modalities: [output] },
    supported_parameters: supportedParameters,
    supported_features: supportedFeatures,
    ...metadata,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchStub(
  implementation: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: () => {} });
}

async function installCatalog(catalog: ModelCatalog): Promise<void> {
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-10-12T00:00:00.000Z",
        originUrl: "https://catalog.invalid/media-routes.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

afterEach(() => resetRuntimeModelCatalog());

describe("deriveSurplusMediaModelId", () => {
  test("derives only signed Venice generation rows using the documented spelling", () => {
    expect(deriveSurplusMediaModelId("venice:gpt-image-2")).toBe("venice-gpt-image-2");
    expect(deriveSurplusMediaModelId("venice:minimax-music-v26")).toBe("venice-minimax-music-v26");
    expect(deriveSurplusMediaModelId("openai:gpt-image-2")).toBeNull();
    expect(deriveSurplusMediaModelId("venice:openai-gpt-6-sol")).toBeNull();
    expect(deriveSurplusMediaModelId("venice:not-in-the-signed-catalog")).toBeNull();
  });

  test("excludes disabled, E2EE, and China-routed signed generation rows", async () => {
    const current = getActiveModelCatalogSync().catalog;
    const source = current.entries.find(
      (entry) => entry.id === "venice:seedance-2-5-text-to-video-basic",
    );
    if (!source) throw new Error("signed video fixture is missing");
    const disabled = { ...source, id: "venice:disabled-generation", defaultEnabled: false };
    const e2ee = {
      ...source,
      id: "venice:e2ee-generation",
      privacy: { grade: 10, label: "e2ee" as const },
    };
    const china = {
      ...source,
      id: "venice:china-generation",
      routing: "china-anonymized" as const,
    };
    await installCatalog({
      ...current,
      catalogVersion: "2026.10.12.1",
      entries: [disabled, e2ee, china],
    } as ModelCatalog);

    expect(deriveSurplusMediaModelId(disabled.id)).toBeNull();
    expect(deriveSurplusMediaModelId(e2ee.id)).toBeNull();
    expect(deriveSurplusMediaModelId(china.id)).toBeNull();
  });
});

describe("findSurplusMediaModel", () => {
  test("uses authenticated read-only discovery and accepts one exact image contract", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const found = await findSurplusMediaModel({
      catalogModelId: "venice:gpt-image-2",
      family: "image",
      apiKey: "same-account-key",
      fetchImpl: fetchStub(async (url, init) => {
        observedUrl = typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : url.url;
        observedInit = init;
        return response({ data: [row(
          "venice-gpt-image-2",
          "image",
          ["prompt", "model", "n", "response_format"],
          ["image", "quality"],
        )] });
      }),
    });

    expect(found).toBe(true);
    expect(observedUrl).toBe("https://api.surplusintelligence.ai/v1/models");
    expect(observedInit).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", Authorization: "Bearer same-account-key" },
    });
    expect(observedInit?.body).toBeUndefined();
  });

  test("requires exact identity and rejects missing, other-version, or duplicate rows", async () => {
    const check = (data: unknown[]) => findSurplusMediaModel({
      catalogModelId: "venice:gpt-image-2",
      family: "image",
      apiKey: "key",
      fetchImpl: fetchStub(async () => response({ data })),
    });
    const contract = row("venice-gpt-image-2", "image", ["prompt", "model"], ["image"]);
    expect(await check([])).toBe(false);
    expect(await check([row("venice-gpt-image-2-fast", "image", ["prompt", "model"], ["image"])]))
      .toBe(false);
    expect(await check([contract, contract])).toBe(false);
  });

  test("requires the advertised family and operation transport traits", async () => {
    const check = (catalogModelId: string, family: "image" | "video" | "music", value: unknown) =>
      findSurplusMediaModel({
        catalogModelId,
        family,
        apiKey: "key",
        fetchImpl: fetchStub(async () => response({ data: [value] })),
      });

    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "video", ["prompt", "model"], ["image"]))).toBe(false);
    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "image", ["prompt"], ["image"]))).toBe(false);
    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "image", ["prompt", "model", "response_format"], ["image"]))).toBe(false);
    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "image", ["prompt", "model", "n"], ["image"]))).toBe(false);
    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "image", ["prompt", "model"], []))).toBe(false);
    expect(await check("venice:gpt-image-2", "image",
      row("venice-gpt-image-2", "image", ["prompt", "model", "n", "response_format"], ["image"]))).toBe(false);

    const videoParameters = ["async", "text-to-video", "artifact"];
    expect(await check("venice:seedance-2-5-text-to-video-basic", "video",
      row("venice-seedance-2-5-text-to-video-basic", "video", videoParameters))).toBe(true);
    expect(await check("venice:seedance-2-5-text-to-video-basic", "video",
      row("venice-seedance-2-5-text-to-video-basic", "video", ["async", "artifact"]))).toBe(false);

    const musicParameters = ["async", "music", "artifact", "instrumental", "lyrics"];
    expect(await check("venice:minimax-music-v26", "music",
      row("venice-minimax-music-v26", "music", musicParameters))).toBe(true);
    expect(await check("venice:minimax-music-v26", "music",
      row("venice-minimax-music-v26", "audio", musicParameters))).toBe(false);
    expect(await check("venice:minimax-music-v26", "music",
      row("venice-minimax-music-v26", "music", musicParameters.filter((item) => item !== "lyrics"))))
      .toBe(false);
  });

  test("requires the exact advertised settings for the signed Seedance 2.5 row", async () => {
    const catalogModelId = "venice:seedance-2-5-text-to-video-basic";
    const supportedParameters = ["async", "text-to-video", "artifact", "audio"];
    const exactRow = row(
      "venice-seedance-2-5-text-to-video-basic",
      "video",
      supportedParameters,
      [],
      {
        durations_seconds: [4, 5, 10, 30],
        aspect_ratios: ["16:9", "9:16"],
        resolutions: ["480p", "720p"],
      },
    );
    const check = (value: unknown, requirements = {
      durationSeconds: 10,
      aspectRatio: "16:9",
      resolution: "720p",
      audio: false,
    }) => findSurplusMediaModel({
      catalogModelId,
      family: "video",
      apiKey: "key",
      requirements,
      fetchImpl: fetchStub(async () => response({ data: [value] })),
    });

    expect(await check(exactRow)).toBe(true);
    expect(await check({ ...exactRow, durations_seconds: [4, 5, 30] })).toBe(false);
    expect(await check({ ...exactRow, aspect_ratios: ["9:16"] })).toBe(false);
    expect(await check({ ...exactRow, resolutions: ["480p"] })).toBe(false);
    expect(await check({ ...exactRow, supported_parameters: supportedParameters.filter(
      (parameter) => parameter !== "audio",
    ) })).toBe(false);
    expect(await check(row(
      "venice-seedance-2-fast-t2v",
      "video",
      supportedParameters,
      [],
      {
        durations_seconds: [10],
        aspect_ratios: ["16:9"],
        resolutions: ["720p"],
      },
    ))).toBe(false);
  });

  test("rejects a signed-family mismatch and video requirements on another family before fetching", async () => {
    let fetchCount = 0;
    const fetchImpl = fetchStub(async () => {
      fetchCount += 1;
      return response({ data: [] });
    });
    expect(await findSurplusMediaModel({
      catalogModelId: "venice:gpt-image-2",
      family: "video",
      apiKey: "key",
      fetchImpl,
    })).toBe(false);
    expect(await findSurplusMediaModel({
      catalogModelId: "venice:gpt-image-2",
      family: "image",
      apiKey: "key",
      requirements: { resolution: "720p" },
      fetchImpl,
    })).toBe(false);
    expect(fetchCount).toBe(0);
  });

  test("fails closed for malformed, HTTP, and network results while forwarding cancellation", async () => {
    const base = {
      catalogModelId: "venice:gpt-image-2",
      family: "image" as const,
      apiKey: "key",
    };
    expect(await findSurplusMediaModel({
      ...base,
      fetchImpl: fetchStub(async () => new Response("not-json")),
    })).toBe(false);
    expect(await findSurplusMediaModel({
      ...base,
      fetchImpl: fetchStub(async () => response({ data: "not-an-array" })),
    })).toBe(false);
    let cancelled = false;
    const nonOkBody = new ReadableStream({
      cancel() { cancelled = true; },
    });
    expect(await findSurplusMediaModel({
      ...base,
      fetchImpl: fetchStub(async () => new Response(nonOkBody, { status: 503 })),
    })).toBe(false);
    expect(cancelled).toBe(true);
    expect(await findSurplusMediaModel({
      ...base,
      fetchImpl: fetchStub(async () => { throw new Error("network unavailable"); }),
    })).toBe(false);

    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    await findSurplusMediaModel({
      ...base,
      signal: controller.signal,
      fetchImpl: fetchStub(async (_url, init) => {
        observedSignal = init?.signal;
        return response({ data: [] });
      }),
    });
    expect(observedSignal).toBe(controller.signal);
  });
});
