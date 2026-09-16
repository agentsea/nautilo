import "../../tests/bun-dom-preload";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { RoomInitialHydrationState } from "../adapters/room-initial-hydration";
import {
  RoomInitialHistorySurface,
  selectRoomInitialHistorySurface,
} from "./room-initial-history-surface";

const scope = {
  origin: "https://server.example",
  viewerKey: "viewer-1",
  viewerGeneration: 2,
  roomId: "room-current",
  generation: 5,
} as const;

function state(kind: RoomInitialHydrationState["kind"]): RoomInitialHydrationState {
  switch (kind) {
    case "waiting-for-authority":
      return { kind, scope, sendAuthorized: true };
    case "recoverable-error":
      return { kind, scope, retainsCachedFrame: false };
    case "access-terminal-error":
      return { kind, scope, reason: "unauthorized" };
    default:
      return { kind, scope };
  }
}

function renderSurface(
  hydration: RoomInitialHydrationState,
  activeRoomId: string | null = scope.roomId,
) {
  const onRetry = mock(() => {});
  return {
    onRetry,
    ...render(
      <RoomInitialHistorySurface
        activeRoomId={activeRoomId}
        onRetry={onRetry}
        state={hydration}
      />,
    ),
  };
}

afterEach(cleanup);

describe("selectRoomInitialHistorySurface", () => {
  test("projects each active-room hydration outcome to one honest surface", () => {
    expect(selectRoomInitialHistorySurface(state("unresolved"), scope.roomId)).toBe("skeletons");
    expect(selectRoomInitialHistorySurface(state("syncing"), scope.roomId)).toBe("syncing");
    expect(selectRoomInitialHistorySurface(state("waiting-for-authority"), scope.roomId))
      .toBe("waiting-for-authority");
    expect(selectRoomInitialHistorySurface(state("ready"), scope.roomId)).toBe("none");
    expect(selectRoomInitialHistorySurface(state("empty"), scope.roomId)).toBe("none");
    expect(selectRoomInitialHistorySurface(state("access-terminal-error"), scope.roomId)).toBe("access-terminal");
    expect(
      selectRoomInitialHistorySurface(
        { kind: "recoverable-error", scope, retainsCachedFrame: false },
        scope.roomId,
      ),
    ).toBe("retry-without-cache");
    expect(
      selectRoomInitialHistorySurface(
        { kind: "recoverable-error", scope, retainsCachedFrame: true },
        scope.roomId,
      ),
    ).toBe("retry-with-cache");
  });

  test("treats a state from another Room as unresolved, never stale disclosure", () => {
    expect(selectRoomInitialHistorySurface(state("ready"), "room-next")).toBe("skeletons");
    expect(selectRoomInitialHistorySurface(state("syncing"), null)).toBe("none");
    expect(selectRoomInitialHistorySurface(null, scope.roomId)).toBe("skeletons");
  });
});

describe("RoomInitialHistorySurface", () => {
  test("renders one polite atomic loading disclosure and anonymous skeleton geometry", () => {
    const view = renderSurface(state("unresolved"));

    const loadingStatus = view.getByRole("status");
    expect(loadingStatus.textContent).toBe("Loading messages");
    expect(loadingStatus.getAttribute("aria-live")).toBe("polite");
    expect(loadingStatus.getAttribute("aria-atomic")).toBe("true");
    expect(view.getAllByRole("status")).toHaveLength(1);

    const geometry = view.getByTestId("room-initial-history-skeletons");
    expect(geometry.querySelector("[aria-hidden=\"true\"]")).toBeTruthy();
    expect(geometry.querySelectorAll("[aria-hidden=\"true\"] > div")).toHaveLength(4);
    expect(geometry.textContent).toContain("Loading messages");
    expect(geometry.textContent).not.toMatch(/avatar|agent|message preview|\d\d:\d\d/i);
    const firstSkeleton = geometry.querySelector("[aria-hidden=\"true\"] > div");
    expect(firstSkeleton?.className).toContain(
      "motion-safe:animate-pulse",
    );
    expect(firstSkeleton?.className).toContain(
      "motion-reduce:animate-none",
    );
  });

  test("keeps the transcript clear during syncing and announces only the quiet disclosure", () => {
    const view = renderSurface(state("syncing"));

    expect(view.getByRole("status").textContent).toBe("Syncing latest");
    expect(view.queryByTestId("room-initial-history-skeletons")).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").className).toContain("absolute");
    expect(view.getByRole("status").className).toContain("pointer-events-none");
  });

  test("shows authority convergence as a calm automatic wait", () => {
    const view = renderSurface(state("waiting-for-authority"));

    expect(view.getByRole("status").textContent).toBe("Waiting for secure message access");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("scope mismatch renders skeletons rather than a previous Room's ready state", () => {
    const view = renderSurface(state("ready"), "room-next");

    expect(view.getByRole("status").textContent).toBe("Loading messages");
    expect(view.queryByText("Syncing latest")).toBeNull();
  });

  test("renders a bounded alert and stable Retry action when no cached frame remains", () => {
    const hydration: RoomInitialHydrationState = {
      kind: "recoverable-error",
      scope,
      retainsCachedFrame: false,
    };
    const view = renderSurface(hydration);

    expect(view.getByRole("alert").textContent).toContain("Couldn't load messages.");
    const retry = view.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(view.onRetry).toHaveBeenCalledTimes(1);
  });

  test("preserves cached transcript space and exposes a quiet failed-sync Retry action", () => {
    const hydration: RoomInitialHydrationState = {
      kind: "recoverable-error",
      scope,
      retainsCachedFrame: true,
    };
    const view = renderSurface(hydration);

    expect(view.getByRole("status").textContent).toContain("Couldn't sync latest messages.");
    expect(view.queryByRole("alert")).toBeNull();
    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("pointer-events-auto");
    fireEvent.click(retry);
    expect(view.onRetry).toHaveBeenCalledTimes(1);
  });

  test("renders no replacement for ready or empty states", () => {
    for (const kind of ["ready", "empty"] as const) {
      const view = renderSurface(state(kind));
      expect(view.container.firstChild).toBeNull();
      view.unmount();
    }
  });

  test("renders a bounded terminal-access message without Retry", () => {
    const unauthorized = renderSurface(state("access-terminal-error"));
    expect(unauthorized.getByRole("alert").textContent).toBe(
      "You no longer have access to this chat.",
    );
    expect(unauthorized.queryByRole("button", { name: "Retry" })).toBeNull();
    unauthorized.unmount();

    const notFound: RoomInitialHydrationState = {
      kind: "access-terminal-error",
      scope,
      reason: "not-found",
    };
    const missing = renderSurface(notFound);
    expect(missing.getByRole("alert").textContent).toBe("This chat is no longer available.");
  });

  test("shows skeletons while the active Room waits for its first state", () => {
    const view = renderSurface(null);
    expect(view.getByRole("status").textContent).toBe("Loading messages");
  });
});
