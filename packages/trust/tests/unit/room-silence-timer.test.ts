import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelAllSilenceWindowExpiryForRoom,
  cancelSilenceWindowExpiry,
  scheduleSilenceWindowExpiry,
} from "../../src/room-silence";

describe("silence expiry timers (D279 3.6)", () => {
  afterEach(() => {
    cancelAllSilenceWindowExpiryForRoom("room-1");
    cancelSilenceWindowExpiry("win-2");
  });

  test("schedule replaces prior timer for the same windowId", async () => {
    const calls: string[] = [];
    const now = new Date("2026-06-09T12:00:00.000Z");

    scheduleSilenceWindowExpiry({
      roomId: "room-1",
      windowId: "win-1",
      expiresAt: new Date(now.getTime() + 50),
      now,
      onExpired: (roomId) => {
        calls.push(roomId);
      },
    });
    scheduleSilenceWindowExpiry({
      roomId: "room-1",
      windowId: "win-1",
      expiresAt: new Date(now.getTime() + 80),
      now,
      onExpired: (roomId) => {
        calls.push(`late:${roomId}`);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toEqual(["late:room-1"]);
  });

  test("cancelAllSilenceWindowExpiryForRoom clears pending timers", async () => {
    const calls: string[] = [];
    const now = new Date("2026-06-09T12:00:00.000Z");

    scheduleSilenceWindowExpiry({
      roomId: "room-1",
      windowId: "win-2",
      expiresAt: new Date(now.getTime() + 30),
      now,
      onExpired: () => {
        calls.push("fired");
      },
    });
    cancelAllSilenceWindowExpiryForRoom("room-1");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
  });
});
