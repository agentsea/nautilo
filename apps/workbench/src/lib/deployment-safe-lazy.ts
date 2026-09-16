import {
  lazy,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import {
  acceptDeploymentIdentity,
  DEPLOYMENT_BASELINE_KEY,
  deploymentStorageKey,
  readDeploymentValue,
} from "../adapters/deployment-identity-storage";
import { getHasUnsentComposerText } from "../adapters/upgrade-reload-guard";
import { apiClient } from "./api";
import { desktopAPI } from "./desktop";

const LAZY_RELOAD_KEY = "nautilo:deployment-lazy-reload";
let reloadedIdentityInMemory: string | null = null;

function errorNameAndMessage(error: unknown): { name: string; message: string } {
  if (typeof error !== "object" || error === null) return { name: "", message: "" };
  const candidate = error as { name?: unknown; message?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

/**
 * Matches only browser/bundler failures that identify a lazy chunk fetch.
 * Generic TypeErrors, network messages, and module evaluation exceptions are
 * deliberately excluded.
 */
export function isEligibleStaleChunkError(error: unknown): boolean {
  const { name, message } = errorNameAndMessage(error);
  if (name === "ChunkLoadError") return true;
  return (
    /^Loading (?:CSS )?chunk [\w.-]+ failed\b/i.test(message) ||
    /^Failed to fetch dynamically imported module(?::|$)/i.test(message) ||
    /^Importing a module script failed\b/i.test(message) ||
    /^Error loading dynamically imported module\b/i.test(message) ||
    /^Unable to preload CSS for\b/i.test(message)
  );
}

export type LazyImportReloadDecision = {
  error: unknown;
  isOnline: boolean;
  hasUnsentComposerText: boolean;
  baselineIdentity: string | null;
  currentIdentity: string | null;
  reloadedIdentity: string | null;
};

/** Pure policy used after a successful health/deployment identity probe. */
export function shouldReloadForLazyImportFailure({
  error,
  isOnline,
  hasUnsentComposerText,
  baselineIdentity,
  currentIdentity,
  reloadedIdentity,
}: LazyImportReloadDecision): boolean {
  const baseline = baselineIdentity?.trim() ?? "";
  const current = currentIdentity?.trim() ?? "";
  return (
    isEligibleStaleChunkError(error) &&
    isOnline &&
    !hasUnsentComposerText &&
    baseline.length > 0 &&
    current.length > 0 &&
    baseline !== current &&
    reloadedIdentity !== current
  );
}

export type LazyImportRecoveryDependencies = {
  isOnline: () => boolean;
  hasUnsentComposerText: () => boolean;
  getBaselineIdentity: () => string | null;
  getCurrentIdentity: () => Promise<string | null>;
  getReloadedIdentity: () => string | null;
  markReloadedIdentity: (identity: string) => void;
  acceptIdentity: (identity: string) => void;
  reload: () => Promise<void> | void;
};

/**
 * Verifies that an eligible chunk failure coincides with a new deployment,
 * then performs one guarded reload. Probe failures are intentionally ignored:
 * offline and ordinary network failures must flow to the existing boundary.
 */
export async function attemptLazyImportRecovery(
  error: unknown,
  dependencies: LazyImportRecoveryDependencies,
): Promise<boolean> {
  if (
    !isEligibleStaleChunkError(error) ||
    !dependencies.isOnline() ||
    dependencies.hasUnsentComposerText()
  ) {
    return false;
  }

  const baselineIdentity = dependencies.getBaselineIdentity();
  if (!baselineIdentity?.trim()) return false;

  let currentIdentity: string | null;
  try {
    currentIdentity = await dependencies.getCurrentIdentity();
  } catch {
    return false;
  }

  if (
    !shouldReloadForLazyImportFailure({
      error,
      isOnline: dependencies.isOnline(),
      hasUnsentComposerText: dependencies.hasUnsentComposerText(),
      baselineIdentity,
      currentIdentity,
      reloadedIdentity: currentIdentity
        ? dependencies.getReloadedIdentity()
        : null,
    })
  ) {
    return false;
  }

  const identity = currentIdentity!.trim();
  // Mark before navigation. Concurrent lazy failures then observe the latch,
  // and a second failure after reload cannot enter a reload loop.
  dependencies.markReloadedIdentity(identity);
  dependencies.acceptIdentity(identity);
  await dependencies.reload();
  return true;
}

function readReloadedIdentity(): string | null {
  if (typeof window === "undefined") return reloadedIdentityInMemory;
  try {
    return (
      window.sessionStorage.getItem(
        deploymentStorageKey(LAZY_RELOAD_KEY, window.location.origin),
      ) ?? reloadedIdentityInMemory
    );
  } catch {
    return reloadedIdentityInMemory;
  }
}

function markReloadedIdentity(identity: string): void {
  reloadedIdentityInMemory = identity;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      deploymentStorageKey(LAZY_RELOAD_KEY, window.location.origin),
      identity,
    );
  } catch {
    // The in-memory latch still guards this renderer session.
  }
}

const browserRecoveryDependencies: LazyImportRecoveryDependencies = {
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  hasUnsentComposerText: getHasUnsentComposerText,
  getBaselineIdentity: () => readDeploymentValue(DEPLOYMENT_BASELINE_KEY),
  getCurrentIdentity: async () => {
    const health = await apiClient.getHealth();
    return health.deploymentIdentity?.trim() || null;
  },
  getReloadedIdentity: readReloadedIdentity,
  markReloadedIdentity,
  acceptIdentity: acceptDeploymentIdentity,
  reload: async () => {
    try {
      if (desktopAPI?.workbench?.reload) {
        await desktopAPI.workbench.reload();
        return;
      }
    } catch {
      // Older preload implementations can fall back to browser navigation.
    }
    window.location.reload();
  },
};

/**
 * React.lazy with stale-deployment recovery. Named exports should be adapted
 * by the caller so each dynamic import remains an explicit bundler boundary.
 */
// React's own lazy() signature uses ComponentType<any>; retaining it here is
// necessary to preserve each imported component's exact props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deploymentSafeLazy<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await importer();
    } catch (error) {
      await attemptLazyImportRecovery(error, browserRecoveryDependencies);
      throw error;
    }
  });
}
