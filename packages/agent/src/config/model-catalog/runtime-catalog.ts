/**
 * Runtime model-catalog seam.
 *
 * A narrow, process-wide wrapper around {@link createRemoteModelCatalogLoader}
 * that wires the tested bounded signed-pointer loader into the resolved
 * catalog, picker, model resolver, exact validator, and discover_models.
 *
 * Guarantees:
 *   - Official-product default pointer URL ships in source:
 *     {@link OFFICIAL_MODEL_CATALOG_POINTER_URL} (`https://media.nautilo.ai/models/v4/latest.json`).
 *     `NAUTILO_MODEL_CATALOG_POINTER_URL` is an OPTIONAL deployment / self-host
 *     override; `null` via the seam disables remote fetching entirely.
 *   - The loader is a cached singleton shared across calls, so its TTL /
 *     stale-while-revalidate / last-known-good cache persists between reads.
 *   - The signed-pointer transport + verification semantics are inherited
 *     verbatim (allowlisted HTTPS origin, byte cap, timeout, strict schema,
 *     Ed25519 signature, exact SHA-256, last-known-good, checked-in fallback).
 *   - No caller-supplied URL is ever accepted: the only URLs this seam ever
 *     fetches are the resolved official pointer URL (default, env override, or
 *     explicit seam) plus the derived same-origin immutable manifest. Tool
 *     callers receive no URL-parameter knob.
 *   - No Task dispatch / request path awaits a network request. The sync
 *     {@link getActiveModelCatalogSync} reads an atomic in-memory snapshot and
 *     NEVER blocks on the network; server boot may start/await a bounded
 *     {@link hydrateRuntimeModelCatalog}; hot reads kick an async
 *     single-flight refresh (stale-while-revalidate) but serve the current
 *     snapshot immediately.
 *   - Deterministic and testable: tests inject a fake loader or remote config
 *     (fetchImpl / clock / trustedKeys) via {@link configureRuntimeModelCatalog}
 *     and reset with {@link resetRuntimeModelCatalog}. No test performs real
 *     network I/O.
 */
import type { ModelCatalog, ModelCatalogResultSource } from "@nautilo/types";
import { replaceActiveModelCapabilityCatalog } from "@nautilo/model-capabilities";
import { localModelCatalog } from "./catalog";
import {
  createRemoteModelCatalogLoader,
  type RemoteModelCatalogConfig,
  type RemoteModelCatalogLoader,
  type RemoteModelCatalogResult,
} from "./remote-catalog";

/**
 * Verified official default model-catalog release-pointer URL. Ordinary
 * official-product users fetch this pointer, which CI republishes as the
 * minimal signed `{catalogVersion, artifactSha256, signature, signingKeyId}`
 * document; the immutable manifest is derived from it.
 */
export const OFFICIAL_MODEL_CATALOG_POINTER_URL = "https://media.nautilo.ai/models/v4/latest.json";

/** Optional deployment / self-host override: release-pointer URL. */
const MODEL_CATALOG_POINTER_URL_ENV = "NAUTILO_MODEL_CATALOG_POINTER_URL";

/**
 * Safe, narrowly typed provenance exposed to discovery callers. The raw
 * pointer/manifest URL, host, headers, signing keys, and provider credentials
 * are never represented here.
 */
export interface ModelCatalogProvenance {
  readonly source: ModelCatalogResultSource;
  readonly stale: boolean;
  readonly catalogVersion: string | null;
}

export interface RuntimeModelCatalogOptions {
  /** Test seam: inject a fully-formed loader to bypass real network I/O. */
  readonly loader?: RemoteModelCatalogLoader;
  /**
   * The official release-pointer URL to fetch. `undefined` => resolve from env
   * override or the official default. `null` => disable remote fetching
   * entirely (serve the checked-in local fallback without any network call).
   */
  readonly catalogPointerUrl?: string | null;
  /** Additional remote-loader config (fetchImpl, clock, TTL, byte cap, timeout, trustedKeys). */
  readonly remoteConfig?: Omit<RemoteModelCatalogConfig, "catalogPointerUrl">;
  /** Process refresh-throttle clock seam. Defaults to Date.now. */
  readonly refreshNow?: () => number;
  /** Minimum milliseconds between refresh attempt starts. Defaults to 60s. */
  readonly minRefreshIntervalMs?: number;
}

const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60_000;
let runtimeLoader: RemoteModelCatalogLoader | null = null;
let runtimeOptions: RuntimeModelCatalogOptions = {};
/** Atomic in-memory snapshot of the last-validated remote catalog (or null). */
let activeSnapshot: { catalog: ModelCatalog; provenance: ModelCatalogProvenance } | null = null;
let refreshAndPublishInflight: Promise<RemoteModelCatalogResult> | null = null;
let lastRefreshAttemptStartedAt: number | null = null;
let runtimeGeneration = 0;

function publishCapabilityProjection(catalog: ModelCatalog): void {
  replaceActiveModelCapabilityCatalog(
    catalog.entries.map((entry) => ({
      id: entry.id,
      ...(entry.modalities ? { modalities: entry.modalities } : {}),
      ...(entry.features ? { features: entry.features } : {}),
      ...(entry.capabilityProvenance
        ? { capabilityProvenance: entry.capabilityProvenance }
        : {}),
    })),
  );
}

// Synchronous consumers see the checked-in signed fallback before hydration.
publishCapabilityProjection(localModelCatalog);

interface RuntimeCatalogTarget {
  readonly pointerUrl: string | null;
}

function resolveRuntimeCatalogTarget(): RuntimeCatalogTarget {
  const optPointer = runtimeOptions.catalogPointerUrl;
  if (optPointer !== undefined) {
    return { pointerUrl: optPointer };
  }
  const envPointer = process.env[MODEL_CATALOG_POINTER_URL_ENV];
  if (envPointer !== undefined && envPointer.trim() !== "") {
    return { pointerUrl: envPointer.trim() };
  }
  return { pointerUrl: OFFICIAL_MODEL_CATALOG_POINTER_URL };
}

function buildLoader(): RemoteModelCatalogLoader {
  if (runtimeOptions.loader) {
    return runtimeOptions.loader;
  }
  const { pointerUrl } = resolveRuntimeCatalogTarget();
  const config: RemoteModelCatalogConfig = {
    ...runtimeOptions.remoteConfig,
    ...(pointerUrl === null ? {} : { catalogPointerUrl: pointerUrl }),
  };
  return createRemoteModelCatalogLoader(config);
}

function getRuntimeLoader(): RemoteModelCatalogLoader {
  if (runtimeLoader === null) {
    runtimeLoader = buildLoader();
  }
  return runtimeLoader;
}

/**
 * Configure the runtime seam (process-level). Resets any cached loader and
 * active snapshot so the next access rebuilds from these options. Intended for
 * test injection and boot-time configuration; never call this from a tool with
 * caller-supplied data.
 */
export function configureRuntimeModelCatalog(options: RuntimeModelCatalogOptions): void {
  runtimeOptions = options;
  runtimeLoader = null;
  activeSnapshot = null;
  refreshAndPublishInflight = null;
  lastRefreshAttemptStartedAt = null;
  runtimeGeneration += 1;
  publishCapabilityProjection(localModelCatalog);
}

/** Reset the runtime seam to official defaults (clears any injected loader). */
export function resetRuntimeModelCatalog(): void {
  runtimeOptions = {};
  runtimeLoader = null;
  activeSnapshot = null;
  refreshAndPublishInflight = null;
  lastRefreshAttemptStartedAt = null;
  runtimeGeneration += 1;
  publishCapabilityProjection(localModelCatalog);
}

function refreshClock(): number {
  return (runtimeOptions.refreshNow ?? Date.now)();
}

function minRefreshIntervalMs(): number {
  return Math.max(0, runtimeOptions.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS);
}

/**
 * Publish a loader result into the process-wide atomic snapshot.
 *
 * A validated remote result always replaces the current snapshot. A checked-in
 * fallback may initialize an empty process, but never replaces an existing
 * remote snapshot: one failed refresh cannot discard the process-level LKG.
 */
function publishRuntimeResult(
  result: RemoteModelCatalogResult,
  generation: number,
): void {
  if (generation !== runtimeGeneration) return;
  if (
    result.source === "checked-in-fallback" &&
    activeSnapshot !== null &&
    activeSnapshot.provenance.source !== "checked-in-fallback"
  ) {
    return;
  }
  activeSnapshot = {
    catalog: result.catalog,
    provenance: mapModelCatalogProvenance(result),
  };
  publishCapabilityProjection(result.catalog);
}

/**
 * Bounded hydration: fetch the remote catalog once and atomically publish the
 * snapshot. Safe to await at server boot (consistent with
 * `hydrateModelCapabilitiesCache`). On any failure the checked-in fallback
 * remains active. Never throws — a hydration failure is non-fatal.
 */
export async function hydrateRuntimeModelCatalog(): Promise<ModelCatalogProvenance> {
  const generation = runtimeGeneration;
  // Boot hydration is one bounded attempt and also starts the negative-refresh
  // throttle window, so the first request after a failed boot does not
  // immediately repeat the same outbound failure.
  lastRefreshAttemptStartedAt = refreshClock();
  try {
    const result = await getRuntimeLoader().get();
    publishRuntimeResult(result, generation);
    return getActiveModelCatalogSync().provenance;
  } catch {
    // The loader itself never throws (it falls back); this guard is defensive.
    return {
      source: "checked-in-fallback",
      stale: true,
      catalogVersion: localModelCatalog.catalogVersion,
    };
  }
}

/**
 * Process-level single-flight refresh-and-publish seam.
 *
 * The loader's own `refresh()` only updates its private LKG cache. This seam
 * follows that refresh with `get()` and atomically publishes the validated
 * result so synchronous consumers observe hot releases without a restart.
 * A failed refresh retains the current remote process snapshot.
 */
export function refreshAndPublishRuntimeModelCatalog(): Promise<RemoteModelCatalogResult | null> {
  if (refreshAndPublishInflight) return refreshAndPublishInflight;
  const now = refreshClock();
  if (
    lastRefreshAttemptStartedAt !== null &&
    now - lastRefreshAttemptStartedAt < minRefreshIntervalMs()
  ) {
    return Promise.resolve(null);
  }
  lastRefreshAttemptStartedAt = now;
  const loader = getRuntimeLoader();
  const generation = runtimeGeneration;
  const promise = (async () => {
    // Production loaders return the truthful result of this one bounded
    // attempt, avoiding the old refresh-then-get double fetch on cold failure.
    // The void fallback preserves compatibility with narrow injected test
    // loaders that predate the result-returning interface.
    const refreshed = await loader.refresh();
    const result = refreshed ?? await loader.get();
    publishRuntimeResult(result, generation);
    return result;
  })();
  refreshAndPublishInflight = promise;
  void promise.then(
    () => {
      if (refreshAndPublishInflight === promise) refreshAndPublishInflight = null;
    },
    () => {
      if (refreshAndPublishInflight === promise) refreshAndPublishInflight = null;
    },
  );
  return promise;
}

/**
 * Non-blocking hot-read refresh kick. Request paths call this and immediately
 * serve the current atomic snapshot; they never await delivery I/O.
 */
export function kickRuntimeModelCatalogRefresh(): void {
  void refreshAndPublishRuntimeModelCatalog().catch(() => {
    // Delivery failure retains the current process-level last-known-good.
  });
}

/**
 * Synchronous active-snapshot read. NEVER blocks on the network. Returns the
 * last-validated remote catalog, or the checked-in fallback when no remote
 * snapshot has been hydrated yet. Atomic: a concurrent refresh replaces the
 * snapshot in one assignment.
 */
export function getActiveModelCatalogSync(): { catalog: ModelCatalog; provenance: ModelCatalogProvenance } {
  if (activeSnapshot) {
    return activeSnapshot;
  }
  return {
    catalog: localModelCatalog,
    provenance: {
      source: "checked-in-fallback",
      stale: true,
      catalogVersion: localModelCatalog.catalogVersion,
    },
  };
}

/** Async best-effort read (used by the server config route for diagnostics). */
export async function getRuntimeModelCatalog(): Promise<RemoteModelCatalogResult> {
  const generation = runtimeGeneration;
  const result = await getRuntimeLoader().get();
  publishRuntimeResult(result, generation);
  return result;
}

/**
 * Map the remote loader's truthful source metadata into the safe, narrowly
 * typed provenance exposed to discovery callers.
 */
export function mapModelCatalogProvenance(
  result: RemoteModelCatalogResult,
): ModelCatalogProvenance {
  return {
    source: result.source,
    stale: result.stale,
    catalogVersion: result.catalogVersion,
  };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start a non-blocking periodic background refresh so newly published
 * supported rows appear without a server restart. No-op if remote is
 * disabled. Idempotent.
 */
export function startRuntimeModelCatalogRefreshLoop(
  intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
): void {
  if (refreshTimer !== null) return;
  refreshTimer = setInterval(() => {
    kickRuntimeModelCatalogRefresh();
  }, intervalMs);
  // Don't keep the event loop alive on its own — the server owns the lifecycle.
  if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) {
    (refreshTimer as { unref: () => void }).unref();
  }
}

/** Stop the periodic background refresh loop. */
export function stopRuntimeModelCatalogRefreshLoop(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
