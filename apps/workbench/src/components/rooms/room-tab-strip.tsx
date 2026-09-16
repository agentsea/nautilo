import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import { ChevronDown, History, Search, X } from "lucide-react";
import type { WorkbenchRoomSummary } from "../../rooms/room-navigation-types";
import { roomTabDisplayLabel } from "../../rooms/room-tab-strip-model";

export interface RoomTabStripProps {
  rooms: WorkbenchRoomSummary[];
  activeRoomId: string | null;
  viewerActorId?: string | null;
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onSelect: (roomId: string) => void;
  onClose: (roomId: string) => void;
  onReorder?: (draggedRoomId: string, targetRoomId: string) => void;
  onNew: () => void;
  showNew?: boolean;
  newDisabled?: boolean;
  /** Opens the active Room transcript search bar owned by Conversation. */
  onSearchOpen?: (opener: HTMLButtonElement) => void;
  searchOpen?: boolean;
  searchDisabled?: boolean;
  /** Full searchable Rooms panel (rendered in a dropdown below the strip). */
  roomsPanelOpen?: boolean;
  onRoomsPanelOpenChange?: (open: boolean) => void;
  roomsPanel?: ReactNode;
  /**
   * D110 — narrow chat column: compact tabs + icon Rooms popdown.
   * Requires `onRoomsPanelOpenChange`; otherwise ignored.
   */
  compact?: boolean;
}

/**
 * D106 — room tab strip with horizontal scroll and Rooms panel entry.
 * D110 — optional `compact` rail: tabs stay visible; label/buttons are tightened.
 */
export function RoomTabStrip({
  rooms,
  activeRoomId,
  viewerActorId,
  loading,
  errorMessage,
  onRetry,
  onSelect,
  onClose,
  onReorder,
  onNew,
  showNew = true,
  newDisabled,
  onSearchOpen,
  searchOpen,
  searchDisabled,
  roomsPanelOpen,
  onRoomsPanelOpenChange,
  roomsPanel,
  compact,
}: RoomTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const roomsButtonRef = useRef<HTMLButtonElement>(null);
  const roomsPanelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const [draggingRoomId, setDraggingRoomId] = useState<string | null>(null);
  const [canPortal, setCanPortal] = useState(false);

  useEffect(() => {
    setCanPortal(typeof document !== "undefined");
  }, []);

  useLayoutEffect(() => {
    if (!roomsPanelOpen) {
      setPanelStyle(null);
      return;
    }

    const updatePosition = (): void => {
      const button = roomsButtonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const stripRect = stripRef.current?.getBoundingClientRect();
      const gap = 4;
      const margin = 8;
      const width = Math.min(352, window.innerWidth - margin * 2);
      const left = Math.min(
        Math.max(margin, rect.right - width),
        window.innerWidth - width - margin,
      );
      const top = Math.min(
        Math.max(rect.bottom + gap, (stripRect?.bottom ?? rect.bottom) + gap),
        window.innerHeight - margin,
      );

      setPanelStyle({
        position: "fixed",
        top,
        left,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [roomsPanelOpen]);

  useEffect(() => {
    if (!roomsPanelOpen || !onRoomsPanelOpenChange) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onRoomsPanelOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roomsPanelOpen, onRoomsPanelOpenChange]);

  useEffect(() => {
    if (!roomsPanelOpen || !onRoomsPanelOpenChange) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (roomsButtonRef.current?.contains(target)) return;
      if (roomsPanelRef.current?.contains(target)) return;
      onRoomsPanelOpenChange(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [roomsPanelOpen, onRoomsPanelOpenChange]);

  const panelOpen = Boolean(roomsPanelOpen);
  const handleTabDrop = (e: DragEvent<HTMLDivElement>, targetRoomId: string): void => {
    e.preventDefault();
    const draggedRoomId =
      e.dataTransfer.getData("application/x-nautilo-room-id") || draggingRoomId;
    setDraggingRoomId(null);
    if (!draggedRoomId || draggedRoomId === targetRoomId) return;
    onReorder?.(draggedRoomId, targetRoomId);
  };
  const panel =
    panelOpen && roomsPanel ? (
      <div
        ref={roomsPanelRef}
        className="z-50 max-h-[calc(100vh-1rem)] overflow-hidden rounded-md border border-border bg-background-panel shadow-lg"
        style={panelStyle ?? undefined}
        role="dialog"
        aria-label="Rooms list"
      >
        {roomsPanel}
      </div>
    ) : null;

  if (compact && onRoomsPanelOpenChange) {
    const setRoomsPanelOpen = onRoomsPanelOpenChange;
    const newChatDisabled = newDisabled || Boolean(loading);
    return (
      <div
        ref={stripRef}
        className="relative min-w-0 max-w-full shrink-0 overflow-hidden border-b border-border bg-background-panel"
      >
        <div
          // pl-8 reserves clearance for the absolutely-positioned context-panel
          // collapse chevron (left-1 + w-6 ≈ 28px) that overlays this compact
          // reader-rail strip, so the first tab doesn't crowd the ›.
          className="grid min-h-10 w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1 pl-8 pr-2 py-1"
          role="toolbar"
          aria-label="Chat rooms"
        >
          {loading ? (
            <span className="min-w-0 px-1 text-xs text-foreground-muted">
              Loading rooms...
            </span>
          ) : null}

          {!loading && errorMessage ? (
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-xs text-amber-700 dark:text-amber-400"
                role="alert"
              >
                {errorMessage}
              </span>
              {onRetry ? (
                <button
                  type="button"
                  className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--primary-muted)]"
                  onClick={() => void onRetry()}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}

          {!loading && !errorMessage ? (
            <div className="min-w-0 overflow-hidden">
              <div className="room-tab-strip-scrollbar-none min-w-0 overflow-x-auto overflow-y-hidden">
                <div className="flex w-max max-w-none flex-nowrap items-center gap-1 px-0.5">
                  {rooms.map((room) => {
                    const active = activeRoomId === room.id;
                    const displayLabel = roomTabDisplayLabel(room, viewerActorId);
                    return (
                      <div
                        key={room.id}
                        draggable={Boolean(onReorder)}
                        onDragStart={(e) => {
                          if (!onReorder) return;
                          setDraggingRoomId(room.id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("application/x-nautilo-room-id", room.id);
                        }}
                        onDragOver={(e) => {
                          if (!onReorder || !draggingRoomId || draggingRoomId === room.id) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(e) => handleTabDrop(e, room.id)}
                        onDragEnd={() => setDraggingRoomId(null)}
                        className={`group flex min-w-0 max-w-[132px] shrink-0 items-center rounded-md border ${
                          active
                            ? "border-border bg-background-element"
                            : "border-transparent bg-transparent hover:bg-background-element/80"
                        } ${draggingRoomId === room.id ? "opacity-50" : ""}`}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs font-medium text-foreground"
                          aria-current={active ? "true" : undefined}
                          aria-label={`Open chat ${displayLabel}`}
                          title={displayLabel}
                          onClick={() => onSelect(room.id)}
                        >
                          <span className="room-tab-strip-label-truncate block truncate">
                            {displayLabel}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-foreground-muted opacity-70 hover:bg-background hover:text-foreground group-hover:opacity-100"
                          aria-label={`Close tab for ${displayLabel}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onClose(room.id);
                          }}
                        >
                          <X className="h-3 w-3" aria-hidden />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex min-w-max shrink-0 items-center gap-1 justify-self-end">
            {onSearchOpen ? (
              <button
                type="button"
                disabled={searchDisabled || Boolean(loading)}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${
                  searchOpen ? "border-border bg-background-element text-foreground" : "border-transparent"
                }`}
                aria-label="Search this room"
                aria-expanded={searchOpen}
                aria-pressed={searchOpen}
                title="Search this room"
                onClick={(event) => onSearchOpen(event.currentTarget)}
              >
                <Search className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            {showNew ? <button
              ref={roomsButtonRef}
              type="button"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-foreground-muted ${
                panelOpen
                  ? "border-border bg-background-element text-foreground"
                  : "border-transparent hover:bg-background-element hover:text-foreground"
              }`}
              aria-expanded={panelOpen}
              aria-haspopup="dialog"
              aria-label="Open rooms list and search"
              title="Rooms list"
              onClick={() => setRoomsPanelOpen(!panelOpen)}
            >
              <History
                className={`h-4 w-4 transition-transform ${panelOpen ? "rotate-[-20deg]" : ""}`}
                aria-hidden
              />
            </button> : null}
            <button
              type="button"
              disabled={newChatDisabled}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-sm font-semibold text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="New chat (Genie)"
              title="New chat (Genie)"
              onClick={() => void onNew()}
            >
              +
            </button>
          </div>
        </div>

        {panel ? (canPortal ? createPortal(panel, document.body) : panel) : null}
      </div>
    );
  }

  return (
    <div
      ref={stripRef}
      className="relative min-w-0 max-w-full shrink-0 overflow-hidden border-b border-border bg-background-panel"
    >
      <div
        className="grid min-h-10 w-full min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 px-2 py-1"
        role="toolbar"
        aria-label="Chat rooms"
      >
        <span className="shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          Rooms
        </span>

        {loading ? (
          <span className="min-w-0 px-2 text-xs text-foreground-muted">Loading rooms...</span>
        ) : null}

        {!loading && errorMessage ? (
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span className="truncate text-xs text-amber-700 dark:text-amber-400" role="alert">
              {errorMessage}
            </span>
            {onRetry ? (
              <button
                type="button"
                className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--primary-muted)]"
                onClick={() => void onRetry()}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        {!loading && !errorMessage ? (
          <div className="min-w-0 overflow-hidden">
            <div className="room-tab-strip-scrollbar-none min-w-0 overflow-x-auto overflow-y-hidden">
              <div className="flex w-max max-w-none flex-nowrap items-center gap-1 px-1">
              {rooms.map((room) => {
                const active = activeRoomId === room.id;
                const displayLabel = roomTabDisplayLabel(room, viewerActorId);
                return (
                  <div
                    key={room.id}
                    draggable={Boolean(onReorder)}
                    onDragStart={(e) => {
                      if (!onReorder) return;
                      setDraggingRoomId(room.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("application/x-nautilo-room-id", room.id);
                    }}
                    onDragOver={(e) => {
                      if (!onReorder || !draggingRoomId || draggingRoomId === room.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(e) => handleTabDrop(e, room.id)}
                    onDragEnd={() => setDraggingRoomId(null)}
                    className={`group flex min-w-0 max-w-[140px] shrink-0 items-center rounded-md border ${
                      active
                        ? "border-border bg-background-element"
                        : "border-transparent bg-transparent hover:bg-background-element/80"
                    } ${draggingRoomId === room.id ? "opacity-50" : ""}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs font-medium text-foreground"
                      aria-current={active ? "true" : undefined}
                      aria-label={`Open chat ${displayLabel}`}
                      title={displayLabel}
                      onClick={() => onSelect(room.id)}
                    >
                      <span className="room-tab-strip-label-truncate block truncate">
                        {displayLabel}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-foreground-muted opacity-70 hover:bg-background hover:text-foreground group-hover:opacity-100"
                      aria-label={`Close tab for ${displayLabel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(room.id);
                      }}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex min-w-max shrink-0 items-center gap-1 justify-self-end">
          {onSearchOpen ? (
            <button
              type="button"
              disabled={searchDisabled || Boolean(loading)}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${
                searchOpen ? "border-border bg-background-element text-foreground" : "border-transparent"
              }`}
              aria-label="Search this room"
              aria-expanded={searchOpen}
              aria-pressed={searchOpen}
              title="Search this room"
              onClick={(event) => onSearchOpen(event.currentTarget)}
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          {onRoomsPanelOpenChange ? (
            <button
              ref={roomsButtonRef}
              type="button"
              className={`flex shrink-0 items-center gap-0.5 rounded-md border border-l border-border px-2 py-1 text-[11px] font-semibold ${
                panelOpen
                  ? "bg-background-element text-foreground"
                  : "border-transparent text-foreground-muted hover:bg-background-element hover:text-foreground"
              }`}
              aria-expanded={panelOpen}
              aria-haspopup="dialog"
              aria-label="Open rooms list and search"
              title="Rooms list"
              onClick={() => onRoomsPanelOpenChange(!panelOpen)}
            >
              Rooms
              <ChevronDown className={`h-3 w-3 transition-transform ${panelOpen ? "rotate-180" : ""}`} />
            </button>
          ) : null}

          {showNew ? <button
            type="button"
            disabled={newDisabled || Boolean(loading)}
            className="shrink-0 rounded-md border border-dashed border-border px-2 py-1 text-sm font-semibold text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="New chat (Genie)"
            title="New chat (Genie)"
            onClick={() => void onNew()}
          >
            +
          </button> : null}
        </div>
      </div>

      {panel ? (canPortal ? createPortal(panel, document.body) : panel) : null}
    </div>
  );
}
