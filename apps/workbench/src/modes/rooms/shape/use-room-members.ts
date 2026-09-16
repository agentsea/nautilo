import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomConductorMode, RoomMemberDto } from "@nautilo/types";
import { apiClient } from "../../../lib/api";

interface RoomMembersCacheEntry {
  readonly members: RoomMemberDto[];
  readonly conductorMode: RoomConductorMode;
}

const roomMembersCache = new Map<string, RoomMembersCacheEntry>();

export function resetRoomMembersCacheForTests(): void {
  roomMembersCache.clear();
}

/**
 * D246 Wave 2 (task 2.3) — progressive active-room hydration.
 *
 * The room chrome (`SlackShapeRoom` / `Conversation`) mounts from the
 * room-summary roster the moment a room is active, before the authoritative
 * `GET /api/rooms/:id` detail settles. Pass the summary-derived member list
 * as `initialMembers` so the shell never blanks while detail loads; member
 * controls stay skeletal (placeholder `roomRole`, no owner cues / avatars)
 * until the authoritative detail replaces the seed.
 *
 * Stale-room guard: the authoritative fetch is keyed to the `roomId` it was
 * started for. When the active room changes, the prior fetch's effect
 * cleanup flips its `cancelled` flag, so a late-resolving detail response
 * for the OLD room can never overwrite the NEW room's members. An explicit
 * `targetRoomId !== currentRoomIdRef.current` belt-and-suspenders check
 * backs the `cancelled` flag so the guard is visible to tests.
 */
export function useRoomMembers(
  roomId: string | null,
  initialMembers?: readonly RoomMemberDto[],
): {
  members: RoomMemberDto[];
  conductorMode: RoomConductorMode;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const [members, setMembers] = useState<RoomMemberDto[]>(() =>
    roomId
      ? [...(roomMembersCache.get(roomId)?.members ?? initialMembers ?? [])]
      : [],
  );
  // Identifies which room the state cells below belong to. The returned
  // snapshot is derived against this key during render, so a room switch can
  // never expose the prior room's members while the synchronization effect is
  // still pending.
  const [stateRoomId, setStateRoomId] = useState<string | null>(roomId);
  const [conductorMode, setConductorMode] = useState<RoomConductorMode>(() =>
    roomId ? (roomMembersCache.get(roomId)?.conductorMode ?? "advanced") : "advanced",
  );
  const [loading, setLoading] = useState(() =>
    Boolean(roomId && !roomMembersCache.has(roomId)),
  );
  const [error, setError] = useState<Error | null>(null);
  const [membershipTick, setMembershipTick] = useState(0);
  const refresh = useCallback((): void => {
    if (roomId) roomMembersCache.delete(roomId);
    setMembershipTick((n) => n + 1);
  }, [roomId]);

  // Latest seed for the active room, read inside the roomId effect without
  // re-running the fetch when the seed array identity changes between renders.
  const initialMembersRef = useRef<readonly RoomMemberDto[] | undefined>(initialMembers);
  initialMembersRef.current = initialMembers;
  // Tracks the room the currently-in-flight authoritative fetch is for, so a
  // late resolution for a prior room is dropped (stale-room guard).
  const currentRoomIdRef = useRef<string | null>(roomId);
  // Update during render, not in the passive fetch effect: a prior room's
  // promise may settle between the new-room render and effect cleanup.
  currentRoomIdRef.current = roomId;

  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId && detail.roomId === roomId) {
        roomMembersCache.delete(detail.roomId);
        setMembershipTick((n) => n + 1);
      }
    };
    window.addEventListener("nautilo:room-members-changed", handler);
    return () => window.removeEventListener("nautilo:room-members-changed", handler);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return undefined;
    // A profile change can carry a new agent avatar. The transcript avatars
    // key off room-member data (`/api/rooms/:id/agents/:id/avatar?v=<blobId>`),
    // and versioned avatar URLs are served `immutable` — so the ONLY way those
    // in-chat avatars repaint is a fresh member fetch that yields the new
    // blobId (new `?v=` → new URL). Refetch members on profile.updated so the
    // agent setting its own avatar (or any avatar change) repaints the chat.
    const handler = (): void => {
      roomMembersCache.delete(roomId);
      setMembershipTick((n) => n + 1);
    };
    window.addEventListener("nautilo:profile-changed", handler);
    return () => window.removeEventListener("nautilo:profile-changed", handler);
  }, [roomId]);

  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{
        roomId?: string;
        conductorMode?: RoomConductorMode;
      }>).detail;
      if (
        detail?.roomId !== roomId ||
        (detail.conductorMode !== "advanced" && detail.conductorMode !== "standard")
      ) {
        return;
      }
      setConductorMode(detail.conductorMode);
      if (roomId) {
        const cached = roomMembersCache.get(roomId);
        if (cached) {
          roomMembersCache.set(roomId, {
            ...cached,
            conductorMode: detail.conductorMode,
          });
        }
      }
    };
    window.addEventListener("nautilo:room-conductor-mode-changed", handler);
    return () => window.removeEventListener("nautilo:room-conductor-mode-changed", handler);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) {
      setMembers([]);
      setConductorMode("advanced");
      setLoading(false);
      setError(null);
      setStateRoomId(null);
      return;
    }

    let cancelled = false;
    const cached = roomMembersCache.get(roomId);
    if (cached) {
      // Authoritative detail already cached — mount with it, no fetch.
      setMembers(cached.members);
      setConductorMode(cached.conductorMode);
      setLoading(false);
      setError(null);
    } else {
      // D246 Wave 2 — seed from the summary roster so the chrome mounts
      // immediately. `loading` still reports "authoritative detail pending"
      // so member-management controls can render skeletal until the detail
      // fetch replaces the seed.
      const seed = initialMembersRef.current ?? [];
      setMembers([...seed]);
      setConductorMode("advanced");
      setLoading(true);
      setError(null);
    }
    // Commit the room key only after its snapshot cells have been queued.
    // This remains paint-safe even in a renderer that does not batch effect
    // state updates: a mismatched key keeps returning cache/summary data.
    setStateRoomId(roomId);

    void apiClient
      .getRoom(roomId)
      .then((detail) => {
        // Stale-room guard: drop a resolution that isn't for the room the
        // user is currently viewing (room switched mid-flight, or the effect
        // for this roomId was cleaned up).
        if (cancelled || roomId !== currentRoomIdRef.current) return;
        const nextMode = detail.conductorMode === "standard" ? "standard" : "advanced";
        roomMembersCache.set(roomId, {
          members: detail.members,
          conductorMode: nextMode,
        });
        setMembers(detail.members);
        setConductorMode(nextMode);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || roomId !== currentRoomIdRef.current) return;
        // D246 Wave 2 — do NOT blank the chrome on a detail-fetch failure.
        // Keep the seeded/last-known members so the conversation surface
        // stays mounted; surface the error so the caller can offer retry
        // (and fall back to an error state only when there are no members
        // to fall back to).
        roomMembersCache.delete(roomId);
        setError(err instanceof Error ? err : new Error("Failed to load room members"));
      })
      .finally(() => {
        if (!cancelled && roomId === currentRoomIdRef.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, membershipTick]);

  const cachedForRender = roomId ? roomMembersCache.get(roomId) : undefined;
  const stateMatchesRoom = stateRoomId === roomId;
  const summaryForRender = initialMembers ?? [];
  const renderedMembers = !roomId
    ? []
    : stateMatchesRoom
      ? members.length === 0 && loading && summaryForRender.length > 0
        ? [...summaryForRender]
        : members
      : [...(cachedForRender?.members ?? summaryForRender)];
  const renderedConductorMode = stateMatchesRoom
    ? conductorMode
    : cachedForRender?.conductorMode ?? "advanced";
  const renderedLoading = !roomId
    ? false
    : stateMatchesRoom
      ? loading
      : !cachedForRender;
  const renderedError = stateMatchesRoom ? error : null;

  return {
    members: renderedMembers,
    conductorMode: renderedConductorMode,
    loading: renderedLoading,
    error: renderedError,
    refresh,
  };
}
