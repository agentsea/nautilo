import type {
  NotificationStateResponse,
  RoomNotificationChangedEvent,
} from "@nautilo/types";
import type { MobileNotificationStateLoadResult } from "@/lib/push-badge-reconciler";

const COMPACT_COUNT_MAX = 99;

function isCount(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

export interface MobileNotificationAttentionPresentation {
  readonly hasUnread: boolean;
  readonly importantText: string | null;
  readonly accessibilityLabel: string;
}

/** Matches Desktop's notificationAttentionPresentation semantics exactly. */
export function notificationAttentionPresentation(input: {
  unreadCount: number;
  importantUnreadCount: number;
  label: string;
}): MobileNotificationAttentionPresentation | null {
  const { unreadCount, importantUnreadCount, label } = input;
  if (!isCount(unreadCount) || !isCount(importantUnreadCount) || importantUnreadCount > unreadCount) {
    return null;
  }
  const importantText = importantUnreadCount > 0
    ? importantUnreadCount > COMPACT_COUNT_MAX ? `${COMPACT_COUNT_MAX}+` : String(importantUnreadCount)
    : null;
  return {
    hasUnread: unreadCount > 0,
    importantText,
    accessibilityLabel: `${label}: ${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"}, ${importantUnreadCount} important ${importantUnreadCount === 1 ? "message" : "messages"}`,
  };
}

export type NotificationStatePatchResult =
  | { readonly kind: "applied"; readonly snapshot: NotificationStateResponse }
  | { readonly kind: "dirty" };

export interface MobileAttentionServerSnapshot {
  readonly snapshot: NotificationStateResponse;
  readonly stale: boolean;
  /** Present only for active-server data, preventing a Human A → B bleed. */
  readonly viewerId?: string;
}

/** Fences asynchronous active-server reads to the currently verified Human. */
export function canApplyMobileNotificationRequest(input: {
  readonly requestGeneration: number;
  readonly currentGeneration: number;
  readonly requestIdentityKey: string | null;
  readonly currentIdentityKey: string | null;
}): boolean {
  return input.requestGeneration === input.currentGeneration
    && input.requestIdentityKey !== null
    && input.requestIdentityKey === input.currentIdentityKey;
}

export function applyMobileNotificationLoad(
  current: ReadonlyMap<string, MobileAttentionServerSnapshot>,
  serverId: string,
  result: MobileNotificationStateLoadResult,
  viewerId?: string,
): ReadonlyMap<string, MobileAttentionServerSnapshot> {
  const next = new Map(current);
  switch (result.kind) {
    case "fresh":
      next.set(serverId, { snapshot: result.snapshot, stale: false, ...(viewerId ? { viewerId } : {}) });
      break;
    case "unavailable": {
      const previous = next.get(serverId);
      if (previous) next.set(serverId, { ...previous, stale: true });
      break;
    }
    case "removed":
    case "signed_out":
      next.delete(serverId);
      break;
  }
  return next;
}

export function pruneMobileNotificationSnapshots(
  current: ReadonlyMap<string, MobileAttentionServerSnapshot>,
  registeredServerIds: ReadonlySet<string>,
  activeServerId: string | null,
  activeSignedIn: boolean,
): ReadonlyMap<string, MobileAttentionServerSnapshot> {
  const next = new Map(current);
  for (const serverId of next.keys()) {
    if (!registeredServerIds.has(serverId) || (serverId === activeServerId && !activeSignedIn)) next.delete(serverId);
  }
  return next;
}

export function applyMobileNotificationDelta(
  current: ReadonlyMap<string, MobileAttentionServerSnapshot>,
  serverId: string,
  event: RoomNotificationChangedEvent,
): { readonly kind: "applied"; readonly snapshots: ReadonlyMap<string, MobileAttentionServerSnapshot> } | { readonly kind: "dirty" } {
  const previous = current.get(serverId);
  const patched = applyNotificationStateChange(previous?.snapshot ?? null, event);
  if (patched.kind === "dirty") return patched;
  const next = new Map(current);
  next.set(serverId, { snapshot: patched.snapshot, stale: false, ...(previous?.viewerId ? { viewerId: previous.viewerId } : {}) });
  return { kind: "applied", snapshots: next };
}

/**
 * Apply an authoritative delta to the canonical snapshot. A top-level Room
 * remains the only aggregate, so a Subthread can never be counted twice.
 */
export function applyNotificationStateChange(
  snapshot: NotificationStateResponse | null,
  event: RoomNotificationChangedEvent,
): NotificationStatePatchResult {
  if (
    snapshot === null ||
    !isCount(event.roomOwnUnreadCount) ||
    !isCount(event.roomOwnImportantUnreadCount) ||
    !isCount(event.topLevelUnreadCount) ||
    !isCount(event.topLevelImportantUnreadCount) ||
    event.roomOwnImportantUnreadCount > event.roomOwnUnreadCount ||
    event.topLevelImportantUnreadCount > event.topLevelUnreadCount
  ) return { kind: "dirty" };

  const parentIndex = snapshot.rooms.findIndex((room) => room.roomId === event.topLevelRoomId);
  if (parentIndex < 0) return { kind: "dirty" };
  const previousParent = snapshot.rooms[parentIndex];
  const rooms = [...snapshot.rooms];
  const subthreads = [...snapshot.subthreads];

  if (event.roomId === event.topLevelRoomId) {
    if (event.topLevelUnreadCount < event.roomOwnUnreadCount || event.topLevelImportantUnreadCount < event.roomOwnImportantUnreadCount) {
      return { kind: "dirty" };
    }
    rooms[parentIndex] = {
      ...previousParent,
      ownUnreadCount: event.roomOwnUnreadCount,
      ownImportantUnreadCount: event.roomOwnImportantUnreadCount,
      subthreadUnreadCount: event.topLevelUnreadCount - event.roomOwnUnreadCount,
      subthreadImportantUnreadCount: event.topLevelImportantUnreadCount - event.roomOwnImportantUnreadCount,
      unreadCount: event.topLevelUnreadCount,
      importantUnreadCount: event.topLevelImportantUnreadCount,
    };
  } else {
    const childIndex = subthreads.findIndex((subthread) => subthread.roomId === event.roomId && subthread.parentRoomId === event.topLevelRoomId);
    if (
      childIndex < 0 ||
      event.topLevelUnreadCount < previousParent.ownUnreadCount ||
      event.topLevelImportantUnreadCount < previousParent.ownImportantUnreadCount
    ) return { kind: "dirty" };
    subthreads[childIndex] = {
      ...subthreads[childIndex],
      unreadCount: event.roomOwnUnreadCount,
      importantUnreadCount: event.roomOwnImportantUnreadCount,
    };
    rooms[parentIndex] = {
      ...previousParent,
      subthreadUnreadCount: event.topLevelUnreadCount - previousParent.ownUnreadCount,
      subthreadImportantUnreadCount: event.topLevelImportantUnreadCount - previousParent.ownImportantUnreadCount,
      unreadCount: event.topLevelUnreadCount,
      importantUnreadCount: event.topLevelImportantUnreadCount,
    };
  }

  const unreadCount = snapshot.totals.unreadCount - previousParent.unreadCount + event.topLevelUnreadCount;
  const importantUnreadCount = snapshot.totals.importantUnreadCount - previousParent.importantUnreadCount + event.topLevelImportantUnreadCount;
  if (!isCount(unreadCount) || !isCount(importantUnreadCount) || importantUnreadCount > unreadCount) return { kind: "dirty" };
  return { kind: "applied", snapshot: { ...snapshot, totals: { unreadCount, importantUnreadCount }, rooms, subthreads } };
}
