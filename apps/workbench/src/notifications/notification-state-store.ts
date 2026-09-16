import type {
  NotificationStateResponse,
  RoomNotificationChangedEvent,
} from "@nautilo/types";

export type NotificationStatePatchResult =
  | { kind: "applied"; snapshot: NotificationStateResponse }
  | { kind: "dirty" };

function isCount(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

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
  ) {
    return { kind: "dirty" };
  }
  const parentIndex = snapshot.rooms.findIndex(
    (room) => room.roomId === event.topLevelRoomId,
  );
  if (parentIndex < 0) return { kind: "dirty" };
  const oldParent = snapshot.rooms[parentIndex];
  const rooms = [...snapshot.rooms];
  const subthreads = [...snapshot.subthreads];

  if (event.roomId === event.topLevelRoomId) {
    if (
      event.topLevelUnreadCount < event.roomOwnUnreadCount ||
      event.topLevelImportantUnreadCount <
        event.roomOwnImportantUnreadCount
    ) {
      return { kind: "dirty" };
    }
    rooms[parentIndex] = {
      ...oldParent,
      ownUnreadCount: event.roomOwnUnreadCount,
      ownImportantUnreadCount: event.roomOwnImportantUnreadCount,
      subthreadUnreadCount:
        event.topLevelUnreadCount - event.roomOwnUnreadCount,
      subthreadImportantUnreadCount:
        event.topLevelImportantUnreadCount -
        event.roomOwnImportantUnreadCount,
      unreadCount: event.topLevelUnreadCount,
      importantUnreadCount: event.topLevelImportantUnreadCount,
    };
  } else {
    if (
      event.topLevelUnreadCount < oldParent.ownUnreadCount ||
      event.topLevelImportantUnreadCount <
        oldParent.ownImportantUnreadCount
    ) {
      return { kind: "dirty" };
    }
    const childIndex = subthreads.findIndex(
      (subthread) =>
        subthread.roomId === event.roomId &&
        subthread.parentRoomId === event.topLevelRoomId,
    );
    if (childIndex < 0) return { kind: "dirty" };
    subthreads[childIndex] = {
      ...subthreads[childIndex],
      unreadCount: event.roomOwnUnreadCount,
      importantUnreadCount: event.roomOwnImportantUnreadCount,
    };
    rooms[parentIndex] = {
      ...oldParent,
      subthreadUnreadCount:
        event.topLevelUnreadCount - oldParent.ownUnreadCount,
      subthreadImportantUnreadCount:
        event.topLevelImportantUnreadCount -
        oldParent.ownImportantUnreadCount,
      unreadCount: event.topLevelUnreadCount,
      importantUnreadCount: event.topLevelImportantUnreadCount,
    };
  }

  return {
    kind: "applied",
    snapshot: {
      ...snapshot,
      totals: {
        unreadCount:
          snapshot.totals.unreadCount -
          oldParent.unreadCount +
          event.topLevelUnreadCount,
        importantUnreadCount:
          snapshot.totals.importantUnreadCount -
          oldParent.importantUnreadCount +
          event.topLevelImportantUnreadCount,
      },
      rooms,
      subthreads,
    },
  };
}

export interface NotificationRefreshCoordinator {
  request(): Promise<NotificationStateResponse | null>;
  reset(sessionKey: string): void;
  dispose(): void;
}

export function createNotificationRefreshCoordinator(input: {
  fetchState: () => Promise<NotificationStateResponse>;
  onApply: (snapshot: NotificationStateResponse, generation: number) => void;
  onError: (error: unknown) => void;
  onRefreshing: (refreshing: boolean) => void;
}): NotificationRefreshCoordinator {
  let generation = 0;
  let sessionKey = "";
  let inFlight = false;
  let pending = false;
  let disposed = false;
  let latestResult: NotificationStateResponse | null = null;
  let waiters: Array<
    (snapshot: NotificationStateResponse | null) => void
  > = [];

  const start = (): void => {
    if (disposed) return;
    const requestGeneration = ++generation;
    const requestSessionKey = sessionKey;
    latestResult = null;
    inFlight = true;
    input.onRefreshing(true);
    void input.fetchState().then(
      (snapshot) => {
        if (
          !disposed &&
          requestGeneration === generation &&
          requestSessionKey === sessionKey
        ) {
          latestResult = snapshot;
          input.onApply(snapshot, requestGeneration);
        }
      },
      (error) => {
        if (
          !disposed &&
          requestGeneration === generation &&
          requestSessionKey === sessionKey
        ) {
          latestResult = null;
          input.onError(error);
        }
      },
    ).finally(() => {
      if (disposed) return;
      inFlight = false;
      input.onRefreshing(false);
      if (pending) {
        pending = false;
        start();
        return;
      }
      const settled = waiters;
      waiters = [];
      for (const resolve of settled) resolve(latestResult);
    });
  };

  return {
    request() {
      if (disposed) return Promise.resolve(null);
      const result = new Promise<NotificationStateResponse | null>(
        (resolve) => {
          waiters.push(resolve);
        },
      );
      if (inFlight) {
        // Supersede the older response and coalesce all queued callers into
        // one follow-up reconciliation.
        generation += 1;
        pending = true;
      } else {
        start();
      }
      return result;
    },
    reset(nextSessionKey: string) {
      generation += 1;
      pending = false;
      sessionKey = nextSessionKey;
      latestResult = null;
      const cancelled = waiters;
      waiters = [];
      for (const resolve of cancelled) resolve(null);
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending = false;
      latestResult = null;
      const cancelled = waiters;
      waiters = [];
      for (const resolve of cancelled) resolve(null);
    },
  };
}
