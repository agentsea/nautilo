/**
 * Shared deployment-identity persistence for the upgrade notice and lazy
 * chunk recovery. Values are scoped by origin so one browser profile can use
 * multiple Nautilo instances without cross-instance upgrade prompts.
 */
export const DEPLOYMENT_BASELINE_KEY = "nautilo:deployment-identity";
export const DEPLOYMENT_LATER_KEY = "nautilo:deployment-upgrade-later";
export const DEPLOYMENT_PENDING_KEY = "nautilo:deployment-upgrade-pending";

export function deploymentStorageKey(key: string, origin: string): string {
  return `${key}:${origin}`;
}

export function readDeploymentValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(deploymentStorageKey(key, window.location.origin));
  } catch {
    return null;
  }
}

export function writeDeploymentValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(deploymentStorageKey(key, window.location.origin), value);
  } catch {
    // Persistence is an enhancement; callers retain their in-memory state.
  }
}

export function removeDeploymentValue(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(deploymentStorageKey(key, window.location.origin));
  } catch {
    // Persistence is an enhancement; callers retain their in-memory state.
  }
}

/** Marks an identity as loaded and clears any now-obsolete refresh prompt. */
export function acceptDeploymentIdentity(identity: string): void {
  writeDeploymentValue(DEPLOYMENT_BASELINE_KEY, identity);
  removeDeploymentValue(DEPLOYMENT_PENDING_KEY);
}
