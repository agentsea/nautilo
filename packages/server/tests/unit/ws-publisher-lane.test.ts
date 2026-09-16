import { describe, expect, test } from "bun:test";
import { roomIdFromLaneKey } from "../../src/realtime/ws-publisher";

/**
 * M134 regression guard. The Conductor routes group-room agent jobs on a
 * per-single-user / per-bot lane key (`room:<id>:user:<actor>:bot:<agentId>`).
 * A `$`-anchored room-lane matcher silently DROPS every event on those lanes,
 * so the bot's reply (message.new / message.tokens / job.*) never reaches the
 * client — "I @-mention a bot and nobody answers." See ISSUE-M134 P3.
 */
describe("roomIdFromLaneKey (M134 WS lane routing)", () => {
  const ROOM = "809996bd-5db4-44a1-875d-82eb9ff84c82";
  const USER = "ee834034-1988-4e71-81e8-182354098ac2";
  const BOT = "d900b3a1-423d-498f-87ae-292553a6744a";

  test("legacy bare room lane resolves to the room", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}`)).toBe(ROOM);
  });

  test("per-single-user lane resolves to the room", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}:user:${USER}`)).toBe(ROOM);
  });

  test("per-(user,bot) group lane resolves to the room (the regression)", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}:user:${USER}:bot:${BOT}`)).toBe(ROOM);
  });

  test("non-room lanes return null", () => {
    expect(roomIdFromLaneKey(`guest:abc`)).toBeNull();
    expect(roomIdFromLaneKey(`app:default`)).toBeNull();
    expect(roomIdFromLaneKey("")).toBeNull();
    expect(roomIdFromLaneKey(`user:${USER}`)).toBeNull();
  });

  test("does not match a malformed room uuid", () => {
    expect(roomIdFromLaneKey("room:not-a-uuid")).toBeNull();
    expect(roomIdFromLaneKey("room:")).toBeNull();
  });
});
