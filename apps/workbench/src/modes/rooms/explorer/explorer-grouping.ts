import type { WorkbenchRoomSummary } from "../../../rooms/room-navigation-types";
import type {
  ExplorerRosterMember,
  ExplorerRow,
  ExplorerSection,
  ExplorerSortSettings,
} from "./explorer-grouping.types";
import { DEFAULT_EXPLORER_SORT } from "./explorer-grouping.types";
import { EXPLORER_UNREAD_FIRST_SORT_ENABLED } from "../../../rooms/unread-visual-flags";

export type {
  ExplorerRow,
  ExplorerSection,
  ExplorerSectionKind,
  ExplorerSortDir,
  ExplorerSortMode,
  ExplorerSortSettings,
} from "./explorer-grouping.types";

function inferAgentLabelFromRoom(room: WorkbenchRoomSummary): string {
  const parts = room.label.split(/\s*[·/]\s*/).map((s) => s.trim());
  if (parts.length >= 2) return parts[parts.length - 1] ?? room.label;
  return room.label;
}

function dateMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function activityMs(room: WorkbenchRoomSummary): number {
  return dateMs(room.lastMessageAt) || dateMs(room.createdAt);
}

function unreadOf(room: WorkbenchRoomSummary | undefined): number {
  return room?.unreadCount ?? 0;
}

type AttentionProjectedRoom = WorkbenchRoomSummary & {
  explorerImportantUnreadCount?: number;
};

export interface ExplorerRoomAttention {
  unreadCount: number;
  importantUnreadCount: number;
}

function importantOf(room: WorkbenchRoomSummary | undefined): number {
  return (room as AttentionProjectedRoom | undefined)
    ?.explorerImportantUnreadCount ?? 0;
}

function rosterFor(
  rosters: Map<string, ExplorerRosterMember[]>,
  roomId: string,
): ExplorerRosterMember[] | undefined {
  return rosters.get(roomId);
}

function countKinds(roster: ExplorerRosterMember[] | undefined): {
  humans: ExplorerRosterMember[];
  agents: ExplorerRosterMember[];
} {
  if (!roster?.length) return { humans: [], agents: [] };
  const humans = roster.filter((m) => m.kind === "user");
  const agents = roster.filter((m) => m.kind === "agent");
  return { humans, agents };
}

function isSubthreadRoom(room: WorkbenchRoomSummary): boolean {
  return room.kind === "subthread";
}

function otherHumanInOneToOne(
  roster: ExplorerRosterMember[] | undefined,
  viewerActorId: string | null,
): ExplorerRosterMember | null {
  if (!roster?.length || !viewerActorId) return null;
  const humans = roster.filter((m) => m.kind === "user");
  if (humans.length !== 2) return null;
  const other = humans.find((h) => h.actorId !== viewerActorId);
  return other ?? null;
}

function isPeopleDm(
  _room: WorkbenchRoomSummary,
  roster: ExplorerRosterMember[] | undefined,
  viewerActorId: string | null,
): boolean {
  const { humans, agents } = countKinds(roster);
  if (agents.length !== 0) return false;
  if (humans.length === 2 && viewerActorId) {
    return humans.some((h) => h.actorId === viewerActorId);
  }
  return false;
}

function isGroupRoom(
  room: WorkbenchRoomSummary,
  roster: ExplorerRosterMember[] | undefined,
): boolean {
  const { humans } = countKinds(roster);
  if (humans.length >= 2) {
    return true;
  }
  if (!roster?.length) {
    return room.kind === "group" || (room.kind === "multi_agent" && (room.memberCount ?? 0) >= 3);
  }
  return false;
}

function isSingleHumanWithAgents(
  room: WorkbenchRoomSummary,
  roster: ExplorerRosterMember[] | undefined,
): boolean {
  const { humans, agents } = countKinds(roster);
  if (humans.length === 1 && agents.length >= 1) return true;
  if (!roster?.length && room.kind === "private" && (room.memberCount ?? 0) === 2) {
    return true;
  }
  return false;
}

function isAgentToAgentRoom(
  room: WorkbenchRoomSummary,
  roster: ExplorerRosterMember[] | undefined,
): boolean {
  const { humans, agents } = countKinds(roster);
  if (humans.length === 0 && agents.length >= 2) return true;
  if (!roster?.length) {
    return room.kind === "multi_agent" && (room.memberCount ?? 0) >= 2;
  }
  return false;
}

function roomLabelForExplorer(room: WorkbenchRoomSummary): string {
  return room.label.startsWith("#") ? room.label : `# ${room.label}`;
}

function compareSecondary(a: ExplorerRow, b: ExplorerRow, sort: ExplorerSortSettings): number {
  if (sort.mode === "alpha") {
    const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    return sort.dir === "asc" ? cmp : -cmp;
  }
  const aAct = a.lastActivityAt ?? 0;
  const bAct = b.lastActivityAt ?? 0;
  const cmp = aAct - bAct;
  return sort.dir === "asc" ? cmp : -cmp;
}

/**
 * Unread-first primary key (when enabled), then user sort mode within each
 * bucket. Unread-first is gated by `EXPLORER_UNREAD_VISUAL_ENABLED` (D286 —
 * phantom counts); `opts.unreadFirst` overrides the flag for unit tests.
 */
export function compareExplorerRows(
  a: ExplorerRow,
  b: ExplorerRow,
  sort: ExplorerSortSettings = DEFAULT_EXPLORER_SORT,
  opts?: { unreadFirst?: boolean },
): number {
  const unreadFirst = opts?.unreadFirst ?? EXPLORER_UNREAD_FIRST_SORT_ENABLED;
  if (unreadFirst) {
    const aUnread = (a.unreadCount ?? 0) > 0 ? 1 : 0;
    const bUnread = (b.unreadCount ?? 0) > 0 ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
  }
  return compareSecondary(a, b, sort);
}

export function sortExplorerRows(
  rows: ExplorerRow[],
  sort: ExplorerSortSettings = DEFAULT_EXPLORER_SORT,
): ExplorerRow[] {
  return [...rows]
    .sort((a, b) => compareExplorerRows(a, b, sort))
    .map((row) =>
      row.children?.length
        ? { ...row, children: sortExplorerRows(row.children, sort) }
        : row,
    );
}

function flatRoomRow(args: {
  id: string;
  label: string;
  room: WorkbenchRoomSummary;
  handle?: ExplorerRow["handle"];
}): ExplorerRow {
  const { id, label, room, handle } = args;
  return {
    id,
    kind: "room",
    depth: 0,
    label,
    roomId: room.id,
    preview: null,
    isSubthread: false,
    unreadCount: unreadOf(room),
    importantUnreadCount: importantOf(room),
    lastActivityAt: activityMs(room),
    roomKind: room.kind,
    ...(handle ? { handle } : {}),
  };
}

function sumUnread(rows: ExplorerRow[]): number {
  return rows.reduce((sum, row) => sum + (row.unreadCount ?? 0), 0);
}

function sumImportant(rows: ExplorerRow[]): number {
  return rows.reduce(
    (sum, row) => sum + (row.importantUnreadCount ?? 0),
    0,
  );
}

/**
 * Build one navigable direct/private room leaf and nest that
 * room's own subthreads beneath it as a "Threads N" container. Threads belong
 * to a specific room, not to the entity as a whole.
 */
function buildRoomLeafRow(args: {
  idPrefix: string;
  kind: "direct-room" | "private-room";
  label: string;
  room: WorkbenchRoomSummary;
  depth: number;
  subthreadsByParent: Map<string, WorkbenchRoomSummary[]>;
  sort: ExplorerSortSettings;
}): ExplorerRow {
  const { idPrefix, kind, label, room, depth, subthreadsByParent, sort } = args;

  const subs = subthreadsByParent.get(room.id) ?? [];
  const threadChildren = sortExplorerRows(
    subs.map((st) => ({
      id: `${idPrefix}:thread:${st.id}`,
      kind: "thread" as const,
      depth: depth + 2,
      label: st.label || "Thread",
      roomId: st.id,
      preview: null,
      isSubthread: true,
      unreadCount: unreadOf(st),
      importantUnreadCount: importantOf(st),
      lastActivityAt: activityMs(st),
    })),
    sort,
  );

  const threadsContainer: ExplorerRow | null =
    threadChildren.length > 0
      ? {
          id: `${idPrefix}:threads`,
          kind: "threads",
          depth: depth + 1,
          label: "Threads",
          roomId: "",
          preview: null,
          isSubthread: false,
          subthreadCount: threadChildren.length,
          unreadCount: sumUnread(threadChildren),
          importantUnreadCount: sumImportant(threadChildren),
          lastActivityAt: threadChildren[0]?.lastActivityAt ?? 0,
          children: threadChildren,
        }
      : null;

  return {
    id: idPrefix,
    kind,
    depth,
    label,
    roomId: room.id,
    preview: null,
    isSubthread: false,
    // M238 — the server-authored top-level value already includes eligible
    // child Subthreads. Re-adding the displayed children double-counts it.
    unreadCount: unreadOf(room),
    importantUnreadCount: importantOf(room),
    lastActivityAt: activityMs(room),
    roomKind: room.kind,
    ...(threadsContainer ? { children: [threadsContainer] } : {}),
  };
}

function maxActivity(rooms: WorkbenchRoomSummary[]): number {
  let max = 0;
  for (const r of rooms) {
    const a = activityMs(r);
    if (a > max) max = a;
  }
  return max;
}

function buildPersonEntityRow(args: {
  other: ExplorerRosterMember;
  directRooms: WorkbenchRoomSummary[];
  subthreadsByParent: Map<string, WorkbenchRoomSummary[]>;
  sort: ExplorerSortSettings;
}): ExplorerRow {
  const { other, directRooms, subthreadsByParent, sort } = args;
  const prefix = `people:entity:${other.actorId}`;

  const directRows = sortExplorerRows(
    directRooms.map((room) =>
      buildRoomLeafRow({
        idPrefix: `${prefix}:direct:${room.id}`,
        kind: "direct-room",
        label: room.label,
        room,
        depth: 1,
        subthreadsByParent,
        sort,
      }),
    ),
    sort,
  );

  const primaryRoomId = directRows[0]?.roomId ?? "";

  return {
    id: prefix,
    kind: "entity-human",
    depth: 0,
    label: other.displayName,
    roomId: primaryRoomId,
    preview: null,
    isSubthread: false,
    ...(other.handle ? { handle: other.handle } : {}),
    unreadCount: sumUnread(directRows),
    importantUnreadCount: sumImportant(directRows),
    lastActivityAt: maxActivity(directRooms),
    children: directRows,
  };
}

function buildAgentEntityRow(args: {
  agentActorId: string;
  agentId: string | undefined;
  agentAvatar?: ExplorerRosterMember["agentAvatar"];
  label: string;
  handle?: ExplorerRow["handle"];
  privateRooms: WorkbenchRoomSummary[];
  subthreadsByParent: Map<string, WorkbenchRoomSummary[]>;
  sort: ExplorerSortSettings;
}): ExplorerRow {
  const {
    agentActorId,
    agentId,
    agentAvatar,
    label,
    handle,
    privateRooms,
    subthreadsByParent,
    sort,
  } = args;
  const prefix = `agent:entity:${agentActorId}`;

  const privateRows = sortExplorerRows(
    privateRooms.map((room) =>
      buildRoomLeafRow({
        idPrefix: `${prefix}:private:${room.id}`,
        kind: "private-room",
        label: room.label,
        room,
        depth: 1,
        subthreadsByParent,
        sort,
      }),
    ),
    sort,
  );

  const primaryRoomId = privateRows[0]?.roomId ?? "";

  return {
    id: prefix,
    kind: "entity-agent",
    depth: 0,
    label,
    roomId: primaryRoomId,
    preview: null,
    isSubthread: false,
    ...(handle ? { handle } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentAvatar ? { agentAvatar } : {}),
    unreadCount: sumUnread(privateRows),
    importantUnreadCount: sumImportant(privateRows),
    lastActivityAt: maxActivity(privateRooms),
    children: privateRows,
  };
}

export function groupRoomsForExplorer(args: {
  rooms: WorkbenchRoomSummary[];
  rosters: Map<string, ExplorerRosterMember[]>;
  viewerActorId: string | null;
  ownedAgentIds?: ReadonlySet<string>;
  sort?: ExplorerSortSettings;
  attentionByRoomId?: ReadonlyMap<string, ExplorerRoomAttention>;
}): ExplorerSection[] {
  const {
    rooms: sourceRooms,
    rosters,
    viewerActorId,
    ownedAgentIds = new Set<string>(),
    sort = DEFAULT_EXPLORER_SORT,
    attentionByRoomId,
  } = args;
  const rooms: AttentionProjectedRoom[] =
    attentionByRoomId === undefined
      ? sourceRooms
      : sourceRooms.map((room) => {
          const attention = attentionByRoomId.get(room.id);
          return {
            ...room,
            // An absent authoritative row is unavailable/ineligible, not a
            // license to reuse the legacy RoomSummary unread value.
            unreadCount: attention?.unreadCount,
            explorerImportantUnreadCount: attention?.importantUnreadCount,
          };
        });

  const roomsById = new Map(rooms.map((r) => [r.id, r]));
  const topLevel = rooms.filter((r) => !isSubthreadRoom(r));
  const subthreads = rooms.filter((r) => isSubthreadRoom(r));

  const peopleEntities = new Map<
    string,
    { other: ExplorerRosterMember; roomIds: string[] }
  >();

  const agentAccumulator = new Map<
    string,
    {
      agentActorId: string;
      agentId: string | undefined;
      agentAvatar?: ExplorerRosterMember["agentAvatar"];
      label: string;
      handle?: ExplorerRow["handle"];
      roomIds: string[];
    }
  >();

  const groupsRows: ExplorerRow[] = [];
  const publicRows: ExplorerRow[] = [];
  const agentToAgentRows: ExplorerRow[] = [];

  for (const room of topLevel) {
    const roster = rosterFor(rosters, room.id);

    // Public/open rooms are channel-like and get their own home. Keyed on
    // room.kind (always known), so a freshly created public room appears
    // immediately — before its roster has been fetched. Without this, open
    // rooms matched no classifier below and were silently dropped.
    if (room.kind === "open") {
      publicRows.push(
        flatRoomRow({
          id: `public:${room.id}`,
          label: roomLabelForExplorer(room),
          room,
        }),
      );
      continue;
    }

    if (isPeopleDm(room, roster, viewerActorId)) {
      const other = otherHumanInOneToOne(roster, viewerActorId);
      if (!other) continue;
      const prior = peopleEntities.get(other.actorId);
      if (!prior) {
        peopleEntities.set(other.actorId, { other, roomIds: [room.id] });
      } else {
        prior.roomIds.push(room.id);
      }
      continue;
    }

    if (isGroupRoom(room, roster)) {
      groupsRows.push(
        flatRoomRow({
          id: `group:${room.id}`,
          label: roomLabelForExplorer(room),
          room,
        }),
      );
      continue;
    }

    if (isAgentToAgentRoom(room, roster)) {
      agentToAgentRows.push(
        flatRoomRow({
          id: `a2a:${room.id}`,
          label: room.label,
          room,
        }),
      );
      continue;
    }

    if (isSingleHumanWithAgents(room, roster)) {
      const { agents } = countKinds(roster);
      const agentList =
        agents.length > 0
          ? agents
          : [
              {
                actorId: `synthetic:${room.id}`,
                kind: "agent" as const,
                displayName: inferAgentLabelFromRoom(room),
              },
            ];
      for (const agent of agentList) {
        const prior = agentAccumulator.get(agent.actorId);
        if (!prior) {
          agentAccumulator.set(agent.actorId, {
            agentActorId: agent.actorId,
            agentId: agent.agentId,
            ...(agent.agentAvatar ? { agentAvatar: agent.agentAvatar } : {}),
            label: agent.displayName,
            ...(agent.handle ? { handle: agent.handle } : {}),
            roomIds: [room.id],
          });
        } else {
          prior.roomIds.push(room.id);
          if (!prior.agentId && agent.agentId) prior.agentId = agent.agentId;
          if (!prior.agentAvatar && agent.agentAvatar) prior.agentAvatar = agent.agentAvatar;
        }
      }
      continue;
    }
  }

  const parentIdToSubthreads = new Map<string, WorkbenchRoomSummary[]>();
  for (const st of subthreads) {
    const parentId = st.parentRoomId ?? "";
    if (!parentId) continue;
    const list = parentIdToSubthreads.get(parentId) ?? [];
    list.push(st);
    parentIdToSubthreads.set(parentId, list);
  }

  for (const [, list] of parentIdToSubthreads) {
    list.sort((a, b) => activityMs(b) - activityMs(a));
  }

  const peopleRows: ExplorerRow[] = [];
  for (const [, data] of peopleEntities) {
    const directRooms = data.roomIds
      .map((id) => roomsById.get(id))
      .filter((r): r is WorkbenchRoomSummary => r != null);
    if (directRooms.length === 0) continue;
    peopleRows.push(
      buildPersonEntityRow({
        other: data.other,
        directRooms,
        subthreadsByParent: parentIdToSubthreads,
        sort,
      }),
    );
  }

  const myAgentRows: ExplorerRow[] = [];
  const otherAgentRows: ExplorerRow[] = [];

  for (const [, data] of agentAccumulator) {
    const privateRooms = data.roomIds
      .map((id) => roomsById.get(id))
      .filter((r): r is WorkbenchRoomSummary => r != null);
    if (privateRooms.length === 0) continue;
    const entityRow = buildAgentEntityRow({
      agentActorId: data.agentActorId,
      agentId: data.agentId,
      agentAvatar: data.agentAvatar,
      label: data.label,
      handle: data.handle,
      privateRooms,
      subthreadsByParent: parentIdToSubthreads,
      sort,
    });
    const ownedKey = data.agentId ?? "";
    if (ownedKey && ownedAgentIds.has(ownedKey)) {
      myAgentRows.push(entityRow);
    } else {
      otherAgentRows.push(entityRow);
    }
  }

  const recentPool = [...subthreads].sort((a, b) => activityMs(b) - activityMs(a));
  const recentRows: ExplorerRow[] = recentPool.map((st) =>
    flatRoomRow({
      id: `recent:${st.id}`,
      label: st.label || "Thread",
      room: st,
    }),
  );

  const sections: ExplorerSection[] = [];

  if (peopleRows.length) {
    sections.push({
      kind: "people",
      title: "People",
      defaultCollapsed: false,
      rows: sortExplorerRows(peopleRows, sort),
    });
  }

  if (myAgentRows.length) {
    sections.push({
      kind: "my-agents",
      title: "My agents",
      defaultCollapsed: false,
      rows: sortExplorerRows(myAgentRows, sort),
    });
  }

  if (otherAgentRows.length) {
    sections.push({
      kind: "other-agents",
      title: "Other agents",
      defaultCollapsed: false,
      rows: sortExplorerRows(otherAgentRows, sort),
    });
  }

  if (groupsRows.length) {
    sections.push({
      kind: "groups",
      title: "Groups",
      defaultCollapsed: false,
      rows: sortExplorerRows(groupsRows, sort),
    });
  }

  if (publicRows.length) {
    sections.push({
      kind: "public",
      title: "Public rooms",
      defaultCollapsed: false,
      rows: sortExplorerRows(publicRows, sort),
    });
  }

  if (recentRows.length) {
    sections.push({
      kind: "recent",
      title: "Recent threads",
      defaultCollapsed: true,
      rows: sortExplorerRows(recentRows, sort),
    });
  }

  if (agentToAgentRows.length) {
    sections.push({
      kind: "agent-to-agent",
      title: "Agent-to-agent",
      defaultCollapsed: true,
      rows: sortExplorerRows(agentToAgentRows, sort),
    });
  }

  return sections;
}

function rowMatchesQuery(row: ExplorerRow, q: string): boolean {
  if (row.label.toLowerCase().includes(q)) return true;
  if (row.handle?.local.toLowerCase().includes(q)) return true;
  if (row.handle?.server && row.handle.server.toLowerCase().includes(q)) return true;
  return row.children?.some((child) => rowMatchesQuery(child, q)) ?? false;
}

function filterRowTree(row: ExplorerRow, q: string): ExplorerRow | null {
  if (!rowMatchesQuery(row, q)) return null;
  if (!row.children?.length) return row;
  const filteredChildren = row.children
    .map((child) => filterRowTree(child, q))
    .filter((child): child is ExplorerRow => child !== null);
  return { ...row, children: filteredChildren.length ? filteredChildren : undefined };
}

export function filterSectionsByQuery(
  sections: ExplorerSection[],
  rawQuery: string,
): ExplorerSection[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((sec) => ({
      ...sec,
      rows: sec.rows
        .map((row) => filterRowTree(row, q))
        .filter((row): row is ExplorerRow => row !== null),
    }))
    .filter((sec) => sec.rows.length > 0);
}
