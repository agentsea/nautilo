import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatSearchPage, RoomSummaryDto } from "@nautilo/types";
import { useChatsSearch } from "../../../adapters/runtime-contexts";
import {
  ChatsSearchResults,
  decodeChatSearchSnippetOnce,
} from "../../../components/rooms/chats-search-results";
import { apiClient } from "../../../lib/api";
import { useToast } from "../../../components/toast";
import { DiscoverPublicRoomsModal } from "./components/DiscoverPublicRoomsModal";
import { filterSectionsByQuery } from "./explorer-grouping";
import { useExplorerData } from "./use-explorer-data";
import { VirtualExplorerTree } from "./components/VirtualExplorerTree";
import { ExplorerSortControl } from "./components/ExplorerSortControl";
import { useNewConversation } from "../new-conversation/new-conversation-context";
import { useCan } from "../../../hooks/use-can";
import { EXPLORER_ROOM_ARCHIVED_EVENT } from "./sections/shared/ExplorerRow";

function ErrorState({ error }: { error: string }) {
  return (
    <div role="alert" className="px-3 py-4 text-xs text-amber-700 dark:text-amber-400">
      {error}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="px-3 py-6 text-center text-xs text-foreground-muted" aria-busy="true">
      Loading rooms…
    </div>
  );
}

function firstNavigableRoomId(
  sections: ReturnType<typeof filterSectionsByQuery>,
  excludeId?: string,
): string | null {
  for (const section of sections) {
    for (const row of section.rows) {
      const walk = (r: typeof row): string | null => {
        if (r.roomId.length > 0 && r.roomId !== excludeId) return r.roomId;
        for (const child of r.children ?? []) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      const id = walk(row);
      if (id) return id;
    }
  }
  return null;
}

export function filterArchivedRooms(
  rooms: readonly RoomSummaryDto[],
  rawQuery: string,
  remotelyMatchedRoomIds: ReadonlySet<string> = new Set(),
): readonly RoomSummaryDto[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return rooms;
  return rooms.filter(
    (room) =>
      room.label.toLocaleLowerCase().includes(query) || remotelyMatchedRoomIds.has(room.id),
  );
}

export function archivedSearchDetails(
  page: ChatSearchPage,
  rawQuery: string,
): { roomIds: ReadonlySet<string>; contextByRoomId: ReadonlyMap<string, string> } {
  const query = rawQuery.trim().toLocaleLowerCase();
  const roomIds = new Set<string>();
  const contextByRoomId = new Map<string, string>();

  for (const hit of page.conversations) {
    roomIds.add(hit.room.id);
    if (hit.matchedBy !== "participant") continue;
    const participant = hit.room.roster?.find((member) => {
      const displayName = member.displayName.toLocaleLowerCase();
      const handle = member.handle?.toLocaleLowerCase() ?? "";
      return displayName.includes(query) || handle.includes(query);
    });
    if (participant) {
      contextByRoomId.set(
        hit.room.id,
        `Participant: ${participant.displayName}${participant.handle ? ` · @${participant.handle}` : ""}`,
      );
    }
  }

  for (const hit of page.messages) {
    roomIds.add(hit.roomId);
    if (!contextByRoomId.has(hit.roomId)) {
      contextByRoomId.set(hit.roomId, decodeChatSearchSnippetOnce(hit.snippet));
    }
  }

  return { roomIds, contextByRoomId };
}

function ExplorerArchiveToastBridge({
  onArchived,
}: {
  onArchived: (detail: {
    roomId?: string;
    label?: string;
    archived?: boolean;
    error?: string;
  }) => void;
}) {
  const toast = useToast();

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        roomId?: string;
        label?: string;
        archived?: boolean;
        error?: string;
      }>).detail;
      if (detail?.error) {
        toast.show({
          variant: "error",
          title: "Couldn't archive",
          message: detail.error,
        });
        return;
      }
      if (detail?.archived && detail.roomId) {
        toast.show({
          variant: "success",
          title: "Archived",
          message: detail.label ?? "Room archived",
          duration: 6_000,
          action: {
            label: "Undo",
            onClick: () => {
              void apiClient.unarchiveRoom(detail.roomId!).then(() => {
                window.dispatchEvent(
                  new CustomEvent(EXPLORER_ROOM_ARCHIVED_EVENT, { detail: {} }),
                );
              });
            },
          },
        });
      }
      onArchived(detail);
    };
    window.addEventListener(EXPLORER_ROOM_ARCHIVED_EVENT, handler);
    return () => window.removeEventListener(EXPLORER_ROOM_ARCHIVED_EVENT, handler);
  }, [onArchived, toast]);

  return null;
}

export function RelationshipExplorer({ onCollapse }: { onCollapse?: () => void } = {}) {
  const can = useCan();
  const toast = useToast();
  const canCreateRooms = can("create_rooms") || can("manage_rooms");
  const canSearchAllRooms = can("read_memories");
  const [clientMounted, setClientMounted] = useState(false);
  const { sections, activeRoomId, setActiveRoom, refreshRooms, refreshing, ready, error } =
    useExplorerData();
  const search = useChatsSearch();
  const newConv = useNewConversation();
  const [discoverCount, setDiscoverCount] = useState(0);
  const [discoverModalOpen, setDiscoverModalOpen] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [archivedRooms, setArchivedRooms] = useState<readonly RoomSummaryDto[]>([]);
  const [archivedPanelOpen, setArchivedPanelOpen] = useState(false);
  const [archivedQuery, setArchivedQuery] = useState("");
  const [archivedSearchResult, setArchivedSearchResult] = useState<{
    query: string;
    roomIds: ReadonlySet<string>;
    contextByRoomId: ReadonlyMap<string, string>;
  }>({ query: "", roomIds: new Set(), contextByRoomId: new Map() });
  const [archivedSearchLoading, setArchivedSearchLoading] = useState(false);
  const searchActive = canSearchAllRooms && search.query.trim().length > 0;
  const showInitialLoading = ready === false;
  const normalizedArchivedQuery = archivedQuery.trim();
  const currentArchivedSearchResult =
    archivedSearchResult.query === normalizedArchivedQuery
      ? archivedSearchResult
      : { query: normalizedArchivedQuery, roomIds: new Set<string>(), contextByRoomId: new Map<string, string>() };
  const filteredArchivedRooms = useMemo(
    () => filterArchivedRooms(archivedRooms, archivedQuery, currentArchivedSearchResult.roomIds),
    [archivedQuery, archivedRooms, currentArchivedSearchResult.roomIds],
  );

  const refreshDiscoverCount = useCallback(async () => {
    try {
      const body = await apiClient.listDiscoverableRooms();
      setDiscoverCount(body.rooms.length);
    } catch {
      setDiscoverCount(0);
    }
  }, []);

  const refreshArchived = useCallback(async () => {
    try {
      const [allManageable, activeManageable] = await Promise.all([
        apiClient.listManageableRooms({ includeArchived: true }),
        apiClient.listManageableRooms(),
      ]);
      const activeIds = new Set(activeManageable.rooms.map((r) => r.id));
      const archived = allManageable.rooms.filter((r) => !activeIds.has(r.id));
      setArchivedRooms(archived);
      setArchivedCount(archived.length);
    } catch {
      setArchivedRooms([]);
      setArchivedCount(0);
    }
  }, []);

  useEffect(() => {
    setClientMounted(true);
  }, []);

  useEffect(() => {
    void refreshDiscoverCount();
    void refreshArchived();
  }, [refreshDiscoverCount, refreshArchived]);

  useEffect(() => {
    const query = archivedQuery.trim();
    if (!archivedPanelOpen || !query) {
      setArchivedSearchLoading(false);
      setArchivedSearchResult({ query, roomIds: new Set(), contextByRoomId: new Map() });
      return;
    }

    const controller = new AbortController();
    setArchivedSearchLoading(true);
    const timeout = window.setTimeout(() => {
      void apiClient
        .searchChats(
          { query, mode: "prefix", archiveScope: "archived", limit: 50 },
          { signal: controller.signal },
        )
        .then((page) => {
          const details = archivedSearchDetails(page, query);
          setArchivedSearchResult({ query, ...details });
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setArchivedSearchResult({ query, roomIds: new Set(), contextByRoomId: new Map() });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setArchivedSearchLoading(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [archivedPanelOpen, archivedQuery]);

  const handleJoinedPublicRoom = useCallback(
    async (roomId: string) => {
      await refreshRooms();
      setActiveRoom(roomId);
      await refreshDiscoverCount();
    },
    [refreshDiscoverCount, refreshRooms, setActiveRoom],
  );

  const handleArchiveSideEffects = useCallback(
    async (detail: { roomId?: string }) => {
      const roomId = detail.roomId;
      await refreshRooms();
      await refreshArchived();
      if (roomId && roomId === activeRoomId) {
        const next = firstNavigableRoomId(sections, roomId);
        if (next) setActiveRoom(next);
      }
    },
    [activeRoomId, sections, refreshArchived, refreshRooms, setActiveRoom],
  );

  const handleSelectArchivedRoom = useCallback(
    async (room: RoomSummaryDto) => {
      try {
        await apiClient.unarchiveRoom(room.id);
        setArchivedPanelOpen(false);
        setArchivedQuery("");
        await refreshRooms();
        await refreshArchived();
        setActiveRoom(room.id);
        toast.show({
          variant: "success",
          title: "Room restored",
          message: room.label,
        });
      } catch (error) {
        toast.show({
          variant: "error",
          title: "Could not restore room",
          message: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [refreshArchived, refreshRooms, setActiveRoom, toast],
  );

  return (
    <aside className="flex h-full min-h-0 min-w-0 overflow-clip flex-col border-r border-border bg-background-panel">
      {clientMounted ? (
        <ExplorerArchiveToastBridge onArchived={(d) => void handleArchiveSideEffects(d)} />
      ) : null}
      {/* Header: "Explorer" title with the ‹ collapse at the FAR RIGHT,
          mirroring the artifacts column's chevron (right edge of its tab
          bar). Chevron points left = the direction the panel moves when
          hidden; re-expand via the PanelEdgeStrip. */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
          Explorer
        </span>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide explorer"
            title="Hide explorer (⌘⇧B)"
            className="flex shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-sm leading-5 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : null}
      </div>
      <div className="border-b border-border px-3 py-2">
        {canSearchAllRooms ? (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
            Search all chats
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {canSearchAllRooms ? <input
            type="search"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchActive) {
                e.preventDefault();
                search.clear();
              }
            }}
            placeholder="Chat names, people, and message text"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none ring-primary focus:ring-1"
            aria-label="Search all chats"
          /> : null}
          <ExplorerSortControl />
          {canCreateRooms ? <button
            type="button"
            className="shrink-0 rounded border border-border bg-background px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-background-element"
            title="New conversation…"
            aria-label="New conversation"
            onClick={() => newConv.open()}
          >
            +
          </button> : null}
        </div>
      </div>
      <div
        className={
          searchActive
            ? "min-h-0 flex-1 overflow-y-auto"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {searchActive ? (
          <ChatsSearchResults
            search={search}
            onOpenConversation={(roomId) => setActiveRoom(roomId)}
            onOpenMessage={(roomId, messageId) =>
              setActiveRoom(roomId, { targetMessageId: messageId })
            }
          />
        ) : error ? (
          <ErrorState error={error} />
        ) : showInitialLoading || (refreshing && sections.length === 0) ? (
          <LoadingState />
        ) : sections.length > 0 ? (
          <VirtualExplorerTree
            sections={sections}
            activeRoomId={activeRoomId}
            onActivate={setActiveRoom}
          />
        ) : null}
      </div>
      {!searchActive && discoverCount > 0 ? (
        <button
          type="button"
          className="shrink-0 border-t border-border px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-background-element"
          onClick={() => setDiscoverModalOpen(true)}
        >
          🌐 Discover public rooms… ({discoverCount})
        </button>
      ) : null}
      {!searchActive && archivedCount > 0 ? (
        <button
          type="button"
          className="shrink-0 border-t border-border px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-background-element"
          onClick={() => {
            setArchivedQuery("");
            setArchivedPanelOpen(true);
          }}
          data-testid="explorer-archived-foot"
        >
          Archived ({archivedCount})
        </button>
      ) : null}
      {discoverModalOpen ? (
        <DiscoverPublicRoomsModal
          onClose={() => {
            setDiscoverModalOpen(false);
            void refreshDiscoverCount();
          }}
          onJoined={(roomId) => void handleJoinedPublicRoom(roomId)}
        />
      ) : null}
      {archivedPanelOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="archived-rooms-title"
          onClick={() => setArchivedPanelOpen(false)}
          data-testid="archived-rooms-panel"
        >
          <div
            className="flex h-[75dvh] max-h-[44rem] w-full max-w-md flex-col rounded-t-lg border border-border-strong bg-background-panel shadow-xl sm:h-[70dvh] sm:rounded-lg"
            onClick={(e) => e.stopPropagation()}
            data-testid="archived-rooms-surface"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <h2 id="archived-rooms-title" className="text-sm font-semibold text-foreground">
                Archived rooms ({archivedCount})
              </h2>
              <button
                type="button"
                onClick={() => setArchivedPanelOpen(false)}
                className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
                aria-label="Close archived rooms"
              >
                ×
              </button>
            </header>
            <div className="shrink-0 border-b border-border px-4 py-3">
              <input
                type="search"
                value={archivedQuery}
                onChange={(event) => setArchivedQuery(event.target.value)}
                placeholder="Search names, people, and messages…"
                aria-label="Search archived room names, people, and messages"
                autoFocus
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none ring-primary placeholder:text-foreground-muted focus:ring-1"
                data-testid="archived-rooms-search"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {archivedRooms.length === 0 ? (
                <p className="px-2 py-4 text-xs text-foreground-muted">No archived rooms.</p>
              ) : archivedSearchLoading && filteredArchivedRooms.length === 0 ? (
                <p className="px-2 py-4 text-xs text-foreground-muted" role="status">
                  Searching archived messages…
                </p>
              ) : filteredArchivedRooms.length === 0 ? (
                <p className="px-2 py-4 text-xs text-foreground-muted">
                  No archived rooms match “{archivedQuery.trim()}”.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {filteredArchivedRooms.map((room) => (
                    <li
                      key={room.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-background-element"
                      data-testid="archived-room-row"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {room.label}
                        </span>
                        {currentArchivedSearchResult.contextByRoomId.get(room.id) ? (
                          <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-foreground-muted">
                            {currentArchivedSearchResult.contextByRoomId.get(room.id)}
                          </span>
                        ) : null}
                      </span>
                      {room.kind === "open" ? (
                        <span className="shrink-0" aria-label="Public room">
                          🌐
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void handleSelectArchivedRoom(room)}
                        className="shrink-0 rounded border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-background"
                        aria-label={`Restore ${room.label}`}
                      >
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
