/**
 * Soft idle policy, not an execution deadline. Only terminal hosted reads
 * become warm. A new turn atomically transfers custody before cleanup can
 * claim it; active hosted, direct, and Human work is never timed out here.
 * At V4's published $0.02/browser-hour, five idle minutes cost ~$0.0017,
 * excluding network traffic. Retain the saved profile after explicit stop.
 */
const CONNECTED_WEB_BROWSER_IDLE_MS = 5 * 60_000;
/** Failed stop requests retry without ever restoring reuse eligibility. */
export const CONNECTED_WEB_BROWSER_CLEANUP_RETRY_MS = 60_000;

import type { ConnectedWebOperation, ConnectedWebOperationAdmission } from "./store";

export function canReuseConnectedWebBrowser(source: ConnectedWebOperation, target: ConnectedWebOperationAdmission, now: Date): boolean {
  return source.accountId !== null && target.accountId !== null && source.browserCleanupStartedAt == null && source.browserIdleUntil != null && source.browserIdleUntil > now
    && source.lifecycle === "terminal" && source.driver === "hosted" && source.terminalReceipt?.outcome === "completed"
    && source.ownerUserId === target.ownerUserId && source.accountId === target.accountId
    && source.initiatingAgentId === target.initiatingAgentId && source.initiatingRoomId === target.initiatingRoomId
    && source.initiatingThreadId === target.initiatingThreadId && source.initiatingLane === target.initiatingLane;
}

export function connectedWebBrowserIdleUntil(now: Date, completed: boolean): Date {
  return new Date(now.getTime() + (completed ? CONNECTED_WEB_BROWSER_IDLE_MS : 0));
}
