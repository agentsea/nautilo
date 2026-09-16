import "../bun-dom-preload";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";

const refreshRooms = mock(async () => undefined);
let capturedProps: Record<string, unknown> | null = null;

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      sessionActorId: "viewer-actor",
    },
  }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "manage_rooms",
}));

mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ refreshRooms }),
}));

mock.module("../../src/modes/rooms/shape/MembersPanel", () => ({
  MembersPanel: (props: Record<string, unknown>): ReactElement => {
    capturedProps = props;
    return <div data-testid="room-manage-modal">{String(props.roomId)}</div>;
  },
}));

const { RoomManageBridge } = await import("../../src/modes/rooms/shape/RoomManageBridge");
const { EXPLORER_ROOM_MANAGE_EVENT } = await import(
  "../../src/modes/rooms/explorer/sections/shared/ExplorerRow"
);

describe("RoomManageBridge", () => {
  afterEach(() => {
    capturedProps = null;
    refreshRooms.mockClear();
  });

  test("opens the management modal without a mounted Rooms explorer", async () => {
    const view = render(<RoomManageBridge />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(EXPLORER_ROOM_MANAGE_EVENT, {
          detail: { roomId: "room-1", label: "Strategy", focus: "members" },
        }),
      );
    });

    await waitFor(() => {
      expect(view.getByTestId("room-manage-modal").textContent).toBe("room-1");
    });
    expect(capturedProps).toMatchObject({
      roomId: "room-1",
      viewerActorId: "viewer-actor",
      initialMembers: [],
      open: true,
      viewerCanManageRooms: true,
    });

    view.unmount();
  });
});
