import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "bun:test";
import { canRestoreDrawerInRoom, DrawerProvider, useDrawer } from "../drawer-state.tsx";

beforeEach(() => {
  reapplyHappyDomGlobals();
});

describe("drawer-state", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useDrawer(), {
      wrapper: DrawerProvider,
    });
    expect(result.current.current.kind).toBe("closed");
  });

  it("opens a thread drawer", () => {
    const { result } = renderHook(() => useDrawer(), {
      wrapper: DrawerProvider,
    });

    act(() => {
      result.current.open({
        kind: "thread",
        parentRoomId: "parent-123",
        subthreadRoomId: "thread-456",
        anchorMessageId: 789,
      });
    });

    expect(result.current.current).toEqual({
      kind: "thread",
      parentRoomId: "parent-123",
      subthreadRoomId: "thread-456",
      anchorMessageId: 789,
    });
  });

  it("closes the drawer", () => {
    const { result } = renderHook(() => useDrawer(), {
      wrapper: DrawerProvider,
    });

    act(() => {
      result.current.open({
        kind: "person",
        personActorId: "actor-123",
      });
    });

    expect(result.current.current.kind).toBe("person");

    act(() => {
      result.current.close();
    });

    expect(result.current.current.kind).toBe("closed");
  });

  it("swaps drawer type", () => {
    const { result } = renderHook(() => useDrawer(), {
      wrapper: DrawerProvider,
    });

    act(() => {
      result.current.open({
        kind: "thread",
        parentRoomId: "parent-123",
        subthreadRoomId: "thread-456",
        anchorMessageId: 789,
      });
    });

    expect(result.current.current.kind).toBe("thread");

    act(() => {
      result.current.swapTo({
        kind: "person",
        personActorId: "actor-999",
      });
    });

    expect(result.current.current).toEqual({
      kind: "person",
      personActorId: "actor-999",
    });
  });

  it("restores only Room-bound drawers that still belong to the active Room", () => {
    expect(canRestoreDrawerInRoom({ kind: "room", roomId: "room-a" }, "room-a")).toBe(true);
    expect(canRestoreDrawerInRoom({ kind: "room", roomId: "room-a" }, "room-b")).toBe(false);
    expect(canRestoreDrawerInRoom({
      kind: "thread",
      parentRoomId: "room-a",
      subthreadRoomId: "thread-a",
      anchorMessageId: 1,
    }, "room-b")).toBe(false);
    expect(canRestoreDrawerInRoom({ kind: "person", personActorId: "person-a" }, "room-b")).toBe(true);
    expect(canRestoreDrawerInRoom({ kind: "closed" }, null)).toBe(true);
  });
});
