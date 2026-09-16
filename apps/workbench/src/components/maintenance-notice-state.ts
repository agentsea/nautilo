import type { MaintenanceStatusEvent } from "@nautilo/types";

export type MaintenanceNoticeKind = "normal" | "draining" | "applying";

export interface MaintenanceNoticeSnapshot {
  readonly kind: MaintenanceNoticeKind;
  readonly applyingLatched: boolean;
}

export type WorkbenchMessageBarKind =
  | "applying"
  | "draining"
  | "refresh"
  | "reconnect"
  | "none";

const NORMAL: MaintenanceNoticeSnapshot = {
  kind: "normal",
  applyingLatched: false,
};

const APPLYING_LATCH_KEY = "nautilo:maintenance-applying";

function originKey(): string {
  return typeof window === "undefined" ? "server" : window.location.origin;
}

function latchStorageKey(): string {
  return `${APPLYING_LATCH_KEY}:${originKey()}`;
}

function readLatchedApplying(): boolean {
  try {
    // "true" is the pre-D420-gate representation. Keep accepting it so an
    // upgrade does not lose a latch that was written by the prior client.
    const value = localStorage.getItem(latchStorageKey());
    return value === "true" || value === "applying";
  } catch {
    return false;
  }
}

function writeLatch(value: "applying" | "reloading" | null): void {
  try {
    if (value) {
      localStorage.setItem(latchStorageKey(), value);
    } else {
      localStorage.removeItem(latchStorageKey());
    }
  } catch {
    // The in-memory latch still protects this renderer when storage is unavailable.
  }
}

let snapshot: MaintenanceNoticeSnapshot = readLatchedApplying()
  ? { kind: "applying", applyingLatched: true }
  : NORMAL;
let normalCompletionObserved = false;
let maintenanceStatusVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
  maintenanceStatusVersion += 1;
  for (const listener of listeners) listener();
}

function setSnapshot(next: MaintenanceNoticeSnapshot): void {
  if (
    snapshot.kind === next.kind &&
    snapshot.applyingLatched === next.applyingLatched
  ) {
    return;
  }
  snapshot = next;
  emit();
}

/**
 * Stores global maintenance truth for this Workbench origin. Applying is
 * intentionally latched: the planned socket close during replacement cannot
 * make the UI regress to a generic reconnect notice.
 */
export function applyMaintenanceStatus(
  event: Pick<MaintenanceStatusEvent, "state">,
): void {
  if (event.state === "normal") {
    if (snapshot.applyingLatched) {
      // Do not release *or relabel* the applying gate merely because the
      // replacement server's first WS frame arrived. Generic disconnect and
      // reconnect paths must remain suppressed until the guarded reload.
      // This transition must be idempotent. The applying gate keys its health
      // probe effect from this store's version; re-emitting an already-observed
      // normal state would immediately restart the probe and starve the reload
      // effect in a tight /health loop.
      if (normalCompletionObserved) return;
      normalCompletionObserved = true;
      emit();
      return;
    }
    setSnapshot(NORMAL);
    return;
  }

  if (event.state === "applying") {
    normalCompletionObserved = false;
    writeLatch("applying");
    setSnapshot({ kind: "applying", applyingLatched: true });
    return;
  }

  // A delayed draining frame from the same planned replacement must never
  // downgrade an applying notice. The durable normal snapshot clears it.
  if (!snapshot.applyingLatched) {
    setSnapshot({ kind: "draining", applyingLatched: false });
  }
}

/**
 * The gate may begin its final health check only after a replacement reports
 * normal. This is intentionally separate from the public applying kind so
 * all other Workbench consumers continue treating the outage as planned.
 */
export function hasMaintenanceNormalCompletion(): boolean {
  return normalCompletionObserved;
}

/** External-store value for consumers that need completion without un-gating. */
export function getMaintenanceStatusVersion(): number {
  return maintenanceStatusVersion;
}

/**
 * Mark the storage latch so the *next* renderer may mount routes only after
 * this renderer has already observed `normal` and a successful health probe.
 * The in-memory snapshot deliberately remains gated until navigation wins.
 */
export function beginMaintenanceRecoveryReload(): void {
  if (snapshot.applyingLatched) writeLatch("reloading");
}

/** Restore a latch if the native/browser reload call itself throws. */
export function restoreApplyingLatchAfterFailedRecoveryReload(): void {
  if (snapshot.applyingLatched) writeLatch("applying");
}

export function getMaintenanceNoticeSnapshot(): MaintenanceNoticeSnapshot {
  return snapshot;
}

export function subscribeMaintenanceNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** D420 R12's single precedence order for all Workbench message-bar callers. */
export function resolveWorkbenchMessageBar(params: {
  maintenance: MaintenanceNoticeSnapshot;
  refreshPending: boolean;
  reconnecting: boolean;
}): WorkbenchMessageBarKind {
  if (params.maintenance.kind === "applying") return "applying";
  if (params.maintenance.kind === "draining") return "draining";
  if (params.refreshPending) return "refresh";
  if (params.reconnecting) return "reconnect";
  return "none";
}

/** Test seam for origin-local module state. */
export function resetMaintenanceNoticeForTest(): void {
  normalCompletionObserved = false;
  writeLatch(null);
  setSnapshot(NORMAL);
}
