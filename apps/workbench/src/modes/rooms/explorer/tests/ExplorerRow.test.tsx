import "../../../../../tests/bun-dom-preload";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";

const setRoomNotificationPreference = mock(async () => true);
const removeRoomMember = mock(async () => ({ ok: true, kind: "user" as const }));
const toastShow = mock(() => undefined);
let sessionActorId: string | null = "viewer-actor";

mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: toastShow }),
}));
mock.module("../../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionActorId } }),
}));
mock.module("../../../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({
    renameRoom: mock(async () => {}),
    refreshRooms: mock(async () => {}),
  }),
}));
mock.module("../../../../lib/api", () => ({
  apiClient: {
    archiveRoom: mock(async () => {}),
    updateRoomVisibility: mock(async () => {}),
    removeRoomMember,
  },
}));
mock.module("../../../../notifications/notification-state-context", () => ({
  useNotificationState: () => ({
    snapshot: {
      preferences: {
        defaultLevel: "direct",
        roomOverrides: [],
      },
    },
    roomPreferenceMutations: new Map(),
    setRoomNotificationPreference,
  }),
}));
mock.module("../../../../components/avatar/authenticated-image", () => ({
  AuthenticatedAvatar: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));

const { ExplorerRow } = await import("../sections/shared/ExplorerRow");

beforeEach(() => {
  cleanup();
  setRoomNotificationPreference.mockClear();
  removeRoomMember.mockClear();
  toastShow.mockClear();
  sessionActorId = "viewer-actor";
});

describe("Explorer public-room self-leave", () => {
  const publicRoom = {
    id: "public:room-1",
    kind: "room" as const,
    depth: 0,
    label: "# Public room",
    roomId: "room-1",
    isSubthread: false,
    roomKind: "open" as const,
  };

  test("uses the signed-in actor and publishes success after confirmation", async () => {
    const confirm = mock(() => true);
    const previousConfirm = window.confirm;
    window.confirm = confirm;
    const received: Event[] = [];
    const listener = (event: Event) => received.push(event);
    window.addEventListener("nautilo:explorer-room-left", listener);
    try {
      const view = render(<ExplorerRow row={publicRoom} isActive onActivate={() => {}} />);
      fireEvent.click(view.getByLabelText("Actions for # Public room"));
      fireEvent.click(await view.findByText("⇱ Leave room…"));
      await waitFor(() => expect(removeRoomMember).toHaveBeenCalledWith("room-1", "viewer-actor"));
      expect(confirm).toHaveBeenCalledWith("Leave # Public room?");
      await waitFor(() => expect(received).toHaveLength(1));
    } finally {
      window.removeEventListener("nautilo:explorer-room-left", listener);
      window.confirm = previousConfirm;
    }
  });

  test("cancellation performs no mutation", async () => {
    const previousConfirm = window.confirm;
    window.confirm = mock(() => false);
    try {
      const view = render(<ExplorerRow row={publicRoom} isActive={false} onActivate={() => {}} />);
      fireEvent.click(view.getByLabelText("Actions for # Public room"));
      fireEvent.click(await view.findByText("⇱ Leave room…"));
      expect(removeRoomMember).not.toHaveBeenCalled();
    } finally {
      window.confirm = previousConfirm;
    }
  });

  test("does not offer self-leave without a signed-in actor", async () => {
    sessionActorId = null;
    const view = render(<ExplorerRow row={publicRoom} isActive={false} onActivate={() => {}} />);
    fireEvent.click(view.getByLabelText("Actions for # Public room"));
    expect(view.queryByText("⇱ Leave room…")).toBeNull();
  });

  test("surfaces a rejected self-leave", async () => {
    removeRoomMember.mockRejectedValueOnce(new ApiError(409, "DELETE room member failed: 409"));
    const previousConfirm = window.confirm;
    window.confirm = mock(() => true);
    try {
      const view = render(<ExplorerRow row={publicRoom} isActive={false} onActivate={() => {}} />);
      fireEvent.click(view.getByLabelText("Actions for # Public room"));
      fireEvent.click(await view.findByText("⇱ Leave room…"));
      await waitFor(() => expect(toastShow).toHaveBeenCalledWith(expect.objectContaining({
        variant: "error",
        message: "Another room administrator is required before you can leave.",
      })));
    } finally {
      window.confirm = previousConfirm;
    }
  });
});

describe("Explorer Room notification preference", () => {
  test("replaces Mute with the locked inheritable selector", async () => {
    const view = render(
      <ExplorerRow
        row={{
          id: "group:room-1",
          kind: "room",
          depth: 0,
          label: "# Kitchen",
          roomId: "room-1",
          isSubthread: false,
          roomKind: "group",
        }}
        isActive={false}
        onActivate={() => {}}
      />,
    );
    fireEvent.click(view.getByLabelText("Actions for # Kitchen"));
    const select = await view.findByLabelText(
      "Notifications for # Kitchen",
    );
    expect(select.textContent).toContain("Inherit (Directed messages)");
    expect(select.textContent).toContain("Nothing");
    expect(select.textContent).toContain("All messages");

    fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() =>
      expect(setRoomNotificationPreference).toHaveBeenCalledWith(
        "room-1",
        "all",
      ),
    );
    expect(view.queryByText("🔔 Mute")).toBeNull();
  });
});

describe("Explorer Agent avatars", () => {
  test("shows the current display name before the stable federated handle", () => {
    const view = render(
      <ExplorerRow
        row={{
          id: "agent:entity:sample-host",
          kind: "entity-agent",
          depth: 0,
          label: "Sample Host",
          roomId: "room-sample-host",
          agentId: "agent-sample-host",
          handle: { local: "kite", server: "example.local" },
          isSubthread: false,
        }}
        isActive={false}
        onActivate={() => {}}
      />,
    );

    expect(view.getByText("Sample Host")).toBeTruthy();
    expect(view.container.textContent).toContain("kite@example.local");
  });

  test("keeps an initial for the generic shell avatar", () => {
    const view = render(
      <ExplorerRow
        row={{
          id: "agent:entity:generic",
          kind: "entity-agent",
          depth: 0,
          label: "Jeannie",
          roomId: "room-generic",
          agentId: "agent-generic",
          agentAvatar: { kind: "preset", id: "shell" },
          isSubthread: false,
        }}
        isActive={false}
        onActivate={() => {}}
      />,
    );

    expect(view.getByText("J")).toBeTruthy();
    expect(view.queryByAltText("Jeannie")).toBeNull();
  });

  test("uses the authenticated image path for a custom avatar", () => {
    const view = render(
      <ExplorerRow
        row={{
          id: "agent:entity:custom",
          kind: "entity-agent",
          depth: 0,
          label: "Anna",
          roomId: "room-custom",
          agentId: "agent-custom",
          agentAvatar: { kind: "uploaded", blobId: "avatar-v1" },
          isSubthread: false,
        }}
        isActive={false}
        onActivate={() => {}}
      />,
    );

    expect(view.getByAltText("Anna").getAttribute("src")).toBe(
      "/api/rooms/room-custom/agents/agent-custom/avatar?v=avatar-v1",
    );
  });
});
