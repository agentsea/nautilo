import { bundledComputerUseContractCatalogue } from "./catalog";
import {
  createRemoteComputerUseContractCatalogueLoader,
  bundledComputerUseContractCatalogueArtifactSha256,
  type ComputerUseContractCatalogueResult,
  type RemoteComputerUseContractCatalogueConfig,
} from "./remote-catalogue";
import type { ComputerUseContractCatalogueV1 } from "./schema";

/** Compiled release authority; an explicit null override disables remote hydration. */
export const OFFICIAL_COMPUTER_USE_CONTRACT_CATALOGUE_POINTER_URL =
  "https://media.nautilo.ai/computer-use/catalogue/v1/latest.json";

function bundled(): ComputerUseContractCatalogueResult {
  return {
    catalogue: bundledComputerUseContractCatalogue,
    source: "bundled-fallback",
    stale: true,
    catalogueVersion: bundledComputerUseContractCatalogue.catalogueVersion,
    artifactSha256: bundledComputerUseContractCatalogueArtifactSha256,
    reason: "bundled computer use contract catalogue",
  };
}

function configuredPointerUrl(value: string | null | undefined): string | undefined {
  if (value === null) return undefined;
  if (value !== undefined) return value || undefined;
  return process.env["NAUTILO_COMPUTER_USE_CONTRACT_CATALOGUE_POINTER_URL"]?.trim()
    || OFFICIAL_COMPUTER_USE_CONTRACT_CATALOGUE_POINTER_URL;
}

let active = bundled();
const initialPointerUrl = configuredPointerUrl(undefined);
let loader = createRemoteComputerUseContractCatalogueLoader(
  initialPointerUrl ? { pointerUrl: initialPointerUrl } : {},
);
let generation = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshLoopInFlight = false;
let acknowledgedCatalogueIdentity: string | null = null;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type ComputerUseContractCatalogueRefreshEvent = Readonly<{
  result: ComputerUseContractCatalogueResult;
  contractsChanged: boolean;
}>;

/** Explicit boot/test refresh; imports and synchronous reads never start I/O. */
export async function refreshRuntimeComputerUseContractCatalogue(): Promise<ComputerUseContractCatalogueResult> {
  const requestGeneration = generation;
  const result = await loader.refresh();
  if (requestGeneration === generation && result.source !== "bundled-fallback") {
    active = result;
  }
  return result;
}

/** One bounded boot hydration. Failure retains bundled/LKG and is never fatal. */
export async function hydrateRuntimeComputerUseContractCatalogue(): Promise<ComputerUseContractCatalogueResult> {
  return await refreshRuntimeComputerUseContractCatalogue();
}

/**
 * Keep the signed contract snapshot current without blocking a Genie turn.
 * The server callback reconciles model-tool registrations only when the exact
 * version or artifact digest changes; every settled refresh is still reported
 * so fallback/staleness cannot fail silently.
 */
export function startRuntimeComputerUseContractCatalogueRefreshLoop(
  onRefresh: (event: ComputerUseContractCatalogueRefreshEvent) => void,
  intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
): void {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("computer use contract catalogue refresh interval rejected");
  }
  if (refreshTimer !== null) return;
  acknowledgedCatalogueIdentity = `${active.catalogueVersion}:${active.artifactSha256}`;
  refreshTimer = setInterval(() => {
    if (refreshLoopInFlight) return;
    refreshLoopInFlight = true;
    void refreshRuntimeComputerUseContractCatalogue()
      .then((result) => {
        const activeIdentity = `${active.catalogueVersion}:${active.artifactSha256}`;
        const contractsChanged = acknowledgedCatalogueIdentity !== activeIdentity;
        onRefresh({ result, contractsChanged });
        acknowledgedCatalogueIdentity = activeIdentity;
      })
      // The callback owns user/operator-visible diagnostics. Keep the prior
      // acknowledged identity after a failed reconciliation so the same valid
      // signed catalogue is retried on the next interval.
      .catch(() => undefined)
      .finally(() => { refreshLoopInFlight = false; });
  }, intervalMs);
  if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) {
    (refreshTimer as { unref: () => void }).unref();
  }
}

export function stopRuntimeComputerUseContractCatalogueRefreshLoop(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshLoopInFlight = false;
  acknowledgedCatalogueIdentity = null;
}

export function getActiveComputerUseContractCatalogueSync(): ComputerUseContractCatalogueV1 {
  return active.catalogue;
}

export function getActiveComputerUseContractCatalogueResultSync(): ComputerUseContractCatalogueResult {
  return active;
}

export function configureRuntimeComputerUseContractCatalogue(
  config: Omit<RemoteComputerUseContractCatalogueConfig, "pointerUrl"> & {
    pointerUrl?: string | null;
  },
): void {
  generation += 1;
  const pointerUrl = configuredPointerUrl(config.pointerUrl);
  const { pointerUrl: _ignored, ...remoteConfig } = config;
  loader = createRemoteComputerUseContractCatalogueLoader(
    pointerUrl ? { ...remoteConfig, pointerUrl } : remoteConfig,
  );
  active = bundled();
}

export function resetRuntimeComputerUseContractCatalogue(): void {
  stopRuntimeComputerUseContractCatalogueRefreshLoop();
  configureRuntimeComputerUseContractCatalogue({});
}
