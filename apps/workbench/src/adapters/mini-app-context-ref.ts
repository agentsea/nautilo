/**
 * M187 — module-level ref for passing active mini-app context from
 * `WorkbenchShell` into the runtime's `sendText`, mirroring
 * `file-context-ref.ts`.
 */

import type {
  ActiveMiniAppRequestContext,
  LiveMiniAppSessionCapability,
} from "@nautilo/types";
import type { ActiveMiniAppContext } from "../apps/app-bridge";
import { boundDocumentDisplayPath } from "../apps/live-app-session-target";

export const ACTIVE_MINI_APP_CONTEXT_TTL_MS = 5 * 60 * 1000;

let ref: ActiveMiniAppRequestContext | null = null;
let liveSessionRef: LiveMiniAppSessionCapability | null = null;

export function mapActiveMiniAppContext(
  ctx: ActiveMiniAppContext,
  appName?: string,
): ActiveMiniAppRequestContext {
  const documentPath =
    ctx.summary.documentPath ??
    (ctx.target ? boundDocumentDisplayPath(ctx.target) : undefined);
  return {
    appId: ctx.appId,
    ...(appName && appName.length > 0 ? { appName } : {}),
    ...(documentPath && documentPath.length > 0 ? { documentPath } : {}),
    ...(ctx.target?.kind ? { targetKind: ctx.target.kind } : {}),
    ...(ctx.summary.selection !== undefined ? { selection: ctx.summary.selection } : {}),
    ...(ctx.summary.summary !== undefined ? { summary: ctx.summary.summary } : {}),
    updatedAt: ctx.updatedAt,
  };
}

export function publishActiveMiniApp(mapped: ActiveMiniAppRequestContext | null): void {
  ref = mapped;
}

export function clearActiveMiniApp(): void {
  ref = null;
  liveSessionRef = null;
}

/** Workbench-host only: iframe context is never permitted to populate this. */
export function publishLiveMiniAppSession(
  session: LiveMiniAppSessionCapability | null,
): void {
  liveSessionRef = session ? { ...session } : null;
}

/**
 * Read-on-send snapshot. Returns `null` when unset or past TTL.
 */
export function readActiveMiniApp(now: number = Date.now()): ActiveMiniAppRequestContext | null {
  if (!ref) return null;
  if (now - ref.updatedAt > ACTIVE_MINI_APP_CONTEXT_TTL_MS) return null;
  return { ...ref };
}

export function readLiveMiniAppSession(): LiveMiniAppSessionCapability | null {
  return liveSessionRef ? { ...liveSessionRef } : null;
}

/** Clear published chat live authority when a server push targets this session. */
export function clearLiveMiniAppSessionIfMatches(sessionId: string): boolean {
  if (!liveSessionRef || liveSessionRef.sessionId !== sessionId) return false;
  liveSessionRef = null;
  return true;
}
