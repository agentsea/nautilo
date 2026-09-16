import "../bun-dom-preload.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ChatsSearchContext,
  type ChatsSearchControls,
} from "../../src/adapters/runtime-contexts";
import type { RoomNavigationAPI } from "../../src/rooms/room-navigation-types";

function emptySearch(overrides: Partial<ChatsSearchControls> = {}): ChatsSearchControls {
  return {
    scope: { serverKey: "server", viewerKey: "viewer", viewerGeneration: 1 },
    query: "",
    mode: "prefix",
    ignoreCase: true,
    status: "idle",
    generation: 1,
    messageAsOf: null,
    currentMessagePageIndex: 0,
    pages: [],
    conversations: [],
    conversationsTruncated: false,
    messages: [],
    hasMoreOlderMessages: false,
    canLoadNewerMessages: false,
    error: null,
    setQuery: () => {},
    setMode: () => {},
    setIgnoreCase: () => {},
    loadOlderMessages: async () => false,
    loadNewerMessages: async () => false,
    retry: async () => false,
    clear: () => {},
    ...overrides,
  };
}

let search = emptySearch();
const roomNav: RoomNavigationAPI = {
  rooms: [
    {
      id: "local-room",
      label: "Local recent room",
      type: "private",
      graphThreadId: "thread-local",
      createdAt: "2026-08-05T08:00:00.000Z",
      memberCount: 2,
      kind: "private",
      pinned: false,
      tabOpen: true,
      closedTab: false,
      lastOpenedAt: Date.parse("2026-08-05T09:00:00.000Z"),
      tabOrder: 0,
    },
  ],
  activeRoomId: null,
  activeRoom: null,
  activeResolution: { kind: "none" },
  status: "ready",
  roomListError: null,
  lastLoadedAt: null,
  refreshRooms: async () => {},
  setActiveRoom: () => {},
  createRoom: async () => {},
  openTabForRoom: () => {},
  pinRoom: () => {},
  unpinRoom: () => {},
  closeTabForRoom: () => {},
  restoreClosedTabForRoom: () => {},
  reorderOpenTabs: () => {},
  renameRoom: async () => {},
};

mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => roomNav,
}));
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { role: "owner", label: "Alex" } }),
}));
mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "read_memories",
}));
mock.module("../../src/hooks/use-profile", () => ({
  useProfile: () => ({ agent: { name: "Jeannie" } }),
}));
mock.module("../../src/modes/rooms/new-conversation/new-conversation-context", () => ({
  useNewConversation: () => ({ open: () => {}, close: () => {}, isOpen: false }),
}));
mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: () => {}, dismiss: () => {}, _current: null }),
}));

const { RoomsPanel } = await import("../../src/components/rooms/rooms-panel");

afterEach(() => {
  cleanup();
  search = emptySearch();
});

describe("RoomsPanel chats search", () => {
  test("preserves the local recent-room model for an empty query", () => {
    const onClose = mock(() => {});
    const view = render(
      <ChatsSearchContext.Provider value={search}>
        <RoomsPanel onClose={onClose} />
      </ChatsSearchContext.Provider>,
    );
    const input = view.getByRole("searchbox", { name: "Search all chats" });
    expect(input).toBe(document.activeElement);
    expect(view.getByText("Recent")).toBeTruthy();
    expect(view.getByText("Local recent room")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("replaces local label filtering with the shared authorized result set", () => {
    const clear = mock(() => {});
    const onClose = mock(() => {});
    search = emptySearch({
      query: "remote",
      status: "ready",
      pages: [],
      conversations: [
        {
          matchedBy: "label",
          room: {
            id: "server-result",
            label: "Remote authorized room",
            type: "group",
            graphThreadId: "thread-server",
            createdAt: "2026-08-05T10:00:00.000Z",
            memberCount: 3,
            kind: "group",
          },
        },
      ],
      clear,
    });

    const view = render(
      <ChatsSearchContext.Provider value={search}>
        <RoomsPanel onClose={onClose} />
      </ChatsSearchContext.Provider>,
    );
    expect(view.getByText("Remote authorized room")).toBeTruthy();
    expect(view.queryByText("Local recent room")).toBeNull();
    expect(view.queryByText("No rooms match your search.")).toBeNull();
    fireEvent.keyDown(view.getByRole("searchbox", { name: "Search all chats" }), {
      key: "Escape",
    });
    expect(clear).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: /Remote authorized room/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
