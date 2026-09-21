import type React from "react";
import { ApiError } from "@nautilo/api-client/browser";
import type { AvatarRef, NotificationLevel } from "@nautilo/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../../../../../components/workbench-portals";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import type { ExplorerRow as ExplorerRowModel, ExplorerRowKind } from "../../explorer-grouping.types";
import { isExplorerRowExpandable } from "../../flatten-explorer-visible-rows";
import {
  notificationAttentionPresentation,
  notificationLevelLabel,
} from "../../../../../notifications/notification-display";
import { useNotificationState } from "../../../../../notifications/notification-state-context";
import { apiClient } from "../../../../../lib/api";
import { useToast } from "../../../../../components/toast";
import { useRoomNavigation } from "../../../../../contexts/room-navigation-context";
import { AuthenticatedAvatar } from "../../../../../components/avatar/authenticated-image";
import { useAuth } from "../../../../../hooks/use-auth";

/** Dispatched on successful archive so the explorer shell can refresh + navigate. */
export const EXPLORER_ROOM_ARCHIVED_EVENT = "nautilo:explorer-room-archived";

/** Dispatched when a row menu opens the manage sheet (rename / add / members). */
export const EXPLORER_ROOM_MANAGE_EVENT = "nautilo:explorer-room-manage";

/** Dispatched after self-leave so the explorer can refresh and navigate away. */
export const EXPLORER_ROOM_LEFT_EVENT = "nautilo:explorer-room-left";

export type ExplorerRoomManageFocus = "rename" | "add" | "members";

const ROOM_LEAF_KINDS = new Set<ExplorerRowKind>([
  "room",
  "direct-room",
  "private-room",
]);

function isRoomLeaf(row: ExplorerRowModel): boolean {
  return row.roomId.length > 0 && ROOM_LEAF_KINDS.has(row.kind);
}

interface ExplorerRowProps {
  row: ExplorerRowModel;
  isActive: boolean;
  onActivate: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

function rowLabel(row: ExplorerRowModel): React.ReactNode {
  if (row.kind === "threads" && row.subthreadCount != null) {
    return (
      <>
        {row.label}
        <span className="ml-1.5 tabular-nums text-foreground-muted">{row.subthreadCount}</span>
      </>
    );
  }
  if (row.handle) {
    return (
      <>
        <span>{row.label}</span>
        <span aria-hidden="true" className="mx-1 text-foreground-muted">
          ·
        </span>
        <span className="text-foreground-muted">
          {row.handle.local}
          {row.handle.server ? `@${row.handle.server}` : null}
        </span>
      </>
    );
  }
  return row.label;
}

function showAvatar(row: ExplorerRowModel): boolean {
  return row.kind === "entity-human" || row.kind === "entity-agent" || row.kind === "room";
}

function customAgentAvatarUrl(row: ExplorerRowModel): string | null {
  if (row.kind !== "entity-agent" || !row.roomId || !row.agentId) return null;
  const avatar: AvatarRef | null | undefined = row.agentAvatar;
  if (!avatar || (avatar.kind === "preset" && avatar.id === "shell")) return null;
  const version = avatar.kind === "preset" ? avatar.id : avatar.blobId;
  return `/api/rooms/${encodeURIComponent(row.roomId)}/agents/${encodeURIComponent(row.agentId)}/avatar?v=${encodeURIComponent(version)}`;
}

export function ExplorerRow({
  row,
  isActive,
  onActivate,
  expanded = false,
  onToggleExpand,
}: ExplorerRowProps) {
  const toast = useToast();
  const auth = useAuth();
  const roomNav = useRoomNavigation();
  const notifications = useNotificationState();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    right: number;
    placement: "below" | "above";
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Guards the blur-commit so an Enter/Escape (which blur the field) does not
  // double-fire the rename after the keydown handler already settled it.
  const renameSettledRef = useRef(false);

  const expandable = isExplorerRowExpandable(row.kind);
  const canToggle = expandable && onToggleExpand != null;
  const navigable = row.roomId.length > 0;
  const showRoomMenu = isRoomLeaf(row);
  const unread = row.unreadCount ?? 0;
  const attention = notificationAttentionPresentation({
    unreadCount: unread,
    importantUnreadCount: row.importantUnreadCount ?? 0,
    label: row.label,
  });
  const isPublic = row.roomKind === "open";
  const roomOverride = notifications.snapshot?.preferences.roomOverrides.find(
    (override) => override.roomId === row.roomId,
  );
  const roomNotificationValue = roomOverride?.level ?? "inherit";
  const defaultLevel = notifications.snapshot?.preferences.defaultLevel;
  const roomNotificationMutation =
    notifications.roomPreferenceMutations.get(row.roomId);

  const initial = row.label.trim().charAt(0).toUpperCase() || "?";
  const customAvatarUrl = customAgentAvatarUrl(row);
  const avatar = customAvatarUrl ? (
    <AuthenticatedAvatar src={customAvatarUrl} alt={row.label} fallback={initial} />
  ) : (
    initial
  );
  const indentPx = 8 + row.depth * 14;
  const baseBg = isActive
    ? "bg-[color-mix(in_oklab,var(--primary)_12%,transparent)]"
    : "bg-transparent hover:bg-[var(--primary-muted)]";
  const textWeight = isActive ? "font-semibold text-foreground" : "font-medium text-foreground";

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuPos(null);
  }, []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const estimatedMenuHeight = 220;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: "below" | "above" =
      spaceBelow < estimatedMenuHeight && rect.top > estimatedMenuHeight ? "above" : "below";
    setMenuPos({
      top: placement === "below" ? rect.bottom + gap : rect.top - gap,
      right: Math.max(8, window.innerWidth - rect.right),
      placement,
    });
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closeMenu();
    };
    // The menu is portaled with fixed positioning, so any scroll of the
    // virtualized list (or window) would detach it from its trigger.
    // Closing on scroll/resize is simpler and avoids a floating orphan.
    const onScrollOrResize = () => closeMenu();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onDocPointer);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, closeMenu]);

  const dispatchManage = useCallback(
    (focus: ExplorerRoomManageFocus) => {
      closeMenu();
      window.dispatchEvent(
        new CustomEvent(EXPLORER_ROOM_MANAGE_EVENT, {
          detail: { roomId: row.roomId, label: row.label, focus },
        }),
      );
    },
    [closeMenu, row.label, row.roomId],
  );

  const handleVisibilityToggle = useCallback(async () => {
    if (visibilityBusy) return;
    closeMenu();
    const makePublic = !isPublic;
    setVisibilityBusy(true);
    try {
      await apiClient.setRoomVisibility(row.roomId, makePublic);
      window.dispatchEvent(
        new CustomEvent("nautilo:room-members-changed", { detail: { roomId: row.roomId } }),
      );
      toast.show({
        variant: "success",
        title: makePublic ? "Room is now public" : "Room is now private",
        message: makePublic ? "Public 🌐" : "Private",
      });
    } catch (e) {
      toast.show({
        variant: "error",
        title: "Could not change visibility",
        message: e instanceof Error ? e.message : "Try again.",
      });
    } finally {
      setVisibilityBusy(false);
    }
  }, [closeMenu, isPublic, row.roomId, toast, visibilityBusy]);

  const handleArchive = useCallback(async () => {
    if (archiving) return;
    closeMenu();
    setArchiving(true);
    try {
      await apiClient.archiveRoom(row.roomId);
      window.dispatchEvent(
        new CustomEvent(EXPLORER_ROOM_ARCHIVED_EVENT, {
          detail: { roomId: row.roomId, label: row.label, archived: true },
        }),
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent(EXPLORER_ROOM_ARCHIVED_EVENT, {
          detail: {
            roomId: row.roomId,
            error: e instanceof Error ? e.message : "Try again.",
          },
        }),
      );
    } finally {
      setArchiving(false);
    }
  }, [archiving, closeMenu, row.label, row.roomId]);

  const handleLeave = useCallback(async () => {
    const actorId = auth.viewer.sessionActorId;
    if (leaving || actorId === null) return;
    closeMenu();
    if (!window.confirm(`Leave ${row.label}?`)) return;
    setLeaving(true);
    try {
      await apiClient.removeRoomMember(row.roomId, actorId);
      window.dispatchEvent(new CustomEvent(EXPLORER_ROOM_LEFT_EVENT, {
        detail: { roomId: row.roomId, label: row.label },
      }));
    } catch (error) {
      toast.show({
        variant: "error",
        title: "Could not leave room",
        message: error instanceof ApiError && error.status === 409
          ? "Another room administrator is required before you can leave."
          : error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setLeaving(false);
    }
  }, [auth.viewer.sessionActorId, closeMenu, leaving, row.label, row.roomId, toast]);

  const startRename = useCallback(() => {
    closeMenu();
    renameSettledRef.current = false;
    setEditing(true);
  }, [closeMenu]);

  const cancelRename = useCallback(() => {
    renameSettledRef.current = true;
    setEditing(false);
  }, []);

  const commitRename = useCallback(
    async (raw: string) => {
      if (renameSettledRef.current) return;
      renameSettledRef.current = true;
      const trimmed = raw.trim();
      setEditing(false);
      if (!trimmed || trimmed === row.label) return;
      setRenameBusy(true);
      try {
        // Routes through room-navigation, which refreshes the shared room
        // store — so tabs AND the explorer rehydrate immediately, no reload.
        await roomNav.renameRoom(row.roomId, trimmed);
        toast.show({ variant: "success", title: "Room renamed", message: trimmed });
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not rename",
          message: e instanceof Error ? e.message : "Try again.",
        });
      } finally {
        setRenameBusy(false);
      }
    },
    [roomNav, row.label, row.roomId, toast],
  );

  useEffect(() => {
    if (!editing) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const handleRowClick = () => {
    if (navigable) {
      onActivate();
      return;
    }
    if (canToggle) onToggleExpand();
  };

  const handleChevronClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onToggleExpand?.();
  };

  const menuItemClass =
    "flex w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div
      className={`relative flex w-full flex-col gap-0.5 pr-3 py-2 text-left text-xs transition-colors ${baseBg}`}
      style={{ paddingLeft: `${indentPx}px` }}
    >
      {isActive ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px] bg-[var(--primary)]"
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5">
        {canToggle ? (
          <button
            type="button"
            onClick={handleChevronClick}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-muted outline-none hover:text-foreground focus:outline-none"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {showAvatar(row) ? (
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background-panel text-[11px] font-semibold text-foreground-muted"
                aria-hidden
              >
                {avatar}
              </span>
            ) : null}
            <input
              ref={renameInputRef}
              type="text"
              defaultValue={row.label}
              maxLength={80}
              disabled={renameBusy}
              aria-label={`Rename ${row.label}`}
              data-testid="explorer-row-rename-input"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitRename(e.currentTarget.value);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={(e) => void commitRename(e.currentTarget.value)}
              className="min-w-0 flex-1 rounded border border-border-strong bg-background px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-[var(--primary)]"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={handleRowClick}
            aria-current={isActive ? "true" : undefined}
            className={`flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus:outline-none ${textWeight}`}
          >
            {showAvatar(row) ? (
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background-panel text-[11px] font-semibold text-foreground-muted"
                aria-hidden
              >
                {avatar}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{rowLabel(row)}</span>
            {row.roomKind === "open" ? (
              <span className="shrink-0" aria-label="Public room">
                🌐
              </span>
            ) : null}
            {attention?.hasUnread ? (
              <span
                className="ml-1 inline-flex shrink-0 items-center gap-1"
                aria-label={attention.ariaLabel}
              >
                <span
                  aria-hidden="true"
                  data-testid="explorer-row-unread-dot"
                  className="h-2 w-2 rounded-full bg-[var(--primary)]"
                />
                {attention.importantText ? (
                  <span
                    aria-hidden="true"
                    data-testid="explorer-row-important-count"
                    className="min-w-4 rounded-full bg-[var(--primary)] px-1 text-center text-[9px] font-semibold leading-4 text-[var(--on-primary)]"
                  >
                    {attention.importantText}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
        )}
        {showRoomMenu ? (
          <div className="relative shrink-0">
            <button
              type="button"
              ref={triggerRef}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) {
                  closeMenu();
                } else {
                  openMenu();
                }
              }}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={`Actions for ${row.label}`}
              disabled={archiving || visibilityBusy || leaving}
              className="flex h-6 w-6 items-center justify-center rounded text-foreground-muted outline-none hover:bg-background-element hover:text-foreground focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
              data-testid="explorer-row-menu"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {menuOpen && menuPos
              ? createPortal(
                  <div
                    ref={panelRef}
                    role="menu"
                    style={{
                      position: "fixed",
                      top: menuPos.placement === "below" ? menuPos.top : undefined,
                      bottom:
                        menuPos.placement === "above"
                          ? window.innerHeight - menuPos.top
                          : undefined,
                      right: menuPos.right,
                    }}
                    className="z-50 min-w-[12rem] rounded border border-border-strong bg-background-panel py-0.5 shadow-lg"
                  >
                <button
                  type="button"
                  role="menuitem"
                  onClick={startRename}
                  className={menuItemClass}
                  data-testid="explorer-row-rename"
                >
                  ✎ Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => dispatchManage("add")}
                  className={menuItemClass}
                  data-testid="explorer-row-add-people"
                >
                  ＋ Add people / genies…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => dispatchManage("members")}
                  className={menuItemClass}
                  data-testid="explorer-row-manage-members"
                >
                  ⛒ Manage members…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleVisibilityToggle()}
                  disabled={visibilityBusy}
                  className={menuItemClass}
                  data-testid="explorer-row-visibility"
                >
                  ◐ {isPublic ? "Make private" : "Make public"}
                </button>
                <div role="none" className="px-2 py-1.5">
                  <label
                    htmlFor={`room-notification-${row.id}`}
                    className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-foreground-muted"
                  >
                    Notifications
                  </label>
                  <select
                    id={`room-notification-${row.id}`}
                    aria-label={`Notifications for ${row.label}`}
                    value={roomNotificationValue}
                    disabled={
                      defaultLevel === undefined ||
                      roomNotificationMutation?.busy === true
                    }
                    onChange={(event) => {
                      const level = event.target.value as
                        | "inherit"
                        | NotificationLevel;
                      void notifications
                        .setRoomNotificationPreference(row.roomId, level)
                        .then((saved) => {
                          if (saved) closeMenu();
                        });
                    }}
                    className="w-full rounded border border-border bg-background-element px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid="explorer-row-notification-preference"
                  >
                    <option value="inherit">
                      {defaultLevel
                        ? `Inherit (${notificationLevelLabel(defaultLevel)})`
                        : "Inherit"}
                    </option>
                    <option value="none">Nothing</option>
                    <option value="direct">Directed messages</option>
                    <option value="all">All messages</option>
                  </select>
                  {roomNotificationMutation?.error ? (
                    <p role="alert" className="mt-1 text-[10px] text-error">
                      {roomNotificationMutation.error}. Try again.
                    </p>
                  ) : null}
                </div>
                <div className="my-0.5 border-t border-border" role="separator" />
                {isPublic && auth.viewer.sessionActorId !== null ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleLeave()}
                    disabled={leaving}
                    className={menuItemClass}
                    data-testid="explorer-row-leave"
                  >
                    ⇱ Leave room…
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleArchive()}
                  disabled={archiving}
                  className={menuItemClass}
                  data-testid="explorer-row-archive"
                >
                  ⌦ Archive
                </button>
                  </div>,
                  document.body,
                )
              : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
