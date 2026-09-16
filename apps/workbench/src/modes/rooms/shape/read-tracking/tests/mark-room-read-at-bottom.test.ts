import { describe, expect, test } from "bun:test";
import {
  isViewportAtBottom,
  shouldMarkRoomReadAtBottom,
} from "../mark-room-read-at-bottom";

const atBottom = { scrollHeight: 1000, scrollTop: 920, clientHeight: 80 };
const scrolledUp = { scrollHeight: 1000, scrollTop: 200, clientHeight: 80 };

describe("isViewportAtBottom", () => {
  test("true when within the threshold of the bottom", () => {
    expect(isViewportAtBottom(atBottom)).toBe(true);
  });

  test("true exactly at the bottom", () => {
    expect(isViewportAtBottom({ scrollHeight: 500, scrollTop: 420, clientHeight: 80 })).toBe(
      true,
    );
  });

  test("false when scrolled up past the threshold", () => {
    expect(isViewportAtBottom(scrolledUp)).toBe(false);
  });

  test("respects a custom threshold", () => {
    const m = { scrollHeight: 1000, scrollTop: 800, clientHeight: 80 };
    expect(isViewportAtBottom(m, 80)).toBe(false);
    expect(isViewportAtBottom(m, 200)).toBe(true);
  });
});

describe("shouldMarkRoomReadAtBottom", () => {
  const base = {
    roomId: "room-1",
    verified: true,
    unreadCount: 3,
    inFlight: false,
    viewport: atBottom,
    documentVisible: true,
    documentFocused: true,
  };

  test("fires when verified, unread, not in flight, and at bottom", () => {
    expect(shouldMarkRoomReadAtBottom(base)).toBe(true);
  });

  // M158 — a hidden browser tab must let inbound messages dot, not auto-read.
  test("no-op when the document is hidden even if otherwise eligible", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, documentVisible: false })).toBe(false);
  });

  test("no-op when the document is visible but unfocused", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, documentFocused: false })).toBe(false);
  });

  test("no-op when there is no unread", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, unreadCount: 0 })).toBe(false);
  });

  test("no-op when scrolled up (preserves unfinished backlog)", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, viewport: scrolledUp })).toBe(false);
  });

  test("no-op while a mark-read call is already in flight", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, inFlight: true })).toBe(false);
  });

  test("no-op for unverified viewers (guests)", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, verified: false })).toBe(false);
  });

  test("no-op without a room id", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, roomId: null })).toBe(false);
  });

  test("no-op before the viewport ref resolves", () => {
    expect(shouldMarkRoomReadAtBottom({ ...base, viewport: null })).toBe(false);
  });
});
