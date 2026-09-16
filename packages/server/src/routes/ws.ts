/**
 * M058 — `/ws` first-message authentication.
 *
 * The Fastify trust preHandler runs on HTTP route handlers, not on
 * WebSocket upgrades, so the `/ws` route would otherwise accept
 * anonymous connections and add them to the broadcast set BEFORE
 * any auth check. This module fixes both halves of that hole:
 *
 *   1. The socket lands in the `awaiting-auth` state. A 3-second
 *      timer (configurable via `NAUTILO_WS_AUTH_TIMEOUT_MS`) closes
 *      the connection if the client doesn't send `{type:"auth",
 *      token}` first.
 *   2. `addClient(socket)` — which adds the socket to the
 *      `ws-publisher` broadcast set — runs only after successful bearer
 *      validation and `listRoomsForActor` (M075 room scope). The server
 *      sends `auth.accepted` immediately after `addClient` on the same
 *      tick so the client never observes bus events before subscription
 *      registration (integration tests race on this otherwise).
 *      Pre-auth sockets are never added and receive zero broadcast events.
 *
 * Bearer validation reuses the M058 `resolveBearer` closure, which
 * the HTTP trust preHandler also consumes — one shared Logto JWT
 * verification path for HTTP and WebSocket upgrades.
 *
 * The resolved `RuntimePolicyContext` is attached to the socket
 * out-of-band via a route-local WeakMap so we don't pollute the
 * `WebSocket` prototype. Future per-event broadcast filtering
 * (M042D-adjacent) will read it via `getWsPolicyContext(socket)`.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket, RawData } from "ws";
import { randomBytes } from "node:crypto";
import { warn } from "@nautilo/logger";
import {
  parseInitiatingClientSurfaceV1,
  type MaintenanceStatusEvent,
  type RemoteHostResumeCursor,
} from "@nautilo/types";
import type { RuntimePolicyContext } from "@nautilo/trust";
import { listRoomsForActor as defaultListRoomsForActor } from "@nautilo/trust";
import { addClient, publishTypingPing, type WsClientMeta } from "../realtime/ws-publisher";
import { getClientActionBindingRegistry } from "../realtime/client-action-binding-registry";
import { getTtsService } from "../realtime/tts-service";
import type { ResolveBearer } from "../auth/resolve-bearer";
import {
  bearerResolutionDigest,
  isResolveBearerPolicyOk,
} from "../auth/resolve-bearer";
import type { RemoteHostPresenceResumePort } from "../remote-control/host-presence-stream";

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

/** Default 3 s. Configurable via env so operators can loosen it on
 *  slow networks without code change. */
function resolveAuthTimeoutMs(): number {
  const raw = process.env["NAUTILO_WS_AUTH_TIMEOUT_MS"];
  if (!raw) return 3_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3_000;
}

/** WS close code reserved for token-auth failures.
 *
 * 4401 lives in the WS private close-code range (4000–4999) and
 * borrows the HTTP 401 convention. M056 uses the same code on the
 * `/relay` socket so the cluster has one auth-failure signal across
 * both WS surfaces. */
export const WS_AUTH_CLOSE_CODE = 4401;

/** Per-connection policy context attached out-of-band. WeakMap so
 *  the entry GCs when the socket does — no manual cleanup needed
 *  beyond the explicit `delete` in `socket.on("close")` for
 *  predictability. */
const wsPolicyContexts = new WeakMap<WebSocket, RuntimePolicyContext>();

/**
 * Read the per-socket policy context attached during the M058 auth
 * handshake. Returns `undefined` when called before
 * `auth.accepted`, on an unauthenticated socket, or after the
 * socket has closed. Future per-event broadcast filtering will read
 * this; today it's exported solely for that consumer.
 */
export function getWsPolicyContext(
  socket: WebSocket,
): RuntimePolicyContext | undefined {
  return wsPolicyContexts.get(socket);
}

export interface WsRoutesDeps {
  /** Built once at boot inside `createApp`; shared with the HTTP
   *  preHandler so HTTP and WS auth paths can never drift. */
  resolveBearer: ResolveBearer;
  checkDeviceAdmission?: (input: Readonly<{
    credentialDigestBase64url: string;
    userId: string;
    humanActorId: string;
  }>) => Promise<Readonly<{
    status: "admitted" | "required";
    reason?: string;
  }>>;
  /** Periodic current-device revalidation for already-open sockets. */
  deviceAdmissionRecheckMs?: number;
  /**
   * D420 (Wave 3 task 3.2.1) — best-effort provider that returns the current
   * `maintenance.status` snapshot to send on authenticated connect, or null
   * to skip the frame. Optional: unit tests of the auth state machine omit it
   * (no snapshot sent); production wires a closure over the maintenance
   * controller. Must never throw — a fetch failure returns null so the WS
   * connection is admitted truthfully without a poisoned snapshot.
   */
  getMaintenanceStatusEvent?: () => Promise<MaintenanceStatusEvent | null>;
  /**
   * D458 Wave 7 — optional controller-presence resume port.  App wiring owns
   * the authoritative projector; this transport layer merely sends the
   * already viewer-scoped snapshot/replay to the authenticated socket.
   */
  remoteHostPresenceStream?: RemoteHostPresenceResumePort;
}

/**
 * Test seam: lets unit tests inject a side-effect spy / fake without
 * pulling in the real `ws-publisher` module + its global Set state.
 * Production callers leave this null and the real `addClient` from
 * `realtime/ws-publisher` is used.
 */
export interface WsRoutesTestHooks {
  /** Spy / replacement for `addClient`. Called after successful auth
   *  and room list load, immediately before `auth.accepted` is sent. */
  addClient?: (socket: WebSocket, meta: WsClientMeta) => void;
  /** Spy / replacement for `getTtsService().stop()`. */
  onVoiceStop?: () => void;
  /** M075 — unit tests without DB: stub room list for WS subscription scope. */
  listRoomsForActor?: (
    actorId: string,
    options?: { includeRoster?: boolean; includeSubthreads?: boolean },
  ) => Promise<Array<{ id: string }>>;
}

export function wsRoutes(
  app: FastifyInstance,
  deps: WsRoutesDeps,
  testHooks?: WsRoutesTestHooks,
): void {
  const addClientFn = testHooks?.addClient ?? addClient;
  const onVoiceStopFn =
    testHooks?.onVoiceStop ?? (() => getTtsService().stop());

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const wsConnDeps: WsConnectionDeps = {
      addClient: addClientFn,
      onVoiceStop: onVoiceStopFn,
      authTimeoutMs: resolveAuthTimeoutMs(),
    };
    if (deps.checkDeviceAdmission) {
      wsConnDeps.checkDeviceAdmission = deps.checkDeviceAdmission;
      wsConnDeps.deviceAdmissionRecheckMs =
        deps.deviceAdmissionRecheckMs ?? 15_000;
    }
    if (deps.getMaintenanceStatusEvent) {
      wsConnDeps.getMaintenanceStatusEvent = deps.getMaintenanceStatusEvent;
    }
    if (deps.remoteHostPresenceStream) {
      wsConnDeps.remoteHostPresenceStream = deps.remoteHostPresenceStream;
    }
    if (testHooks?.listRoomsForActor) {
      wsConnDeps.listRoomsForActor = testHooks.listRoomsForActor;
    }
    handleWsConnection(socket, deps.resolveBearer, wsConnDeps);
  });
}

interface WsConnectionDeps {
  addClient: (socket: WebSocket, meta: WsClientMeta) => void;
  onVoiceStop: () => void;
  authTimeoutMs: number;
  checkDeviceAdmission?: NonNullable<WsRoutesDeps["checkDeviceAdmission"]>;
  deviceAdmissionRecheckMs?: number;
  listRoomsForActor?: (
    actorId: string,
    options?: { includeRoster?: boolean; includeSubthreads?: boolean },
  ) => Promise<Array<{ id: string }>>;
  /**
   * D420 (Wave 3 task 3.2.1) — optional maintenance-status snapshot provider
   * invoked once after successful auth + `addClient`. See {@link WsRoutesDeps}.
   */
  getMaintenanceStatusEvent?: () => Promise<MaintenanceStatusEvent | null>;
  remoteHostPresenceStream?: RemoteHostPresenceResumePort;
}

/** Exported for unit testing — drives the per-connection state
 *  machine the Fastify route handler hands off to. */
export function handleWsConnection(
  socket: WebSocket,
  resolveBearer: ResolveBearer,
  deps: WsConnectionDeps,
): void {
  let state: "awaiting-auth" | "authenticated" | "closed" = "awaiting-auth";
  // Stack-3 P6b — captured at successful auth so the post-auth WS
  // dispatch can validate that inbound `typing.ping.userId` matches
  // the authenticated socket (no cross-user spoofing).
  let authenticatedUserId: string | null = null;
  let authenticatedRoomIds: Set<string> | null = null;
  let admissionRecheckTimer: ReturnType<typeof setInterval> | null = null;
  let admissionRecheckInFlight = false;

  const clearAdmissionRecheck = (): void => {
    if (admissionRecheckTimer !== null) {
      clearInterval(admissionRecheckTimer);
      admissionRecheckTimer = null;
    }
  };

  const rejectAdmission = (reason: string): void => {
    if (state === "closed") return;
    clearAdmissionRecheck();
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({
        type: "auth.rejected",
        error: reason,
      }));
    }
    socket.close(WS_AUTH_CLOSE_CODE, reason);
    state = "closed";
  };

  const authTimeout = setTimeout(() => {
    if (state !== "awaiting-auth") return;
    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({ type: "auth.rejected", error: "auth_timeout" }),
      );
    }
    socket.close(WS_AUTH_CLOSE_CODE, "auth_timeout");
    state = "closed";
  }, deps.authTimeoutMs);

  socket.on("message", (raw: RawData) => {
    if (state === "closed") return;
    let parsed: { type?: unknown; token?: unknown; initiatingClientSurface?: unknown };
    try {
      parsed = JSON.parse(rawDataToString(raw)) as {
        type?: unknown;
        token?: unknown;
        initiatingClientSurface?: unknown;
      };
    } catch {
      // Malformed first frame — close without echoing an error
      // (defensive against scanners that probe with garbage).
      try {
        socket.close(1003, "non_json");
      } catch {
        /* already closing */
      }
      state = "closed";
      return;
    }

    if (state === "awaiting-auth") {
      void handleAuthFrame(parsed);
      return;
    }

    // state === "authenticated" — minimal post-auth dispatch (today's
    // server doesn't act on WS messages beyond ping + voice.stop;
    // anything else is ignored).
    const msgType = parsed.type;
    if (msgType === "ping") {
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({ type: "pong", timestamp: Date.now() }),
        );
      }
    } else if (msgType === "voice.stop") {
      deps.onVoiceStop();
    } else if (msgType === "typing.ping") {
      handleTypingPing(parsed as Record<string, unknown>);
    } else if (msgType === "remote.host.resume") {
      void handleRemoteHostResume(parsed as Record<string, unknown>);
    }
  });

  function handleTypingPing(parsed: Record<string, unknown>): void {
    if (authenticatedUserId === null || authenticatedRoomIds === null) return;
    const roomId = parsed["roomId"];
    const displayNameRaw = parsed["displayName"];
    if (typeof roomId !== "string" || roomId.length === 0) return;
    if (!authenticatedRoomIds.has(roomId)) return;
    const displayName =
      typeof displayNameRaw === "string" ? displayNameRaw.trim().slice(0, 80) : "";
    publishTypingPing({
      type: "typing.ping",
      roomId,
      userId: authenticatedUserId,
      displayName: displayName.length > 0 ? displayName : "Someone",
    });
  }

  async function handleRemoteHostResume(parsed: Record<string, unknown>): Promise<void> {
    if (authenticatedUserId === null || !deps.remoteHostPresenceStream) return;
    const cursor = parseRemoteHostCursor(parsed["cursor"]);
    // A malformed supplied cursor is deliberately treated as no cursor.  The
    // stream returns a snapshot rather than leaking whether some other user's
    // cursor/stream id exists or closing an otherwise healthy connection.
    try {
      const frames = await deps.remoteHostPresenceStream.resumeForUser(
        authenticatedUserId,
        cursor,
      );
      if (state !== "authenticated" || socket.readyState !== socket.OPEN) return;
      for (const frame of frames) {
        if (socket.readyState !== socket.OPEN) break;
        socket.send(JSON.stringify(frame));
      }
    } catch (err) {
      warn(
        `[ws] remote.host resume snapshot/replay failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  socket.on("close", () => {
    state = "closed";
    clearTimeout(authTimeout);
    clearAdmissionRecheck();
    wsPolicyContexts.delete(socket);
  });

  async function handleAuthFrame(parsed: {
    type?: unknown;
    token?: unknown;
    initiatingClientSurface?: unknown;
  }): Promise<void> {
    if (state !== "awaiting-auth") return;

    if (parsed.type !== "auth" || typeof parsed.token !== "string") {
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({ type: "auth.rejected", error: "auth_required" }),
        );
      }
      socket.close(WS_AUTH_CLOSE_CODE, "auth_required");
      state = "closed";
      return;
    }

    const result = await resolveBearer(parsed.token, { depth: "policy" });
    // The `socket.on("close")` handler may have flipped state to
    // "closed" while we awaited the resolver. The type-narrower
    // doesn't see that mutation; cast through a wider view to do the
    // safety check.
    if ((state as "awaiting-auth" | "authenticated" | "closed") === "closed") {
      return;
    }
    if (!result.ok) {
      warn(`[ws] auth.rejected reason=${result.reason}`);
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({ type: "auth.rejected", error: "invalid_token" }),
        );
      }
      socket.close(WS_AUTH_CLOSE_CODE, "invalid_token");
      state = "closed";
      return;
    }
    if (!isResolveBearerPolicyOk(result)) {
      warn("[ws] auth.rejected reason=shallow_bearer_depth");
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({ type: "auth.rejected", error: "invalid_token" }),
        );
      }
      socket.close(WS_AUTH_CLOSE_CODE, "invalid_token");
      state = "closed";
      return;
    }

    const admissionInput = Object.freeze({
      credentialDigestBase64url: bearerResolutionDigest(parsed.token),
      userId: result.sessionUserId,
      humanActorId: result.sessionActorId,
    });
    if (deps.checkDeviceAdmission !== undefined) {
      let admission: Awaited<ReturnType<
        NonNullable<WsConnectionDeps["checkDeviceAdmission"]>
      >>;
      try {
        admission = await deps.checkDeviceAdmission(admissionInput);
      } catch {
        admission = {
          status: "required",
          reason: "device_admission_unavailable",
        };
      }
      if (admission.status !== "admitted") {
        const reason = admission.reason ?? "device_admission_required";
        rejectAdmission(reason);
        return;
      }
    }

    clearTimeout(authTimeout);
    state = "authenticated";
    wsPolicyContexts.set(socket, result.policyContext);

    // D513 Phase 3.2 — register the socket-local id before the room lookup
    // yields, so a close during that lookup cannot leave a live registry entry.
    // It remains silent until `auth.accepted` below.
    // The identifier is later reused by the Live Shadow HTTP contract and its
    // persisted coordinates, both of which require a portable identifier to
    // start with an ASCII alphanumeric. Base64url may start with `-` or `_`,
    // so reject those two encodings instead of occasionally minting a socket
    // session that chat accepts but Live Shadow cannot represent.
    let clientActionSessionId: string;
    do {
      clientActionSessionId = randomBytes(16).toString("base64url");
    } while (!/^[A-Za-z0-9]/u.test(clientActionSessionId));
    const initiatingClientSurface = parseInitiatingClientSurfaceV1(
      parsed.initiatingClientSurface,
    );
    const clientActionRegistry = getClientActionBindingRegistry();
    clientActionRegistry?.registerLiveSession({
      socket,
      clientActionSessionId,
      actorId: result.sessionActorId,
      initiatingClientSurface,
    });

    const listRoomsFn = deps.listRoomsForActor ?? defaultListRoomsForActor;
    let roomRows: Array<{ id: string }>;
    try {
      roomRows = await listRoomsFn(result.sessionActorId, {
        includeRoster: false,
        includeSubthreads: true,
      });
    } catch {
      clientActionRegistry?.unregisterLiveSession(clientActionSessionId);
      if (socket.readyState === socket.OPEN) socket.close(WS_AUTH_CLOSE_CODE, "subscription_failed");
      state = "closed";
      return;
    }

    if ((state as "awaiting-auth" | "authenticated" | "closed") === "closed") {
      clientActionRegistry?.unregisterLiveSession(clientActionSessionId);
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      clientActionRegistry?.unregisterLiveSession(clientActionSessionId);
      return;
    }

    const roomIds = new Set(roomRows.map((r) => r.id));
    deps.addClient(socket, {
      userId: result.sessionUserId,
      actorId: result.sessionActorId,
      roomIds,
    });
    authenticatedUserId = result.sessionUserId;
    authenticatedRoomIds = roomIds;

    if (deps.checkDeviceAdmission !== undefined) {
      const recheckMs = deps.deviceAdmissionRecheckMs ?? 15_000;
      admissionRecheckTimer = setInterval(() => {
        if (state !== "authenticated" || admissionRecheckInFlight) return;
        admissionRecheckInFlight = true;
        void deps.checkDeviceAdmission!(admissionInput).then((admission) => {
          if (admission.status !== "admitted") {
            rejectAdmission(
              admission.reason ?? "device_admission_required",
            );
          }
        }).catch(() => {
          rejectAdmission("device_admission_unavailable");
        }).finally(() => {
          admissionRecheckInFlight = false;
        });
      }, recheckMs);
      (admissionRecheckTimer as unknown as { unref?: () => void }).unref?.();
    }

    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "auth.accepted" }));
      // D513 Phase 3.1 — a new opaque session identifier for this exact socket only.
      // It deliberately bypasses ws-publisher and has no Room/user audience.
      socket.send(JSON.stringify({
        type: "client.session.v1",
        clientActionSessionId,
      }));
    }

    // D420 (Wave 3 task 3.2.1) — send a current maintenance-status snapshot
    // immediately after admission so a client that missed a live event starts
    // truthful (R12). Best-effort and fail-safe: a provider failure (or a
    // null return) MUST NOT poison the connection with a fabricated snapshot
    // or tear down an already-authenticated socket. We swallow the error, warn,
    // and skip the frame; the client stays admitted and learns the truth from
    // the next live broadcast or a future reconnect.
    const snapshotProvider = deps.getMaintenanceStatusEvent;
    if (snapshotProvider && socket.readyState === socket.OPEN) {
      try {
        const event = await snapshotProvider();
        if (event && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
      } catch {
        warn("[ws] maintenance.status snapshot skipped on connect");
      }
    }
  }
}

function parseRemoteHostCursor(value: unknown): RemoteHostResumeCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["streamId"] !== "string" ||
    candidate["streamId"].length === 0 ||
    candidate["streamId"].length > 128 ||
    typeof candidate["sequence"] !== "number" ||
    !Number.isSafeInteger(candidate["sequence"]) ||
    candidate["sequence"] < 0 ||
    typeof candidate["snapshotRevision"] !== "number" ||
    !Number.isSafeInteger(candidate["snapshotRevision"]) ||
    candidate["snapshotRevision"] < 0
  ) {
    return null;
  }
  return {
    streamId: candidate["streamId"],
    sequence: candidate["sequence"],
    snapshotRevision: candidate["snapshotRevision"],
  };
}
