import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Pin, PinOff, Pencil, Plus, RotateCcw } from "lucide-react";
import { SHELL_AGENT_NAME } from "@nautilo/types";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { useAuth } from "../../hooks/use-auth";
import { useProfile } from "../../hooks/use-profile";
import { useCan } from "../../hooks/use-can";
import { useNewConversation } from "../../modes/rooms/new-conversation/new-conversation-context";
import { useToast } from "../toast";
import { useChatsSearch } from "../../adapters/runtime-contexts";
import type { WorkbenchRoomSummary } from "../../rooms/room-navigation-types";
import {
  partitionRoomsForPanel,
  roomPanelActivityLine,
  roomPanelContextLine,
} from "../../rooms/rooms-panel-model";
import { ChatsSearchResults } from "./chats-search-results";

export interface RoomsPanelProps {
  onClose: () => void;
}

function SectionHeader({ children }: { children: string }) {
  return (
    <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
      {children}
    </div>
  );
}

export function RoomsPanel({ onClose }: RoomsPanelProps) {
  const searchInputId = useId();
  const roomNav = useRoomNavigation();
  const auth = useAuth();
  const can = useCan();
  const canCreateRooms = can("create_rooms") || can("manage_rooms");
  const canSearchAllRooms = can("read_memories");
  const newConv = useNewConversation();
  const { agent } = useProfile();
  const agentName = agent?.name ?? SHELL_AGENT_NAME;
  const search = useChatsSearch();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const sections = useMemo(
    () => partitionRoomsForPanel(roomNav.rooms, ""),
    [roomNav.rooms],
  );
  const searchActive = canSearchAllRooms && search.query.trim().length > 0;

  const handleSelect = useCallback(
    (id: string) => {
      roomNav.setActiveRoom(id);
      onClose();
    },
    [onClose, roomNav],
  );

  const handleSelectMessage = useCallback(
    (roomId: string, messageId: string) => {
      roomNav.setActiveRoom(roomId, { targetMessageId: messageId });
      onClose();
    },
    [onClose, roomNav],
  );

  // Phase 11.6.E.3 — "+ New conversation…" link at top opens the
  // shell-mounted dialog and dismisses this panel. Slack/Linear
  // pattern: create-action lives at top of nav, immediately
  // discoverable. Same dialog the explorer's "+" trigger opens —
  // single source of truth via NewConversationProvider.
  const handleNewConversationClick = useCallback(() => {
    onClose();
    newConv.open();
  }, [newConv, onClose]);

  return (
    <div className="flex max-h-[min(70vh,28rem)] flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground">Rooms</div>
          {canCreateRooms ? <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-background-element"
            onClick={handleNewConversationClick}
            title="New conversation…"
            aria-label="New conversation"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
            <span>New conversation…</span>
          </button> : null}
        </div>
        {canSearchAllRooms ? <><label
          className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-foreground-muted"
          htmlFor={searchInputId}
        >
          Search all chats
        </label>
        <input
          id={searchInputId}
          ref={searchRef}
          type="search"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            if (searchActive) search.clear();
            else onClose();
          }}
          placeholder="Chat names, people, and message text"
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none ring-primary focus:ring-1"
          aria-label="Search all chats"
        />
        </> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {searchActive ? (
          <ChatsSearchResults
            search={search}
            onOpenConversation={handleSelect}
            onOpenMessage={handleSelectMessage}
          />
        ) : null}

        {!searchActive && roomNav.rooms.length === 0 && roomNav.status === "ready" ? (
          <p className="px-3 py-4 text-xs text-foreground-muted">
            No rooms yet. Use the + button in the tab strip to start a new chat.
          </p>
        ) : null}

        {!searchActive && sections.pinned.length > 0 ? (
          <>
            <SectionHeader>Pinned</SectionHeader>
            {sections.pinned.map((r) => (
              <RoomRow
                key={r.id}
                room={r}
                active={roomNav.activeRoomId === r.id}
                viewerRole={auth.viewer.role}
                viewerLabel={auth.viewer.label}
                agentName={agentName}
                onSelect={() => handleSelect(r.id)}
                onPin={() => roomNav.pinRoom(r.id)}
                onUnpin={() => roomNav.unpinRoom(r.id)}
                onRestore={
                  r.closedTab ? () => roomNav.restoreClosedTabForRoom(r.id) : undefined
                }
                onRename={roomNav.renameRoom}
              />
            ))}
          </>
        ) : null}

        {!searchActive && sections.recent.length > 0 ? (
          <>
            <SectionHeader>Recent</SectionHeader>
            {sections.recent.map((r) => (
              <RoomRow
                key={r.id}
                room={r}
                active={roomNav.activeRoomId === r.id}
                viewerRole={auth.viewer.role}
                viewerLabel={auth.viewer.label}
                agentName={agentName}
                onSelect={() => handleSelect(r.id)}
                onPin={() => roomNav.pinRoom(r.id)}
                onUnpin={() => roomNav.unpinRoom(r.id)}
                onRestore={
                  r.closedTab ? () => roomNav.restoreClosedTabForRoom(r.id) : undefined
                }
                onRename={roomNav.renameRoom}
              />
            ))}
          </>
        ) : null}

        {!searchActive && sections.closed.length > 0 ? (
          <>
            <SectionHeader>Closed tabs</SectionHeader>
            {sections.closed.map((r) => (
              <RoomRow
                key={r.id}
                room={r}
                active={roomNav.activeRoomId === r.id}
                viewerRole={auth.viewer.role}
                viewerLabel={auth.viewer.label}
                agentName={agentName}
                onSelect={() => handleSelect(r.id)}
                onPin={() => roomNav.pinRoom(r.id)}
                onUnpin={() => roomNav.unpinRoom(r.id)}
                onRestore={() => roomNav.restoreClosedTabForRoom(r.id)}
                onRename={roomNav.renameRoom}
              />
            ))}
          </>
        ) : null}

        {!searchActive && sections.olderHiddenCount > 0 ? (
          <p className="px-3 py-2 text-[11px] text-foreground-muted">
            {sections.olderHiddenCount} more room
            {sections.olderHiddenCount === 1 ? "" : "s"} — search by name to open.
          </p>
        ) : null}

      </div>
    </div>
  );
}

function RoomRow({
  room,
  active,
  viewerRole,
  viewerLabel,
  agentName,
  onSelect,
  onPin,
  onUnpin,
  onRestore,
  onRename,
}: {
  room: WorkbenchRoomSummary;
  active: boolean;
  viewerRole: import("@nautilo/types").ViewerRole;
  viewerLabel: string;
  agentName: string;
  onSelect: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onRestore?: () => void;
  onRename: (roomId: string, label: string) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.label);
  const context = roomPanelContextLine({
    roomType: room.type,
    viewerRole,
    viewerLabel,
    agentName,
  });
  const canRename = room.type === "private";

  useEffect(() => {
    if (!editing) setDraft(room.label);
  }, [editing, room.label]);

  const commitRename = useCallback(async () => {
    const next = draft.trim();
    if (!next) {
      toast.show({ variant: "error", title: "Invalid name", message: "Title cannot be empty." });
      return;
    }
    if (next.length > 80) {
      toast.show({
        variant: "error",
        title: "Invalid name",
        message: "Title must be at most 80 characters.",
      });
      return;
    }
    if (next === room.label) {
      setEditing(false);
      return;
    }
    try {
      await onRename(room.id, next);
      setEditing(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not rename room.";
      toast.show({ variant: "error", title: "Rename failed", message: msg });
    }
  }, [draft, onRename, room.id, room.label, toast]);

  return (
    <div
      className={`group flex items-start gap-1 border-b border-border/60 px-2 py-1.5 hover:bg-background-element/80 ${
        active ? "bg-background-element/60" : ""
      }`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 rounded px-1 py-0.5 text-left"
        onClick={onSelect}
      >
        {editing ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
              maxLength={80}
              aria-label="Room title"
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") {
                  setDraft(room.label);
                  setEditing(false);
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-[var(--primary-muted)]"
              onClick={() => void commitRename()}
            >
              Save
            </button>
          </div>
        ) : (
          <div className="truncate text-xs font-medium text-foreground">{room.label}</div>
        )}
        <div className="mt-0.5 truncate text-[11px] text-foreground-muted">{context}</div>
        <div className="mt-0.5 text-[10px] text-foreground-muted/80">
          {roomPanelActivityLine(room)}
        </div>
      </button>

      <div className="flex shrink-0 flex-row gap-0.5 pt-1 opacity-80 group-hover:opacity-100">
        {canRename && !editing ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
            aria-label={`Rename ${room.label}`}
            title="Rename room"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        {room.pinned ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
            aria-label={`Unpin ${room.label}`}
            title="Unpin"
            onClick={(e) => {
              e.stopPropagation();
              onUnpin();
            }}
          >
            <PinOff className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
            aria-label={`Pin ${room.label}`}
            title="Pin"
            onClick={(e) => {
              e.stopPropagation();
              onPin();
            }}
          >
            <Pin className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        {onRestore ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
            aria-label={`Restore tab for ${room.label}`}
            title="Restore tab"
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
