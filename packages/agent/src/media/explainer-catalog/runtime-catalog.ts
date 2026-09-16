/**
 * D429 Phase 7.4 — runtime explainer-catalog seam.
 *
 * A narrow, process-wide wrapper around {@link createRemoteExplainerCatalogLoader}
 * that wires the tested bounded signed-pointer loader into real discovery and
 * the authenticated verified-byte playback route.
 *
 * Guarantees:
 *   - Official-product default pointer URL ships in source:
 *     {@link OFFICIAL_EXPLAINER_CATALOG_URL} (`https://media.nautilo.ai/catalog/latest.json`),
 *     which CI republishes as the minimal signed
 *     `{catalogVersion, artifactSha256, signature, signingKeyId}` document under
 *     the `nautilo-explainer-catalog-v1` domain; the immutable manifest is
 *     derived from it. `NAUTILO_EXPLAINER_CATALOG_POINTER_URL` is an OPTIONAL
 *     deployment / self-host override; `null` via the seam disables remote
 *     fetching entirely (serve the bundled seed without any network call).
 *   - The production full-manifest / unsigned override
 *     (`NAUTILO_EXPLAINER_CATALOG_URL`) is REMOVED. Only verified signed remote
 *     LKG or the bundled seed is ever served.
 *   - The direct Bunny Storage media origin is
 *     {@link OFFICIAL_EXPLAINER_MEDIA_ORIGIN} (`https://media.nautilo.ai/`);
 *     `NAUTILO_EXPLAINER_BUNNY_STORAGE_ORIGIN` may override it for deployment /
 *     self-host. The server-side verified-byte route derives playback URLs
 *     from this origin; the Workbench never receives it.
 *   - The loader is a cached singleton shared across tool invocations, so its
 *     TTL / stale-while-revalidate / last-known-good cache persists between calls.
 *   - The signed-pointer transport + verification semantics are inherited
 *     verbatim (allowlisted HTTPS origin, byte cap, timeout, strict schema,
 *     Ed25519 signature, exact SHA-256, last-known-good, bundled fallback).
 *   - No caller-supplied URL is ever accepted: the only URLs this seam ever
 *     fetches are the resolved official pointer URL (default, env override, or
 *     explicit seam) plus the derived same-origin immutable manifest. Tool
 *     callers receive no URL-parameter knob.
 *   - Deterministic and testable: tests inject a fake loader or remote config
 *     (fetchImpl / clock / trustedKeys) via {@link configureRuntimeExplainerCatalog}
 *     and reset with {@link resetRuntimeExplainerCatalog}. No test performs real
 *     network I/O.
 */
import type { ExplainerCatalog, ExplainerCatalogResultSource } from "@nautilo/types";
import {
  createRemoteExplainerCatalogLoader,
  type RemoteExplainerCatalogConfig,
  type RemoteExplainerCatalogLoader,
  type RemoteExplainerCatalogResult,
} from "./remote-catalog";

/**
 * Verified official default catalog release-pointer URL. Ordinary
 * official-product users fetch this pointer
 * (`https://media.nautilo.ai/catalog/latest.json`), which CI republishes as
 * the minimal signed `{catalogVersion, artifactSha256, signature, signingKeyId}`
 * document; the immutable manifest is derived from it.
 * `NAUTILO_EXPLAINER_CATALOG_POINTER_URL` may override it for deployment /
 * self-host.
 */
export const OFFICIAL_EXPLAINER_CATALOG_URL = "https://media.nautilo.ai/catalog/latest.json";

/**
 * Verified official default direct Bunny Storage media origin. The
 * server-side verified-byte route fetches public MP4s from here (or an
 * operator-owned mirror); the Workbench never receives this origin.
 */
export const OFFICIAL_EXPLAINER_MEDIA_ORIGIN = "https://media.nautilo.ai/";

/** Optional deployment / self-host override: release-pointer catalog URL. */
const EXPLAINER_CATALOG_POINTER_URL_ENV = "NAUTILO_EXPLAINER_CATALOG_POINTER_URL";

/** Optional deployment / self-host override for the direct media origin. */
export const EXPLAINER_MEDIA_ORIGIN_ENV = "NAUTILO_EXPLAINER_BUNNY_STORAGE_ORIGIN";

/**
 * Safe, narrowly typed provenance exposed to discovery callers. This is the
 * only catalog-origin information ever surfaced: the raw pointer/manifest URL,
 * host, headers, signing keys, and provider credentials are never represented
 * here.
 */
export interface ExplainerCatalogProvenance {
  readonly source: "local" | "remote";
  readonly stale: boolean;
}

/**
 * Options for the runtime seam. None of these are tool-caller knobs; they are
 * process-level configuration and test seams.
 */
export interface RuntimeExplainerCatalogOptions {
  /**
   * Test seam: inject a fully-formed loader (e.g. a fake returning the local
   * catalog) to bypass real network I/O. Mutually exclusive with the
   * URL / remoteConfig knobs.
   */
  readonly loader?: RemoteExplainerCatalogLoader;
  /**
   * The official release-pointer catalog URL to fetch. `undefined` => resolve
   * from env override or the official default. `null` => disable remote
   * fetching entirely (serve the bundled seed without any network call).
   */
  readonly catalogPointerUrl?: string | null;
  /**
   * Additional remote-loader config (fetchImpl, clock, TTL, byte cap, timeout,
   * trustedKeys) forwarded to `createRemoteExplainerCatalogLoader`. Used by
   * tests to record fetches and control time without real network I/O.
   */
  readonly remoteConfig?: Omit<RemoteExplainerCatalogConfig, "catalogPointerUrl">;
}

let runtimeLoader: RemoteExplainerCatalogLoader | null = null;
let runtimeOptions: RuntimeExplainerCatalogOptions = {};

interface RuntimeCatalogTarget {
  readonly pointerUrl: string | null;
}

/**
 * Resolve the official catalog target: explicit seam override wins, then env
 * override, then the verified official default (pointer mode). A `null`
 * explicit seam disables remote fetching (local-only).
 */
function resolveRuntimeCatalogTarget(): RuntimeCatalogTarget {
  const optPointer = runtimeOptions.catalogPointerUrl;
  if (optPointer !== undefined) {
    return { pointerUrl: optPointer };
  }
  const envPointer = process.env[EXPLAINER_CATALOG_POINTER_URL_ENV];
  if (envPointer !== undefined && envPointer.trim() !== "") {
    return { pointerUrl: envPointer.trim() };
  }
  return { pointerUrl: OFFICIAL_EXPLAINER_CATALOG_URL };
}

function buildLoader(): RemoteExplainerCatalogLoader {
  if (runtimeOptions.loader) {
    return runtimeOptions.loader;
  }
  const { pointerUrl } = resolveRuntimeCatalogTarget();
  const config: RemoteExplainerCatalogConfig = {
    ...runtimeOptions.remoteConfig,
    ...(pointerUrl === null ? {} : { catalogPointerUrl: pointerUrl }),
  };
  return createRemoteExplainerCatalogLoader(config);
}

function getRuntimeExplainerCatalogLoader(): RemoteExplainerCatalogLoader {
  if (runtimeLoader === null) {
    runtimeLoader = buildLoader();
  }
  return runtimeLoader;
}

/**
 * Configure the runtime seam (process-level). Resets any cached loader so the
 * next access rebuilds it from these options. Intended for test injection and
 * boot-time configuration; never call this from a tool with caller-supplied
 * data.
 */
export function configureRuntimeExplainerCatalog(options: RuntimeExplainerCatalogOptions): void {
  runtimeOptions = options;
  runtimeLoader = null;
}

/** Reset the runtime seam to official defaults (clears any injected loader). */
export function resetRuntimeExplainerCatalog(): void {
  runtimeOptions = {};
  runtimeLoader = null;
}

/** Resolve the best available catalog with truthful source metadata. */
export async function getRuntimeExplainerCatalog(): Promise<RemoteExplainerCatalogResult> {
  return getRuntimeExplainerCatalogLoader().get();
}

/**
 * Map the remote loader's truthful source metadata into the safe, narrowly
 * typed provenance exposed to discovery callers.
 *
 * - `remote-fresh`       => `{ source: "remote", stale: false }`
 * - `remote-stale`       => `{ source: "remote", stale: true }`
 * - `checked-in-fallback` => `{ source: "local", stale: true }`
 */
export function mapExplainerCatalogProvenance(
  result: RemoteExplainerCatalogResult,
): ExplainerCatalogProvenance {
  return mapExplainerCatalogSource(result.source);
}

/** Map a raw loader source into the safe list-DTO provenance. */
export function mapExplainerCatalogSource(
  source: ExplainerCatalogResultSource,
): ExplainerCatalogProvenance {
  switch (source) {
    case "remote-fresh":
      return { source: "remote", stale: false };
    case "remote-stale":
      return { source: "remote", stale: true };
    case "checked-in-fallback":
      return { source: "local", stale: true };
  }
}

/**
 * Resolve the direct Bunny Storage media origin for the server-side
 * verified-byte route. The Workbench never receives this origin.
 *
 * Uses `OFFICIAL_EXPLAINER_MEDIA_ORIGIN` by default so ordinary official-product
 * deployments need no environment configuration. The
 * `NAUTILO_EXPLAINER_BUNNY_STORAGE_ORIGIN` override, when set, must be a clean
 * HTTPS origin (no path, query, fragment, or credentials) or this throws — it
 * is never silently accepted malformed.
 */
export function resolveExplainerMediaOrigin(): URL {
  const value = process.env[EXPLAINER_MEDIA_ORIGIN_ENV];
  if (value === undefined || value.trim() === "") {
    return new URL(OFFICIAL_EXPLAINER_MEDIA_ORIGIN);
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${EXPLAINER_MEDIA_ORIGIN_ENV} must be a valid HTTPS storage origin.`);
  }

  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.pathname !== "/"
  ) {
    throw new Error(
      `${EXPLAINER_MEDIA_ORIGIN_ENV} must be an HTTPS origin without a path, query, hash, or credentials.`,
    );
  }

  return origin;
}

/**
 * Resolve one catalog entry by stable id from a served catalog. Shared by
 * playback so it resolves the exact requested id from the same runtime catalog
 * discovery uses — never a hardcoded local copy.
 */
export function findExplainerCatalogEntry(
  catalog: ExplainerCatalog,
  id: string,
): ExplainerCatalog["entries"][number] | undefined {
  return catalog.entries.find((candidate) => candidate.id === id);
}
