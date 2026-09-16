import type { ApplicationCatalogueV1 } from "@nautilo/types";
import { bundledApplicationCatalogue } from "./catalog";
import { createRemoteApplicationCatalogueLoader, type ApplicationCatalogueResult, type RemoteApplicationCatalogueConfig } from "./remote-catalogue";

function bundled(): ApplicationCatalogueResult {
  return {
    catalogue: bundledApplicationCatalogue,
    source: "checked-in-fallback",
    stale: true,
    catalogueVersion: bundledApplicationCatalogue.catalogueVersion,
    reason: "bundled application catalogue",
  };
}

function configuredPointerUrl(value: string | null | undefined): string | undefined {
  if (value === null) return undefined;
  if (value !== undefined) return value || undefined;
  return process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"]?.trim() || undefined;
}

let active: ApplicationCatalogueResult = bundled();
const initialPointerUrl = configuredPointerUrl(undefined);
let loader = createRemoteApplicationCatalogueLoader(initialPointerUrl ? { pointerUrl: initialPointerUrl } : {});
let generation = 0;
let inflight: Promise<ApplicationCatalogueResult> | null = null;
let lastKick = -Infinity;
const MIN_REFRESH_MS = 60_000;
/** Explicit boot/test-owned refresh; no network starts on import or synchronous read. */
export async function refreshRuntimeApplicationCatalogue(): Promise<ApplicationCatalogueResult> {
  const requestGeneration = generation;
  const result = await loader.refresh();
  if (requestGeneration === generation && result.source !== "checked-in-fallback") {
    active = result;
  }
  return result;
}
/** Non-blocking hot-path owner: disabled/default loader makes no fetches; callers always read current snapshot. */
export function kickRuntimeApplicationCatalogueRefresh(now = Date.now()): void {
  if (inflight || now - lastKick < MIN_REFRESH_MS) return;
  lastKick = now;
  const request = refreshRuntimeApplicationCatalogue();
  inflight = request;
  void request.finally(() => {
    if (inflight === request) inflight = null;
  });
}

export function getActiveApplicationCatalogueSync(): ApplicationCatalogueV1 {
  return active.catalogue;
}

export function getActiveApplicationCatalogueResultSync(): ApplicationCatalogueResult {
  return active;
}

export function configureRuntimeApplicationCatalogue(
  config: Omit<RemoteApplicationCatalogueConfig, "pointerUrl"> & { pointerUrl?: string | null },
): void {
  generation += 1;
  const pointerUrl = configuredPointerUrl(config.pointerUrl);
  const { pointerUrl: _ignored, ...remoteConfig } = config;
  loader = createRemoteApplicationCatalogueLoader(pointerUrl ? { ...remoteConfig, pointerUrl } : remoteConfig);
  active = bundled();
  inflight = null;
  lastKick = -Infinity;
}

export function resetRuntimeApplicationCatalogue(): void {
  configureRuntimeApplicationCatalogue({});
}
