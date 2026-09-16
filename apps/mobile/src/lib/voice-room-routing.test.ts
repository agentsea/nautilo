import { describe, expect, test } from "bun:test";
import type { VoiceAudioEvent } from "@nautilo/types";

import {
  activeRoomIdFromPathname,
  shouldPlayRoomVoiceAudio,
} from "./voice-room-routing";

const event: VoiceAudioEvent = {
  type: "voice.audio",
  data: "audio",
  chunkIndex: 0,
  sentenceIndex: 0,
  final: false,
  roomId: "room-a",
};

describe("D570 Mobile room-scoped voice routing", () => {
  test("resolves only a visible chat Room", () => {
    expect(activeRoomIdFromPathname("/chat/room-a")).toBe("room-a");
    expect(activeRoomIdFromPathname("/chat/room%20a")).toBe("room a");
    expect(activeRoomIdFromPathname("/settings/voice")).toBeNull();
    expect(activeRoomIdFromPathname(null)).toBeNull();
  });

  test("plays only with local voice enabled in the exact active Room", () => {
    expect(shouldPlayRoomVoiceAudio({ event, activeRoomId: "room-a", enabled: true })).toBe(true);
    expect(shouldPlayRoomVoiceAudio({ event, activeRoomId: "room-b", enabled: true })).toBe(false);
    expect(shouldPlayRoomVoiceAudio({ event, activeRoomId: null, enabled: true })).toBe(false);
    expect(shouldPlayRoomVoiceAudio({ event, activeRoomId: "room-a", enabled: false })).toBe(false);
  });

  test("missing Room provenance fails closed", () => {
    expect(shouldPlayRoomVoiceAudio({
      event: { ...event, roomId: undefined },
      activeRoomId: "room-a",
      enabled: true,
    })).toBe(false);
  });
});
