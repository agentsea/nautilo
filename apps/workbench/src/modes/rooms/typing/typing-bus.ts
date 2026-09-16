/**
 * Stack-3 Phase 6b — typed wrapper around the inbound `window` CustomEvent
 * that carries typing pings from the runtime adapter to feature code.
 *
 * Stack 207 / ISSUE-D441 — added a narrow typed OUTBOUND bridge so the
 * desktop composer can emit `typing.ping` pings without feature code
 * ever touching a raw WebSocket sender. The runtime adapter installs
 * the sender; the composer calls {@link requestTypingPing}.
 *
 *   - INBOUND (`nautilo:typing-ping`): nautilo-runtime.tsx dispatches
 *     this when a server `typing.ping` event arrives over the WS.
 *     Consumers: {@link subscribeTypingPing} (receiver hooks).
 *   - OUTBOUND (`typing.ping`): the runtime installs a sender via
 *     {@link setTypingPingSender}; feature code calls
 *     {@link requestTypingPing}. The sender is responsible for the
 *     drop-when-closed gate so `RealtimeClient`'s outbound queue can
 *     never replay stale typing after reconnect.
 *
 * Using a window event for inbound + a module-level sender slot for
 * outbound keeps the typing pipeline decoupled from the runtime
 * provider's render tree (no extra context Provider / consumer hops;
 * ephemeral state never enters React state and so doesn't trigger
 * re-renders elsewhere). This module is runtime-free (no React, no
 * DOM) so it can be unit-tested in isolation and imported by
 * `nautilo-runtime.tsx` without side effects.
 */

const INBOUND_EVENT = "nautilo:typing-ping";
const COMMITTED_EVENT = "nautilo:typing-committed";

export interface TypingPingDetail {
  roomId: string;
  userId: string;
  displayName: string;
}

/** Local evidence that a human message was persisted for this Room/user. */
export interface TypingCommittedDetail {
  roomId: string;
  userId: string;
}

export function subscribeTypingPing(
  listener: (detail: TypingPingDetail) => void,
): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<TypingPingDetail>).detail;
    if (!detail || typeof detail.roomId !== "string") return;
    listener(detail);
  };
  window.addEventListener(INBOUND_EVENT, handler);
  return () => window.removeEventListener(INBOUND_EVENT, handler);
}

/** Notify presence consumers that a typer committed their message. */
export function publishTypingCommitted(detail: TypingCommittedDetail): void {
  if (
    typeof detail.roomId !== "string" || detail.roomId.length === 0 ||
    typeof detail.userId !== "string" || detail.userId.length === 0
  ) return;
  window.dispatchEvent(new CustomEvent<TypingCommittedDetail>(COMMITTED_EVENT, { detail }));
}

export function subscribeTypingCommitted(
  listener: (detail: TypingCommittedDetail) => void,
): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<TypingCommittedDetail>).detail;
    if (!detail || typeof detail.roomId !== "string" || typeof detail.userId !== "string") return;
    listener(detail);
  };
  window.addEventListener(COMMITTED_EVENT, handler);
  return () => window.removeEventListener(COMMITTED_EVENT, handler);
}

/**
 * Outbound typing-ping payload. Deliberately omits `userId` — the
 * server uses the authenticated socket's `userId` and ignores any
 * client-sent value, so sending it would be misleading at best.
 */
export interface TypingPingOutboundPayload {
  type: "typing.ping";
  roomId: string;
  displayName: string;
}

type TypingPingSender = (payload: TypingPingOutboundPayload) => void;

// Module-level sender slot installed and cleared by the runtime adapter.
// Feature code reaches it through `requestTypingPing`; `null` drops the ping.
let typingPingSender: TypingPingSender | null = null;

/**
 * Install (or clear, with `null`) the outbound typing-ping sender.
 * The runtime is the only intended caller. Clearing on unmount prevents
 * a hot-reload/teardown from calling a stale closure.
 */
export function setTypingPingSender(fn: TypingPingSender | null): void {
  typingPingSender = fn;
}

/**
 * Convenience alias for `setTypingPingSender(null)`.
 */
export function clearTypingPingSender(): void {
  typingPingSender = null;
}

/**
 * Request an outbound `typing.ping` for `roomId` from `displayName`.
 * Returns `true` when a sender is installed and the payload was
 * forwarded; returns `false` (and drops the ping silently) when no
 * sender is installed, when `roomId` is empty/non-string, or when
 * `displayName` is empty/whitespace-only. Never throws.
 *
 * The runtime sender is the authority on whether the ping actually
 * leaves the socket — it MUST short-circuit before
 * `RealtimeClient.send(...)` when the WS is not authenticated/open so
 * the disconnected outbound queue cannot replay stale typing.
 */
export function requestTypingPing(input: {
  roomId: string;
  displayName: string;
}): boolean {
  if (
    !typingPingSender ||
    typeof input.roomId !== "string" ||
    input.roomId.length === 0 ||
    typeof input.displayName !== "string" ||
    input.displayName.trim().length === 0
  ) {
    return false;
  }
  const payload: TypingPingOutboundPayload = {
    type: "typing.ping",
    roomId: input.roomId,
    displayName: input.displayName,
  };
  typingPingSender(payload);
  return true;
}
