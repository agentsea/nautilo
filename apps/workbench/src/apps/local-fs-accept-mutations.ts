import type { FsDirectoryChangedEvent } from "../lib/fs-directory-changed";

/** Host-only suppression for accepted Current Folder live-review writes. */
const ACCEPT_MUTATION_TTL_MS = 60_000;
const MAX_ACCEPT_MUTATIONS = 256;

export type PendingAcceptMutationEventOutcome =
  | "deferred"
  | "confirmed_success"
  | "untracked";

type DeferredAcceptMutationEvent = {
  event: FsDirectoryChangedEvent;
  processAsExternal: (event: FsDirectoryChangedEvent) => void;
};

type PendingAcceptMutation = {
  expiresAt: number;
  responseSucceeded: boolean;
  deferredEvent: DeferredAcceptMutationEvent | null;
};

const pendingAcceptMutations = new Map<string, PendingAcceptMutation>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function replayDeferredEvent(entry: PendingAcceptMutation): void {
  const deferred = entry.deferredEvent;
  entry.deferredEvent = null;
  if (!deferred) return;
  try {
    deferred.processAsExternal(deferred.event);
  } catch {
    /* A surface callback must not break global mutation outcome cleanup. */
  }
}

function scheduleExpiryTimer(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const entry of pendingAcceptMutations.values()) {
    nextExpiry = Math.min(nextExpiry, entry.expiresAt);
  }
  if (!Number.isFinite(nextExpiry)) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    prunePendingAcceptMutations();
    scheduleExpiryTimer();
  }, Math.max(0, nextExpiry - Date.now()));
}

function prunePendingAcceptMutations(now = Date.now()): void {
  const expired: PendingAcceptMutation[] = [];
  for (const [clientMutationId, entry] of pendingAcceptMutations) {
    if (entry.expiresAt > now) continue;
    pendingAcceptMutations.delete(clientMutationId);
    if (!entry.responseSucceeded) expired.push(entry);
  }
  for (const entry of expired) replayDeferredEvent(entry);
}

function makeRoomForPendingAcceptMutation(): void {
  while (pendingAcceptMutations.size >= MAX_ACCEPT_MUTATIONS) {
    const oldest = pendingAcceptMutations.keys().next().value;
    if (typeof oldest !== "string") break;
    const evicted = pendingAcceptMutations.get(oldest);
    pendingAcceptMutations.delete(oldest);
    if (evicted && !evicted.responseSucceeded) replayDeferredEvent(evicted);
  }
}

export function registerPendingAcceptMutation(clientMutationId: string): void {
  const now = Date.now();
  prunePendingAcceptMutations(now);
  if (pendingAcceptMutations.has(clientMutationId)) {
    scheduleExpiryTimer();
    return;
  }
  makeRoomForPendingAcceptMutation();
  pendingAcceptMutations.set(clientMutationId, {
    expiresAt: now + ACCEPT_MUTATION_TTL_MS,
    responseSucceeded: false,
    deferredEvent: null,
  });
  scheduleExpiryTimer();
}

/**
 * Defer an event while its HTTP outcome is unknown, suppress it after confirmed
 * success, or return untracked so the caller can process it as external now.
 * Repeated pending events keep the first exact event; one canonical re-read on
 * failure/expiry subsumes duplicate watcher notifications.
 */
export function observePendingAcceptMutationEvent(
  clientMutationId: string | undefined,
  event: FsDirectoryChangedEvent,
  processAsExternal: (event: FsDirectoryChangedEvent) => void,
): PendingAcceptMutationEventOutcome {
  if (!clientMutationId) return "untracked";
  prunePendingAcceptMutations();
  const entry = pendingAcceptMutations.get(clientMutationId);
  if (!entry) {
    scheduleExpiryTimer();
    return "untracked";
  }
  if (entry.responseSucceeded) return "confirmed_success";
  entry.deferredEvent ??= { event, processAsExternal };
  return "deferred";
}

/** Confirm success and discard any event-first observation without replaying it. */
export function markPendingAcceptMutationSucceeded(clientMutationId: string): void {
  prunePendingAcceptMutations();
  const entry = pendingAcceptMutations.get(clientMutationId);
  if (!entry) {
    scheduleExpiryTimer();
    return;
  }
  entry.responseSucceeded = true;
  entry.deferredEvent = null;
  scheduleExpiryTimer();
}

/** A failed or unknown response reclassifies the deferred event as external. */
export function failPendingAcceptMutation(clientMutationId: string): void {
  prunePendingAcceptMutations();
  const entry = pendingAcceptMutations.get(clientMutationId);
  if (!entry) {
    scheduleExpiryTimer();
    return;
  }
  pendingAcceptMutations.delete(clientMutationId);
  if (!entry.responseSucceeded) replayDeferredEvent(entry);
  scheduleExpiryTimer();
}

/** Detach callbacks owned by an unmounted/rebound surface. */
export function releasePendingAcceptMutationObserver(
  processAsExternal: (event: FsDirectoryChangedEvent) => void,
): void {
  for (const entry of pendingAcceptMutations.values()) {
    if (entry.deferredEvent?.processAsExternal === processAsExternal) {
      entry.deferredEvent = null;
    }
  }
}

/** Test-only helper to avoid cross-test mutation registry bleed. */
export function clearPendingAcceptMutationsForTests(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  pendingAcceptMutations.clear();
}
