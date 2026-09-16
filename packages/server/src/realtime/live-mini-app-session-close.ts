import type { LiveMiniAppSessionRegistry } from "../apps/live-mini-app-session-registry";

export type LiveMiniAppRelayDisconnectedEvent = {
  type: "live-mini-app.session.closed";
  sessionId: string;
  reason: "relay_disconnected";
};

/** Revoke relay-pinned review authority before publishing one sanitized event
 * per closed session. The user id is delivery metadata, never event payload. */
export function closeLiveMiniAppSessionsForRelay(
  input: { userId: string; relayId: string },
  deps: {
    registry: Pick<LiveMiniAppSessionRegistry, "revokeForRelay">;
    /** Resolve Task-owned review state while registry lineage still exists. */
    onSessionClosing?: (sessionId: string) => void;
    publish: (event: LiveMiniAppRelayDisconnectedEvent, userId: string) => void;
  },
): readonly string[] {
  const sessionIds = deps.registry.revokeForRelay(
    input.userId,
    input.relayId,
    deps.onSessionClosing,
  );
  for (const sessionId of sessionIds) {
    deps.publish(
      {
        type: "live-mini-app.session.closed",
        sessionId,
        reason: "relay_disconnected",
      },
      input.userId,
    );
  }
  return sessionIds;
}
