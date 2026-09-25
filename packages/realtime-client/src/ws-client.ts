import {
  clientSessionEventV1Schema,
  parseUiActionEventV1,
  VoiceStreamIngress,
  type VoicePlaybackEvent,
  type InitiatingClientSurfaceV1,
  type RealtimeControlEvent,
  type ServerEvent,
} from "@nautilo/types";

export type RealtimeEventHandler = (event: ServerEvent) => void;
/** Socket-local controls are deliberately separate from ServerEvent broadcasts. */
export type RealtimeControlEventHandler = (event: RealtimeControlEvent) => void;
export type RealtimeErrorHandler = (error: Error) => void;
/**
 * State sequence on a clean session:
 *   `connecting` → `authenticating` → `open` → `closed`
 *
 * `authenticating` covers the window between the WS upgrade
 * completing and the server's `auth.accepted` reply landing.
 * Consumers that previously branched on `state === "open"` for
 * "really connected" keep working unchanged — the client only fires
 * `"open"` after `auth.accepted`.
 */
export type RealtimeState =
  | "connecting"
  | "authenticating"
  | "open"
  | "closed";
export type RealtimeStateHandler = (state: RealtimeState) => void;

export type GetTokenFn = () =>
  | string
  | null
  | Promise<string | null>;

/**
 * Reasons the auth handshake can fail. Surfaced verbatim to
 * `onAuthRejected` and to the `error.code` field on the auth
 * `Error` passed to `onError`.
 */
export type AuthRejectedReason =
  | "no_token"
  | "auth_required"
  | "auth_timeout"
  | "invalid_token"
  | "device_admission_required"
  | "device_admission_expired"
  | "device_removed_or_stale"
  | "device_admission_unavailable"
  | "unknown";

export interface RealtimeClient {
  close(): void;
  send(message: Record<string, unknown>): void;
  /**
   *  Tab hidden / intentional idle: close the socket
   * without scheduling reconnect backoff. Idempotent. No-op after
   * `close()` (permanent shutdown). Orthogonal to `reconnect()`.
   */
  suspend(): void;
  /**
   * counterpart to `suspend()`: resume the connection loop.
   * Idempotent. No-op after `close()`.
   */
  resume(): void;
  /**
   * re-enable the reconnect loop after `onAuthRejected`
   * suspended it. Consumers call this once they've refreshed their
   * token (e.g. completed a new sign-in flow). No-op if the loop
   * is still active.
   */
  reconnect(): void;
}

export interface RealtimeClientOptions {
  onEvent: RealtimeEventHandler;
  /** Advertise PCM support only when this client has an installed audio sink. */
  onVoiceEvent?: ((event: VoicePlaybackEvent) => void) | undefined;
  /** Product-owned fixed declaration sent only in this socket's auth frame. */
  initiatingClientSurface?: InitiatingClientSurfaceV1 | undefined;
  /** Called for strict socket-local control frames after authentication. */
  onControlEvent?: RealtimeControlEventHandler | undefined;
  onError?: RealtimeErrorHandler | undefined;
  onStateChange?: RealtimeStateHandler | undefined;
  /** Reconnect backoff base (ms). Default 1_000. */
  reconnectBaseMs?: number | undefined;
  /** Reconnect backoff cap (ms). Default 30_000. */
  reconnectMaxMs?: number | undefined;
  /**
   * How often to send `{type: "ping"}` (ms). Default 15_000.
   * Set to 0 to disable heartbeat (tests).
   */
  heartbeatIntervalMs?: number | undefined;
  /** Local Human activity snapshot at ping time; omitted for older callers. */
  isIdle?: (() => boolean) | undefined;
  /**
   * Reconnect if no inbound message for this long (ms). Default 75_000
   * (= 5 × the ping interval). Any inbound message (pong, event) resets the
   * stale timer.
   *
   * this is a TRANSPORT-liveness check ("how many missed pings before
   * the socket is presumed dead"), NOT a model-response timeout. It must be a
   * multiple of `heartbeatIntervalMs`, not tied to model first-token budgets:
   * pong (15s, answered in the server WS handler independently of the job
   * loop) + `agent.progress` (~1.5s during active work) keep inbound traffic
   * flowing even through a 180s reasoning think, so a slow-but-alive turn
   * never trips this. (A dropped terminal
   * `job.status` after a *genuine* dead-socket reconnect — is fixed by the
   * run-state reconcile on reconnect, not by this value.)
   */
  heartbeatTimeoutMs?: number | undefined;
  /**
   * token provider for the first-frame auth handshake. Called
   * fresh on every connect attempt so reconnects pick up refreshed
   * bundles transparently. Returning null closes the socket and
   * counts toward the 3-failure cap before `onAuthRejected("no_token")`.
   *
   * Optional so lightweight tests can omit it, BUT real clients
   * running against an authenticated server MUST provide one.
   */
  getToken?: GetTokenFn | undefined;
  /**
   * fires after 3 consecutive auth handshake failures
   * (`invalid_token` rejections OR `getToken()` returning null).
   * Reconnection is suspended until the consumer calls
   * `client.reconnect()` after refreshing tokens.
   */
  onAuthRejected?: ((reason: AuthRejectedReason) => void) | undefined;
  /**
   * bounded outbound queue. Messages sent during
   * `connecting` / `authenticating` / brief disconnect windows are
   * buffered (oldest dropped on overflow) and flushed on
   * `auth.accepted`. Default 64.
   */
  outboundQueueLimit?: number | undefined;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
// "5 consecutive missed pings → the socket is dead." Tied to the ping
// INTERVAL, not to model latency: this is a transport-liveness check, not a
// model-response timeout. Pong (every 15s, answered in the server WS handler
// independently of the job loop) plus `agent.progress` (~1.5s during active
// work) keep inbound traffic flowing even through a 180s reasoning
// first-token wait, so a slow-but-alive turn never trips this — only a
// genuinely silent (half-open / dead) socket does.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * DEFAULT_HEARTBEAT_INTERVAL_MS; // 75s
const DEFAULT_OUTBOUND_QUEUE_LIMIT = 64;
const AUTH_FAILURE_CAP = 3;

/**
 * Creates a WebSocket realtime client with first-message auth,
 * automatic reconnection, and heartbeat-based staleness
 * detection.
 *
 * Behavior:
 * - Each connect: sends `{type:"auth", token}` as the first frame
 *   after socket-open. Transitions to `"open"` only on
 *   `auth.accepted`.
 * - Exponential backoff + jitter on any disconnect (capped at
 *   reconnectMaxMs). Reset on `auth.accepted`.
 * - Heartbeat clock starts on `auth.accepted`, NOT on bare
 *   socket-open — a slow handshake won't trigger spurious staleness
 *   closes.
 * - Outbound messages sent before `"open"` are buffered (cap
 *   `outboundQueueLimit`, default 64; oldest dropped on overflow).
 * - 3 consecutive auth failures (invalid_token OR getToken() ===
 *   null) suspend reconnect and fire `onAuthRejected(reason)`. The
 *   consumer refreshes credentials, then calls `client.reconnect()`.
 * - `close()` is idempotent and cancels any pending reconnect.
 * - `suspend()` / `resume()` implement visibility-aware idle
 *   close without reconnect backoff; orthogonal to `suspended`.
 */
export function createWsRealtimeClient(
  wsUrl: string,
  options: RealtimeClientOptions,
): RealtimeClient {
  const {
    onEvent,
    onVoiceEvent,
    onControlEvent,
    onError,
    onStateChange,
    getToken,
    onAuthRejected,
    initiatingClientSurface,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    isIdle,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    outboundQueueLimit = DEFAULT_OUTBOUND_QUEUE_LIMIT,
  } = options;

  let ws: WebSocket | null = null;
  let closed = false;
  /** auth-rejection path: blocks `connect` / `scheduleReconnect`. */
  let suspended = false;
  /** visibility / intentional idle: blocks reconnect until `resume()`. */
  let idleSuspended = false;
  let state: RealtimeState = "closed";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageAt = 0;
  let consecutiveAuthFailures = 0;
  const outboundQueue: Record<string, unknown>[] = [];
  let voiceListener: Record<string, unknown> | null = null;
  let voiceNegotiated = false;

  function setState(next: RealtimeState): void {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    if (heartbeatIntervalMs <= 0) return;
    lastMessageAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!ws) {
        stopHeartbeat();
        return;
      }
      // Stale: no inbound message for heartbeatTimeoutMs. Force close — the
      // browser often doesn't notice a half-open TCP. The close handler will
      // schedule a reconnect.
      if (Date.now() - lastMessageAt > heartbeatTimeoutMs) {
        onError?.(
          new Error(
            `WebSocket stale (no message in ${heartbeatTimeoutMs}ms) — forcing reconnect`,
          ),
        );
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(isIdle ? { type: "ping", idle: isIdle() } : { type: "ping" }));
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }, heartbeatIntervalMs);
  }

  function scheduleReconnect(): void {
    if (closed || suspended || idleSuspended) return;
    if (reconnectTimer) return;

    const jitter = Math.random() * 1_000;
    const delay = Math.min(
      reconnectBaseMs * Math.pow(2, reconnectAttempt) + jitter,
      reconnectMaxMs,
    );
    reconnectAttempt++;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function suspendReconnect(reason: AuthRejectedReason): void {
    suspended = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    onAuthRejected?.(reason);
  }

  function noteAuthFailure(reason: AuthRejectedReason): void {
    consecutiveAuthFailures++;
    if (consecutiveAuthFailures >= AUTH_FAILURE_CAP) {
      suspendReconnect(reason);
    }
  }

  function flushOutboundQueue(): void {
    while (outboundQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
      const next = outboundQueue.shift();
      if (next === undefined) continue;
      try {
        ws.send(JSON.stringify(next));
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  function enqueueOutbound(message: Record<string, unknown>): void {
    if (outboundQueue.length >= outboundQueueLimit) {
      // Drop oldest — the alternative is unbounded memory growth
      // during long disconnects.
      const dropped = outboundQueue.shift();
      const droppedType =
        dropped && typeof dropped["type"] === "string" ? dropped["type"] : "unknown";
      console.warn(
        `[realtime-client] outbound queue full (limit ${outboundQueueLimit}); dropped oldest message type=${droppedType}`,
      );
    }
    outboundQueue.push(message);
  }

  function connect(): void {
    if (closed || suspended || idleSuspended) return;

    setState("connecting");
    let thisWs: WebSocket;
    try {
      thisWs = new WebSocket(wsUrl);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      ws = null;
      scheduleReconnect();
      return;
    }
    ws = thisWs;
    thisWs.binaryType = "arraybuffer";
    const voiceIngress = new VoiceStreamIngress();
    voiceNegotiated = false;

    /**
     * socket-ownership race fix.
     *
     * Pre-fix race: `suspend()` calls `ws.close(1000)` (async). If
     * `resume()` runs before the close event fires, `connect()`
     * creates a NEW socket and reassigns `ws`. When the OLD socket's
     * close event eventually fires, its handler executed on the
     * SHARED `ws` reference and set `ws = null` + `state = "closed"`,
     * killing the new connection and scheduling reconnect backoff.
     *
     * Fix: each handler captures `thisWs` at attach time and
     * short-circuits via `isStale()` when `ws` has been reassigned to
     * a different socket. The close handler is the load-bearing one;
     * the message/open/error handlers get the same guard for
     * consistency (a stale message frame from a closed-but-not-yet-
     * GC'd socket is also possible under high churn).
     *
     * Pinned by the suspend/resume-race test in suspend-resume.test.ts.
     */
    const isStale = (): boolean => ws !== thisWs;

    thisWs.addEventListener("open", () => {
      if (isStale()) return;
      // Note: we DO NOT start the heartbeat here — it starts on
      // `auth.accepted` so a slow auth round-trip can't trigger a
      // stale-close before the handshake completes.
      setState("authenticating");

      void (async () => {
        let token: string | null = null;
        if (getToken) {
          try {
            token = await getToken();
          } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
            token = null;
          }
        }
        // Re-check after the async getToken: the socket we attached
        // to may have been superseded while awaiting.
        if (isStale()) return;

        if (!token) {
          // No token configured / getToken returned null. Surface
          // and let the close+reconnect cycle drive retries; the
          // 3-failure cap suspends the loop.
          noteAuthFailure("no_token");
          try {
            thisWs.close();
          } catch {
            /* already closing */
          }
          return;
        }
        try {
          thisWs.send(JSON.stringify({
            type: "auth",
            token,
            ...(initiatingClientSurface ? { initiatingClientSurface } : {}),
            ...(onVoiceEvent ? { voiceProtocol: 1 } : {}),
          }));
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    thisWs.addEventListener("message", (event: MessageEvent) => {
      if (isStale()) return;
      lastMessageAt = Date.now();
      if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
        const frame = state === "open" && voiceNegotiated ? voiceIngress.data(event.data) : null;
        if (frame) onVoiceEvent?.({ type: "voice.stream.data", ...frame });
        else {
          onError?.(new Error("Invalid voice stream frame"));
          thisWs.close(1002, "invalid voice stream");
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch (err) {
        onError?.(
          err instanceof Error ? err : new Error("Failed to parse WS message"),
        );
        return;
      }

      if (state === "authenticating") {
        const msgType = (parsed as { type?: unknown }).type;
        if (msgType === "auth.accepted") {
          voiceNegotiated = onVoiceEvent !== undefined && (parsed as { voiceProtocol?: unknown }).voiceProtocol === 1;
          consecutiveAuthFailures = 0;
          reconnectAttempt = 0;
          startHeartbeat();
          setState("open");
          flushOutboundQueue();
          if (voiceNegotiated && voiceListener !== null) thisWs.send(JSON.stringify(voiceListener));
          return;
        }
        if (msgType === "auth.rejected") {
          const errField = (parsed as { error?: unknown }).error;
          const reason: AuthRejectedReason =
            errField === "auth_required" ||
            errField === "auth_timeout" ||
            errField === "invalid_token" ||
            errField === "device_admission_required" ||
            errField === "device_admission_expired" ||
            errField === "device_removed_or_stale" ||
            errField === "device_admission_unavailable"
              ? errField
              : "unknown";
          // Only invalid_token / auth_required count toward the
          // failure cap — auth_timeout is more often a transport
          // problem than a bad credential, but counting it keeps
          // the cap cleanly enforced. (`unknown` also counts so a
          // misbehaving server can't pin the client in a loop.)
          noteAuthFailure(reason);
          const error = new Error(`WS auth rejected: ${reason}`);
          (error as Error & { code?: string }).code = reason;
          onError?.(error);
          try {
            thisWs.close();
          } catch {
            /* already closing */
          }
          return;
        }
        // Any other frame during `authenticating` is a protocol
        // violation — servers without this handshake will fail this check.
        onError?.(
          new Error("WS protocol violation: message before auth.accepted"),
        );
        try {
          thisWs.close();
        } catch {
          /* already closing */
        }
        return;
      }

      // Pongs are heartbeat-only; don't surface them to consumers.
      if (isPongMessage(parsed)) return;
      if (typeof (parsed as { type?: unknown }).type === "string" && String((parsed as { type: string }).type).startsWith("voice.stream.")) {
        const control = voiceNegotiated ? voiceIngress.control(parsed) : null;
        if (control) onVoiceEvent?.(control);
        else thisWs.close(1002, "invalid voice stream control");
        return;
      }
      // socket-local controls are never ServerEvents and never
      // forwarded through room/user broadcast handlers. Reserved control
      // names are consumed even when malformed, so an untrusted frame cannot
      // fall through to an application's ordinary event router.
      if ((parsed as { type?: unknown }).type === "client.session.v1") {
        const control = clientSessionEventV1Schema.safeParse(parsed);
        if (control.success) {
          onControlEvent?.(control.data);
        } else {
          onError?.(new Error("WS client session control frame rejected"));
        }
        return;
      }
      if ((parsed as { type?: unknown }).type === "ui.action.v1") {
        try {
          onControlEvent?.(parseUiActionEventV1(parsed));
        } catch {
          onError?.(new Error("WS UI action control frame rejected"));
        }
        return;
      }
      onEvent(parsed as ServerEvent);
    });

    thisWs.addEventListener("close", () => {
      // Phase 6.9.3 LOAD-BEARING: ignore stale close events from
      // prior sockets. Without this guard, a suspend()-then-resume()
      // race tears down the new socket because the old socket's
      // close handler sets the shared `ws` ref to null.
      if (isStale()) return;
      stopHeartbeat();
      ws = null;
      setState("closed");
      scheduleReconnect();
    });

    thisWs.addEventListener("error", () => {
      if (isStale()) return;
      onError?.(new Error("WebSocket connection error"));
      // The 'close' handler will fire next and schedule reconnect.
    });
  }

  connect();

  return {
    close() {
      closed = true;
      suspended = false;
      idleSuspended = false;
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        ws = null;
      }
    },
    send(message: Record<string, unknown>) {
      // A stop belongs to the current socket generation, never a future turn.
      if ((message["type"] === "voice.stop" || message["type"] === "voice.consumed") && state !== "open") return;
      // Old servers omit turn IDs. Preserve their Stop command, but never let
      // an unscoped Stop cancel other device turns on a negotiated server.
      if (message["type"] === "voice.stop" && voiceNegotiated &&
          (typeof message["turnId"] !== "string" || message["turnId"].length === 0)) return;
      if (message["type"] === "voice.listen") {
        voiceListener = message;
        if (state !== "open" || !voiceNegotiated) return;
      }
      if (state === "open" && ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(message));
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      // Buffer during connecting / authenticating / brief disconnect
      // windows. Heartbeat pings are NEVER queued — startHeartbeat()
      // only fires from `state === "open"`, so they can't outrun the
      // handshake.
      enqueueOutbound(message);
    },
    reconnect() {
      if (closed) return;
      if (!suspended) return;
      suspended = false;
      consecutiveAuthFailures = 0;
      reconnectAttempt = 0;
      // Re-fire connect immediately rather than via scheduleReconnect's
      // backoff: the consumer just refreshed credentials and expects
      // a prompt retry.
      connect();
    },
    suspend() {
      if (closed) return;
      if (idleSuspended) return;
      idleSuspended = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopHeartbeat();
      if (ws) {
        try {
          ws.close(1000);
        } catch {
          /* already closing */
        }
      }
    },
    resume() {
      if (closed) return;
      if (!idleSuspended) return;
      idleSuspended = false;
      connect();
    },
  };
}

function isPongMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "pong"
  );
}
