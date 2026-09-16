/**
 * Thin TCP `ws` client for `/ws` integration tests — mirrors what
 * `@nautilo/realtime-client` does on the wire (M058 first-frame JSON auth).
 */
import WebSocket, { type RawData } from "ws";
import { WS_AUTH_CLOSE_CODE } from "../../../../src/routes/ws";

export function httpBaseToWsUrl(baseUrl: string, path: string): string {
  const origin = baseUrl.replace(/^http/, "ws");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

export interface WsTestClientOptions {
  url: string;
  /** Sent as `{ type: "auth", token }` — same value as HTTP `Authorization: Bearer`. */
  token: string;
  /** Max wait for `auth.accepted` / terminal rejection (ms). Does not change `NAUTILO_WS_AUTH_TIMEOUT_MS`. */
  waitForHandshakeMs?: number;
}

export interface WsTestClient {
  ws: WebSocket;
  /** Already settled after `connectWsTestClient` resolves. */
  authAccepted: Promise<void>;
  events: Array<unknown>;
  send: (msg: unknown) => void;
  waitForEvent: <T = unknown>(
    predicate: (e: unknown) => e is T,
    timeoutMs?: number,
  ) => Promise<T>;
  close: () => Promise<void>;
}

type PendingWait = {
  predicate: (e: unknown) => boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function parseMessage(data: RawData): unknown {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
  return JSON.parse(text) as unknown;
}

function awaitOpen(ws: WebSocket, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const t = setTimeout(() => reject(new Error("WebSocket open timeout")), ms);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function connectWsTestClient(
  opts: WsTestClientOptions,
): Promise<WsTestClient> {
  const waitMs = opts.waitForHandshakeMs ?? 15_000;
  const events: unknown[] = [];
  const pending: PendingWait[] = [];

  function flushWaiters() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const w = pending[i]!;
      for (const e of events) {
        if (w.predicate(e)) {
          clearTimeout(w.timer);
          pending.splice(i, 1);
          w.resolve(e);
          break;
        }
      }
    }
  }

  function pushEvent(parsed: unknown) {
    events.push(parsed);
    flushWaiters();
  }

  const ws = new WebSocket(opts.url);
  await awaitOpen(ws, waitMs);

  const handshake = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WS auth handshake timed out after ${waitMs}ms`));
    }, waitMs);

    const onMessage = (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = parseMessage(data);
      } catch {
        cleanup();
        reject(new Error("Invalid JSON from server during auth"));
        return;
      }
      pushEvent(parsed);
      const t = (parsed as { type?: unknown }).type;
      if (t === "auth.accepted") {
        cleanup();
        resolve();
        return;
      }
      if (t === "auth.rejected") {
        cleanup();
        const err = (parsed as { error?: unknown }).error;
        reject(
          new Error(
            `auth.rejected: ${typeof err === "string" ? err : String(err)}`,
          ),
        );
      }
    };

    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(`WS closed during handshake: code=${code} reason=${reason.toString()}`),
      );
    };

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.send(JSON.stringify({ type: "auth", token: opts.token }));
  });

  await handshake;

  ws.on("message", (data) => {
    try {
      pushEvent(parseMessage(data));
    } catch {
      /* ignore malformed post-auth frames in harness */
    }
  });

  return {
    ws,
    authAccepted: Promise.resolve(),
    events,
    send(msg: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    waitForEvent<T = unknown>(
      predicate: (e: unknown) => e is T,
      timeoutMs = 15_000,
    ): Promise<T> {
      for (const e of events) {
        if (predicate(e)) return Promise.resolve(e);
      }
      return new Promise<T>((resolve, reject) => {
        const row: PendingWait = {
          predicate: predicate as (e: unknown) => boolean,
          resolve: resolve as (v: unknown) => void,
          reject,
          timer: setTimeout(() => {
            const idx = pending.indexOf(row);
            if (idx >= 0) pending.splice(idx, 1);
            reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`));
          }, timeoutMs),
        };
        pending.push(row);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      });
    },
  };
}

export interface RawWsSession {
  ws: WebSocket;
  events: unknown[];
  close: () => Promise<void>;
}

/** Opens `/ws` without sending an auth frame. */
export async function openWsAwaitingAuth(
  wsUrl: string,
  openTimeoutMs = 15_000,
): Promise<RawWsSession> {
  const ws = new WebSocket(wsUrl);
  const events: unknown[] = [];

  await awaitOpen(ws, openTimeoutMs);

  ws.on("message", (data) => {
    try {
      events.push(parseMessage(data));
    } catch {
      const raw = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : typeof data === "string"
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
      events.push({ _parseError: true, raw });
    }
  });

  return {
    ws,
    events,
    close() {
      return new Promise<void>((resolve) => {
        if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      });
    },
  };
}

export { WS_AUTH_CLOSE_CODE };
