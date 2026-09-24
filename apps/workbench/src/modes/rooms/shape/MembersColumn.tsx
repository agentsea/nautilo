import { useMemo } from "react";
import type { ReactElement } from "react";
import type { RoomMemberDto } from "@nautilo/types";
import { useRoomFocus } from "./use-room-focus";
import { sortMembersByTalking } from "./members-panel-model";
import { MemberFocusAvatar } from "./MemberFocusAvatar";
import { useRoomPresence } from "./use-room-presence";

/**
 * Compact members column (the ~48px thin column in the
 * artifact-open multi-user layout). The *compact mode* of the members panel:
 * same shared core (`MemberFocusAvatar` + `useRoomFocus` + sort) as the full
 * drawer, just a narrower shell.
 *
 * Stacks member avatars top-to-bottom (sorted by talking → admin → alpha),
 * each carrying the per-bot focus ring (tap to open/clear); overflow collapses
 * to `+N`; click-to-expand opens the full drawer.
 */
const MAX_VISIBLE_COMPACT = 6;
const EMPTY_LAST_SPOKE: ReadonlyMap<string, number> = new Map();

export function MembersColumn({
  roomId,
  viewerActorId,
  members,
  onExpand,
  lastSpokeAtMs,
}: {
  readonly roomId: string;
  readonly viewerActorId: string;
  readonly members: readonly RoomMemberDto[];
  readonly onExpand: () => void;
  readonly lastSpokeAtMs?: ReadonlyMap<string, number>;
}): ReactElement {
  const focus = useRoomFocus(roomId);
  const presence = useRoomPresence(roomId, viewerActorId);
  const sorted = useMemo(
    () => sortMembersByTalking(members, lastSpokeAtMs ?? EMPTY_LAST_SPOKE),
    [members, lastSpokeAtMs],
  );
  const visible = sorted.slice(0, MAX_VISIBLE_COMPACT);
  const overflow = sorted.length - visible.length;

  return (
    <aside
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1.5 border-l border-border bg-background-panel py-2"
      aria-label={`Members (${members.length})`}
      data-testid="members-column"
    >
      {visible.map((m) => (
        <MemberFocusAvatar
          key={m.actorId}
          member={m}
          focus={focus}
          size="sm"
          roomId={roomId}
          showPresence={m.kind === "user"}
          presence={m.kind === "user" ? presence.get(m.actorId) : undefined}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={onExpand}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium text-foreground-muted hover:text-foreground"
          aria-label={`${overflow} more — expand members`}
          data-testid="members-column-overflow"
        >
          +{overflow}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onExpand}
        className="mt-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-background hover:text-foreground"
        aria-label="Expand members panel"
        data-testid="members-column-expand"
      >
        ⋯
      </button>
    </aside>
  );
}
