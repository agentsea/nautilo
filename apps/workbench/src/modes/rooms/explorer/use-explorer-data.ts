import { parseFederatedId } from "@nautilo/config/federated-id-pure";
import type {
  AgentProfileResponse,
  RoomMemberDto,
  RoomSummaryDto,
  RoomSummaryRosterMemberDto,
} from "@nautilo/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../../../hooks/viewer-authentication";
import { useProfile } from "../../../hooks/use-profile";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useNotificationState } from "../../../notifications/notification-state-context";
import { apiClient } from "../../../lib/api";
import { groupRoomsForExplorer } from "./explorer-grouping";
import type { ExplorerRosterMember } from "./explorer-grouping.types";
import { useExplorerSort } from "./hooks/useExplorerSort";

type MemberWithOptionalFederated = RoomMemberDto & { federatedId?: string };

/**
 * D246 Wave 2 — map a compact summary-roster member (server wire shape) to the
 * explorer's roster row. The compact projection carries the canonical
 * federated identity so the explorer preserves both local handle and home
 * server for display and server-name search without a room-detail fetch.
 */
function mapSummaryRosterMember(m: RoomSummaryRosterMemberDto): ExplorerRosterMember {
  const parsed =
    typeof m.federatedId === "string" ? parseFederatedId(m.federatedId) : null;
  const handle = parsed
    ? { local: parsed.handle, server: parsed.server }
    : typeof m.handle === "string" && m.handle.length > 0
      ? { local: m.handle, server: null as string | null }
      : undefined;
  return {
    actorId: m.actorId,
    kind: m.kind,
    displayName: m.displayName,
    ...(m.userId ? { userId: m.userId } : {}),
    ...(m.agentId ? { agentId: m.agentId } : {}),
    ...(m.kind === "agent" ? { agentAvatar: m.agentAvatar ?? null } : {}),
    ...(handle ? { handle } : {}),
  };
}

function rosterHandleFromDetailMember(
  m: MemberWithOptionalFederated,
): ExplorerRosterMember["handle"] {
  const fed = typeof m.federatedId === "string" ? m.federatedId : undefined;
  if (fed) {
    const parsed = parseFederatedId(fed);
    if (parsed) return { local: parsed.handle, server: parsed.server };
  }
  if (typeof m.handle === "string" && m.handle.length > 0) {
    return { local: m.handle, server: null };
  }
  return undefined;
}

/** Mixed-deployment fallback — map authoritative room detail members to explorer rows. */
function mapDetailMemberToRosterRow(m: RoomMemberDto): ExplorerRosterMember {
  const ext = m as MemberWithOptionalFederated;
  const handle = rosterHandleFromDetailMember(ext);
  return {
    actorId: m.actorId,
    kind: m.kind,
    displayName: m.displayName,
    ...(m.userId ? { userId: m.userId } : {}),
    ...(m.agentId ? { agentId: m.agentId } : {}),
    ...(m.kind === "agent" ? { agentAvatar: m.agentAvatar ?? null } : {}),
    ...(handle ? { handle } : {}),
  };
}

export function buildExplorerRosters(
  rooms: readonly Pick<RoomSummaryDto, "id" | "roster">[],
): Map<string, ExplorerRosterMember[]> {
  const map = new Map<string, ExplorerRosterMember[]>();
  for (const room of rooms) {
    if (room.roster === undefined) continue;
    map.set(room.id, room.roster.map(mapSummaryRosterMember));
  }
  return map;
}

function mergeExplorerRosters(
  summaryRosters: Map<string, ExplorerRosterMember[]>,
  fallbackRosters: Map<string, ExplorerRosterMember[]>,
): Map<string, ExplorerRosterMember[]> {
  const merged = new Map(summaryRosters);
  for (const [roomId, members] of fallbackRosters) {
    if (!merged.has(roomId)) merged.set(roomId, members);
  }
  return merged;
}

async function fetchRoomRosterFallback(roomId: string): Promise<ExplorerRosterMember[]> {
  const detail = await apiClient.getRoom(roomId);
  return detail.members.map(mapDetailMemberToRosterRow);
}

const explorerRosterFallbackCache = {
  viewerGeneration: null as number | null,
  settled: new Map<string, ExplorerRosterMember[]>(),
  inFlight: new Map<string, Promise<ExplorerRosterMember[]>>(),
};

export function resetExplorerRosterFallbackForTests(): void {
  explorerRosterFallbackCache.viewerGeneration = null;
  explorerRosterFallbackCache.settled.clear();
  explorerRosterFallbackCache.inFlight.clear();
}

function readOwnedAgentIds(response: AgentProfileResponse | null): Set<string> {
  if (!response) return new Set();
  if (!("ownedAgents" in response)) return new Set();
  return new Set(response.ownedAgents.map((a) => a.agentId));
}

export function useExplorerData() {
  const roomNav = useRoomNavigation();
  const notifications = useNotificationState();
  const auth = useAuth();
  const { response: profileResponse } = useProfile();
  const { sort } = useExplorerSort();
  const viewerActorId = auth.viewer.sessionActorId;
  const viewerGeneration = auth.viewerGeneration;
  const ownedAgentIds = useMemo(
    () => readOwnedAgentIds(profileResponse),
    [profileResponse],
  );

  const summaryRosters = useMemo(
    () => buildExplorerRosters(roomNav.rooms),
    [roomNav.rooms],
  );
  const [fallbackState, setFallbackState] = useState<{
    viewerGeneration: number;
    rosters: Map<string, ExplorerRosterMember[]>;
  }>(() => ({ viewerGeneration, rosters: new Map() }));
  const viewerActorIdRef = useRef(viewerActorId);
  viewerActorIdRef.current = viewerActorId;
  const viewerGenerationRef = useRef(viewerGeneration);
  viewerGenerationRef.current = viewerGeneration;

  const rosters = useMemo(
    () =>
      mergeExplorerRosters(
        summaryRosters,
        fallbackState.viewerGeneration === viewerGeneration
          ? fallbackState.rosters
          : new Map<string, ExplorerRosterMember[]>(),
      ),
    [summaryRosters, fallbackState, viewerGeneration],
  );

  // D246 Wave 2 — rosters normally arrive folded into the room-list response
  // (`GET /api/rooms` → `RoomSummaryDto.roster`), so the explorer classifies
  // every row from one batched payload with zero per-room detail calls.
  //
  // Mixed-deployment compatibility: an old server omits the optional `roster`
  // field. When every current room carries a roster array (including `[]`),
  // we stay on that fast path. Otherwise we hydrate ONLY the missing rooms via
  // `GET /api/rooms/:id`, dedupe in-flight work, settle failures once, and
  // keep progressive rendering — embedded rosters classify immediately while
  // missing-roster rooms use heuristics until fallback resolves.
  useEffect(() => {
    if (!isAuthenticatedHumanViewer(auth.viewer)) return undefined;

    if (explorerRosterFallbackCache.viewerGeneration !== viewerGeneration) {
      explorerRosterFallbackCache.viewerGeneration = viewerGeneration;
      explorerRosterFallbackCache.settled.clear();
      explorerRosterFallbackCache.inFlight.clear();
    }

    const allowedIds = roomNav.rooms.map((r) => r.id);
    const allowed = new Set(allowedIds);
    const snapshotViewer = viewerActorIdRef.current;
    const snapshotGeneration = viewerGeneration;

    setFallbackState((prev) => {
      const previousRosters =
        prev.viewerGeneration === snapshotGeneration
          ? prev.rosters
          : new Map<string, ExplorerRosterMember[]>();
      let changed = false;
      const next = new Map(previousRosters);
      for (const id of previousRosters.keys()) {
        if (!allowed.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      for (const room of roomNav.rooms) {
        if (room.roster !== undefined && next.has(room.id)) {
          next.delete(room.id);
          changed = true;
          explorerRosterFallbackCache.settled.delete(room.id);
        }
      }
      for (const room of roomNav.rooms) {
        if (room.roster !== undefined) continue;
        const settled = explorerRosterFallbackCache.settled.get(room.id);
        if (settled !== undefined && !next.has(room.id)) {
          next.set(room.id, settled);
          changed = true;
        }
      }
      if (!changed && prev.viewerGeneration === snapshotGeneration) return prev;
      return { viewerGeneration: snapshotGeneration, rosters: next };
    });

    for (const id of explorerRosterFallbackCache.settled.keys()) {
      if (!allowed.has(id)) explorerRosterFallbackCache.settled.delete(id);
    }
    for (const id of explorerRosterFallbackCache.inFlight.keys()) {
      if (!allowed.has(id)) explorerRosterFallbackCache.inFlight.delete(id);
    }

    const needsFallback = roomNav.rooms
      .filter((room) => room.roster === undefined)
      .map((room) => room.id)
      .filter((roomId) => !explorerRosterFallbackCache.settled.has(roomId));

    if (needsFallback.length === 0) return undefined;

    let cancelled = false;

    for (const roomId of needsFallback) {
      let promise = explorerRosterFallbackCache.inFlight.get(roomId);
      if (!promise) {
        const request = fetchRoomRosterFallback(roomId).catch(
          () => [] as ExplorerRosterMember[],
        );
        const ownedPromise = request
          .then((members) => {
            if (
              explorerRosterFallbackCache.viewerGeneration === snapshotGeneration &&
              explorerRosterFallbackCache.inFlight.get(roomId) === ownedPromise
            ) {
              explorerRosterFallbackCache.settled.set(roomId, members);
            }
            return members;
          })
          .finally(() => {
            if (explorerRosterFallbackCache.inFlight.get(roomId) === ownedPromise) {
              explorerRosterFallbackCache.inFlight.delete(roomId);
            }
          });
        promise = ownedPromise;
        explorerRosterFallbackCache.inFlight.set(roomId, promise);
      }

      void promise.then((members) => {
        if (cancelled) return;
        if (viewerGenerationRef.current !== snapshotGeneration) return;
        if (viewerActorIdRef.current !== snapshotViewer) return;
        if (!allowed.has(roomId)) return;

        setFallbackState((prev) => {
          const previousRosters =
            prev.viewerGeneration === snapshotGeneration
              ? prev.rosters
              : new Map<string, ExplorerRosterMember[]>();
          if (previousRosters.has(roomId)) return prev;
          const next = new Map(previousRosters);
          next.set(roomId, members);
          return { viewerGeneration: snapshotGeneration, rosters: next };
        });
      });
    }

    return () => {
      cancelled = true;
    };
  }, [auth.viewer, roomNav.rooms, viewerActorId, viewerGeneration]);

  // `ready` tracks room-list readiness only. Embedded rosters classify
  // immediately; missing-roster rooms may use heuristics until fallback
  // resolves and then self-correct. Stays `true` across refreshes (status
  // does not flip back to `loading` on `refreshRooms`), so the tree never
  // flashes back to the "Loading rooms…" placeholder.
  const ready = roomNav.status !== "loading";
  const attentionByRoomId = useMemo(() => {
    const map = new Map<
      string,
      { unreadCount: number; importantUnreadCount: number }
    >();
    for (const room of notifications.snapshot?.rooms ?? []) {
      map.set(room.roomId, {
        unreadCount: room.unreadCount,
        importantUnreadCount: room.importantUnreadCount,
      });
    }
    for (const subthread of notifications.snapshot?.subthreads ?? []) {
      map.set(subthread.roomId, {
        unreadCount: subthread.unreadCount,
        importantUnreadCount: subthread.importantUnreadCount,
      });
    }
    return map;
  }, [notifications.snapshot]);

  const humanDirectory = useMemo(() => {
    const map = new Map<string, string>();
    for (const members of rosters.values()) {
      for (const m of members) {
        if (m.kind !== "user" || !m.userId) continue;
        if (!map.has(m.userId)) {
          map.set(m.userId, m.displayName);
        }
      }
    }
    return [...map.entries()].map(([userId, displayName]) => ({ userId, displayName }));
  }, [rosters]);

  return useMemo(
    () => ({
      sections: groupRoomsForExplorer({
        rooms: roomNav.rooms,
        rosters,
        viewerActorId,
        ownedAgentIds,
        sort,
        attentionByRoomId,
      }),
      sort,
      activeRoomId: roomNav.activeRoomId,
      setActiveRoom: roomNav.setActiveRoom,
      refreshRooms: roomNav.refreshRooms,
      refreshing: roomNav.status === "loading",
      ready,
      error: roomNav.roomListError,
      humanDirectory,
    }),
    [
      roomNav.rooms,
      roomNav.activeRoomId,
      roomNav.setActiveRoom,
      roomNav.refreshRooms,
      roomNav.status,
      roomNav.roomListError,
      rosters,
      viewerActorId,
      ownedAgentIds,
      sort,
      attentionByRoomId,
      ready,
      humanDirectory,
    ],
  );
}
