/**
 * D246 Wave 2 (task 2.3) — progressive active-room hydration.
 *
 * Proves the three load-bearing behaviors of `ActiveRoom` + `useRoomMembers`:
 *
 *  1. **Chrome mounts from the summary roster** while the authoritative
 *     `GET /api/rooms/:id` detail is still in flight (injected latency) —
 *     the conversation surface shows summary-derived member names before
 *     the detail resolves, so a slow detail response cannot blank the shell.
 *  2. **Room switching cannot apply stale details** — a slow detail fetch
 *     for room A that resolves AFTER the user switched to room B must NOT
 *     overwrite B's members.
 *  3. **Failure keeps the chrome mounted** — a detail-fetch error does not
 *     blank the conversation surface when summary/last-known members exist;
 *     the error UI only appears when there are no members to fall back to.
 *
 * `SlackShapeRoom` and `RoomShapeSkeleton` are mocked thin so the test
 * exercises `ActiveRoom`'s hydration logic (mount/skeleton/error gating)
 * without dragging the full `Conversation` tree into the DOM.
 */
import { afterAll, beforeAll, beforeEach, describe, test, expect, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { RoomMemberDto } from "@nautilo/types";

// --- Controllable apiClient.getRoom deferreds keyed by roomId ---------------
interface Deferred {
  resolve: (detail: { members: RoomMemberDto[]; conductorMode: "advanced" | "standard" }) => void;
  reject: (err: Error) => void;
}
const pending = new Map<string, Deferred>();
const getRoomCalls: string[] = [];

mock.module("../../../../lib/api", () => ({
  apiClient: {
    getRoom: (roomId: string) => {
      getRoomCalls.push(roomId);
      return new Promise<{ members: RoomMemberDto[]; conductorMode: "advanced" | "standard" }>(
        (resolve, reject) => {
          pending.set(roomId, {
            resolve: resolve as Deferred["resolve"],
            reject,
          });
        },
      );
    },
  },
}));

// --- Mutable room-navigation state so tests can switch rooms via rerender ---
let navState: {
  activeRoomId: string | null;
  activeRoom: { id: string; roster: RoomMemberDto[] } | null;
};
mock.module("../../../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => navState,
}));

// --- Thin mocks so the test focuses on hydration, not the full chat tree ----
mock.module("../slack/SlackShapeRoom", () => ({
  SlackShapeRoom: (props: {
    roomId?: string;
    members: readonly RoomMemberDto[];
  }) => {
    const names = props.members.map((m) => m.displayName).join(",");
    return (
      <div
        data-testid="slack-shape"
        data-room-id={props.roomId ?? ""}
        data-member-names={names}
      >
        {names}
      </div>
    );
  },
}));

mock.module("../RoomShapeSkeleton", () => ({
  RoomShapeSkeleton: () => <div data-testid="room-skeleton" aria-busy="true" />,
}));

const { ActiveRoom } = await import("../ActiveRoom");
const { resetRoomMembersCacheForTests } = await import("../use-room-members");

const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
});

afterAll(async () => {
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
});

beforeEach(() => {
  resetRoomMembersCacheForTests();
  pending.clear();
  getRoomCalls.length = 0;
  navState = { activeRoomId: null, activeRoom: null };
});

function summaryRoster(members: Array<Partial<RoomMemberDto> & Pick<RoomMemberDto, "actorId" | "kind" | "displayName">>) {
  return members as unknown as RoomMemberDto[];
}

describe("ActiveRoom — D246 Wave 2 progressive hydration", () => {
  test("first render mounts chrome synchronously from the summary roster", async () => {
    navState = {
      activeRoomId: "room-a",
      activeRoom: {
        id: "room-a",
        roster: summaryRoster([
          { actorId: "u1", kind: "user", displayName: "Summary Owner", userId: "u1" },
          { actorId: "a1", kind: "agent", displayName: "Summary Genie", agentId: "a1" },
        ]),
      },
    };

    const view = render(<ActiveRoom />);

    // Assert immediately after render — do not wait for the passive detail
    // effect. The initial hook state itself must carry the summary roster.
    expect(view.getByTestId("slack-shape")).toBeTruthy();
    expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
      "Summary Owner,Summary Genie",
    );
    expect(view.queryByTestId("room-skeleton")).toBeNull();
    // Exactly one detail fetch for the active room (no per-room fan-out here).
    expect(getRoomCalls).toEqual(["room-a"]);

    // Authoritative detail lands → members replace the seed.
    pending.get("room-a")?.resolve({
      members: [
        { actorId: "u1", kind: "user", displayName: "Authoritative Owner", userId: "u1", roomRole: "admin" },
        { actorId: "a1", kind: "agent", displayName: "Authoritative Genie", agentId: "a1", roomRole: "member" },
      ],
      conductorMode: "advanced",
    });

    await waitFor(() => {
      expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
        "Authoritative Owner,Authoritative Genie",
      );
    });
    view.unmount();
  });

  test("room switch returns the new summary synchronously and rejects stale detail", async () => {
    navState = {
      activeRoomId: "room-a",
      activeRoom: {
        id: "room-a",
        roster: summaryRoster([
          { actorId: "u1", kind: "user", displayName: "A Owner", userId: "u1" },
        ]),
      },
    };
    const view = render(<ActiveRoom />);
    expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe("A Owner");
    // room-a's detail is still pending.

    // Switch to room-b with its own summary roster.
    navState = {
      activeRoomId: "room-b",
      activeRoom: {
        id: "room-b",
        roster: summaryRoster([
          { actorId: "u1", kind: "user", displayName: "B Owner", userId: "u1" },
          { actorId: "a2", kind: "agent", displayName: "B Genie", agentId: "a2" },
        ]),
      },
    };
    view.rerender(<ActiveRoom />);

    // Assert synchronously after rerender. The hook must key its returned
    // snapshot to room-b rather than exposing room-a until an effect runs.
    expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
      "B Owner,B Genie",
    );
    expect(view.queryByTestId("room-skeleton")).toBeNull();

    // room-a's slow detail finally resolves with A-specific names. It MUST NOT
    // overwrite room-b's members.
    pending.get("room-a")?.resolve({
      members: [
        { actorId: "u1", kind: "user", displayName: "STALE A OWNER", userId: "u1", roomRole: "admin" },
      ],
      conductorMode: "advanced",
    });

    // Yield a tick so the stale resolution's .then runs.
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
      "B Owner,B Genie",
    );
    expect(view.getByTestId("slack-shape").getAttribute("data-room-id")).toBe("room-b");
    view.unmount();
  });

  test("detail-fetch failure keeps the chrome mounted when summary members exist", async () => {
    navState = {
      activeRoomId: "room-a",
      activeRoom: {
        id: "room-a",
        roster: summaryRoster([
          { actorId: "u1", kind: "user", displayName: "Summary Owner", userId: "u1" },
        ]),
      },
    };
    const view = render(<ActiveRoom />);
    await waitFor(() => {
      expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
        "Summary Owner",
      );
    });

    // Detail fetch fails — chrome must stay mounted with the summary members,
    // NOT blank to an error state (we have members to fall back to).
    pending.get("room-a")?.reject(new Error("detail fetch blew up"));

    await waitFor(() => {
      // Still mounted with the summary-derived name.
      expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
        "Summary Owner",
      );
    });
    expect(view.queryByTestId("room-skeleton")).toBeNull();
    view.unmount();
  });

  test("skeleton shows when there is no summary roster AND detail is still loading", async () => {
    navState = {
      activeRoomId: "room-a",
      activeRoom: { id: "room-a", roster: [] },
    };
    const view = render(<ActiveRoom />);
    // No seed members + detail pending → skeleton (no blank SlackShapeRoom).
    await waitFor(() => {
      expect(view.queryByTestId("room-skeleton")).toBeTruthy();
    });
    expect(view.queryByTestId("slack-shape")).toBeNull();

    pending.get("room-a")?.resolve({
      members: [
        { actorId: "u1", kind: "user", displayName: "Late Owner", userId: "u1", roomRole: "admin" },
      ],
      conductorMode: "advanced",
    });
    await waitFor(() => {
      expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe(
        "Late Owner",
      );
    });
    view.unmount();
  });

  test("no active room → empty SlackShapeRoom, no fetch", () => {
    navState = { activeRoomId: null, activeRoom: null };
    const view = render(<ActiveRoom />);
    expect(view.getByTestId("slack-shape").getAttribute("data-member-names")).toBe("");
    expect(getRoomCalls).toEqual([]);
    view.unmount();
  });
});
