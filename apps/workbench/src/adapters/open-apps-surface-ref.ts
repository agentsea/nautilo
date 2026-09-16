/**
 * D344 — module-level dispatchers for opening the full-width Apps surfaces
 * (the all-apps overview/manager and a per-app detail page) from deeply nested
 * components (the side-panel launcher rows) without prop-drilling. Mirrors the
 * `open-mini-app-ref` pattern: the shell registers the real handlers on mount.
 */

type OpenAppsOverviewDispatcher = () => void;
type OpenAppDetailDispatcher = (appId: string) => void;

let overviewDispatcher: OpenAppsOverviewDispatcher | null = null;
let detailDispatcher: OpenAppDetailDispatcher | null = null;

export function setOpenAppsOverviewDispatcher(fn: OpenAppsOverviewDispatcher | null): void {
  overviewDispatcher = fn;
}

export function setOpenAppDetailDispatcher(fn: OpenAppDetailDispatcher | null): void {
  detailDispatcher = fn;
}

/** Open the full Apps page (all installed apps). Returns false if the shell
 *  hasn't registered a dispatcher (not mounted). */
export function requestOpenAppsOverview(): boolean {
  if (!overviewDispatcher) return false;
  overviewDispatcher();
  return true;
}

/** Open the detail page for a specific app. Returns false if no dispatcher. */
export function requestOpenAppDetail(appId: string): boolean {
  if (!detailDispatcher || appId.length === 0) return false;
  detailDispatcher(appId);
  return true;
}
