/**
 * D279 Phase 4 — bridge between the WS layer and ask-user picker state.
 *
 * Mirrors the typing-bus pattern (`nautilo:typing-ping`): nautilo-runtime.tsx
 * dispatches `nautilo:conductor-ask-user` when a scoped `conductor.ask_user`
 * event arrives; this module applies it to the module store.
 */

import type { ConductorAskUserEvent } from "@nautilo/types";
import { applyConductorAskUserEvent } from "./ask-user-state";

const CONDUCTOR_ASK_USER_EVENT = "nautilo:conductor-ask-user";

/** Bun/SSR tests may define a stub `window` without EventTarget APIs (Linux CI). */
function canUseWindowEventBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof window.removeEventListener === "function" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  );
}

export interface ConductorAskUserBridgeDetail {
  readonly event: ConductorAskUserEvent;
  readonly pendingContent?: string | null;
}

export function bridgeConductorAskUserEvent(
  event: ConductorAskUserEvent,
  pendingContent: string | null = null,
): void {
  if (!canUseWindowEventBridge()) {
    applyConductorAskUserEvent(event, pendingContent);
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ConductorAskUserBridgeDetail>(CONDUCTOR_ASK_USER_EVENT, {
      detail: { event, pendingContent },
    }),
  );
}

function subscribeConductorAskUserBridge(
  listener: (detail: ConductorAskUserBridgeDetail) => void,
): () => void {
  if (!canUseWindowEventBridge()) return () => {};
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<ConductorAskUserBridgeDetail>).detail;
    if (!detail?.event || detail.event.type !== "conductor.ask_user") return;
    listener(detail);
  };
  window.addEventListener(CONDUCTOR_ASK_USER_EVENT, handler);
  return () => window.removeEventListener(CONDUCTOR_ASK_USER_EVENT, handler);
}

if (canUseWindowEventBridge()) {
  subscribeConductorAskUserBridge(({ event, pendingContent }) => {
    applyConductorAskUserEvent(event, pendingContent ?? null);
  });
}
