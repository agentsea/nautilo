import type { ConductorAskUserEvent } from "@nautilo/types";
import { bridgeConductorAskUserEvent } from "../components/composer/ask-user-bus";
import { applyConductorAskUserEvent } from "../components/composer/ask-user-state";
import { shouldApplyWsEventForActiveRoom } from "./ws-event-room";

/**
 * D279 Phase 4 — requester-private consumer for `conductor.ask_user`. Called from
 * the runtime WS switch (or tests) after `shouldApplyWsEventForActiveRoom`
 * gating. Wakes no bot; holds `{ options, messageId, roomId }` for the picker.
 *
 * Kept out of `ws-event-room.ts` so routing helpers stay free of ask-user-bus
 * imports (avoids circular-init TDZ on `GLOBAL_EVENT_TYPES` in CI).
 */
export function consumeConductorAskUserWsEvent(params: {
  event: ConductorAskUserEvent;
  viewerUserId: string | null;
  viewerActorId: string | null;
  activeRoomId: string | null;
  laneKeyToRoomId: ReadonlyMap<string, string>;
  jobIdToRoomId: ReadonlyMap<string, string>;
  lastStreamLaneKey: string | null;
  pendingContent?: string | null;
  /** When false, mutate state directly (unit tests). Default: window bridge. */
  useWindowBridge?: boolean;
}): boolean {
  if (
    !params.viewerUserId ||
    !params.viewerActorId ||
    params.event.userId !== params.viewerUserId ||
    params.event.userActorId !== params.viewerActorId
  ) return false;

  const routed = shouldApplyWsEventForActiveRoom({
    event: params.event,
    activeRoomId: params.activeRoomId,
    laneKeyToRoomId: params.laneKeyToRoomId,
    jobIdToRoomId: params.jobIdToRoomId,
    lastStreamLaneKey: params.lastStreamLaneKey,
  });
  if (!routed) return false;

  if (params.event.options.length < 2) {
    applyConductorAskUserEvent(params.event, params.pendingContent ?? null);
    return false;
  }

  if (params.useWindowBridge === false) {
    applyConductorAskUserEvent(params.event, params.pendingContent ?? null);
  } else {
    bridgeConductorAskUserEvent(params.event, params.pendingContent ?? null);
  }
  return true;
}
