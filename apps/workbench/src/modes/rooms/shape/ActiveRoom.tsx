import type { ReactElement } from "react";
import { useMemo } from "react";
import type { RoomMemberDto, RoomSummaryRosterMemberDto } from "@nautilo/types";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useRoomMembers } from "./use-room-members";
import { SlackShapeRoom } from "./slack/SlackShapeRoom";
import { RoomShapeSkeleton } from "./RoomShapeSkeleton";

/**
 * D246 Wave 2 (task 2.3) — map the compact summary roster (server wire
 * shape) to the `RoomMemberDto[]` the room chrome consumes. `roomRole` is a
 * placeholder `"member"`; the authoritative role arrives with the detail
 * fetch. Owner cues / agent avatars are intentionally absent — the chrome
 * does not consume them before detail hydrates, and member-management
 * controls stay skeletal until the authoritative detail replaces the seed.
 */
function summaryRosterToMembers(
  roster: readonly RoomSummaryRosterMemberDto[] | undefined,
): RoomMemberDto[] {
  if (!roster?.length) return [];
  return roster.map((m) => ({
    actorId: m.actorId,
    kind: m.kind,
    displayName: m.displayName,
    roomRole: "member" as const,
    ...(m.userId ? { userId: m.userId } : {}),
    ...(m.agentId ? { agentId: m.agentId } : {}),
    ...(typeof m.handle === "string" && m.handle.length > 0 ? { handle: m.handle } : {}),
  }));
}

export function ActiveRoom(): ReactElement {
  const { activeRoomId, activeRoom } = useRoomNavigation();
  const summaryMembers = useMemo(
    () => summaryRosterToMembers(activeRoom?.roster),
    [activeRoom?.roster],
  );
  const { members, loading, error, refresh } = useRoomMembers(activeRoomId, summaryMembers);

  if (!activeRoomId) {
    return <SlackShapeRoom members={[]} />;
  }

  // No members at all (no summary roster AND no authoritative detail yet)
  // → skeleton. Once summary members are available the chrome mounts
  // immediately and stays mounted across the authoritative detail fetch —
  // no remount, so no composer/microphone re-init beep.
  if (members.length === 0 && loading) {
    return <RoomShapeSkeleton />;
  }

  if (error && members.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center bg-background p-6">
        <div role="alert" className="max-w-md rounded-lg border border-border bg-background-panel p-4 text-sm">
          <p className="font-medium text-foreground">Could not load this room's members.</p>
          <p className="mt-1 text-foreground-muted">{error.message}</p>
          <button
            type="button"
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // D246 Wave 2 — when a detail fetch fails but we have summary/last-known
  // members, keep the chrome mounted (degraded) rather than blanking the
  // conversation surface. The error is swallowed from the chrome path; a
  // retry surfaces on the next membership/refresh tick.
  return <SlackShapeRoom roomId={activeRoomId} members={members} onMembershipChanged={refresh} />;
}
