import { describe, test, expect } from "bun:test";
import {
  parentGraphThreadIdFromForkCheckpoint,
  roomGraphThreadFromLaneThread,
} from "../../src/graph/fork-thread-id";

const ROOM = "809996bd-5db4-44a1-875d-82eb9ff84c82";
const BOT = "d900b3a1-423d-498f-87ae-292553a6744a";
const ACTOR = "ee834034-1988-4e71-81e8-182354098ac2";

describe("parentGraphThreadIdFromForkCheckpoint", () => {
  test("strips :fork: suffix, leaves non-fork threads untouched", () => {
    expect(parentGraphThreadIdFromForkCheckpoint(`room:${ROOM}:fork:turn1`)).toBe(
      `room:${ROOM}`,
    );
    expect(parentGraphThreadIdFromForkCheckpoint(`room:${ROOM}`)).toBe(`room:${ROOM}`);
    expect(parentGraphThreadIdFromForkCheckpoint("app:default")).toBe("app:default");
  });
});

describe("roomGraphThreadFromLaneThread (M137 follow-up — multi-agent resume auth)", () => {
  test("bare room thread is unchanged", () => {
    expect(roomGraphThreadFromLaneThread(`room:${ROOM}`)).toBe(`room:${ROOM}`);
  });

  test("per-bot lane collapses to the canonical room thread (THE bug)", () => {
    // This is the exact shape that 403'd every approval reply in a 2+-agent
    // room: the room row stores `room:<id>`, the interrupt thread is bot-laned.
    expect(roomGraphThreadFromLaneThread(`room:${ROOM}:bot:${BOT}`)).toBe(
      `room:${ROOM}`,
    );
  });

  test("per-(user,bot) lane collapses to the canonical room thread", () => {
    expect(
      roomGraphThreadFromLaneThread(`room:${ROOM}:user:${ACTOR}:bot:${BOT}`),
    ).toBe(`room:${ROOM}`);
  });

  test("fork checkpoint on a bot lane still collapses to the room", () => {
    expect(
      roomGraphThreadFromLaneThread(`room:${ROOM}:fork:turn1:bot:${BOT}`),
    ).toBe(`room:${ROOM}`);
  });

  test("non-room threads fall back to fork-stripping unchanged", () => {
    expect(roomGraphThreadFromLaneThread("app:default")).toBe("app:default");
    expect(roomGraphThreadFromLaneThread("app:default:fork:t")).toBe("app:default");
  });
});
