import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { log } from "@nautilo/logger";
import type {
  ModelCapabilitiesCacheFile,
  ModelCapabilityFeatures,
  ModelInputModality,
  ModelOutputModality,
  OpenRouterCapabilitySnapshot,
} from "./types";
import { fetchOpenRouterCapabilitiesSnapshot } from "./openrouter";

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function defaultCachePath(): string {
  const override = process.env["NAUTILO_MODEL_CAP_CACHE_PATH"];
  if (override?.trim()) return override.trim();
  return path.join(homedir(), ".nautilo", "model-capabilities-cache.json");
}

let memoryCache: ModelCapabilitiesCacheFile | null = null;
let hydratePromise: Promise<void> | null = null;

const INPUT_MODALITIES = new Set<ModelInputModality>(["text", "image", "file"]);
const OUTPUT_MODALITIES = new Set<ModelOutputModality>(["text", "image"]);

function parseFeatures(raw: unknown): ModelCapabilityFeatures | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const visualGrounding = r["visualGrounding"];
  return {
    tools: r["tools"] === true,
    structuredOutputs: r["structuredOutputs"] === true,
    reasoning: r["reasoning"] === true,
    ...(visualGrounding === true || visualGrounding === false || visualGrounding === null
      ? { visualGrounding }
      : {}),
  };
}

function parseSnapshot(raw: unknown): OpenRouterCapabilitySnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["input"]) || !Array.isArray(r["output"])) return null;
  const input = r["input"].filter((m): m is ModelInputModality =>
    typeof m === "string" && INPUT_MODALITIES.has(m as ModelInputModality),
  );
  const output = r["output"].filter((m): m is ModelOutputModality =>
    typeof m === "string" && OUTPUT_MODALITIES.has(m as ModelOutputModality),
  );
  if (input.length === 0 || output.length === 0) return null;
  const features = parseFeatures(r["features"]);
  return {
    input,
    output,
    ...(features ? { features } : {}),
  };
}

function parseCacheFile(raw: unknown): ModelCapabilitiesCacheFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed["fetchedAt"] !== "string" || Number.isNaN(Date.parse(parsed["fetchedAt"]))) return null;
  const rawModels = parsed["models"];
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return null;
  const models: ModelCapabilitiesCacheFile["models"] = {};
  for (const [id, value] of Object.entries(rawModels as Record<string, unknown>)) {
    const snap = parseSnapshot(value);
    if (snap) models[id] = snap;
  }
  return { fetchedAt: parsed["fetchedAt"], models };
}

export function getCachedOpenRouterModels(): ModelCapabilitiesCacheFile | null {
  return memoryCache;
}

export async function readCapabilitiesCacheFromDisk(
  filePath?: string,
): Promise<ModelCapabilitiesCacheFile | null> {
  const p = filePath ?? defaultCachePath();
  try {
    const raw = await fsp.readFile(p, "utf8");
    return parseCacheFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeCapabilitiesCacheToDisk(
  data: ModelCapabilitiesCacheFile,
  filePath?: string,
): Promise<void> {
  const p = filePath ?? defaultCachePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function cacheFresh(cache: ModelCapabilitiesCacheFile): boolean {
  const t = Date.parse(cache.fetchedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CACHE_MAX_AGE_MS;
}

/**
 * Load disk cache into memory and optionally refresh from OpenRouter when
 * `OPENROUTER_API_KEY` is set and the cache is missing or stale.
 * Safe to call multiple times — concurrent calls share one promise.
 */
export function hydrateModelCapabilitiesCache(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const disk = await readCapabilitiesCacheFromDisk();
    if (disk) memoryCache = disk;

    const key = process.env["OPENROUTER_API_KEY"]?.trim();
    const force = process.env["NAUTILO_REFRESH_MODEL_CAPS"] === "1";
    const needsNetwork =
      !!key && (!memoryCache || !cacheFresh(memoryCache) || force);

    if (!needsNetwork) {
      if (!memoryCache) {
        log("[model-capabilities] no cache on disk; using defaults/overrides only until OpenRouter import runs");
      }
      return;
    }

    try {
      const snap = await fetchOpenRouterCapabilitiesSnapshot(key);
      memoryCache = snap;
      await writeCapabilitiesCacheToDisk(snap);
      log(`[model-capabilities] imported OpenRouter catalog (${Object.keys(snap.models).length} models) at ${snap.fetchedAt}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[model-capabilities] OpenRouter import failed (continuing with overrides/disk): ${msg}`);
    }
  })();
  return hydratePromise;
}

/** Test helper — reset in-memory cache between tests */
export function resetModelCapabilitiesCacheForTests(): void {
  memoryCache = null;
  hydratePromise = null;
}

/** Test helper — seed in-memory cache without touching disk/network. */
export function setModelCapabilitiesCacheForTests(cache: ModelCapabilitiesCacheFile | null): void {
  memoryCache = cache;
  hydratePromise = null;
}
