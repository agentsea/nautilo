import { describe, expect, test } from "bun:test";
import {
  parseRoomMessageRouteIntent,
  parseRouteRoomId,
  roomPath,
} from "../../src/routes/room-route";

describe("room-route", () => {
  test("roomPath encodes segment", () => {
    expect(roomPath("abc-123")).toBe("/rooms/abc-123");
    expect(roomPath("x/y")).toBe("/rooms/x%2Fy");
  });

  test("roomPath trims and handles empty", () => {
    expect(roomPath("  z  ")).toBe("/rooms/z");
    expect(roomPath("")).toBe("/rooms/");
  });

  test("roomPath encodes a canonical bounded message target", () => {
    expect(roomPath("abc", { targetMessageId: 42 })).toBe("/rooms/abc?messageId=42");
    expect(roomPath("abc", { targetMessageId: "9007199254740991" })).toBe(
      "/rooms/abc?messageId=9007199254740991",
    );
  });

  test("roomPath omits invalid message targets", () => {
    expect(roomPath("abc", { targetMessageId: 0 })).toBe("/rooms/abc");
    expect(roomPath("abc", { targetMessageId: -1 })).toBe("/rooms/abc");
    expect(roomPath("abc", { targetMessageId: 1.5 })).toBe("/rooms/abc");
    expect(roomPath("abc", { targetMessageId: "01" })).toBe("/rooms/abc");
    expect(roomPath("abc", { targetMessageId: "9007199254740992" })).toBe("/rooms/abc");
  });

  test("parseRouteRoomId extracts id", () => {
    expect(parseRouteRoomId("/rooms/abc")).toBe("abc");
    expect(parseRouteRoomId("/rooms/x%2Fy")).toBe("x/y");
  });

  test("parseRouteRoomId rejects non-room paths", () => {
    expect(parseRouteRoomId("/")).toBeUndefined();
    expect(parseRouteRoomId("/settings")).toBeUndefined();
    expect(parseRouteRoomId("/rooms/")).toBeUndefined();
    expect(parseRouteRoomId("/rooms/a/extra")).toBeUndefined();
  });

  test("parses one canonical message target while preserving unrelated query state", () => {
    expect(parseRoomMessageRouteIntent("?source=all&messageId=42")).toEqual({
      kind: "target",
      messageId: 42,
    });
    expect(parseRoomMessageRouteIntent("?source=all")).toEqual({ kind: "none" });
  });

  test("rejects duplicate, non-canonical, and unbounded message targets", () => {
    for (const search of [
      "?messageId=1&messageId=2",
      "?messageId=0",
      "?messageId=-1",
      "?messageId=01",
      "?messageId=1.5",
      "?messageId=9007199254740992",
    ]) {
      expect(parseRoomMessageRouteIntent(search)).toEqual({ kind: "invalid" });
    }
  });
});
