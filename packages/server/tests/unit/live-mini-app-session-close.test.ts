import { describe, expect, test } from "bun:test";
import { closeLiveMiniAppSessionsForRelay } from "../../src/realtime/live-mini-app-session-close";

describe("relay disconnect live-review closure", () => {
  test("publishes exactly one sanitized user-scoped event per revoked session", () => {
    const calls: Array<{ event: Record<string, unknown>; userId: string }> = [];
    const revoked = closeLiveMiniAppSessionsForRelay(
      { userId: "user-1", relayId: "relay-private" },
      {
        registry: {
          revokeForRelay(userId, relayId, beforeRevoke) {
            expect(userId).toBe("user-1");
            expect(relayId).toBe("relay-private");
            beforeRevoke?.("session-a");
            beforeRevoke?.("session-b");
            return ["session-a", "session-b"];
          },
      },
        onSessionClosing(sessionId) {
          calls.push({ event: { type: "closing", sessionId }, userId: "internal" });
        },
        publish(event, userId) {
          calls.push({ event, userId });
        },
      },
    );

    expect(revoked).toEqual(["session-a", "session-b"]);
    expect(calls).toEqual([
      { event: { type: "closing", sessionId: "session-a" }, userId: "internal" },
      { event: { type: "closing", sessionId: "session-b" }, userId: "internal" },
      {
        event: {
          type: "live-mini-app.session.closed",
          sessionId: "session-a",
          reason: "relay_disconnected",
        },
        userId: "user-1",
      },
      {
        event: {
          type: "live-mini-app.session.closed",
          sessionId: "session-b",
          reason: "relay_disconnected",
        },
        userId: "user-1",
      },
    ]);
    const wire = JSON.stringify(calls.map(({ event }) => event));
    expect(wire).not.toContain("relay-private");
    expect(wire).not.toContain("user-1");
    expect(wire).not.toContain("token");
    expect(wire).not.toContain("path");
    expect(wire).not.toContain("root");
  });
});
