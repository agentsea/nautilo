/**
 * Tier 0 (D183 follow-up) — decide whether a "scroll-to-bottom marks the whole
 * room read" call should fire. Pure so the gating logic is unit-testable without
 * mounting the full Signal room (assistant-ui viewport + contexts).
 *
 * The model is the mainstream-chat default (Slack/Discord "you reached the
 * latest message"): per-bubble `useMarkReadOnView` stays the precise layer; this
 * is the coarse signal that keeps the rail dot honest on caught-up rooms.
 *
 * A hidden or unfocused surface must not auto-mark read — inbound messages are
 * left unread until the viewer returns to the visible, focused transcript.
 * Electron needs both signals: a WebContentsView can remain renderer-visible
 * while its host window is parked on another macOS Space.
 */

export interface ViewportMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

const DEFAULT_BOTTOM_THRESHOLD_PX = 80;

export function isViewportAtBottom(
  metrics: ViewportMetrics,
  thresholdPx: number = DEFAULT_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

export function shouldMarkRoomReadAtBottom(args: {
  roomId: string | null;
  verified: boolean;
  unreadCount: number;
  inFlight: boolean;
  viewport: ViewportMetrics | null;
  documentVisible: boolean;
  documentFocused: boolean;
  thresholdPx?: number;
}): boolean {
  const {
    roomId,
    verified,
    unreadCount,
    inFlight,
    viewport,
    documentVisible,
    documentFocused,
    thresholdPx = DEFAULT_BOTTOM_THRESHOLD_PX,
  } = args;
  if (!roomId || !verified) return false;
  if (!documentVisible) return false;
  if (!documentFocused) return false;
  if (unreadCount <= 0) return false;
  if (inFlight) return false;
  if (!viewport) return false;
  return isViewportAtBottom(viewport, thresholdPx);
}
