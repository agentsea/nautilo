/**
 * D458 Wave 7 — ordered, viewer-scoped remote-host presence.
 *
 * Presence is process-local, so reconnect promises are intentionally bounded:
 * a controller receives a retained contiguous suffix for the same stream or a
 * fresh authoritative snapshot. A new process/user-cache epoch gets a new
 * stream id, making restart and LRU eviction explicit.
 */
import { randomUUID } from "node:crypto";
import type {
  RemoteHostConnectedEvent,
  RemoteHostDisconnectedEvent,
  RemoteHostProjection,
  RemoteHostResumeCursor,
  RemoteHostRevokedEvent,
  RemoteHostUpdatedEvent,
} from "@nautilo/types";

const REMOTE_HOST_PRESENCE_RING_LIMIT = 128;
const REMOTE_HOST_PRESENCE_RETENTION_MS = 10 * 60 * 1_000;
const REMOTE_HOST_PRESENCE_USER_CACHE_LIMIT = 256;

export type RemoteHostPresenceEvent =
  | RemoteHostConnectedEvent
  | RemoteHostUpdatedEvent
  | RemoteHostDisconnectedEvent
  | RemoteHostRevokedEvent;

/** Direct WS convergence frame. Its payload matches the REST snapshot exactly. */
export interface RemoteHostDirectSnapshot {
  type: "remote.host.snapshot";
  hosts: readonly RemoteHostProjection[];
  cursor: RemoteHostResumeCursor;
}

/** Shape consumed by the REST list route—no transport-only `type` field. */
export interface RemoteHostAuthoritativeSnapshot {
  hosts: readonly RemoteHostProjection[];
  cursor: RemoteHostResumeCursor;
}

export type RemoteHostPresenceFrame = RemoteHostPresenceEvent | RemoteHostDirectSnapshot;

export interface RemoteHostPresenceProjector {
  /** Must enforce caller ownership and exact live-registry truth. */
  projectForUser(userId: string): Promise<readonly RemoteHostProjection[]>;
  /**
   * Optional durable authority seam. Generation ids are consumed here and
   * never retained in the display cache or emitted to a client.
   */
  invalidatePairingGenerations?(args: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }): Promise<void>;
}

export interface RemoteHostPresenceResumePort {
  resumeForUser(
    userId: string,
    cursor: RemoteHostResumeCursor | null,
  ): Promise<readonly RemoteHostPresenceFrame[]>;
}

export interface RemoteHostPresenceStreamOptions {
  projector: RemoteHostPresenceProjector;
  publishToUser: (userId: string, event: RemoteHostPresenceEvent) => void;
  now?: () => number;
  /** Deterministic test seam. Production leaves this unset for a random epoch. */
  streamId?: string;
  ringLimit?: number;
  retentionMs?: number;
  userCacheLimit?: number;
}

type RetainedEvent = { at: number; event: RemoteHostPresenceEvent };
type UserState = {
  streamId: string;
  hosts: Map<string, RemoteHostProjection>;
  ring: RetainedEvent[];
  sequence: number;
  snapshotRevision: number;
  tail: Promise<void>;
  /** Includes both queued and currently executing work for this user. */
  activeOperations: number;
  lastTouchedAt: number;
};

type RemovalMode =
  | "offline"
  | "revoked"
  | { readonly revokedRemoteHostId: string };

/** Narrow reconstruction prevents hidden projector properties entering cache/wire. */
function cloneHost(host: RemoteHostProjection): RemoteHostProjection {
  return {
    remoteHostId: host.remoteHostId,
    label: host.label,
    connected: host.connected,
    readiness: host.readiness,
    lastSeenAt: host.lastSeenAt,
  };
}

function validHost(host: RemoteHostProjection): boolean {
  return (
    typeof host.remoteHostId === "string" &&
    host.remoteHostId.length > 0 &&
    host.remoteHostId.length <= 200 &&
    (host.label === null || (typeof host.label === "string" && host.label.length <= 500)) &&
    typeof host.connected === "boolean" &&
    (host.lastSeenAt === null || typeof host.lastSeenAt === "string")
  );
}

function sameHost(left: RemoteHostProjection, right: RemoteHostProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class RemoteHostPresenceStream implements RemoteHostPresenceResumePort {
  private readonly states = new Map<string, UserState>();
  private readonly now: () => number;
  private readonly ringLimit: number;
  private readonly retentionMs: number;
  private readonly userCacheLimit: number;

  constructor(private readonly options: RemoteHostPresenceStreamOptions) {
    this.now = options.now ?? Date.now;
    this.ringLimit = options.ringLimit ?? REMOTE_HOST_PRESENCE_RING_LIMIT;
    this.retentionMs = options.retentionMs ?? REMOTE_HOST_PRESENCE_RETENTION_MS;
    this.userCacheLimit = options.userCacheLimit ?? REMOTE_HOST_PRESENCE_USER_CACHE_LIMIT;
  }

  reconcileUser(userId: string): Promise<readonly RemoteHostPresenceEvent[]> {
    return this.enqueue(userId, async (state) => {
      const next = await this.projectNext(userId);
      return this.commitProjection(userId, state, next, "offline");
    });
  }

  /**
   * Reconcile one explicit controller-binding revocation. Only that exact
   * display id gets a revoked terminal event; unrelated concurrent removals
   * remain ordinary offline transitions.
   */
  revokeRemoteHost(args: {
    userId: string;
    remoteHostId: string;
  }): Promise<readonly RemoteHostPresenceEvent[]> {
    return this.enqueue(args.userId, async (state) => {
      const next = await this.projectNext(args.userId);
      return this.commitProjection(args.userId, state, next, {
        revokedRemoteHostId: args.remoteHostId,
      });
    });
  }

  invalidatePairingGenerations(args: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }): Promise<readonly RemoteHostPresenceEvent[]> {
    return this.enqueue(args.userId, async (state) => {
      await this.options.projector.invalidatePairingGenerations?.(args);
      const next = await this.projectNext(args.userId);
      return this.commitProjection(args.userId, state, next, "revoked");
    });
  }

  /**
   * Fresh authoritative projection plus real stream cursor for the REST route.
   * Any changed projection is committed before the returned snapshot is read.
   */
  authoritativeSnapshotForUser(userId: string): Promise<RemoteHostAuthoritativeSnapshot> {
    return this.enqueue(userId, async (state) => {
      const next = await this.projectNext(userId);
      this.commitProjection(userId, state, next, "offline");
      return this.authoritativeSnapshot(state);
    });
  }

  async resumeForUser(
    userId: string,
    cursor: RemoteHostResumeCursor | null,
  ): Promise<readonly RemoteHostPresenceFrame[]> {
    return this.enqueue(userId, async (state) => {
      this.pruneRing(state);
      if (
        cursor !== null &&
        cursor.streamId === state.streamId &&
        Number.isSafeInteger(cursor.sequence) &&
        cursor.sequence >= 0 &&
        cursor.sequence <= state.sequence &&
        Number.isSafeInteger(cursor.snapshotRevision) &&
        cursor.snapshotRevision >= 0 &&
        cursor.snapshotRevision <= state.snapshotRevision
      ) {
        if (
          cursor.sequence === state.sequence &&
          cursor.snapshotRevision === state.snapshotRevision
        ) {
          return [];
        }
        const later = state.ring.filter((entry) => entry.event.sequence > cursor.sequence);
        if (
          later.length > 0 &&
          later[0]!.event.sequence === cursor.sequence + 1 &&
          later[later.length - 1]!.event.sequence === state.sequence
        ) {
          return later.map((entry) => entry.event);
        }
      }

      const next = await this.projectNext(userId);
      this.commitProjection(userId, state, next, "offline");
      return [this.directSnapshot(state)];
    });
  }

  private enqueue<T>(userId: string, work: (state: UserState) => Promise<T>): Promise<T> {
    const state = this.getState(userId);
    // Touch and mark active before joining the promise tail. A queued caller
    // must protect this epoch from LRU eviction just like an executing caller.
    state.activeOperations += 1;
    state.lastTouchedAt = this.now();
    const run = state.tail.then(async () => {
      try {
        return await work(state);
      } finally {
        state.activeOperations -= 1;
        state.lastTouchedAt = this.now();
        this.trimIdleStates();
      }
    });
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private getState(userId: string): UserState {
    const known = this.states.get(userId);
    if (known) return known;
    if (this.states.size >= this.userCacheLimit) {
      this.evictOldestIdleState();
    }
    const created: UserState = {
      streamId: this.options.streamId ?? randomUUID(),
      hosts: new Map(),
      ring: [],
      sequence: 0,
      snapshotRevision: 0,
      tail: Promise.resolve(),
      activeOperations: 0,
      lastTouchedAt: this.now(),
    };
    this.states.set(userId, created);
    return created;
  }

  private trimIdleStates(): void {
    while (this.states.size > this.userCacheLimit) {
      if (!this.evictOldestIdleState()) return;
    }
  }

  /**
   * Never evict queued/in-flight state. If every epoch is active the cache may
   * temporarily exceed its nominal bound and is trimmed when work settles.
   */
  private evictOldestIdleState(): boolean {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, candidate] of this.states) {
      if (candidate.activeOperations !== 0) continue;
      if (candidate.lastTouchedAt < oldestAt) {
        oldestAt = candidate.lastTouchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return false;
    this.states.delete(oldestKey);
    return true;
  }

  private async projectNext(userId: string): Promise<Map<string, RemoteHostProjection>> {
    const projected = await this.options.projector.projectForUser(userId);
    const next = new Map<string, RemoteHostProjection>();
    for (const candidate of projected) {
      if (!validHost(candidate) || next.has(candidate.remoteHostId)) continue;
      next.set(candidate.remoteHostId, cloneHost(candidate));
    }
    return next;
  }

  private commitProjection(
    userId: string,
    state: UserState,
    next: Map<string, RemoteHostProjection>,
    removalMode: RemovalMode,
  ): RemoteHostPresenceEvent[] {
    const changed = [...new Set([...state.hosts.keys(), ...next.keys()])]
      .sort()
      .filter((id) => {
        const previous = state.hosts.get(id);
        const current = next.get(id);
        return previous === undefined || current === undefined || !sameHost(previous, current);
      });
    if (changed.length === 0) return [];

    state.snapshotRevision += 1;
    const emitted: RemoteHostPresenceEvent[] = [];
    for (const remoteHostId of changed) {
      const previous = state.hosts.get(remoteHostId);
      const current = next.get(remoteHostId);
      if (!current) {
        const revoked =
          removalMode === "revoked" ||
          (typeof removalMode === "object" &&
            removalMode.revokedRemoteHostId === remoteHostId);
        emitted.push(
          revoked
            ? this.emitTerminal(userId, state, "remote.host.revoked", remoteHostId, "revoked")
            : this.emitTerminal(userId, state, "remote.host.disconnected", remoteHostId, "offline"),
        );
        continue;
      }
      if (previous?.connected === true && current.connected === false) {
        const terminalReason =
          current.readiness === "identity_conflict" ? "identity_conflict" : "offline";
        emitted.push(
          this.emitTerminal(
            userId,
            state,
            "remote.host.disconnected",
            remoteHostId,
            terminalReason,
          ),
        );
        continue;
      }
      const type =
        current.connected && previous?.connected !== true
          ? "remote.host.connected"
          : "remote.host.updated";
      emitted.push(this.emitHost(userId, state, type, current));
    }
    state.hosts = next;
    return emitted;
  }

  private eventBase(state: UserState, remoteHostId: string) {
    const sequence = ++state.sequence;
    return {
      eventId: `${state.streamId}:${sequence}`,
      remoteHostId,
      streamId: state.streamId,
      sequence,
      snapshotRevision: state.snapshotRevision,
    };
  }

  private emitHost(
    userId: string,
    state: UserState,
    type: "remote.host.connected" | "remote.host.updated",
    host: RemoteHostProjection,
  ): RemoteHostConnectedEvent | RemoteHostUpdatedEvent {
    const event =
      type === "remote.host.connected"
        ? ({ type, ...this.eventBase(state, host.remoteHostId), host: cloneHost(host) } satisfies RemoteHostConnectedEvent)
        : ({ type, ...this.eventBase(state, host.remoteHostId), host: cloneHost(host) } satisfies RemoteHostUpdatedEvent);
    this.retainAndPublish(userId, state, event);
    return event;
  }

  private emitTerminal(
    userId: string,
    state: UserState,
    type: "remote.host.disconnected" | "remote.host.revoked",
    remoteHostId: string,
    reason: "offline" | "identity_conflict" | "revoked",
  ): RemoteHostDisconnectedEvent | RemoteHostRevokedEvent {
    const event =
      type === "remote.host.revoked"
        ? ({
            type,
            ...this.eventBase(state, remoteHostId),
            terminalReason: "revoked",
          } satisfies RemoteHostRevokedEvent)
        : ({
            type,
            ...this.eventBase(state, remoteHostId),
            terminalReason: reason === "identity_conflict" ? reason : "offline",
          } satisfies RemoteHostDisconnectedEvent);
    this.retainAndPublish(userId, state, event);
    return event;
  }

  private retainAndPublish(
    userId: string,
    state: UserState,
    event: RemoteHostPresenceEvent,
  ): void {
    state.ring.push({ at: this.now(), event });
    this.pruneRing(state);
    this.options.publishToUser(userId, event);
  }

  private cursor(state: UserState): RemoteHostResumeCursor {
    return {
      streamId: state.streamId,
      sequence: state.sequence,
      snapshotRevision: state.snapshotRevision,
    };
  }

  private authoritativeSnapshot(state: UserState): RemoteHostAuthoritativeSnapshot {
    return {
      hosts: [...state.hosts.values()]
        .sort((a, b) => a.remoteHostId.localeCompare(b.remoteHostId))
        .map(cloneHost),
      cursor: this.cursor(state),
    };
  }

  private directSnapshot(state: UserState): RemoteHostDirectSnapshot {
    return { type: "remote.host.snapshot", ...this.authoritativeSnapshot(state) };
  }

  private pruneRing(state: UserState): void {
    const cutoff = this.now() - this.retentionMs;
    while (state.ring.length > 0 && state.ring[0]!.at < cutoff) state.ring.shift();
    while (state.ring.length > this.ringLimit) state.ring.shift();
  }
}
