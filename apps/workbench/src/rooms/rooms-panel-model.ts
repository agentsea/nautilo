import type { JobStatusEvent, ViewerRole } from "@nautilo/types";
import type { WorkbenchRoomSummary } from "./room-navigation-types";

/** D163 — bounded dedupe + optimistic deltas for sidebar message counts (WS-driven). */
const JOB_ID_RING_CAP = 128;

function ringRemember(ring: string[], set: Set<string>, jobId: string): boolean {
  if (set.has(jobId)) return false;
  set.add(jobId);
  ring.push(jobId);
  while (ring.length > JOB_ID_RING_CAP) {
    const evicted = ring.shift();
    if (evicted !== undefined) set.delete(evicted);
  }
  return true;
}

const dispatchedJobIds: string[] = [];
const dispatchedJobIdSet = new Set<string>();
const agentCompletedJobIds: string[] = [];
const agentCompletedJobIdSet = new Set<string>();
const terminalRefetchJobIds: string[] = [];
const terminalRefetchJobIdSet = new Set<string>();
const optimisticMessageDeltaByRoomId = new Map<string, number>();

function bumpOptimisticMessageDelta(roomId: string, delta: number): void {
  if (!roomId || delta === 0) return;
  const next = (optimisticMessageDeltaByRoomId.get(roomId) ?? 0) + delta;
  if (next === 0) {
    optimisticMessageDeltaByRoomId.delete(roomId);
  } else {
    optimisticMessageDeltaByRoomId.set(roomId, next);
  }
}

function getOptimisticMessageDelta(roomId: string | undefined): number {
  if (!roomId) return 0;
  return optimisticMessageDeltaByRoomId.get(roomId) ?? 0;
}

/**
 * Clears optimistic message-count overlays (call after rooms-list refetch; server wins).
 */
export function clearRoomPanelMessageCountOptimisticOverlay(): void {
  optimisticMessageDeltaByRoomId.clear();
}

/**
 * Test-only reset: clears overlays and WS dedupe rings.
 */
export function resetRoomPanelMessageCountSyncStateForTests(): void {
  optimisticMessageDeltaByRoomId.clear();
  dispatchedJobIds.length = 0;
  dispatchedJobIdSet.clear();
  agentCompletedJobIds.length = 0;
  agentCompletedJobIdSet.clear();
  terminalRefetchJobIds.length = 0;
  terminalRefetchJobIdSet.clear();
}

export type RoomPanelJobStatusOutcome = {
  /** True when sidebar optimistic counters changed (caller may tick React). */
  didMutateOptimistic: boolean;
  /** True once per job when a terminal `job.status` arrives — caller should refetch rooms. */
  shouldRefetchRooms: boolean;
};

function isTerminalJobStatus(status: JobStatusEvent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

/**
 * D163 — `job.dispatched`: count the user message entering the queue (+1 per jobId).
 */
export function handleRoomPanelJobDispatched(opts: {
  jobId: string;
  roomId: string | null;
}): boolean {
  if (!opts.roomId) return false;
  if (!ringRemember(dispatchedJobIds, dispatchedJobIdSet, opts.jobId)) return false;
  bumpOptimisticMessageDelta(opts.roomId, 1);
  return true;
}

/**
 * D163 — `job.status`: first `completed` for a jobId counts the agent reply (+1).
 * First terminal status per jobId triggers a rooms-list refetch (reconcile with server).
 */
export function handleRoomPanelJobStatus(opts: {
  jobId: string;
  roomId: string | null;
  status: JobStatusEvent["status"];
}): RoomPanelJobStatusOutcome {
  let didMutateOptimistic = false;
  if (opts.roomId && opts.status === "completed") {
    if (ringRemember(agentCompletedJobIds, agentCompletedJobIdSet, opts.jobId)) {
      bumpOptimisticMessageDelta(opts.roomId, 1);
      didMutateOptimistic = true;
    }
  }
  const shouldRefetchRooms =
    isTerminalJobStatus(opts.status) &&
    ringRemember(terminalRefetchJobIds, terminalRefetchJobIdSet, opts.jobId);
  return { didMutateOptimistic, shouldRefetchRooms };
}

/** Default cap for open (unpinned) rooms in the compact panel when search is empty. */
export const ROOM_PANEL_CAP_RECENT = 8;

/** Default cap for closed-tab rows when search is empty. */
export const ROOM_PANEL_CAP_CLOSED = 5;

/**
 * Case-insensitive match on server Room label (after trim).
 */
export function filterRoomsByQuery(
  rooms: readonly WorkbenchRoomSummary[],
  rawQuery: string,
): WorkbenchRoomSummary[] {
  const q = rawQuery.trim().toLowerCase();
  const filtered = q
    ? rooms.filter((r) => r.label.toLowerCase().includes(q))
    : [...rooms];
  return sortRoomsForPanel(filtered);
}

function dateMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function roomPanelActivityMs(room: WorkbenchRoomSummary): number {
  return dateMs(room.lastMessageAt) || dateMs(room.createdAt);
}

function sortRoomsForPanel(
  rooms: readonly WorkbenchRoomSummary[],
): WorkbenchRoomSummary[] {
  return [...rooms].sort((a, b) => {
    const activityDelta = roomPanelActivityMs(b) - roomPanelActivityMs(a);
    if (activityDelta !== 0) return activityDelta;
    return a.label.localeCompare(b.label);
  });
}

export type RoomsPanelSections = {
  pinned: WorkbenchRoomSummary[];
  recent: WorkbenchRoomSummary[];
  closed: WorkbenchRoomSummary[];
  /** Rooms not shown in the compact default view (use search). */
  olderHiddenCount: number;
};

/**
 * When `queryTrimmed` is non-empty, every matching room is listed in sections.
 * When empty, recent + closed tabs are capped; older rooms stay discoverable via search.
 */
export function partitionRoomsForPanel(
  filteredSorted: readonly WorkbenchRoomSummary[],
  queryTrimmed: string,
): RoomsPanelSections {
  const hasQuery = queryTrimmed.length > 0;

  if (hasQuery) {
    const pinned = filteredSorted.filter((r) => r.pinned);
    const rest = filteredSorted.filter((r) => !r.pinned);
    const recent = rest.filter((r) => !r.closedTab);
    const closed = rest.filter((r) => r.closedTab);
    return { pinned, recent, closed, olderHiddenCount: 0 };
  }

  const pinned = filteredSorted.filter((r) => r.pinned);
  const unpinnedOpen = filteredSorted.filter((r) => !r.pinned && !r.closedTab);
  const recent = unpinnedOpen.slice(0, ROOM_PANEL_CAP_RECENT);

  const closed = filteredSorted.filter((r) => r.closedTab).slice(0, ROOM_PANEL_CAP_CLOSED);

  const shown = new Set<string>([
    ...pinned.map((r) => r.id),
    ...recent.map((r) => r.id),
    ...closed.map((r) => r.id),
  ]);
  const olderHiddenCount = filteredSorted.filter((r) => !shown.has(r.id)).length;

  return { pinned, recent, closed, olderHiddenCount };
}

export function roomPanelContextLine(opts: {
  roomType: string;
  viewerRole: ViewerRole;
  viewerLabel: string;
  agentName: string;
}): string {
  const human = opts.viewerRole === "owner" ? "Owner" : opts.viewerLabel;
  if (opts.roomType === "private") {
    return `${human} / ${opts.agentName}`;
  }
  return `${human} · ${opts.roomType}`;
}

function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatShortDate(raw: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(raw));
}

function relativeAge(raw: string, nowMs: number): string {
  const ms = dateMs(raw);
  if (ms <= 0) return "";
  const diffMs = Math.max(0, nowMs - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

export function roomPanelActivityLine(
  room: Pick<WorkbenchRoomSummary, "messageCount" | "lastMessageAt" | "createdAt"> & {
    id?: string;
  },
  nowMs: number = Date.now(),
): string {
  const base = room.messageCount ?? 0;
  const messageCount = base + getOptimisticMessageDelta(room.id);
  const messageCopy = `${formatCount(messageCount)} message${messageCount === 1 ? "" : "s"}`;
  if (room.lastMessageAt) {
    return `${messageCopy} · last ${relativeAge(room.lastMessageAt, nowMs)}`;
  }
  return `${messageCopy} · created ${formatShortDate(room.createdAt)}`;
}
