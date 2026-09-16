import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AgentResponseMode,
  RoomConductorMode,
  RoomDetailResponse,
  RoomKind,
  RoomMemberDto,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { useToast } from "../../../components/toast";
import {
  isAskUserCandidate,
  useAskUserPicker,
} from "../../../components/composer/ask-user-state";
import { resumeAskUserPick } from "../../../components/composer/ask-user-resume";
import { memberTypeSuffix, sortMembersByTalking } from "./members-panel-model";
import { useRoomFocus } from "./use-room-focus";
import {
  useAutoApprove,
  useProtectedRoomAccess,
  useVoiceControls,
} from "../../../adapters/runtime-contexts";
import {
  SelectablePicker,
  memberKey,
  type SelectableCandidate,
  type SelectedMeta,
} from "../new-conversation/SelectablePicker";

const EMPTY_LAST_SPOKE: ReadonlyMap<string, number> = new Map();

/**
 * D193 — In-room members management panel.
 *
 * Room membership and response controls share the selected Room identity.
 *
 * Composes with:
 * - D128 mode-flip (Q4): admin can flip an agent's `agentResponseMode`
 *   from this panel — natural home, removes the "no UI to change mode"
 *   gap from the D128 ship.
 * - D192 add-bot consent (sibling Phase 5 sub-PR): the agent-add path
 *   will route through D192's dialog before completing once that
 *   sub-PR ships. Until then, agent adds use default mode = mention_only.
 * - D194 wireframes (Phase 0): visual vocabulary anchor.
 *
 * Scope per phase-5-d193-members-panel.md. Sub-tasks 5.2-5.5 implemented
 * in this iteration: fetch + remove (with confirmation) + add picker +
 * mode-flip for agents + unit tests. MR4 (D192 consent route) and MR6
 * (audit timeline) deferred to follow-ups.
 */

const MODE_LABELS: Record<AgentResponseMode, string> = {
  active: "active",
  mention_only: "listening (mention to wake)",
  observe: "observe-only (silenced)",
};

export interface MembersPanelProps {
  readonly roomId: string;
  readonly viewerActorId: string;
  readonly initialMembers: readonly RoomMemberDto[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onMembershipChanged?: () => void;
  /**
   * Server-wide `manage_rooms` cosmetic gate (M129). Hosts should pass
   * `useCan()("manage_rooms")`; defaults false when omitted (SSR tests).
   */
  readonly viewerCanManageRooms?: boolean;
  /**
   * D278 §4.7.4 sort-by-talking: actorId → epoch-ms of that member's most
   * recent message, derived client-side from the room transcript. Omit (or
   * empty) → falls back to admin → alphabetical. Wired by the room shell that
   * has transcript access (MembersPanel itself mounts outside the Thread
   * context).
   */
  readonly lastSpokeAtMs?: ReadonlyMap<string, number>;
}

interface AddableHumans {
  readonly users: ReadonlyArray<{ userId: string; handle: string; displayName: string }>;
}

interface AddableAgents {
  readonly agents: ReadonlyArray<{
    agentId: string;
    handle: string;
    displayName: string;
    agentOwnerUserId?: string;
    agentOwnerHandle?: string | null;
    agentOwnerDisplayName?: string | null;
  }>;
}

export function filterAddMemberCandidates(
  candidates: readonly SelectableCandidate[],
  rawQuery: string,
): SelectableCandidate[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [...candidates];
  return candidates.filter(
    (candidate) =>
      candidate.displayName.toLowerCase().includes(query) ||
      (candidate.handle ?? "").toLowerCase().includes(query) ||
      (candidate.agentOwnerDisplayName ?? "").toLowerCase().includes(query) ||
      (candidate.agentOwnerHandle ?? "").toLowerCase().includes(query),
  );
}

export function MembersPanel({
  roomId,
  viewerActorId,
  initialMembers,
  open,
  onClose,
  onMembershipChanged,
  lastSpokeAtMs,
  viewerCanManageRooms,
}: MembersPanelProps): ReactElement | null {
  const toast = useToast();
  const focus = useRoomFocus(roomId);
  const protectedRoomAccess = useProtectedRoomAccess();
  const autoApprove = useAutoApprove();
  const voice = useVoiceControls();
  const askUser = useAskUserPicker();
  const canManageRooms = viewerCanManageRooms ?? false;

  const handleAskUserPick = useCallback(
    (botActorId: string) => {
      if (!askUser.active || askUser.roomId !== roomId) return;
      const content = askUser.pendingContent;
      if (!content) {
        toast.show({
          variant: "warning",
          title: "Could not resume message",
          message: "The original message text is no longer available.",
        });
        return;
      }
      void resumeAskUserPick({
        roomId,
        botActorId,
        content,
        humanTurnId: askUser.humanTurnId,
        messageId: askUser.messageId,
        voiceMode: voice.enabled,
        autoApprove: autoApprove.enabled,
      }).catch((e) => {
        toast.show({
          variant: "error",
          title: "Could not send",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      });
    },
    [
      askUser.active,
      askUser.humanTurnId,
      askUser.messageId,
      askUser.pendingContent,
      askUser.roomId,
      autoApprove.enabled,
      roomId,
      toast,
      voice.enabled,
    ],
  );

  const [members, setMembers] = useState<readonly RoomMemberDto[]>(initialMembers);
  const [roomLabel, setRoomLabel] = useState<string>("");
  const [roomKind, setRoomKind] = useState<RoomKind>("private");
  const [conductorMode, setConductorMode] = useState<RoomConductorMode>("advanced");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [archiving, setArchiving] = useState<boolean>(false);
  const [roomActionsOpen, setRoomActionsOpen] = useState<boolean>(false);
  const [openMemberActionsActorId, setOpenMemberActionsActorId] = useState<string | null>(null);
  const [confirmArchiveOpen, setConfirmArchiveOpen] = useState<boolean>(false);
  const [visibilityBusy, setVisibilityBusy] = useState<boolean>(false);
  const [conductorModeBusy, setConductorModeBusy] = useState<boolean>(false);

  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  // Only dismiss when a click both STARTS and ENDS on the backdrop. Without
  // this, drag-selecting text inside the panel that releases over the dim
  // backdrop fires a `click` on the overlay and nukes the panel mid-edit.
  const backdropArmedRef = useRef(false);

  const [confirmRemove, setConfirmRemove] = useState<RoomMemberDto | null>(null);
  const [removing, setRemoving] = useState<boolean>(false);

  // Per-agent mode-flip in-flight flags (Q4)
  const [modeBusy, setModeBusy] = useState<Record<string, boolean>>({});
  const [roleBusy, setRoleBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail: RoomDetailResponse = await apiClient.getRoomManageDetail(roomId);
      setMembers(detail.members);
      setRoomLabel(detail.label);
      setRoomKind(detail.kind);
      setConductorMode(detail.conductorMode === "standard" ? "standard" : "advanced");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        if (pickerOpen) return;
        else if (confirmRemove) setConfirmRemove(null);
        else if (confirmArchiveOpen) setConfirmArchiveOpen(false);
        else if (openMemberActionsActorId) setOpenMemberActionsActorId(null);
        else if (roomActionsOpen) setRoomActionsOpen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pickerOpen, confirmRemove, confirmArchiveOpen, openMemberActionsActorId, roomActionsOpen]);

  useEffect(() => {
    if (!open || (!roomActionsOpen && !openMemberActionsActorId)) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target &&
        typeof (target as Element).closest === "function" &&
        (target as Element).closest("[data-members-actions-root]")
      ) return;
      setRoomActionsOpen(false);
      setOpenMemberActionsActorId(null);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open, openMemberActionsActorId, roomActionsOpen]);

  const viewerIsAdmin = useMemo(
    () => members.some((m) => m.actorId === viewerActorId && m.roomRole === "admin"),
    [members, viewerActorId],
  );

  const canEditRoom = viewerIsAdmin || canManageRooms;
  const canEditMemberRoles = canEditRoom;
  const canFlipVisibility =
    canManageRooms && (roomKind === "open" || roomKind === "group");
  const canFlipConductorMode = canManageRooms && roomKind !== "private";

  const sorted = useMemo(
    () => sortMembersByTalking(members, lastSpokeAtMs ?? EMPTY_LAST_SPOKE),
    [members, lastSpokeAtMs],
  );

  const handleRemove = useCallback(async () => {
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      const removed = await apiClient.removeRoomMember(
        roomId,
        confirmRemove.actorId,
      );
      if (removed.protectedEncryption !== undefined) {
        protectedRoomAccess.markMembershipPending(
          roomId,
          removed.protectedEncryption.namespaceId,
        );
      }
      toast.show({
        variant: "success",
        title: "Member removed",
        message: `${confirmRemove.displayName} is no longer in this room.`,
      });
      setConfirmRemove(null);
      await refresh();
    } catch (e) {
      toast.show({
        variant: "error",
        title: "Could not remove",
        message: e instanceof Error ? e.message : "Unknown error.",
      });
    } finally {
      setRemoving(false);
    }
  }, [confirmRemove, protectedRoomAccess, roomId, refresh, toast]);

  const handleModeFlip = useCallback(
    async (member: RoomMemberDto, next: AgentResponseMode) => {
      if (member.agentResponseMode === next) return;
      setModeBusy((s) => ({ ...s, [member.actorId]: true }));
      try {
        await apiClient.updateRoomMemberMode(roomId, member.actorId, next);
        await refresh();
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not change mode",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setModeBusy((s) => {
          const { [member.actorId]: _drop, ...rest } = s;
          return rest;
        });
      }
    },
    [roomId, refresh, toast],
  );

  const handleRename = useCallback(
    async (nextLabel: string) => {
      const trimmed = nextLabel.trim();
      if (!trimmed || trimmed === roomLabel) return;
      setRenaming(true);
      try {
        await apiClient.renameRoom(roomId, { label: trimmed });
        setRoomLabel(trimmed);
        onMembershipChanged?.();
        toast.show({
          variant: "success",
          title: "Room renamed",
          message: trimmed,
        });
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not rename",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setRenaming(false);
      }
    },
    [onMembershipChanged, roomId, roomLabel, toast],
  );

  const handleRoleFlip = useCallback(
    async (member: RoomMemberDto, next: "admin" | "member") => {
      if (member.roomRole === next) return;
      setRoleBusy((s) => ({ ...s, [member.actorId]: true }));
      try {
        await apiClient.updateRoomMemberRole(roomId, member.actorId, next);
        await refresh();
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not change role",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setRoleBusy((s) => {
          const { [member.actorId]: _drop, ...rest } = s;
          return rest;
        });
      }
    },
    [roomId, refresh, toast],
  );

  const handleVisibilityFlip = useCallback(
    async (isPublic: boolean) => {
      const alreadyPublic = roomKind === "open";
      if (isPublic === alreadyPublic) return;
      setVisibilityBusy(true);
      try {
        await apiClient.setRoomVisibility(roomId, isPublic);
        await refresh();
        onMembershipChanged?.();
        toast.show({
          variant: "success",
          title: isPublic ? "Room is now public" : "Room is now private",
          message: isPublic ? "Public 🌐" : "Private",
        });
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not change visibility",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setVisibilityBusy(false);
      }
    },
    [onMembershipChanged, refresh, roomId, roomKind, toast],
  );

  const handleConductorModeFlip = useCallback(
    async (next: RoomConductorMode) => {
      if (next === conductorMode) return;
      setConductorModeBusy(true);
      try {
        await apiClient.setRoomConductorMode(roomId, next);
        setConductorMode(next);
        toast.show({
          variant: "success",
          title: next === "advanced" ? "Smart routing on" : "Smart routing off",
          message:
            next === "advanced"
              ? "First-contact routing will use the Floor Manager."
              : "@mentions, replies, and focus still work.",
        });
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not change smart routing",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setConductorModeBusy(false);
      }
    },
    [conductorMode, roomId, toast],
  );

  const handleArchiveRoom = useCallback(async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      await apiClient.archiveRoom(roomId);
      toast.show({
        variant: "success",
        title: "Archived",
        message: roomLabel || "Room archived",
        duration: 6_000,
        action: {
          label: "Undo",
          onClick: () => {
            void apiClient.unarchiveRoom(roomId).then(() => {
              window.dispatchEvent(
                new CustomEvent("nautilo:explorer-room-archived", { detail: {} }),
              );
            });
          },
        },
      });
      window.dispatchEvent(
        new CustomEvent("nautilo:explorer-room-archived", { detail: { roomId } }),
      );
      setConfirmArchiveOpen(false);
      onClose();
      onMembershipChanged?.();
    } catch (e) {
      toast.show({
        variant: "error",
        title: "Couldn't archive",
        message: e instanceof Error ? e.message : "Try again.",
      });
    } finally {
      setArchiving(false);
    }
  }, [archiving, onClose, onMembershipChanged, roomId, roomLabel, toast]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex justify-end bg-black/30"
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-panel-title"
        onMouseDown={(e) => {
          backdropArmedRef.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && backdropArmedRef.current) onClose();
          backdropArmedRef.current = false;
        }}
        data-testid="members-panel-overlay"
      >
        <aside
          className="flex h-full w-full max-w-sm flex-col border-l border-border-strong bg-background-panel shadow-xl"
          onClick={(e) => e.stopPropagation()}
          data-testid="members-panel"
        >
          <header className="relative flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <h2 id="members-panel-title" className="text-sm font-semibold text-foreground">
              Members ({members.length})
            </h2>
            <div className="flex items-center gap-1">
              {canEditRoom ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpenMemberActionsActorId(null);
                    setRoomActionsOpen((value) => !value);
                  }}
                  className="rounded px-1.5 py-1 text-xs text-foreground-muted hover:bg-background hover:text-foreground"
                  aria-label="Room actions"
                  aria-expanded={roomActionsOpen}
                  data-testid="members-panel-room-actions"
                  data-members-actions-root
                >
                  •••
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
                aria-label="Close members panel"
              >
                ×
              </button>
            </div>
            {roomActionsOpen ? (
              <div
                className="absolute right-9 top-10 z-10 w-40 rounded-md border border-border-strong bg-background-panel p-1 shadow-xl"
                data-members-actions-root
              >
                <button
                  type="button"
                  onClick={() => {
                    setRoomActionsOpen(false);
                    setConfirmArchiveOpen(true);
                  }}
                  className="w-full rounded px-2 py-1.5 text-left text-xs text-red-500 hover:bg-red-500/10"
                  data-testid="members-panel-archive"
                >
                  Archive room…
                </button>
              </div>
            ) : null}
          </header>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            <RoomSettingsSection
              label={roomLabel}
              kind={roomKind}
              conductorMode={conductorMode}
              canEdit={canEditRoom}
              canFlipVisibility={canFlipVisibility}
              canFlipConductorMode={canFlipConductorMode}
              renaming={renaming}
              visibilityBusy={visibilityBusy}
              conductorModeBusy={conductorModeBusy}
              onRename={(next) => void handleRename(next)}
              onVisibilityFlip={(isPublic) => void handleVisibilityFlip(isPublic)}
              onConductorModeFlip={(next) => void handleConductorModeFlip(next)}
            />
            {loading ? (
              <div className="px-2 py-4 text-xs text-foreground-muted">Loading…</div>
            ) : error ? (
              <div className="px-2 py-4 text-xs text-red-500">
                {error}{" "}
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            ) : sorted.length === 0 ? (
              <div className="px-2 py-4 text-xs text-foreground-muted">No members yet.</div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {sorted.map((m) => (
                  <MemberRow
                    key={m.actorId}
                    member={m}
                    viewerIsAdmin={viewerIsAdmin}
                    canEditMemberRoles={canEditMemberRoles}
                    isSelf={m.actorId === viewerActorId}
                    modeBusy={modeBusy[m.actorId] === true}
                    focus={focus}
                    askUserActive={askUser.active && askUser.roomId === roomId}
                    onAskUserPick={handleAskUserPick}
                    roleBusy={roleBusy[m.actorId] === true}
                    actionsOpen={openMemberActionsActorId === m.actorId}
                    onActionsToggle={() => {
                      setRoomActionsOpen(false);
                      setOpenMemberActionsActorId((actorId) =>
                        actorId === m.actorId ? null : m.actorId,
                      );
                    }}
                    onRemove={() => {
                      setOpenMemberActionsActorId(null);
                      setConfirmRemove(m);
                    }}
                    onModeFlip={(next) => void handleModeFlip(m, next)}
                    onRoleFlip={(next) => void handleRoleFlip(m, next)}
                  />
                ))}
              </ul>
            )}
          </div>

          {viewerIsAdmin ? (
            <footer className="shrink-0 border-t border-border px-3 py-3">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover"
                data-testid="members-panel-add"
              >
                + Add member
              </button>
            </footer>
          ) : null}
        </aside>
      </div>

      {pickerOpen ? (
        <AddMemberPicker
          roomId={roomId}
          existingActorIds={members.map((m) => m.actorId)}
          onClose={() => setPickerOpen(false)}
          onAdded={() => {
            onMembershipChanged?.();
            void refresh();
          }}
        />
      ) : null}

      {confirmRemove ? (
        <ConfirmDialog
          title={`Remove ${confirmRemove.displayName}?`}
          body={
            confirmRemove.kind === "agent"
              ? `Remove this bot from the room. ${confirmRemove.displayName} will no longer have access to messages or memory shared with this room. Members can re-add later.`
              : `Remove ${confirmRemove.displayName} from this room. They will lose access to room history. They can be re-invited later.`
          }
          confirmLabel={removing ? "Removing…" : "Remove"}
          cancelLabel="Cancel"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => void handleRemove()}
        />
      ) : null}

      {confirmArchiveOpen ? (
        <ConfirmDialog
          title={`Archive ${roomLabel || "this room"}?`}
          body="It will disappear from active rooms for everyone. You can restore it later from the Archived rooms panel."
          confirmLabel={archiving ? "Archiving…" : "Archive room"}
          cancelLabel="Cancel"
          onCancel={() => setConfirmArchiveOpen(false)}
          onConfirm={() => void handleArchiveRoom()}
        />
      ) : null}
    </>
  );
}

function RoomSettingsSection({
  label,
  kind,
  conductorMode,
  canEdit,
  canFlipVisibility,
  canFlipConductorMode,
  renaming,
  visibilityBusy,
  conductorModeBusy,
  onRename,
  onVisibilityFlip,
  onConductorModeFlip,
}: {
  readonly label: string;
  readonly kind: RoomKind;
  readonly conductorMode: RoomConductorMode;
  readonly canEdit: boolean;
  readonly canFlipVisibility: boolean;
  readonly canFlipConductorMode: boolean;
  readonly renaming: boolean;
  readonly visibilityBusy: boolean;
  readonly conductorModeBusy: boolean;
  readonly onRename: (next: string) => void;
  readonly onVisibilityFlip: (isPublic: boolean) => void;
  readonly onConductorModeFlip: (next: RoomConductorMode) => void;
}): ReactElement {
  const [draft, setDraft] = useState(label);
  useEffect(() => {
    setDraft(label);
  }, [label]);

  const isPublic = kind === "open";

  return (
    <div
      className="mb-2 flex flex-col gap-2 border-b border-border px-2 pb-3"
      data-testid="members-panel-room-settings"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
          Room name
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onRename(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          disabled={!canEdit || renaming}
          maxLength={80}
          className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-60"
          data-testid="members-panel-rename"
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
          Visibility
        </span>
        {canFlipVisibility ? (
          <fieldset
            className="flex flex-col gap-0.5 border-0 p-0"
            disabled={visibilityBusy}
            data-testid="members-panel-visibility"
          >
            {(
              [
                { isPublic: false, label: "Private" },
                { isPublic: true, label: "Public 🌐" },
              ] as const
            ).map(({ isPublic, label: optionLabel }) => {
              const checked = isPublic ? kind === "open" : kind === "group";
              return (
                <label
                  key={optionLabel}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-background-element"
                >
                  <input
                    type="radio"
                    name="room-visibility"
                    checked={checked}
                    disabled={visibilityBusy}
                    onChange={() => onVisibilityFlip(isPublic)}
                    className="h-3 w-3"
                    data-testid={isPublic ? "visibility-radio-public" : "visibility-radio-private"}
                  />
                  <span className={checked ? "text-foreground" : "text-foreground-muted"}>
                    {optionLabel}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <span className="text-xs text-foreground" data-testid="members-panel-visibility">
            {isPublic ? "Public 🌐" : "Private"}
          </span>
        )}
      </div>
      {kind !== "private" ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
            Smart routing
          </span>
          {canFlipConductorMode ? (
            <fieldset
              className="flex flex-col gap-0.5 border-0 p-0"
              disabled={conductorModeBusy}
              data-testid="members-panel-conductor-mode"
            >
              {(
                [
                  { mode: "advanced", label: "On" },
                  { mode: "standard", label: "Off" },
                ] as const
              ).map(({ mode, label: optionLabel }) => {
                const checked = conductorMode === mode;
                return (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-background-element"
                  >
                    <input
                      type="radio"
                      name="room-conductor-mode"
                      checked={checked}
                      disabled={conductorModeBusy}
                      onChange={() => onConductorModeFlip(mode)}
                      className="h-3 w-3"
                      data-testid={`conductor-mode-radio-${mode}`}
                    />
                    <span className={checked ? "text-foreground" : "text-foreground-muted"}>
                      {optionLabel}
                    </span>
                  </label>
                );
              })}
              <span className="px-1 text-[11px] text-foreground-muted">
                Off keeps @mentions, replies, and focus; only smart first-contact routing is disabled.
              </span>
            </fieldset>
          ) : (
            <span className="text-xs text-foreground" data-testid="members-panel-conductor-mode">
              {conductorMode === "advanced" ? "On" : "Off"}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MemberRow({
  member,
  viewerIsAdmin,
  canEditMemberRoles,
  isSelf,
  modeBusy,
  focus,
  askUserActive,
  onAskUserPick,
  roleBusy,
  onRemove,
  actionsOpen,
  onActionsToggle,
  onModeFlip,
  onRoleFlip,
}: {
  readonly member: RoomMemberDto;
  readonly viewerIsAdmin: boolean;
  readonly canEditMemberRoles: boolean;
  readonly isSelf: boolean;
  readonly modeBusy: boolean;
  readonly focus: ReturnType<typeof useRoomFocus>;
  readonly askUserActive: boolean;
  readonly onAskUserPick: (botActorId: string) => void;
  readonly roleBusy: boolean;
  readonly actionsOpen: boolean;
  readonly onActionsToggle: () => void;
  readonly onRemove: () => void;
  readonly onModeFlip: (next: AgentResponseMode) => void;
  readonly onRoleFlip: (next: "admin" | "member") => void;
}): ReactElement {
  const isAgent = member.kind === "agent";
  const showModeSelect = isAgent && viewerIsAdmin;
  const showRoleSelect = !isAgent && canEditMemberRoles;
  const canRemove = viewerIsAdmin && !isSelf;
  const suffix = memberTypeSuffix(member);
  const isHeld = isAgent && focus.isHeld(member.actorId);
  const isAskUserOption =
    askUserActive && isAgent && isAskUserCandidate(member.actorId);

  return (
    <li
      className="relative flex flex-col rounded-md px-2 py-1.5 hover:bg-background"
      data-testid="members-panel-row"
      data-actor-id={member.actorId}
      data-kind={member.kind}
      data-focus-held={isHeld ? "true" : "false"}
    >
      <div className="flex items-center gap-2">
        {isAgent ? (
          <button
            type="button"
            disabled={focus.isBusy(member.actorId)}
            onClick={() => {
              if (isAskUserOption) onAskUserPick(member.actorId);
              else focus.toggle(member.actorId);
            }}
            title={member.displayName}
            aria-label={
              isAskUserOption
                ? `Pick ${member.displayName} to answer your message`
                : focus.isTarget(member.actorId)
                  ? `Clear focus on ${member.displayName}`
                  : `Focus on ${member.displayName}`
            }
            data-testid="members-panel-focus-avatar"
            data-actor-id={member.actorId}
            data-focus-state={isHeld ? "held" : focus.isTarget(member.actorId) ? "target" : "none"}
            className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-foreground-muted disabled:cursor-wait disabled:opacity-50${
              focus.isTarget(member.actorId)
                ? " ring-2 ring-primary ring-offset-1 ring-offset-background-panel"
                : ""
            }`}
          >
            {member.displayName.charAt(0).toUpperCase()}
            {isHeld ? (
              <span
                aria-hidden
                data-testid="members-panel-held-dot"
                className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background-panel bg-primary/70"
              />
            ) : null}
          </button>
        ) : (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-foreground-muted"
            aria-hidden
          >
            {member.displayName.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-foreground">
            {member.displayName}
            {isSelf ? <span className="ml-1 text-foreground-muted">(you)</span> : null}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-foreground-muted">
            {isAgent ? "Bot" : "Person"} · {member.roomRole} · {suffix}
            {isAgent && member.agentResponseMode && member.agentResponseMode !== "active" ? (
              <span className="ml-1 normal-case">· {MODE_LABELS[member.agentResponseMode]}</span>
            ) : null}
          </span>
        </div>
        {showRoleSelect ? (
          <select
            value={member.roomRole}
            disabled={roleBusy}
            onChange={(e) => onRoleFlip(e.target.value as "admin" | "member")}
            aria-label={`Room role for ${member.displayName}`}
            className="w-28 shrink-0 rounded border border-border bg-background px-1 py-1 text-[10px] text-foreground disabled:opacity-50"
            data-testid="members-panel-role-select"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
          </select>
        ) : null}
        {showModeSelect ? (
          <select
            value={member.agentResponseMode ?? "active"}
            disabled={modeBusy}
            onChange={(event) => onModeFlip(event.target.value as AgentResponseMode)}
            aria-label={`Response mode for ${member.displayName}`}
            className="w-28 shrink-0 rounded border border-border bg-background px-1 py-1 text-[10px] text-foreground disabled:opacity-50"
            data-testid="members-panel-mode-select"
          >
            <option value="active">active</option>
            <option value="mention_only">listening</option>
            <option value="observe">silenced</option>
          </select>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            onClick={onActionsToggle}
            className="w-7 shrink-0 rounded px-1 py-0.5 text-[10px] text-foreground-muted hover:bg-background-element hover:text-foreground"
            aria-label={`Actions for ${member.displayName}`}
            aria-expanded={actionsOpen}
            data-testid="members-panel-member-actions"
            data-members-actions-root
          >
            •••
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden="true" />
        )}
      </div>

      {actionsOpen && canRemove ? (
        <div
          className="absolute right-2 top-9 z-10 w-32 rounded-md border border-border-strong bg-background-panel p-1 shadow-lg"
          data-members-actions-root
        >
          <button
            type="button"
            onClick={() => {
              onRemove();
            }}
            className="w-full rounded px-2 py-1.5 text-left text-[11px] text-red-500 hover:bg-red-500/10"
            aria-label={`Remove ${member.displayName}`}
            data-testid="members-panel-remove"
          >
            Remove from room…
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Inline picker for adding a human or agent to the room.
 *
 * P3/MR6 (D187): the tabbed People/Bots list + bespoke `PickerRow` were
 * replaced by the shared `SelectablePicker`. This room-management variant now
 * uses its multi-select mode so an admin can choose several humans and Genies,
 * then add the selection with one explicit commit.
 *
 * Because the addable lists are room-scoped and small, the picker's `search`
 * is a local case-insensitive filter over the already-loaded list — no server
 * search here.
 *
 * Agent path: ships with default mode = `mention_only` per D128 default for
 * multi-human rooms. The D192 consent dialog hookup is intentionally deferred
 * to a follow-up sub-PR — when D192 lands, this add call routes through it.
 * Tracked as MR4 in phase-5-d193-members-panel.md.
 */
function AddMemberPicker({
  roomId,
  existingActorIds,
  onClose,
  onAdded,
}: {
  readonly roomId: string;
  readonly existingActorIds: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}): ReactElement {
  const toast = useToast();
  const protectedRoomAccess = useProtectedRoomAccess();
  const [humans, setHumans] = useState<AddableHumans["users"] | null>(null);
  const [agents, setAgents] = useState<AddableAgents["agents"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<ReadonlyMap<string, SelectedMeta>>(new Map());
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      apiClient.listAddableUsersForRoom(roomId),
      apiClient.listAddableAgentsForRoom(roomId),
    ])
      .then(([u, a]) => {
        if (cancelled) return;
        setHumans(u);
        setAgents(a);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load people");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Unified candidate list (humans + agents) for the multi-select picker.
  const candidates = useMemo<SelectableCandidate[]>(() => {
    const out: SelectableCandidate[] = [];
    for (const h of humans ?? []) {
      out.push({ kind: "user", id: h.userId, displayName: h.displayName, handle: h.handle });
    }
    for (const a of agents ?? []) {
      out.push({
        kind: "agent",
        id: a.agentId,
        displayName: a.displayName,
        handle: a.handle,
        agentOwnerUserId: a.agentOwnerUserId,
        agentOwnerHandle: a.agentOwnerHandle,
        agentOwnerDisplayName: a.agentOwnerDisplayName,
      });
    }
    return out;
  }, [humans, agents]);

  // Local filter over the pre-loaded list — the picker owns the query/debounce.
  const search = useCallback(
    (q: string): Promise<SelectableCandidate[]> => {
      return Promise.resolve(filterAddMemberCandidates(candidates, q));
    },
    [candidates],
  );

  // Existing members carry `user:`/`agent:` actor ids, which are exactly the
  // picker's `memberKey` format — hide them so they can't be re-added.
  const disabledKeys = useMemo(
    () => new Set([...existingActorIds, ...addedKeys]),
    [addedKeys, existingActorIds],
  );

  const selectedUserIds = useMemo(
    () =>
      new Set(
        [...selectedMeta.values()]
          .filter((candidate) => candidate.kind === "user")
          .map((candidate) => candidate.id),
      ),
    [selectedMeta],
  );
  const selectedAgentIds = useMemo(
    () =>
      new Set(
        [...selectedMeta.values()]
          .filter((candidate) => candidate.kind === "agent")
          .map((candidate) => candidate.id),
      ),
    [selectedMeta],
  );
  const selectedCount = selectedMeta.size;

  const handleToggle = useCallback(
    (candidate: SelectableCandidate) => {
      if (submitting) return;
      setSubmissionError(null);
      setSelectedMeta((current) => {
        const next = new Map(current);
        const key = memberKey(candidate.kind, candidate.id);
        if (next.has(key)) next.delete(key);
        else next.set(key, candidate);
        return next;
      });
    },
    [submitting],
  );

  const clearSelection = useCallback(() => {
    if (submitting) return;
    setSubmissionError(null);
    setSelectedMeta(new Map());
  }, [submitting]);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current || selectedMeta.size === 0) return;
    const selected = [...selectedMeta.values()];
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);

    const results = await Promise.allSettled(
      selected.map((candidate) =>
        candidate.kind === "user"
          ? apiClient.addRoomMember(roomId, {
              kind: "user",
              userId: candidate.id,
              roomRole: "member",
            })
          : apiClient.addRoomMember(roomId, {
              kind: "agent",
              agentId: candidate.id,
              roomRole: "member",
            }),
      ),
    );
    const succeeded = selected.filter((_, index) => results[index]?.status === "fulfilled");
    const failed = selected.filter((_, index) => results[index]?.status === "rejected");

    if (succeeded.length > 0) {
      for (const result of results) {
        if (
          result.status === "fulfilled"
          && result.value.protectedEncryption !== undefined
        ) {
          protectedRoomAccess.markMembershipPending(
            roomId,
            result.value.protectedEncryption.namespaceId,
          );
        }
      }
      const succeededKeys = succeeded.map((candidate) => memberKey(candidate.kind, candidate.id));
      setAddedKeys((current) => new Set([...current, ...succeededKeys]));
      setSelectedMeta((current) => {
        const next = new Map(current);
        for (const key of succeededKeys) next.delete(key);
        return next;
      });
      onAdded();
    }

    submittingRef.current = false;
    setSubmitting(false);
    if (failed.length === 0) {
      const noun = succeeded.length === 1 ? "member" : "members";
      toast.show({
        variant: "success",
        title: `${succeeded.length === 1 ? "Member" : "Members"} added`,
        message: `Added ${succeeded.length} ${noun} to the room.`,
      });
      onClose();
    } else {
      const successPrefix = succeeded.length > 0 ? `Added ${succeeded.length}. ` : "";
      const failedNoun = failed.length === 1 ? "member" : "members";
      setSubmissionError(
        `${successPrefix}Could not add ${failed.length} ${failedNoun}. The failed selection is still here to retry.`,
      );
    }
  }, [onAdded, onClose, protectedRoomAccess, roomId, selectedMeta, toast]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-member-title"
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="add-member-picker"
    >
      <div
        className="flex h-[480px] w-full max-w-md flex-col rounded-lg border border-border-strong bg-background-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
        aria-busy={submitting ? "true" : undefined}
        data-testid="add-member-picker-surface"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 id="add-member-title" className="text-sm font-semibold text-foreground">
            Add to this room
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded p-1 text-foreground-muted hover:bg-background hover:text-foreground"
            aria-label="Close picker"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="px-2 py-4 text-xs text-foreground-muted">Loading…</div>
          ) : error ? (
            <div className="px-2 py-4 text-xs text-red-500">{error}</div>
          ) : (
            <div className={`flex min-h-0 flex-1 flex-col${submitting ? " pointer-events-none opacity-60" : ""}`}>
              <SelectablePicker
                search={search}
                emptyLabel="No more people to add."
                selectedUserIds={selectedUserIds}
                selectedAgentIds={selectedAgentIds}
                selectedMeta={selectedMeta}
                onToggle={handleToggle}
                selectionHint="Choose one or more people or Genies"
                onClearSelection={clearSelection}
                disabledKeys={disabledKeys}
                fillAvailableHeight
              />
            </div>
          )}
        </div>
        {submissionError ? (
          <div className="mx-3 mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
            {submissionError}
          </div>
        ) : null}
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 py-3">
          <span className="hidden text-xs text-foreground-muted sm:block" aria-live="polite">
            {selectedCount} {selectedCount === 1 ? "member" : "members"} selected
          </span>
          <div className="flex w-full gap-2 sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-md border border-border-strong px-3 py-2 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || selectedCount === 0}
              className="flex-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-28 sm:flex-none"
            >
              {submitting
                ? "Adding…"
                : submissionError
                  ? `Retry ${selectedCount}`
                  : selectedCount === 0
                    ? "Add members"
                    : `Add ${selectedCount} ${selectedCount === 1 ? "member" : "members"}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
