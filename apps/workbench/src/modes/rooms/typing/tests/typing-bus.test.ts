import "../../../../../tests/bun-dom-preload";
import { describe, expect, test, afterEach, mock } from "bun:test";
import {
  requestTypingPing,
  setTypingPingSender,
  clearTypingPingSender,
  subscribeTypingPing,
  publishTypingCommitted,
  subscribeTypingCommitted,
} from "../typing-bus";

describe("typing-bus outbound bridge (D441)", () => {
  afterEach(() => {
    clearTypingPingSender();
  });

  test("returns false and does not throw before any sender is installed", () => {
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "Alice" }),
    ).toBe(false);
  });

  test("forwards a typing.ping payload and returns true when a sender is installed", () => {
    const calls: { type: string; roomId: string; displayName: string }[] = [];
    setTypingPingSender((payload) => {
      calls.push(payload);
    });
    const ok = requestTypingPing({ roomId: "room-A", displayName: "Alice" });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "typing.ping",
      roomId: "room-A",
      displayName: "Alice",
    });
  });

  test("the forwarded payload never contains a userId key", () => {
    const calls: Record<string, unknown>[] = [];
    setTypingPingSender((payload) => {
      calls.push(payload as unknown as Record<string, unknown>);
    });
    requestTypingPing({ roomId: "room-A", displayName: "Alice" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("userId");
    // Belt-and-braces: assert the exact key set.
    expect(Object.keys(calls[0]).sort()).toEqual(
      ["displayName", "roomId", "type"].sort(),
    );
  });

  test("drops the ping (returns false, never calls sender) on empty roomId", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    expect(requestTypingPing({ roomId: "", displayName: "Alice" })).toBe(false);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("drops the ping on non-string roomId", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    expect(
      requestTypingPing({
        roomId: null as unknown as string,
        displayName: "Alice",
      }),
    ).toBe(false);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("drops the ping on empty / whitespace-only displayName", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    expect(requestTypingPing({ roomId: "room-A", displayName: "" })).toBe(false);
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "   " }),
    ).toBe(false);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("clearTypingPingSender returns the bridge to the no-sender state", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "Alice" }),
    ).toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
    clearTypingPingSender();
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "Alice" }),
    ).toBe(false);
  });

  test("setTypingPingSender(null) also clears the bridge", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "Alice" }),
    ).toBe(true);
    setTypingPingSender(null);
    expect(
      requestTypingPing({ roomId: "room-A", displayName: "Alice" }),
    ).toBe(false);
  });

  test("inbound subscribeTypingPing path is unchanged", () => {
    const seen: { roomId: string; userId: string; displayName: string }[] = [];
    const unsubscribe = subscribeTypingPing((detail) => {
      seen.push(detail);
    });
    window.dispatchEvent(
      new CustomEvent("nautilo:typing-ping", {
        detail: { roomId: "room-A", userId: "u1", displayName: "Alice" },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      roomId: "room-A",
      userId: "u1",
      displayName: "Alice",
    });
    // Ignores malformed detail (no roomId string).
    window.dispatchEvent(
      new CustomEvent("nautilo:typing-ping", { detail: null }),
    );
    expect(seen).toHaveLength(1);
    unsubscribe();
    window.dispatchEvent(
      new CustomEvent("nautilo:typing-ping", {
        detail: { roomId: "room-A", userId: "u2", displayName: "Bob" },
      }),
    );
    expect(seen).toHaveLength(1);
  });

  test("publishes typed local committed evidence and rejects malformed detail", () => {
    const seen: { roomId: string; userId: string }[] = [];
    const unsubscribe = subscribeTypingCommitted((detail) => seen.push(detail));
    publishTypingCommitted({ roomId: "room-A", userId: "u1" });
    publishTypingCommitted({ roomId: "", userId: "u2" });
    expect(seen).toEqual([{ roomId: "room-A", userId: "u1" }]);
    unsubscribe();
  });
});
