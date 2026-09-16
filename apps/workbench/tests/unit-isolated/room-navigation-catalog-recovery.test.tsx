import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useEffect } from "react";
import type { ListRoomsResponse, RoomSummaryDto } from "@nautilo/types";

const KNOWN_ROOM_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ROOM_ID = "22222222-2222-4222-8222-222222222222";

function room(id: string, label: string): RoomSummaryDto {
  return {
    id,
    label,
    type: "private",
    graphThreadId: `room:${id}`,
    createdAt: "2026-08-13T08:00:00.000Z",
    memberCount: 2,
    messageCount: 0,
    lastMessageAt: null,
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    unreadCount: 0,
  };
}

const knownRoom = room(KNOWN_ROOM_ID, "Known");
const targetRoom = room(TARGET_ROOM_ID, "Legal");
const listRooms = mock(async (): Promise<ListRoomsResponse> => ({ rooms: [knownRoom] }));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    listRooms,
  },
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: true,
      staleWhoami: false,
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      userIdentity: "casey",
      capabilities: ["invoke_agents"],
    },
  }),
}));

const { RoomNavigationProvider, useRoomNavigation } = await import(
  "../../src/contexts/room-navigation-context"
);

function Probe() {
  const navigation = useRoomNavigation();
  return (
    <output
      data-testid="navigation"
      data-resolution={navigation.activeResolution.kind}
      data-active-room={navigation.activeRoomId ?? ""}
      data-room-ids={navigation.rooms.map((candidate) => candidate.id).join(",")}
      data-room-labels={navigation.rooms.map((candidate) => candidate.label).join(",")}
      data-error={navigation.roomListError ?? ""}
    />
  );
}

function SwitchProbe({ onBeforeChange }: { onBeforeChange: (roomId: string | null) => void }) {
  const navigation = useRoomNavigation();
  const location = useLocation();
  useEffect(
    () => navigation.registerBeforeActiveRoomChange?.(onBeforeChange),
    [navigation.registerBeforeActiveRoomChange, onBeforeChange],
  );
  return (
    <button
      data-testid="switch-room"
      data-path={location.pathname}
      onClick={() => navigation.setActiveRoom(TARGET_ROOM_ID)}
    >
      Switch
    </button>
  );
}

function renderNavigation(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <RoomNavigationProvider>
        <Probe />
      </RoomNavigationProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  listRooms.mockClear();
  listRooms.mockImplementation(async () => ({ rooms: [knownRoom] }));
});

describe("RoomNavigationProvider room-catalog convergence", () => {
  test("notifies the viewport freeze seam synchronously before canonical Room navigation", async () => {
    listRooms.mockImplementation(async () => ({ rooms: [knownRoom, targetRoom] }));
    const order: string[] = [];
    const onBeforeChange = (roomId: string | null): void => {
      order.push(`before:${roomId}`);
    };
    const view = render(
      <MemoryRouter initialEntries={[`/rooms/${KNOWN_ROOM_ID}`]}>
        <RoomNavigationProvider>
          <SwitchProbe onBeforeChange={onBeforeChange} />
        </RoomNavigationProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));

    fireEvent.click(view.getByTestId("switch-room"));
    expect(order).toEqual([`before:${TARGET_ROOM_ID}`]);
    await waitFor(() => {
      expect(view.getByTestId("switch-room").dataset.path).toBe(`/rooms/${TARGET_ROOM_ID}`);
    });
  });

  test("refreshes an unknown routed room once before declaring it missing", async () => {
    let releaseRecovery: ((value: ListRoomsResponse) => void) | null = null;
    listRooms
      .mockImplementationOnce(async () => ({ rooms: [knownRoom] }))
      .mockImplementationOnce(
        () => new Promise<ListRoomsResponse>((resolve) => {
          releaseRecovery = resolve;
        }),
      );

    const view = renderNavigation(`/rooms/${TARGET_ROOM_ID}`);

    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));
    expect(view.getByTestId("navigation").dataset.resolution).toBe("none");

    releaseRecovery?.({ rooms: [knownRoom, targetRoom] });

    await waitFor(() => {
      expect(view.getByTestId("navigation").dataset.resolution).toBe("selected");
    });
    expect(view.getByTestId("navigation").dataset.activeRoom).toBe(TARGET_ROOM_ID);
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  test("settles a genuinely absent routed room after one recovery read", async () => {
    const view = renderNavigation(`/rooms/${TARGET_ROOM_ID}`);

    await waitFor(() => {
      expect(view.getByTestId("navigation").dataset.resolution).toBe("missing");
    });
    expect(listRooms).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  test("does not call an unverified route missing when recovery is offline", async () => {
    listRooms
      .mockImplementationOnce(async () => ({ rooms: [knownRoom] }))
      .mockImplementationOnce(async () => {
        throw new Error("offline");
      });
    const view = renderNavigation(`/rooms/${TARGET_ROOM_ID}`);

    await waitFor(() => {
      expect(view.getByTestId("navigation").dataset.error).toBe("offline");
    });
    expect(view.getByTestId("navigation").dataset.resolution).toBe("none");
    expect(listRooms).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  test("reloads the catalogue when another client reports a change", async () => {
    listRooms
      .mockImplementationOnce(async () => ({ rooms: [knownRoom] }))
      .mockImplementationOnce(async () => ({ rooms: [knownRoom, targetRoom] }));
    const view = renderNavigation("/");

    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent("nautilo:room-catalog-changed"));

    await waitFor(() => {
      expect(view.getByTestId("navigation").dataset.roomIds).toContain(TARGET_ROOM_ID);
    });
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  test("reloads Room identity projections after a profile rename", async () => {
    const renamedRoom = room(KNOWN_ROOM_ID, "Sample Host");
    listRooms
      .mockImplementationOnce(async () => ({ rooms: [knownRoom] }))
      .mockImplementationOnce(async () => ({ rooms: [renamedRoom] }));
    const view = renderNavigation("/");

    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("nautilo:profile-changed"));

    await waitFor(() => {
      expect(view.getByTestId("navigation").dataset.roomIds).toBe(KNOWN_ROOM_ID);
      expect(view.getByTestId("navigation").dataset.roomLabels).toBe("Sample Host");
      expect(listRooms).toHaveBeenCalledTimes(2);
    });
  });
});
