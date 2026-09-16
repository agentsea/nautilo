import { describe, expect, test } from "bun:test";
import { routingDecidingAfterEvent } from "../conductor-routing-status";

const ROOM = "room-1";
const VIEWER = "actor-viewer";
const OTHER = "actor-other";

describe("routingDecidingAfterEvent (D299)", () => {
  test("enters deciding for matching room + viewer", () => {
    expect(
      routingDecidingAfterEvent(false, {
        roomId: ROOM,
        userActorId: VIEWER,
        state: "deciding",
      }, ROOM, VIEWER),
    ).toBe(true);
  });

  test("clears on settled for matching room + viewer", () => {
    expect(
      routingDecidingAfterEvent(true, {
        roomId: ROOM,
        userActorId: VIEWER,
        state: "settled",
      }, ROOM, VIEWER),
    ).toBe(false);
  });

  test("ignores events for another viewer", () => {
    expect(
      routingDecidingAfterEvent(true, {
        roomId: ROOM,
        userActorId: OTHER,
        state: "settled",
      }, ROOM, VIEWER),
    ).toBe(true);
  });

  test("ignores events for another room", () => {
    expect(
      routingDecidingAfterEvent(false, {
        roomId: "room-2",
        userActorId: VIEWER,
        state: "deciding",
      }, ROOM, VIEWER),
    ).toBe(false);
  });

  test("returns false when room or viewer is missing", () => {
    expect(
      routingDecidingAfterEvent(true, {
        roomId: ROOM,
        userActorId: VIEWER,
        state: "deciding",
      }, null, VIEWER),
    ).toBe(false);
    expect(
      routingDecidingAfterEvent(true, {
        roomId: ROOM,
        userActorId: VIEWER,
        state: "deciding",
      }, ROOM, null),
    ).toBe(false);
  });
});
