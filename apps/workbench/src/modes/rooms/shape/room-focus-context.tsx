import { createContext, useContext, type ReactNode, type ReactElement } from "react";
import { useRoomFocus, type RoomFocusState } from "./use-room-focus";

/**
 * D278 §4.7.4 — single room-scoped Conversational Focus source.
 *
 * Focus must have exactly ONE live source per room so every surface that
 * shows or toggles it — the always-on Members panel cards, the compact rail,
 * and the in-transcript agent avatars (R4) — reads and writes the same state.
 * Two independent `useRoomFocus` instances would each poll and drift, so the
 * panel and the chat would disagree about who's focused. This provider owns
 * the one instance; everyone else consumes it.
 *
 * Performance: `useRoomFocus` ticks once a second (TTL countdown). The
 * provider is given its subtree via `children` (created by the parent), so
 * React preserves that element identity across the provider's own re-renders
 * — only actual `useRoomFocusContext()` consumers re-render each tick, never
 * the whole transcript.
 */
const RoomFocusContext = createContext<RoomFocusState | null>(null);

/** Inert state for consumers rendered outside a provider (SSR/tests). */
const NOOP_FOCUS: RoomFocusState = {
  ring: { kind: "none" },
  isTarget: () => false,
  isHeld: () => false,
  isExpiringSoon: () => false,
  secondsLeft: () => null,
  remainingFraction: () => null,
  reasonFor: () => null,
  isBusy: () => false,
  toggle: () => {},
  refresh: async () => {},
};

export function RoomFocusProvider({
  roomId,
  children,
}: {
  readonly roomId: string | null;
  readonly children: ReactNode;
}): ReactElement {
  const focus = useRoomFocus(roomId);
  return <RoomFocusContext.Provider value={focus}>{children}</RoomFocusContext.Provider>;
}

/** Read the shared room focus. Returns an inert state if no provider is present. */
export function useRoomFocusContext(): RoomFocusState {
  return useContext(RoomFocusContext) ?? NOOP_FOCUS;
}
