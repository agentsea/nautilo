import {
  UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET,
  type ClientSessionEventV1,
  type UiActionEventV1,
} from "@nautilo/types";

let currentClientActionSessionId: string | null = null;
const retainedUiActionExpiries = new Map<string, number>();
const retainedUiActionTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Workbench-local volatile state for the current authenticated WebSocket only.
 * This value is neither persisted nor accepted from ordinary callers.
 */
export function installClientActionSession(event: ClientSessionEventV1): void {
  currentClientActionSessionId = event.clientActionSessionId;
}

/** Clear before reconnecting so an old socket can never stamp a new request. */
export function clearClientActionSession(): void {
  currentClientActionSessionId = null;
  for (const timer of retainedUiActionTimers.values()) clearTimeout(timer);
  retainedUiActionTimers.clear();
  retainedUiActionExpiries.clear();
}

/** Current socket-minted binding for foreground crypto resume requests. */
export function currentClientActionSessionIdForResume(): string | undefined {
  return currentClientActionSessionId ?? undefined;
}

function removeRetainedClientUiAction(actionId: string, expectedExpiry: number): void {
  if (retainedUiActionExpiries.get(actionId) !== expectedExpiry) return;
  const timer = retainedUiActionTimers.get(actionId);
  if (timer) clearTimeout(timer);
  retainedUiActionTimers.delete(actionId);
  retainedUiActionExpiries.delete(actionId);
}

/**
 * Accept a server-delivered automatic action once for this WebSocket lifetime.
 * The realtime client has already strictly parsed its short expiry; this
 * second check is intentionally local so reconnects, unmounts, and delayed
 * callbacks never replay an expired or over-cap action.
 */
export function retainClientUiAction(event: UiActionEventV1, now = Date.now()): boolean {
  for (const [actionId, expiresAt] of retainedUiActionExpiries) {
    if (expiresAt <= now) removeRetainedClientUiAction(actionId, expiresAt);
  }
  const expiresAt = Date.parse(event.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (retainedUiActionExpiries.has(event.actionId)) return false;
  if (retainedUiActionExpiries.size >= UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET) {
    return false;
  }
  retainedUiActionExpiries.set(event.actionId, expiresAt);
  const timer = setTimeout(() => {
    removeRetainedClientUiAction(event.actionId, expiresAt);
  }, expiresAt - now);
  retainedUiActionTimers.set(event.actionId, timer);
  return true;
}

/** Stamp only the current socket-minted value; strip caller-authored values. */
export function withCurrentClientActionSession<T extends Record<string, unknown>>(
  body: T,
): Omit<T, "clientActionSessionId"> & { clientActionSessionId?: string } {
  const { clientActionSessionId: _callerSupplied, ...withoutCallerValue } = body;
  return currentClientActionSessionId
    ? { ...withoutCallerValue, clientActionSessionId: currentClientActionSessionId }
    : withoutCallerValue;
}
