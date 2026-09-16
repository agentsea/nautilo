import type {
  RemoteHost,
  RemoteHostPresenceEvent,
  RemoteHostResumeCursor,
  RemoteHostSnapshotEvent,
  RemoteHostSnapshotResponse,
} from "@nautilo/api-client/browser";

const SEEN_EVENT_LIMIT = 256;

export interface RemoteHostState {
  readonly serverId: string;
  readonly hosts: readonly RemoteHost[];
  readonly cursor: RemoteHostResumeCursor | null;
  readonly needsResume: boolean;
  readonly seenEventIds: readonly string[];
}

export type RemoteHostAction =
  | {
      type: "snapshot";
      serverId: string;
      snapshot: RemoteHostSnapshotResponse;
    }
  | {
      type: "event";
      serverId: string;
      event: RemoteHostPresenceEvent | RemoteHostSnapshotEvent;
      /** Advance the owner-wide stream cursor without projecting another phone's host. */
      includeHost?: boolean;
    };

export function createRemoteHostState(serverId: string): RemoteHostState {
  return {
    serverId,
    hosts: [],
    cursor: null,
    needsResume: false,
    seenEventIds: [],
  };
}

export function reduceRemoteHostState(
  state: RemoteHostState,
  action: RemoteHostAction,
): RemoteHostState {
  if (action.serverId !== state.serverId) return state;
  if (action.type === "snapshot") {
    return applySnapshot(state, action.snapshot);
  }
  if (action.event.type === "remote.host.snapshot") {
    return applySnapshot(state, action.event);
  }
  return applyPresenceEvent(state, action.event, action.includeHost ?? true);
}

function applySnapshot(
  state: RemoteHostState,
  snapshot: RemoteHostSnapshotResponse,
): RemoteHostState {
  if (
    state.cursor !== null &&
    snapshot.cursor.streamId === state.cursor.streamId &&
    (snapshot.cursor.sequence < state.cursor.sequence ||
      snapshot.cursor.snapshotRevision < state.cursor.snapshotRevision)
  ) {
    return state;
  }
  return {
    ...state,
    hosts: sortHosts(snapshot.hosts),
    cursor: { ...snapshot.cursor },
    needsResume: false,
    seenEventIds:
      state.cursor?.streamId === snapshot.cursor.streamId
        ? state.seenEventIds
        : [],
  };
}

function applyPresenceEvent(
  state: RemoteHostState,
  event: RemoteHostPresenceEvent,
  includeHost: boolean,
): RemoteHostState {
  if (state.seenEventIds.includes(event.eventId)) return state;
  const cursor = state.cursor;
  if (
    cursor === null ||
    cursor.streamId !== event.streamId ||
    state.needsResume
  ) {
    return { ...state, needsResume: true };
  }
  if (event.sequence <= cursor.sequence) return state;
  if (
    event.sequence !== cursor.sequence + 1 ||
    event.snapshotRevision < cursor.snapshotRevision
  ) {
    return { ...state, needsResume: true };
  }

  const byId = new Map(
    state.hosts.map((host) => [host.remoteHostId, host] as const),
  );
  if (!includeHost) {
    // Presence is sequenced per Human, while this projection is per phone.
    // Ignored relationships still advance the shared cursor to avoid a false gap.
  } else if (
    event.type === "remote.host.connected" ||
    event.type === "remote.host.updated"
  ) {
    byId.set(event.remoteHostId, event.host);
  } else if (event.type === "remote.host.revoked") {
    // Revocation removes the host projection entirely; a stale controller may never
    // remain actionable after its authority has been revoked.
    byId.delete(event.remoteHostId);
  } else {
    const previous = byId.get(event.remoteHostId);
    if (previous) {
      byId.set(event.remoteHostId, {
        ...previous,
        connected: false,
        readiness:
          event.terminalReason === "identity_conflict"
            ? "identity_conflict"
            : "offline",
      });
    }
  }

  return {
    ...state,
    hosts: sortHosts([...byId.values()]),
    cursor: {
      streamId: event.streamId,
      sequence: event.sequence,
      snapshotRevision: event.snapshotRevision,
    },
    needsResume: false,
    seenEventIds: [...state.seenEventIds, event.eventId].slice(
      -SEEN_EVENT_LIMIT,
    ),
  };
}

function sortHosts(hosts: readonly RemoteHost[]): RemoteHost[] {
  return [...hosts].sort(
    (left, right) =>
      (left.label ?? "").localeCompare(right.label ?? "") ||
      left.remoteHostId.localeCompare(right.remoteHostId),
  );
}
