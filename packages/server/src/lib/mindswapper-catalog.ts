import { createHmac } from "node:crypto";
import { DEFAULT_PROVIDER_TIMEOUT_MS, type MindSwapperChatModel } from "@nautilo/agent";
import type { PersonalProviderCredentialRecord } from "@nautilo/db";
import { isApprovedMindSwapperDestination, normalizeMindSwapperBaseUrl } from "./personal-provider-destination";

const KEY_PATTERN = /^ngw_[A-Za-z0-9_-]{43}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/u;
const MAX_MODEL_ROWS = 512;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CACHED_CONNECTIONS = 256;
const MAX_CONCURRENT_REFRESHES = 16;
const REFRESH_INTERVAL_MS = 30_000;
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = Math.min(DEFAULT_PROVIDER_TIMEOUT_MS, 5_000);

type Connection = Readonly<{ baseUrl: string; apiKey: string }>;
type Snapshot = Readonly<{ models: readonly MindSwapperChatModel[]; expiresAt: number }>;
type CacheEntry = { snapshot?: Snapshot; retryAt: number; pending?: Promise<readonly MindSwapperChatModel[]> };
type CatalogueFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export function isMindSwapperModelId(id: string): boolean {
  return id.startsWith("mindswapper:");
}

export function serverMindSwapperConnection(env = process.env): Connection | null {
  const baseUrl = normalizeMindSwapperBaseUrl(env["MINDSWAPPER_BASE_URL"], env);
  const apiKey = env["MINDSWAPPER_API_KEY"]?.trim();
  return baseUrl && apiKey && KEY_PATTERN.test(apiKey) ? { baseUrl, apiKey } : null;
}

/** A domain-separated revision for the high-entropy Gateway key and its exact destination. */
export function serverMindSwapperRevision(connection: Connection): string {
  return createHmac("sha256", connection.apiKey)
    .update("nautilo.mindswapper.server-connection.v1\0")
    .update(connection.baseUrl)
    .digest("hex");
}

export function personalMindSwapperDestination(record: PersonalProviderCredentialRecord): string | null {
  const baseUrl = normalizeMindSwapperBaseUrl(record.destination);
  return record.provider === "mindswapper" && baseUrl === record.destination
    && isApprovedMindSwapperDestination(baseUrl) ? baseUrl : null;
}

export function personalMindSwapperCacheId(record: PersonalProviderCredentialRecord, baseUrl: string): string {
  return JSON.stringify(["personal", record.userId, record.id, record.revision, baseUrl]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : undefined;
}

export function parseMindSwapperModels(payload: unknown): readonly MindSwapperChatModel[] {
  const root = asRecord(payload);
  const data = root?.["data"];
  if (root?.["object"] !== "list" || !Array.isArray(data) || data.length > MAX_MODEL_ROWS) {
    throw new Error("Invalid MindSwapper model list");
  }
  const ids = new Set<string>();
  const models: MindSwapperChatModel[] = [];
  for (const item of data) {
    const row = asRecord(item);
    const id = row?.["id"];
    const gateway = asRecord(row?.["gateway"]);
    if (typeof id !== "string" || id.length > 512 || !MODEL_ID_PATTERN.test(id)
      || ids.has(id) || row?.["object"] !== "model" || !gateway
      || typeof gateway["available"] !== "boolean" || !strings(gateway["endpoints"])) {
      throw new Error("Invalid MindSwapper model row");
    }
    ids.add(id);
    if (!gateway["available"] || !gateway["endpoints"].includes("chat/completions")) continue;
    const rawOffers = gateway["chatCompletions"];
    if (rawOffers === undefined) continue;
    if (!Array.isArray(rawOffers)) throw new Error("Invalid MindSwapper Chat Completions capabilities");
    const offers: MindSwapperChatModel["offers"][number][] = [];
    for (const raw of rawOffers) {
      const offer = asRecord(raw);
      const modalities = offer?.["inputModalities"];
      const supportedParameters = offer?.["supportedParameters"];
      const maxInputTokens = offer?.["maxInputTokens"];
      const maxOutputTokens = offer?.["maxOutputTokens"];
      if (!strings(modalities) || !modalities.includes("text") || !strings(supportedParameters)
        || !positiveInteger(maxInputTokens) || !positiveInteger(maxOutputTokens)
        || !Number.isSafeInteger(maxInputTokens + maxOutputTokens)) {
        throw new Error("Invalid MindSwapper Chat Completions capability envelope");
      }
      offers.push({
        inputModalities: modalities.includes("image") ? ["text", "image"] : ["text"],
        supportedParameters, maxInputTokens, maxOutputTokens,
      });
    }
    const name = gateway["name"];
    const price = asRecord(gateway["cheapestInputPrice"]);
    const inputPerMtok = parseRate(price?.["usdPerMillion"]);
    const outputPerMtok = parseRate(price?.["outputUsdPerMillion"]);
    if (offers.length > 0) models.push({
      id: "mindswapper:" + id,
      displayName: typeof name === "string" && name.trim() ? name.trim() : id,
      offers,
      ...(inputPerMtok !== undefined && outputPerMtok !== undefined
        ? { indicativePrice: { inputPerMtok, outputPerMtok } } : {}),
    });
  }
  return models;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("MindSwapper model list has no body");
  if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) {
    await response.body.cancel();
    throw new Error("MindSwapper model list exceeds its byte limit");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid MindSwapper model response body");
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) throw new Error("MindSwapper model list exceeds its byte limit");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createMindSwapperCatalogue(
  fetcher: CatalogueFetch = globalThis.fetch,
  now: () => number = Date.now,
) {
  const entries = new Map<string, CacheEntry>();
  let active = 0;
  const current = (entry: CacheEntry | undefined) =>
    entry?.snapshot && entry.snapshot.expiresAt > now() ? entry.snapshot.models : [];

  function get(id: string, open: () => Connection | Promise<Connection>): Promise<readonly MindSwapperChatModel[]> {
    const existing = entries.get(id);
    if (existing?.pending) return existing.pending;
    if (existing && existing.retryAt > now()) return Promise.resolve(current(existing));
    if (active >= MAX_CONCURRENT_REFRESHES) return Promise.resolve(current(existing));
    if (!existing && entries.size >= MAX_CACHED_CONNECTIONS) {
      for (const [key, entry] of entries) {
        if (entry.pending) continue;
        entries.delete(key);
        break;
      }
      if (entries.size >= MAX_CACHED_CONNECTIONS) return Promise.resolve([]);
    }
    const entry = existing ?? { retryAt: 0 };
    entries.delete(id);
    entries.set(id, entry);
    active += 1;
    entry.pending = (async () => {
      try {
        const connection = await Promise.resolve().then(open);
        if (!KEY_PATTERN.test(connection.apiKey)) {
          delete entry.snapshot;
          return [];
        }
        const response = await fetcher(connection.baseUrl + "/models", {
          headers: { Authorization: "Bearer " + connection.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
          redirect: "error",
        });
        if (response.status === 401 || response.status === 403) delete entry.snapshot;
        if (!response.ok) {
          await response.body?.cancel();
          return current(entry);
        }
        const models = parseMindSwapperModels(await boundedJson(response));
        entry.snapshot = { models, expiresAt: now() + MAX_SNAPSHOT_AGE_MS };
        return models;
      } catch {
        return current(entry);
      } finally {
        entry.retryAt = now() + REFRESH_INTERVAL_MS;
        delete entry.pending;
        active -= 1;
      }
    })();
    return entry.pending;
  }

  return { get, invalidate: (id: string) => { entries.delete(id); } };
}

export const mindSwapperCatalogue = createMindSwapperCatalogue((...args) => globalThis.fetch(...args));

export function mindSwapperConfigured(env = process.env): boolean {
  return Boolean(env["MINDSWAPPER_BASE_URL"]?.trim() || env["MINDSWAPPER_APPROVED_BASE_URLS"]?.trim());
}

export function readServerMindSwapperModels(): Promise<readonly MindSwapperChatModel[]> {
  const connection = serverMindSwapperConnection();
  if (!connection) return Promise.resolve([]);
  return mindSwapperCatalogue.get("server:" + serverMindSwapperRevision(connection), () => connection);
}
