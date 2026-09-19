import "../../../../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  ChatsSearchContext,
  type ChatsSearchControls,
} from "../../../../adapters/runtime-contexts";
import type { ExplorerRow, ExplorerSection } from "../explorer-grouping.types";
import type { RoomSummaryDto } from "@nautilo/types";

let grantedCapabilities = new Set(["create_rooms", "read_memories"]);
let archivedRoomsFixture: RoomSummaryDto[] = [];
const unarchiveRoom = mock(async () => ({ ok: true }));
const removeRoomMember = mock(async () => ({ ok: true, kind: "user" as const }));
const navigate = mock(() => undefined);
const searchChats = mock(async () => ({
  conversations: [],
  conversationsTruncated: false,
  messages: [],
  messageAsOf: null,
  nextOlderMessageCursor: null,
  hasMoreOlderMessages: false,
}));

mock.module("../../../../lib/api", () => ({
  apiClient: {
    listDiscoverableRooms: async () => ({ rooms: [] }),
    listManageableRooms: async (opts?: { includeArchived?: boolean }) => ({
      rooms: opts?.includeArchived ? archivedRoomsFixture : [],
    }),
    unarchiveRoom,
    removeRoomMember,
    searchChats,
  },
}));

mock.module("../../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionActorId: "viewer-actor" } }),
}));

mock.module("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

mock.module("../../../../hooks/use-can", () => ({
  useCan: () => (capability: string) => grantedCapabilities.has(capability),
}));

mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: () => undefined, dismiss: () => undefined, _current: null }),
}));
mock.module("../../../../notifications/notification-state-context", () => ({
  useNotificationState: () => ({
    snapshot: {
      preferences: { defaultLevel: "direct", roomOverrides: [] },
    },
    roomPreferenceMutations: new Map(),
    setRoomNotificationPreference: mock(async () => true),
  }),
}));

const EXPANDED_STORAGE_KEY = "nautilo.workbench.explorer.expanded.v1";
const SORT_STORAGE_KEY = "nautilo.workbench.explorer.sort.v1";

function mockVirtualizer() {
  mock.module("@tanstack/react-virtual", () => ({
    useVirtualizer: (opts: {
      count: number;
      getItemKey?: (index: number) => string | number;
    }) => ({
      getVirtualItems: () =>
        Array.from({ length: opts.count }, (_, index) => ({
          index,
          start: index * 40,
          size: 40,
          key: opts.getItemKey?.(index) ?? index,
        })),
      getTotalSize: () => opts.count * 40,
      scrollToIndex: () => {},
    }),
  }));
}

function setExpandedInStorage(...rowIds: string[]) {
  localStorage.setItem(
    EXPANDED_STORAGE_KEY,
    JSON.stringify({
      v: 1,
      expanded: Object.fromEntries(rowIds.map((id) => [id, true])),
    }),
  );
}

function agentEntity(id: string, label: string, extras?: Partial<ExplorerRow>): ExplorerRow {
  return {
    id,
    kind: "entity-agent",
    depth: 0,
    label,
    roomId: `${id}-room`,
    preview: null,
    isSubthread: false,
    children: [
      {
        id: `${id}:private`,
        kind: "private-room",
        depth: 1,
        label: "Private with me",
        roomId: `${id}-room`,
        preview: null,
        isSubthread: false,
      },
    ],
    ...extras,
  };
}

describe("RelationshipExplorer", () => {
  afterEach(() => {
    cleanup();
    archivedRoomsFixture = [];
    unarchiveRoom.mockClear();
    removeRoomMember.mockClear();
    navigate.mockClear();
    searchChats.mockClear();
    grantedCapabilities = new Set(["create_rooms", "read_memories"]);
    localStorage.removeItem(EXPANDED_STORAGE_KEY);
    localStorage.removeItem(SORT_STORAGE_KEY);
    mock.restore();
  });

  test("create_rooms without manage_rooms renders the existing new-conversation action", async () => {
    mockVirtualizer();
    mock.module("../../../../contexts/room-navigation-context", () => ({
      useRoomNavigation: () => ({
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
      }),
    }));
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [
          {
            kind: "people",
            title: "People",
            defaultCollapsed: false,
            rows: [
              {
                id: "p1",
                kind: "entity-human",
                depth: 0,
                label: "Jordan",
                roomId: "r-dm",
                preview: null,
                isSubthread: false,
              },
            ],
          },
          {
            kind: "agent-to-agent",
            title: "Agent-to-agent",
            defaultCollapsed: true,
            rows: [
              {
                id: "a2a",
                kind: "room",
                depth: 0,
                label: "A ↔ B",
                roomId: "r-a2a",
                preview: null,
                isSubthread: false,
              },
            ],
          },
        ],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(<RelationshipExplorer />);
    expect(html).toContain("People");
    expect(html).toContain("Jordan");
    expect(html).toContain("Agent-to-agent");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("A ↔ B");
    expect(html).toContain("Search all chats");
    expect(html).toContain('aria-label="New conversation"');
  });

  test("renders My agents and Other agents section headers", async () => {
    mockVirtualizer();
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [
          {
            kind: "my-agents",
            title: "My agents",
            defaultCollapsed: false,
            rows: [agentEntity("agent:entity:mine", "Jeannie")],
          },
          {
            kind: "other-agents",
            title: "Other agents",
            defaultCollapsed: false,
            rows: [agentEntity("agent:entity:other", "Nova")],
          },
        ] satisfies ExplorerSection[],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(<RelationshipExplorer />);
    expect(html).toContain("My agents");
    expect(html).toContain("Other agents");
    expect(html).toContain("Jeannie");
    expect(html).toContain("Nova");
  });

  test("expand reveals nested private-room child in DOM", async () => {
    setExpandedInStorage("agent:entity:mine");
    mockVirtualizer();
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [
          {
            kind: "my-agents",
            title: "My agents",
            defaultCollapsed: false,
            rows: [agentEntity("agent:entity:mine", "Jeannie")],
          },
        ],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(<RelationshipExplorer />);
    expect(html).toContain("Private with me");
  });

  test("renders authoritative unread dot plus important count", async () => {
    mockVirtualizer();
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [
          {
            kind: "groups",
            title: "Groups",
            defaultCollapsed: false,
            rows: [
              {
                id: "group:1",
                kind: "room",
                depth: 0,
                label: "# household",
                roomId: "g1",
                preview: null,
                isSubthread: false,
                unreadCount: 7,
                importantUnreadCount: 3,
              },
            ],
          },
        ],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(<RelationshipExplorer />);
    expect(html).toContain('data-testid="explorer-row-unread-dot"');
    expect(html).toContain('data-testid="explorer-row-important-count"');
    expect(html).toContain(
      'aria-label="# household: 7 unread messages, 3 important messages"',
    );
    expect(html).toContain(">3<");
  });

  test("sort control is present in header", async () => {
    mockVirtualizer();
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(<RelationshipExplorer />);
    expect(html).toContain('aria-label="Sort rooms (Recent, descending)"');
  });

  test("refreshes and navigates away after leaving the active public room", async () => {
    mockVirtualizer();
    const setActiveRoom = mock(() => {});
    const refreshRooms = mock(async () => {});
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({ open: mock(() => {}), close: mock(() => {}), isOpen: false }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [{
          kind: "public",
          title: "Public",
          defaultCollapsed: false,
          rows: [
            { id: "left", kind: "room", depth: 0, label: "Leaving", roomId: "room-left", isSubthread: false, roomKind: "open" },
            { id: "next", kind: "room", depth: 0, label: "Next", roomId: "room-next", isSubthread: false, roomKind: "open" },
          ],
        }],
        activeRoomId: "room-left",
        setActiveRoom,
        refreshRooms,
        refreshing: false,
        ready: true,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    render(<RelationshipExplorer />);
    window.dispatchEvent(new CustomEvent("nautilo:explorer-room-left", {
      detail: { roomId: "room-left", label: "Leaving" },
    }));

    await waitFor(() => expect(refreshRooms).toHaveBeenCalled());
    await waitFor(() => expect(setActiveRoom).toHaveBeenCalledWith("room-next"));
  });

  test("navigates home when the departed room has no fallback even if refresh fails", async () => {
    mockVirtualizer();
    const refreshRooms = mock(async () => { throw new Error("refresh unavailable"); });
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({ open: mock(() => {}), close: mock(() => {}), isOpen: false }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [{
          kind: "public",
          title: "Public",
          defaultCollapsed: false,
          rows: [{ id: "left", kind: "room", depth: 0, label: "Leaving", roomId: "room-left", isSubthread: false, roomKind: "open" }],
        }],
        activeRoomId: "room-left",
        setActiveRoom: mock(() => {}),
        refreshRooms,
        refreshing: false,
        ready: true,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    render(<RelationshipExplorer />);
    window.dispatchEvent(new CustomEvent("nautilo:explorer-room-left", {
      detail: { roomId: "room-left", label: "Leaving" },
    }));

    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    await waitFor(() => expect(refreshRooms).toHaveBeenCalled());
  });

  test("a nonempty query renders shared authorized results instead of filtering the tree", async () => {
    mockVirtualizer();
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({
        open: mock(() => {}),
        close: mock(() => {}),
        isOpen: false,
      }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [
          {
            kind: "groups",
            title: "Groups",
            defaultCollapsed: false,
            rows: [
              {
                id: "local-row",
                kind: "room",
                depth: 0,
                label: "Local explorer room",
                roomId: "local-room",
                preview: null,
                isSubthread: false,
              },
            ],
          },
        ],
        activeRoomId: null,
        setActiveRoom: mock(() => {}),
        refreshRooms: mock(async () => {}),
        refreshing: false,
        ready: true,
        error: null,
        humanDirectory: [],
      }),
    }));

    const search: ChatsSearchControls = {
      scope: { serverKey: "server", viewerKey: "viewer", viewerGeneration: 1 },
      query: "authorized",
      mode: "prefix",
      ignoreCase: true,
      status: "ready",
      generation: 1,
      messageAsOf: null,
      currentMessagePageIndex: 0,
      pages: [],
      conversations: [
        {
          matchedBy: "label",
          room: {
            id: "authorized-room",
            label: "Authorized room",
            type: "group",
            graphThreadId: "authorized-thread",
            createdAt: "2026-08-05T10:00:00.000Z",
            memberCount: 2,
            kind: "group",
          },
        },
      ],
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
    };

    const { RelationshipExplorer } = await import("../RelationshipExplorer");
    const html = renderToStaticMarkup(
      <ChatsSearchContext.Provider value={search}>
        <RelationshipExplorer />
      </ChatsSearchContext.Provider>,
    );
    expect(html).toContain("Authorized room");
    expect(html).not.toContain("Local explorer room");
    expect(html).toContain("Matching chats");
    expect(html).toContain("Matching messages");
  });

  test("archived panel shows rooms immediately, searches by name, and restores explicitly", async () => {
    archivedRoomsFixture = [
      {
        id: "r-project",
        label: "Project Atlas",
        type: "group",
        graphThreadId: "g-project",
        createdAt: "2026-08-01T00:00:00.000Z",
        memberCount: 3,
        kind: "group",
      },
      {
        id: "r-notes",
        label: "Old notes",
        type: "private",
        graphThreadId: "g-notes",
        createdAt: "2026-07-01T00:00:00.000Z",
        memberCount: 2,
        kind: "private",
      },
    ];
    mockVirtualizer();
    const setActiveRoom = mock(() => {});
    mock.module("../../new-conversation/new-conversation-context", () => ({
      useNewConversation: () => ({ open: mock(() => {}), close: mock(() => {}), isOpen: false }),
    }));
    mock.module("../use-explorer-data", () => ({
      useExplorerData: () => ({
        sections: [],
        activeRoomId: null,
        setActiveRoom,
        refreshRooms: mock(async () => {}),
        refreshing: false,
        ready: true,
        error: null,
        humanDirectory: [],
      }),
    }));

    const { RelationshipExplorer, archivedSearchDetails, filterArchivedRooms } = await import("../RelationshipExplorer");
    const view = render(<RelationshipExplorer />);
    const archivedButton = await view.findByTestId("explorer-archived-foot");
    fireEvent.click(archivedButton);

    expect(view.queryByTestId("show-archived-toggle")).toBeNull();
    expect(view.getByTestId("archived-rooms-surface").className).toContain("h-[75dvh]");
    expect(view.getByText("Project Atlas")).toBeTruthy();
    expect(view.getByText("Old notes")).toBeTruthy();

    expect(filterArchivedRooms(archivedRoomsFixture, "Atlas").map((room) => room.id)).toEqual([
      "r-project",
    ]);
    const contentMatches = archivedSearchDetails(
      {
        conversations: [{
          matchedBy: "participant",
          room: {
            ...archivedRoomsFixture[1]!,
            roster: [{ actorId: "actor-mara", kind: "user", displayName: "Mara Voss", handle: "mara" }],
          },
        }],
        conversationsTruncated: false,
        messages: [{
          messageId: "42",
          createdAt: "2026-07-02T00:00:00.000Z",
          role: "user",
          snippet: "Discussed the &lt;launch&gt; checklist",
          roomId: "r-project",
          roomLabel: "Project Atlas",
          roomKind: "group",
        }],
        messageAsOf: null,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      },
      "mara",
    );
    expect(contentMatches.contextByRoomId.get("r-notes")).toBe("Participant: Mara Voss · @mara");
    expect(contentMatches.contextByRoomId.get("r-project")).toBe("Discussed the <launch> checklist");
    expect(filterArchivedRooms(archivedRoomsFixture, "mara", contentMatches.roomIds).map((room) => room.id)).toEqual([
      "r-project",
      "r-notes",
    ]);

    fireEvent.click(view.getByLabelText("Restore Project Atlas"));
    await waitFor(() => expect(unarchiveRoom).toHaveBeenCalledWith("r-project"));
    expect(setActiveRoom).toHaveBeenCalledWith("r-project");
  });
});
