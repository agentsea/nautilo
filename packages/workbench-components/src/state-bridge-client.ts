/**
 * D121-P3 — iframe-side client for the host postMessage state bridge.
 *
 * Runs inside the sandboxed `srcDoc` iframe. The parent workbench
 * (`apps/workbench/src/viewers/html/state-bridge.ts`) installs the
 * host-side handler that pulls the bearer + binds the artifactId
 * from closure. This file is what the artifact's own JS code calls
 * via `window.nwState.get(...)` / `window.nwState.set(...)`.
 *
 * Contract:
 *   - `await window.nwState.get(key)` → returns the JSON value, or
 *     `undefined` if the key was never set.
 *   - `await window.nwState.set(key, value)` → writes; resolves
 *     when the host has persisted (HTTP round-trip). `value` is any
 *     JSON-serializable payload (including `null`).
 *   - `await window.nwState.emit(topic, payload)` → enqueues an
 *     agent-notification event (D261 P6b) for the agent's next turn;
 *     resolves when the host has accepted the HTTP round-trip.
 *   - `await window.nwState.ping(topic, payload)` → enqueues the same
 *     event **and** wakes an idle agent now (M153); resolves when the
 *     host has accepted the HTTP round-trip.
 *
 * Failure modes:
 *   - 5s timeout per request — rejects with `new Error("nwState
 *     timeout")` if the host doesn't respond.
 *   - Network / auth / server failures surface as
 *     `new Error(<server-reason>)` with the upstream status if any.
 *
 * Wire shape (parent ↔ iframe):
 *   - State req:  `{type: "nw.state.req", requestId, op: "get"|"set", key, value?}`
 *   - Event req:  `{type: "nw.event.emit", requestId, topic, payload}`
 *   - Ping req:   `{type: "nw.event.ping", requestId, topic, payload}`
 *   - Response:   `{type: "nw.state.res", requestId, ok: true, value}`
 *                 OR `{type: "nw.state.res", requestId, ok: false, error, status?}`
 *                 (same envelope for state and event requests)
 *
 * Why postMessage and not direct fetch: the iframe has CSP
 * `connect-src 'none'` so it cannot reach the host's `/api/*`
 * directly. The parent is the only thing with the bearer + the
 * artifact-id binding. postMessage is the gateway.
 */

const TIMEOUT_MS = 5000;
const TOPIC_MAX_LEN = 128;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResponseEnvelope {
  type: "nw.state.res";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  status?: number;
}

function isResponseEnvelope(x: unknown): x is ResponseEnvelope {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o["type"] === "nw.state.res" &&
    typeof o["requestId"] === "string" &&
    typeof o["ok"] === "boolean"
  );
}

const pending = new Map<string, PendingRequest>();
let listenerInstalled = false;
let counter = 0;

function ensureListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener("message", (event) => {
    // Only accept messages from the parent (the host); ignore any
    // other source. In a sandboxed srcDoc iframe the only legitimate
    // window with reach into us is `window.parent`.
    if (event.source !== window.parent) return;
    const data: unknown = event.data;
    if (!isResponseEnvelope(data)) return;
    const req = pending.get(data.requestId);
    if (!req) return;
    pending.delete(data.requestId);
    clearTimeout(req.timer);
    if (data.ok) {
      req.resolve(data.value);
    } else {
      const errMsg =
        typeof data.error === "string" ? data.error : "nwState error (no message)";
      const e = new Error(
        typeof data.status === "number" ? `[${data.status}] ${errMsg}` : errMsg,
      );
      req.reject(e);
    }
  });
}

function newRequestId(): string {
  counter += 1;
  return `nw-${Date.now()}-${counter}`;
}

function assertJsonSerializable(value: unknown, context: string): void {
  if (value === undefined) {
    throw new Error(`${context}: payload must be JSON-serializable (undefined not allowed)`);
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`${context}: payload must be JSON-serializable`);
  }
  try {
    if (JSON.stringify(value) === undefined) {
      throw new Error(`${context}: payload must be JSON-serializable`);
    }
  } catch {
    throw new Error(`${context}: payload must be JSON-serializable`);
  }
}

function sendBridgeMessage(msg: Record<string, unknown>): Promise<unknown> {
  ensureListener();
  const requestId = newRequestId();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`nwState timeout (${TIMEOUT_MS}ms)`));
    }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ ...msg, requestId }, "*");
  });
}

function sendRequest(payload: {
  op: "get" | "set";
  key: string;
  value?: unknown;
}): Promise<unknown> {
  const msg: Record<string, unknown> = {
    type: "nw.state.req",
    op: payload.op,
    key: payload.key,
  };
  if (payload.op === "set") msg["value"] = payload.value;
  return sendBridgeMessage(msg);
}

function sendEmit(topic: string, payload: unknown): Promise<unknown> {
  return sendBridgeMessage({
    type: "nw.event.emit",
    topic,
    payload,
  });
}

function sendPing(topic: string, payload: unknown): Promise<unknown> {
  return sendBridgeMessage({
    type: "nw.event.ping",
    topic,
    payload,
  });
}

/**
 * Public surface exposed on `window.nwState` at runtime-bundle load.
 * Artifact authors call `nwState.get(...)` / `nwState.set(...)` /
 * `nwState.emit(...)` / `nwState.ping(...)`.
 */
export const nwState = {
  async get(key: string): Promise<unknown> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("nwState.get: key must be a non-empty string");
    }
    return await sendRequest({ op: "get", key });
  },
  async set(key: string, value: unknown): Promise<void> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("nwState.set: key must be a non-empty string");
    }
    await sendRequest({ op: "set", key, value });
  },
  async emit(topic: string, payload: unknown): Promise<void> {
    if (typeof topic !== "string" || topic.length === 0) {
      throw new Error("nwState.emit: topic must be a non-empty string");
    }
    if (topic.length > TOPIC_MAX_LEN) {
      throw new Error(`nwState.emit: topic must be at most ${TOPIC_MAX_LEN} characters`);
    }
    assertJsonSerializable(payload, "nwState.emit");
    await sendEmit(topic, payload);
  },
  async ping(topic: string, payload: unknown): Promise<void> {
    if (typeof topic !== "string" || topic.length === 0) {
      throw new Error("nwState.ping: topic must be a non-empty string");
    }
    if (topic.length > TOPIC_MAX_LEN) {
      throw new Error(`nwState.ping: topic must be at most ${TOPIC_MAX_LEN} characters`);
    }
    assertJsonSerializable(payload, "nwState.ping");
    await sendPing(topic, payload);
  },
};

declare global {
  interface Window {
    nwState?: typeof nwState;
  }
}

/**
 * Idempotent install. Runtime entry calls this on module load.
 * If `window.nwState` already exists (re-eval, HMR), keep the
 * existing reference so any in-flight pending requests on the old
 * map don't get orphaned.
 */
export function installNwState(): void {
  if (!window.nwState) {
    window.nwState = nwState;
  }
  ensureListener();
}
