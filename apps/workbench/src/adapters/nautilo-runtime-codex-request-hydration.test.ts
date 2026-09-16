import { describe, expect, test } from "bun:test";
import {
  canCommitCodexRequestHydration,
  canStartCodexRequestHydration,
  type CodexRequestHydrationFence,
} from "./nautilo-runtime";

function fence(overrides: Partial<CodexRequestHydrationFence> = {}): CodexRequestHydrationFence {
  return {
    generation: 7,
    viewerKey: "owner-a",
    roomId: "room-a",
    liveSequenceAtStart: 3,
    arrivals: [],
    overflowed: false,
    ...overrides,
  };
}

describe("Codex durable request hydration fences", () => {
  test("starts only for an authenticated owner, active Room, and open WS", () => {
    expect(canStartCodexRequestHydration({ authState: "signed-in", viewerKey: "owner-a", roomId: "room-a", wsState: "open" })).toBe(true);
    expect(canStartCodexRequestHydration({ authState: "signed-out", viewerKey: "owner-a", roomId: "room-a", wsState: "open" })).toBe(false);
    expect(canStartCodexRequestHydration({ authState: "signed-in", viewerKey: null, roomId: "room-a", wsState: "open" })).toBe(false);
    expect(canStartCodexRequestHydration({ authState: "signed-in", viewerKey: "owner-a", roomId: null, wsState: "open" })).toBe(false);
    expect(canStartCodexRequestHydration({ authState: "signed-in", viewerKey: "owner-a", roomId: "room-a", wsState: "connecting" })).toBe(false);
  });

  test("commits only the current viewer/Room/generation snapshot", () => {
    const current = fence();
    const input = {
      cancelled: false,
      hydration: current,
      activeHydration: current,
      viewerKey: "owner-a",
      activeRoomId: "room-a",
      wsState: "open" as const,
      responseRoomId: "room-a",
    };
    expect(canCommitCodexRequestHydration(input)).toBe(true);
    expect(canCommitCodexRequestHydration({ ...input, activeHydration: fence({ generation: 8 }) })).toBe(false);
    expect(canCommitCodexRequestHydration({ ...input, viewerKey: "owner-b" })).toBe(false);
    expect(canCommitCodexRequestHydration({ ...input, activeRoomId: "room-b" })).toBe(false);
    expect(canCommitCodexRequestHydration({ ...input, responseRoomId: "room-b" })).toBe(false);
    expect(canCommitCodexRequestHydration({ ...input, cancelled: true })).toBe(false);
  });

  test("refuses an overflowed fetch window instead of truncating terminal evidence", () => {
    const current = fence({ overflowed: true });
    expect(canCommitCodexRequestHydration({
      cancelled: false,
      hydration: current,
      activeHydration: current,
      viewerKey: "owner-a",
      activeRoomId: "room-a",
      wsState: "open",
      responseRoomId: "room-a",
    })).toBe(false);
  });
});
