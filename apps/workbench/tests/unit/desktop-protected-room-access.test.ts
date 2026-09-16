import { describe, expect, mock, test } from "bun:test";
import {
  subscribeToDesktopProtectedRoomAccessState,
  type DesktopForegroundShadowAPI,
} from "../../src/lib/desktop";

type ProtectedRoomAccessSubscription = Pick<
  DesktopForegroundShadowAPI,
  "onProtectedRoomAccessState"
>;

describe("protected Room Desktop preload compatibility", () => {
  test("does not call a missing subscription on an older Desktop shell", () => {
    expect(() => {
      const unsubscribe = subscribeToDesktopProtectedRoomAccessState(
        {},
        () => undefined,
      );
      unsubscribe();
    }).not.toThrow();
  });

  test("subscribes and unsubscribes through a current Desktop shell", () => {
    const unsubscribe = mock(() => undefined);
    const onProtectedRoomAccessState = mock(() => unsubscribe);
    const api: ProtectedRoomAccessSubscription = {
      onProtectedRoomAccessState,
    };

    const cleanup = subscribeToDesktopProtectedRoomAccessState(
      api,
      () => undefined,
    );
    expect(onProtectedRoomAccessState).toHaveBeenCalledTimes(1);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("contains partial or stale preload failures", () => {
    const throwingSubscription: ProtectedRoomAccessSubscription = {
      onProtectedRoomAccessState: () => {
        throw new Error("stale preload");
      },
    };
    const throwingCleanup: ProtectedRoomAccessSubscription = {
      onProtectedRoomAccessState: () => () => {
        throw new Error("stale cleanup");
      },
    };

    expect(() =>
      subscribeToDesktopProtectedRoomAccessState(
        throwingSubscription,
        () => undefined,
      )()
    ).not.toThrow();
    expect(() =>
      subscribeToDesktopProtectedRoomAccessState(
        throwingCleanup,
        () => undefined,
      )()
    ).not.toThrow();
  });
});
