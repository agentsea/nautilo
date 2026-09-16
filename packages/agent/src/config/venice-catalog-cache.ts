import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveNautiloRuntimePaths } from "@nautilo/config";
import { log } from "@nautilo/logger";
import type { EligibleModelCapabilities } from "@nautilo/trust";
import { VENICE_MODELS_LIST_URL } from "../providers/venice-api";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface VeniceParsedCaps {
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly e2ee: boolean;
  readonly webSearch: boolean;
}

/** Types enumerated by Venice's `GET /models` API reference. */
export type VeniceListedModelType =
  | "asr"
  | "embedding"
  | "image"
  | "inpaint"
  | "music"
  | "text"
  | "tts"
  | "upscale"
  | "video";

/**
 * A non-secret, evidence-only row from Venice's list response. `null` means
 * the response/cached legacy shape did not assert that field. In particular,
 * this deliberately has no inferred beta, reference, or generation-limit
 * fields: Venice's public list response does not document them.
 */
export interface VeniceCatalogModelHint {
  readonly type: VeniceListedModelType | null;
  readonly offline: boolean | null;
  readonly privacy: string | null;
  readonly capabilities: VeniceParsedCaps | null;
}

interface VeniceModelsCacheFile {
  readonly fetchedAt: string;
  /** Only true for a validated successful `GET /models?type=all` payload. */
  readonly complete: boolean;
  /** Keys: Venice API `id` (no `venice:` prefix). */
  readonly models: Record<string, VeniceCatalogModelHint>;
}

/** Disk snapshot metadata needed to make absence/offline decisions safely. */
export interface VeniceCatalogSnapshot {
  readonly fetchedAt: string;
  readonly complete: boolean;
  readonly models: ReadonlyMap<string, VeniceCatalogModelHint>;
}

let refreshInflight: Promise<void> | null = null;
let loggedDefaultsFallback = false;

export function resetVeniceCatalogCacheModuleForTests(): void {
  refreshInflight = null;
  loggedDefaultsFallback = false;
}

function cacheFilePath(): string {
  const env = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"]?.trim();
  if (env) return env;
  const { dataDir } = resolveNautiloRuntimePaths();
  return path.join(dataDir, "venice-models-catalog.json");
}

function parseModelSpecCaps(raw: unknown): VeniceParsedCaps | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const caps = spec["capabilities"];
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const c = caps as Record<string, unknown>;
  return {
    tools: c["supportsFunctionCalling"] === true,
    vision: c["supportsVision"] === true,
    reasoning: c["supportsReasoning"] === true || c["supportsReasoningEffort"] === true,
    e2ee: c["supportsE2EE"] === true,
    webSearch: c["supportsWebSearch"] === true,
  };
}

function parseVeniceModelType(raw: unknown): VeniceListedModelType | null {
  switch (raw) {
    case "asr":
    case "embedding":
    case "image":
    case "inpaint":
    case "music":
    case "text":
    case "tts":
    case "upscale":
    case "video":
      return raw;
    default:
      return null;
  }
}

function parseVeniceCatalogModel(raw: unknown): [string, VeniceCatalogModelHint] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = item["id"];
  if (typeof id !== "string" || !id.trim()) return null;
  const spec = item["model_spec"];
  const modelSpec = spec && typeof spec === "object" && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)
    : null;
  const privacy = modelSpec?.["privacy"];
  return [
    id.trim(),
    {
      type: parseVeniceModelType(item["type"]),
      offline: typeof modelSpec?.["offline"] === "boolean" ? modelSpec["offline"] : null,
      // Keep a bounded non-secret diagnostic value, but never use it to
      // replace the signed catalog's privacy routing/grade semantics.
      privacy: typeof privacy === "string" && privacy.length <= 128 ? privacy : null,
      capabilities: parseModelSpecCaps(spec),
    },
  ];
}

/**
 * Parses a Venice list response into a snapshot. A response is complete only
 * when it explicitly identifies itself as the all-types list and every row is
 * present with a documented type. This deliberately errs toward `false`: an
 * incomplete response must never make a signed fallback row unavailable.
 */
export function parseVeniceCatalogSnapshotResponse(
  json: unknown,
): Pick<VeniceModelsCacheFile, "complete" | "models"> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const data = root["data"];
  if (!Array.isArray(data)) return null;
  const models = Object.create(null) as Record<string, VeniceCatalogModelHint>;
  let allRowsDocumented = true;
  for (const item of data) {
    const parsed = parseVeniceCatalogModel(item);
    if (!parsed || parsed[1].type === null || models[parsed[0]] !== undefined) {
      allRowsDocumented = false;
      continue;
    }
    models[parsed[0]] = parsed[1];
  }
  return {
    complete: root["object"] === "list"
      && root["type"] === "all"
      && allRowsDocumented
      && Object.keys(models).length > 0,
    models,
  };
}

/** Parses cached `GET /api/v1/models?type=all` JSON into sku → caps. Does not infer routing (local catalog is authoritative). */
export function parseVeniceListModelsResponse(json: unknown): Record<string, VeniceParsedCaps> {
  const out: Record<string, VeniceParsedCaps> = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  const data = (json as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>)["id"];
    if (typeof id !== "string" || !id.trim()) continue;
    const parsed = parseModelSpecCaps((item as Record<string, unknown>)["model_spec"]);
    if (parsed) out[id.trim()] = parsed;
  }
  return out;
}

function parseCacheFile(raw: unknown): VeniceModelsCacheFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["fetchedAt"] !== "string" || Number.isNaN(Date.parse(r["fetchedAt"]))) return null;
  const models = r["models"];
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const cleaned = Object.create(null) as Record<string, VeniceCatalogModelHint>;
  let allRowsParsed = true;
  for (const [sku, v] of Object.entries(models as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      allRowsParsed = false;
      continue;
    }
    const o = v as Record<string, unknown>;
    const oldCapsOnly = !("capabilities" in o) && !("type" in o);
    cleaned[sku] = {
      type: oldCapsOnly ? null : parseVeniceModelType(o["type"]),
      offline: typeof o["offline"] === "boolean" ? o["offline"] : null,
      privacy: typeof o["privacy"] === "string" && o["privacy"].length <= 128 ? o["privacy"] : null,
      capabilities: oldCapsOnly
        ? {
            tools: o["tools"] === true,
            vision: o["vision"] === true,
            reasoning: o["reasoning"] === true,
            e2ee: o["e2ee"] === true,
            webSearch: o["webSearch"] === true,
          }
        : parseModelSpecCaps({ capabilities: o["capabilities"] }),
    };
  }
  // Legacy capability-only files deliberately remain readable, but cannot be
  // treated as a complete all-types snapshot for absence/offline denial.
  const complete = r["complete"] === true
    && allRowsParsed
    && Object.keys(cleaned).length > 0
    && Object.values(cleaned).every((model) => model.type !== null);
  return { fetchedAt: r["fetchedAt"], complete, models: cleaned };
}

function loadVeniceModelsCacheFromDisk(): VeniceModelsCacheFile | null {
  try {
    const text = fs.readFileSync(cacheFilePath(), "utf8");
    return parseCacheFile(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function cacheFresh(fetchedAt: string): boolean {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  const age = Date.now() - t;
  return age >= 0 && age < TTL_MS;
}

/** Synchronously reads the cached list snapshot; no network is ever used. */
export function readVeniceCatalogSnapshotSync(): VeniceCatalogSnapshot | null {
  const disk = loadVeniceModelsCacheFromDisk();
  if (!disk) return null;
  return {
    fetchedAt: disk.fetchedAt,
    complete: disk.complete,
    models: new Map(Object.entries(disk.models)),
  };
}

/** A stale, partial, or failed snapshot must not narrow signed fallbacks. */
export function isVeniceCatalogSnapshotFresh(snapshot: VeniceCatalogSnapshot): boolean {
  return cacheFresh(snapshot.fetchedAt);
}

/**
 * Sync map keyed by `venice:${sku}` for lookup from eligible-model ids.
 * Empty map when no readable cache; picker still works via static defaults.
 */
export function readVeniceCapabilityHintsSync(): Map<string, VeniceParsedCaps> {
  const disk = loadVeniceModelsCacheFromDisk();
  const map = new Map<string, VeniceParsedCaps>();
  if (!disk) {
    return map;
  }
  for (const [sku, hint] of Object.entries(disk.models)) {
    if (hint.capabilities) map.set(`venice:${sku}`, hint.capabilities);
  }
  if (map.size === 0 && process.env["VENICE_API_KEY"]?.trim() && !loggedDefaultsFallback) {
    loggedDefaultsFallback = true;
    log("[nautilo/venice] capability cache empty on disk — using static defaults until refresh");
  }
  return map;
}

export function mergeVeniceCatalogCapabilities(
  base: EligibleModelCapabilities,
  fullVeniceId: string,
  hints: ReadonlyMap<string, VeniceParsedCaps>,
): EligibleModelCapabilities {
  const hint = hints.get(fullVeniceId);
  if (!hint) return base;
  return {
    tools: hint.tools,
    vision: hint.vision,
    reasoning: hint.reasoning,
    e2ee: hint.e2ee || base.e2ee,
    webSearch: hint.webSearch,
  };
}

async function writeVeniceCacheFile(payload: VeniceModelsCacheFile): Promise<void> {
  const p = cacheFilePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function refreshVeniceCatalogCache(): Promise<void> {
  const key = process.env["VENICE_API_KEY"]?.trim();
  if (!key) {
    log("[nautilo/venice] skip network refresh — VENICE_API_KEY not set");
    return;
  }
  const url = process.env["NAUTILO_VENICE_MODELS_URL"]?.trim() ?? VENICE_MODELS_LIST_URL;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      log(`[nautilo/venice] GET models failed status=${res.status}`);
      return;
    }
    const json: unknown = await res.json();
    const parsed = parseVeniceCatalogSnapshotResponse(json);
    if (!parsed) {
      log("[nautilo/venice] GET models returned no parsable list payload — cache not updated");
      return;
    }
    const payload: VeniceModelsCacheFile = {
      fetchedAt: new Date().toISOString(),
      complete: parsed.complete,
      models: parsed.models,
    };
    await writeVeniceCacheFile(payload);
    log(`[nautilo/venice] catalog refreshed (${Object.keys(parsed.models).length} skus; complete=${parsed.complete})`);
  } catch (e) {
    log(`[nautilo/venice] catalog refresh error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** When cache is missing or past TTL and a Venice key exists, refresh in the background (single-flight). */
export function scheduleVeniceCatalogRefreshIfNeeded(): void {
  if (process.env["NAUTILO_SKIP_VENICE_REFRESH"] === "1") return;

  const key = process.env["VENICE_API_KEY"]?.trim();
  if (!key) return;

  const disk = loadVeniceModelsCacheFromDisk();
  if (disk && cacheFresh(disk.fetchedAt)) return;

  if (refreshInflight) return;
  refreshInflight = refreshVeniceCatalogCache().finally(() => {
    refreshInflight = null;
  });
}
