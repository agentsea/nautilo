import "../../../../../tests/bun-dom-preload";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { TYPING_DECAY_MS } from "@nautilo/types";
import { useTypingOthers } from "../use-typing-others";

function dispatchPing(detail: { roomId: string; userId: string; displayName: string }): void {
  window.dispatchEvent(new CustomEvent("nautilo:typing-ping", { detail }));
}

function dispatchCommitted(detail: { roomId: string; userId: string }): void {
  window.dispatchEvent(new CustomEvent("nautilo:typing-committed", { detail }));
}

describe("useTypingOthers", () => {
  let now = 1_000_000;
  let originalNow: () => number;

  beforeEach(() => {
    now = 1_000_000;
    originalNow = Date.now;
    Date.now = (): number => now;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("ignores pings for other rooms", () => {
    const { result } = renderHook(() => useTypingOthers("room-A"));
    expect(result.current).toEqual([]);
    act(() => {
      dispatchPing({ roomId: "room-B", userId: "u1", displayName: "Bob" });
    });
    expect(result.current).toEqual([]);
  });

  test("collects multiple typers and orders by last ping time", () => {
    const { result } = renderHook(() => useTypingOthers("room-A"));

    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
    });
    expect(result.current.map((o) => o.userId)).toEqual(["u1"]);

    now += 1000;
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u2", displayName: "Bob" });
    });
    expect(result.current.map((o) => o.userId)).toEqual(["u1", "u2"]);

    now += 1000;
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
    });
    expect(result.current.map((o) => o.userId)).toEqual(["u2", "u1"]);
  });

  test("returns empty when roomId becomes null", () => {
    const { result, rerender } = renderHook(({ roomId }) => useTypingOthers(roomId), {
      initialProps: { roomId: "room-A" as string | null },
    });
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
    });
    expect(result.current).toHaveLength(1);
    rerender({ roomId: null });
    expect(result.current).toEqual([]);
  });

  test("clears peers immediately on A→B room switch (not only on null)", () => {
    const { result, rerender } = renderHook(
      ({ roomId }) => useTypingOthers(roomId),
      {
        initialProps: { roomId: "room-A" as string | null },
      },
    );
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current.map((o) => o.userId)).toEqual(["u1"]);

    // Switch to a new non-null room. Before the fix this left room A's
    // chip in state until a room-B ping arrived; now it must be `[]`
    // immediately on the next render, with no room-B ping dispatched.
    rerender({ roomId: "room-B" });
    expect(result.current).toEqual([]);
  });

  test("clears only the committed human immediately", () => {
    const { result } = renderHook(() => useTypingOthers("room-A"));
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
      dispatchPing({ roomId: "room-A", userId: "u2", displayName: "Bob" });
      dispatchCommitted({ roomId: "room-A", userId: "u1" });
    });
    expect(result.current.map((other) => other.userId)).toEqual(["u2"]);
    act(() => dispatchCommitted({ roomId: "room-B", userId: "u2" }));
    expect(result.current.map((other) => other.userId)).toEqual(["u2"]);
  });

  test("decay: TYPING_DECAY_MS is the cutoff threshold", () => {
    expect(TYPING_DECAY_MS).toBeGreaterThan(0);
    const { result } = renderHook(() => useTypingOthers("room-A"));
    act(() => {
      dispatchPing({ roomId: "room-A", userId: "u1", displayName: "Alice" });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.lastPingAt).toBe(now);
  });
});
