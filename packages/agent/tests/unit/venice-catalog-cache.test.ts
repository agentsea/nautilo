import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mergeVeniceCatalogCapabilities,
  parseVeniceCatalogSnapshotResponse,
  parseVeniceListModelsResponse,
  readVeniceCatalogSnapshotSync,
  refreshVeniceCatalogCache,
  resetVeniceCatalogCacheModuleForTests,
} from "../../src/config/venice-catalog-cache";

describe("parseVeniceListModelsResponse", () => {
  test("extracts capabilities from OpenAPI-shaped payload", () => {
    const parsed = parseVeniceListModelsResponse({
      object: "list",
      type: "text",
      data: [
        {
          id: "zai-org-glm-5-1",
          model_spec: {
            capabilities: {
              supportsFunctionCalling: true,
              supportsVision: false,
              supportsReasoning: true,
              supportsReasoningEffort: false,
              supportsWebSearch: true,
              supportsE2EE: false,
            },
          },
        },
      ],
    });
    expect(parsed["zai-org-glm-5-1"]).toEqual({
      tools: true,
      vision: false,
      reasoning: true,
      e2ee: false,
      webSearch: true,
    });
  });

  test("returns empty object for malformed json", () => {
    expect(parseVeniceListModelsResponse(null)).toEqual({});
    expect(parseVeniceListModelsResponse({})).toEqual({});
    expect(parseVeniceListModelsResponse({ data: "x" })).toEqual({});
  });
});

describe("parseVeniceCatalogSnapshotResponse", () => {
  test("retains documented media presence/offline/privacy fields from a complete all-types response", () => {
    const parsed = parseVeniceCatalogSnapshotResponse({
      object: "list",
      type: "all",
      data: [
        {
          id: "seedance-2-5-text-to-video-basic",
          type: "video",
          model_spec: { offline: false, privacy: "private" },
        },
        {
          id: "sonilo-v1-1-music",
          type: "music",
          model_spec: { offline: true, privacy: "private" },
        },
      ],
    });
    expect(parsed).toEqual({
      complete: true,
      models: {
        "seedance-2-5-text-to-video-basic": {
          type: "video",
          offline: false,
          privacy: "private",
          capabilities: null,
        },
        "sonilo-v1-1-music": {
          type: "music",
          offline: true,
          privacy: "private",
          capabilities: null,
        },
      },
    });
  });

  test("decision listings retain presence without inventing chat capabilities or completeness", () => {
    const data = [{ id: "jev-latest", type: "decision", model_spec: { offline: false, privacy: "anonymized" } }];
    const all = parseVeniceCatalogSnapshotResponse({ object: "list", type: "all", data });
    expect(all?.complete).toBe(true);
    expect(all?.models["jev-latest"]).toMatchObject({ type: "decision", offline: false, privacy: "anonymized" });
    expect(all?.models["jev-latest"]?.capabilities).toBeNull();
    expect(parseVeniceCatalogSnapshotResponse({ object: "list", type: "decision", data })?.complete).toBe(false);
  });

  test("marks a response partial when its type or a row type is not documented", () => {
    expect(parseVeniceCatalogSnapshotResponse({
      object: "list",
      type: "all",
      data: [],
    })).toMatchObject({ complete: false, models: {} });
    expect(parseVeniceCatalogSnapshotResponse({
      object: "list",
      type: "all",
      data: [{ id: "unknown", type: "future-media", model_spec: {} }],
    })).toMatchObject({ complete: false, models: {} });
    expect(parseVeniceCatalogSnapshotResponse({
      object: "list",
      type: "text",
      data: [{ id: "known", type: "text", model_spec: {} }],
    })).toMatchObject({ complete: false });
  });
});

describe("mergeVeniceCatalogCapabilities", () => {
  test("uses hint when present", () => {
    const hints = new Map([
      [
        "venice:zai-org-glm-5-1",
        {
          tools: false,
          vision: true,
          reasoning: false,
          e2ee: false,
          webSearch: false,
        },
      ],
    ]);
    const base = {
      tools: true,
      vision: false,
      reasoning: false,
      e2ee: false,
      webSearch: false,
    };
    expect(mergeVeniceCatalogCapabilities(base, "venice:zai-org-glm-5-1", hints)).toEqual({
      tools: false,
      vision: true,
      reasoning: false,
      e2ee: false,
      webSearch: false,
    });
  });

  test("preserves base e2ee when hint has e2ee false but base has heuristic e2ee", () => {
    const hints = new Map([
      [
        "venice:e2ee-deepseek-v4-flash",
        {
          tools: true,
          vision: false,
          reasoning: false,
          e2ee: false,
          webSearch: false,
        },
      ],
    ]);
    const base = {
      tools: true,
      vision: false,
      reasoning: false,
      e2ee: true,
      webSearch: false,
    };
    const merged = mergeVeniceCatalogCapabilities(base, "venice:e2ee-deepseek-v4-flash", hints);
    expect(merged.e2ee).toBe(true);
  });
});

describe("refreshVeniceCatalogCache", () => {
  let tmpDir: string;
  let prevKey: string | undefined;
  let prevUrl: string | undefined;
  let prevCachePath: string | undefined;
  let prevSkip: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    resetVeniceCatalogCacheModuleForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-cache-"));
    prevKey = process.env["VENICE_API_KEY"];
    prevUrl = process.env["NAUTILO_VENICE_MODELS_URL"];
    prevCachePath = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    prevSkip = process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    prevFetch = globalThis.fetch;
    delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    process.env["VENICE_API_KEY"] = "test-key";
    process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = path.join(tmpDir, "cache.json");
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env["VENICE_API_KEY"];
    else process.env["VENICE_API_KEY"] = prevKey;
    if (prevUrl === undefined) delete process.env["NAUTILO_VENICE_MODELS_URL"];
    else process.env["NAUTILO_VENICE_MODELS_URL"] = prevUrl;
    if (prevCachePath === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = prevCachePath;
    if (prevSkip === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = prevSkip;
    resetVeniceCatalogCacheModuleForTests();
  });

  test("writes cache when fetch succeeds", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      return ({
        ok: true,
        json: async () => ({
          object: "list",
          type: "all",
          data: [
          {
            id: "zai-org-glm-5-1",
              type: "text",
              model_spec: {
                capabilities: {
                  supportsFunctionCalling: true,
                  supportsVision: false,
                  supportsReasoning: false,
                  supportsReasoningEffort: false,
                  supportsWebSearch: false,
                  supportsE2EE: false,
                },
              },
            },
          ],
        }),
      }) as unknown as Response;
    }) as unknown as typeof fetch;

    await refreshVeniceCatalogCache();

    const raw = fs.readFileSync(process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"]!, "utf8");
    const disk = JSON.parse(raw) as { models: Record<string, unknown>; fetchedAt: string; complete: boolean };
    expect(typeof disk.fetchedAt).toBe("string");
    expect(disk.complete).toBe(true);
    expect(disk.models["zai-org-glm-5-1"]).toBeDefined();
    expect(requestedUrl).toBe("https://api.venice.ai/api/v1/models?type=all");
  });

  test("does not write cache when fetch fails", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 503,
      }) as unknown as Response) as unknown as typeof fetch;

    await refreshVeniceCatalogCache();

    expect(fs.existsSync(process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"]!)).toBe(false);
  });

  test("legacy capability-only cache remains usable but never becomes complete", () => {
    fs.writeFileSync(process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"]!, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: {
        "legacy-text": {
          tools: true,
          vision: false,
          reasoning: false,
          e2ee: false,
          webSearch: false,
        },
      },
    }));
    const snapshot = readVeniceCatalogSnapshotSync();
    expect(snapshot?.complete).toBe(false);
    expect(snapshot?.models.get("legacy-text")).toMatchObject({ type: null, offline: null });
  });
});
