/**
 * Bounded, process-local exact-client binding state.
 *
 * This registry deliberately stores no Room, content, transcript, or durable
 * job input. A client session is only a socket-local routing identifier; it is
 * not authority and cannot be reconstructed after expiry/disconnect.
 */
import { randomUUID } from "node:crypto";
import type { ForegroundTurnCandidate } from "@nautilo/runtime";
import {
  CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE,
  CLIENT_ACTION_BINDING_TTL_MS,
  CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET,
  clientSessionEventV1Schema,
  parseInitiatingClientSurfaceV1,
} from "@nautilo/types";

type SocketLike = {
  on(event: "close", handler: () => void): unknown;
};

type ForegroundTurnCoalescingContext = NonNullable<
  ForegroundTurnCandidate["coalescingContext"]
>;

type Session = {
  socket: SocketLike;
  actorId: string;
  /** Opaque process-local identity; never expose the raw client session id to Job input. */
  coalescingContext: ForegroundTurnCoalescingContext;
  admissions: number[];
  handles: Set<string>;
};

type Entry = {
  handle: string;
  clientActionSessionId: string;
  actorId: string;
  expiresAt: number;
  state: "reserved" | "bound";
  turnId?: string;
};

export type ConsumedClientActionBinding = {
  socket: SocketLike;
  /** Non-authoritative closed session declaration; never a raw session identifier. */
  initiatingClientSurface: ForegroundTurnCoalescingContext["initiatingClientSurface"];
};

export type InspectedClientActionSession = Readonly<{
  /** Non-authoritative closed declaration; the caller still proves product authority. */
  initiatingClientSurface: ForegroundTurnCoalescingContext["initiatingClientSurface"];
}>;

export class ClientActionBindingRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly entries = new Map<string, Entry>();
  private readonly handlesByTurn = new Map<string, string>();
  private readonly handlesByGroupTurn = new Map<string, Set<string>>();
  private readonly armedHandlesByTurn = new Map<string, string>();
  // Consuming a one-shot UI action must not erase speech routing for that turn.
  // Retention shares the original admission TTL/rate bound and socket lifetime.
  private readonly consumedTurnRoutes = new Map<string, Pick<Entry, "clientActionSessionId" | "expiresAt">>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onDeleteClientSession: (clientActionSessionId: string) => void = () => {},
  ) {}

  registerLiveSession(args: {
    socket: SocketLike;
    clientActionSessionId: string;
    actorId: string;
    initiatingClientSurface?: unknown;
  }): boolean {
    if (!clientSessionEventV1Schema.safeParse({
      type: "client.session.v1",
      clientActionSessionId: args.clientActionSessionId,
    }).success) {
      return false;
    }
    this.prune();
    this.deleteSession(args.clientActionSessionId);
    const session: Session = {
      socket: args.socket,
      actorId: args.actorId,
      coalescingContext: {
        clientSessionToken: Symbol("client-action-session"),
        initiatingClientSurface: parseInitiatingClientSurfaceV1(args.initiatingClientSurface),
      },
      admissions: [],
      handles: new Set(),
    };
    this.sessions.set(args.clientActionSessionId, session);
    args.socket.on("close", () => this.deleteSession(args.clientActionSessionId));
    return true;
  }

  unregisterLiveSession(clientActionSessionId: string): void {
    this.deleteSession(clientActionSessionId);
  }

  /**
   * Inspect one still-live socket session without consuming an admission or
   * manufacturing a foreground-turn handle. This is only an exact-client
   * eligibility fact; it grants no Room, Human, or Agent authority.
   */
  inspectLiveSession(args: {
    clientActionSessionId: unknown;
    actorId: string;
  }): InspectedClientActionSession | null {
    this.prune();
    if (typeof args.clientActionSessionId !== "string") return null;
    const session = this.sessions.get(args.clientActionSessionId);
    if (!session || session.actorId !== args.actorId) return null;
    return Object.freeze({
      initiatingClientSurface: session.coalescingContext.initiatingClientSurface,
    });
  }

  reserve(args: {
    clientActionSessionId: unknown;
    actorId: string;
  }): string | null {
    this.prune();
    if (typeof args.clientActionSessionId !== "string") return null;
    const session = this.sessions.get(args.clientActionSessionId);
    if (!session || session.actorId !== args.actorId) return null;

    const now = this.now();
    session.admissions = session.admissions.filter(
      (admittedAt) => admittedAt > now - 60_000,
    );
    if (session.admissions.length >= CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE) return null;
    if (session.handles.size >= CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET) return null;

    const handle = randomUUID();
    session.admissions.push(now);
    session.handles.add(handle);
    this.entries.set(handle, {
      handle,
      clientActionSessionId: args.clientActionSessionId,
      actorId: args.actorId,
      expiresAt: now + CLIENT_ACTION_BINDING_TTL_MS,
      state: "reserved",
    });
    return handle;
  }

  createForegroundTurnCandidate(handle: string): ForegroundTurnCandidate {
    const entry = this.entries.get(handle);
    const session = entry ? this.sessions.get(entry.clientActionSessionId) : undefined;
    return {
      onMainTurn: (turnId) => this.armDirectTurn(handle, turnId),
      onIneligible: () => { this.cancel(handle); },
      ...(session ? { coalescingContext: session.coalescingContext } : {}),
    };
  }

  /** Read one reserved handle's private context without constructing lifecycle callbacks. */
  coalescingContextForHandle(handle: string): ForegroundTurnCoalescingContext | undefined {
    const entry = this.entries.get(handle);
    return entry ? this.sessions.get(entry.clientActionSessionId)?.coalescingContext : undefined;
  }

  holdGroupTurn(handle: string, humanTurnId: string): boolean {
    this.prune();
    const entry = this.entries.get(handle);
    if (!entry || entry.state !== "reserved") return false;
    const handles = this.handlesByGroupTurn.get(humanTurnId) ?? new Set<string>();
    handles.add(handle);
    this.handlesByGroupTurn.set(humanTurnId, handles);
    return true;
  }

  /** A normal group burst is eligible only when routing retained exactly one new Human turn. */
  resolveGroupTurns(coveredHumanTurnIds: readonly string[]): void {
    this.prune();
    if (coveredHumanTurnIds.length === 1) {
      const turnId = coveredHumanTurnIds[0];
      if (!turnId) return;
      for (const handle of this.handlesByGroupTurn.get(turnId) ?? []) {
        if (!this.bind(handle, turnId)) this.cancel(handle);
      }
      this.handlesByGroupTurn.delete(turnId);
      return;
    }
    for (const turnId of coveredHumanTurnIds) {
      for (const handle of this.handlesByGroupTurn.get(turnId) ?? []) this.cancel(handle);
      this.handlesByGroupTurn.delete(turnId);
    }
  }

  cancelGroupTurns(coveredHumanTurnIds: readonly string[]): void {
    this.prune();
    for (const turnId of coveredHumanTurnIds) {
      for (const handle of this.handlesByGroupTurn.get(turnId) ?? []) this.cancel(handle);
      this.handlesByGroupTurn.delete(turnId);
    }
  }

  onHumanPersistence(turnId: string, succeeded: boolean): void {
    this.prune();
    const handle = this.armedHandlesByTurn.get(turnId);
    if (!handle) return;
    this.armedHandlesByTurn.delete(turnId);
    if (succeeded) {
      if (!this.bind(handle, turnId)) this.cancel(handle);
    } else {
      this.cancel(handle);
    }
  }

  bind(handle: string, turnId: string): boolean {
    this.prune();
    const entry = this.entries.get(handle);
    if (!entry || entry.state !== "reserved" || this.handlesByTurn.has(turnId)) return false;
    entry.state = "bound";
    entry.turnId = turnId;
    this.handlesByTurn.set(turnId, handle);
    return true;
  }

  cancel(handle: string): boolean {
    const entry = this.entries.get(handle);
    if (!entry) return false;
    this.removeEntry(entry);
    return true;
  }

  /** Read the live initiating socket without consuming its UI-action binding. */
  inspectTurnSocket(turnId: string): SocketLike | null {
    this.prune();
    const handle = this.handlesByTurn.get(turnId);
    const entry = handle ? this.entries.get(handle) : undefined;
    const route = entry?.state === "bound" ? entry : this.consumedTurnRoutes.get(turnId);
    return route ? this.sessions.get(route.clientActionSessionId)?.socket ?? null : null;
  }

  consumeOnce(turnId: string): ConsumedClientActionBinding | null {
    this.prune();
    const handle = this.handlesByTurn.get(turnId);
    const entry = handle ? this.entries.get(handle) : undefined;
    const session = entry ? this.sessions.get(entry.clientActionSessionId) : undefined;
    if (!entry || entry.state !== "bound" || entry.turnId !== turnId || !session) return null;
    const consumed: ConsumedClientActionBinding = {
      socket: session.socket,
      initiatingClientSurface: session.coalescingContext.initiatingClientSurface,
    };
    this.consumedTurnRoutes.set(turnId, {
      clientActionSessionId: entry.clientActionSessionId,
      expiresAt: entry.expiresAt,
    });
    this.removeEntry(entry);
    return consumed;
  }

  /** Test-only bounded-state inspection; no Room/content or input data exists here. */
  size(): number {
    this.prune();
    return this.entries.size;
  }

  private armDirectTurn(handle: string, turnId: string): void {
    this.prune();
    const entry = this.entries.get(handle);
    if (!entry || entry.state !== "reserved" || !turnId || this.armedHandlesByTurn.has(turnId)) {
      this.cancel(handle);
      return;
    }
    this.armedHandlesByTurn.set(turnId, handle);
  }

  private prune(): void {
    const now = this.now();
    for (const [turnId, route] of this.consumedTurnRoutes) {
      if (route.expiresAt <= now) this.consumedTurnRoutes.delete(turnId);
    }
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) this.removeEntry(entry);
    }
    for (const session of this.sessions.values()) {
      session.admissions = session.admissions.filter((admittedAt) => admittedAt > now - 60_000);
    }
  }

  private deleteSession(clientActionSessionId: string): void {
    const session = this.sessions.get(clientActionSessionId);
    if (!session) return;
    for (const handle of [...session.handles]) this.cancel(handle);
    for (const [turnId, route] of this.consumedTurnRoutes) {
      if (route.clientActionSessionId === clientActionSessionId) this.consumedTurnRoutes.delete(turnId);
    }
    this.sessions.delete(clientActionSessionId);
    this.onDeleteClientSession(clientActionSessionId);
  }

  private removeEntry(entry: Entry): void {
    this.entries.delete(entry.handle);
    const session = this.sessions.get(entry.clientActionSessionId);
    session?.handles.delete(entry.handle);
    if (entry.turnId) this.handlesByTurn.delete(entry.turnId);
    for (const [turnId, handles] of this.handlesByGroupTurn) {
      handles.delete(entry.handle);
      if (handles.size === 0) this.handlesByGroupTurn.delete(turnId);
    }
    for (const [turnId, handle] of this.armedHandlesByTurn) {
      if (handle === entry.handle) this.armedHandlesByTurn.delete(turnId);
    }
  }
}

let installedRegistry: { token: symbol; registry: ClientActionBindingRegistry } | null = null;

export function installClientActionBindingRegistry(
  registry: ClientActionBindingRegistry,
): () => void {
  const token = Symbol("client-action-binding-registry");
  installedRegistry = { token, registry };
  return () => {
    if (installedRegistry?.token === token) installedRegistry = null;
  };
}

export function getClientActionBindingRegistry(): ClientActionBindingRegistry | null {
  return installedRegistry?.registry ?? null;
}
