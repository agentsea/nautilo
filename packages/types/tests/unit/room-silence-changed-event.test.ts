import { describe, expect, test } from "bun:test";
import type {
  RoomConductorModeChangedEvent,
  RoomSilenceChangedEvent,
  ServerEvent,
} from "@nautilo/types";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

describe("RoomSilenceChangedEvent wire shape (D279 3.6)", () => {
  test("active silence payload matches contract", () => {
    const ev = {
      type: "room.silence.changed",
      roomId: ROOM_ID,
      laneKey: `room:${ROOM_ID}`,
      silence: {
        id: "55555555-5555-4555-8555-555555555555",
        kind: "mute",
        botActorId: null,
        botDisplayName: null,
        setByDisplayName: "Room Admin",
        expiresAt: "2026-06-09T12:30:00.000Z",
      },
    } satisfies RoomSilenceChangedEvent;
    const asServer: ServerEvent = ev;
    expect(asServer.type).toBe("room.silence.changed");
    expect(ev.laneKey).toBe(`room:${ROOM_ID}`);
    expect(ev.silence?.kind).toBe("mute");
  });

  test("cleared silence carries null", () => {
    const ev = {
      type: "room.silence.changed",
      roomId: ROOM_ID,
      laneKey: `room:${ROOM_ID}`,
      silence: null,
    } satisfies RoomSilenceChangedEvent;
    expect(ev.silence).toBeNull();
  });
});

describe("RoomConductorModeChangedEvent wire shape (D302 P5b)", () => {
  test("mode payload matches contract", () => {
    const ev = {
      type: "room.conductor_mode.changed",
      roomId: ROOM_ID,
      laneKey: `room:${ROOM_ID}`,
      conductorMode: "standard",
    } satisfies RoomConductorModeChangedEvent;
    const asServer: ServerEvent = ev;
    expect(asServer.type).toBe("room.conductor_mode.changed");
    expect(ev.laneKey).toBe(`room:${ROOM_ID}`);
    expect(ev.conductorMode).toBe("standard");
  });
});
