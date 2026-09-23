import { describe, expect, test } from "bun:test";
import { resolveVoiceOwnership } from "../../src/adapters/voice-ownership";

describe("voice ownership", () => {
  test("a companion pin prevents an ordinary send in another Room from requesting discarded speech", () => {
    expect(resolveVoiceOwnership({
      activeRoomId: "room-visible",
      activeRoomEnabled: true,
      companionRoomId: "room-floating",
    })).toEqual({
      roomId: "room-floating",
      enabled: true,
      activeRoomSendVoiceMode: false,
    });
  });

  test("removing a companion pin restores the active Room's chosen voice preference", () => {
    const pinned = resolveVoiceOwnership({
      activeRoomId: "room-visible",
      activeRoomEnabled: true,
      companionRoomId: "room-floating",
    });
    const restored = resolveVoiceOwnership({
      activeRoomId: "room-visible",
      activeRoomEnabled: true,
      companionRoomId: null,
    });

    expect(pinned.roomId).toBe("room-floating");
    expect(restored).toEqual({
      roomId: "room-visible",
      enabled: true,
      activeRoomSendVoiceMode: true,
    });
  });

  test("a companion can temporarily own playback without changing a disabled active Room preference", () => {
    expect(resolveVoiceOwnership({
      activeRoomId: "room-visible",
      activeRoomEnabled: false,
      companionRoomId: "room-floating",
    }).enabled).toBe(true);
    expect(resolveVoiceOwnership({
      activeRoomId: "room-visible",
      activeRoomEnabled: false,
      companionRoomId: null,
    }).enabled).toBe(false);
  });
});
