/**
 * D121-P3 — parent-side postMessage bridge for HTML artifact state.
 *
 * ─── If you edit this file, RE-CONFIRM these invariants ─────────────
 *
 *   1. `event.source === iframe.contentWindow` — NOT `event.origin === ...`.
 *      srcDoc iframes have opaque "null" origin; origin-equality would
 *      accept any null-origin source.
 *   2. The bridge supplies `artifactId` from closure. Messages from the
 *      iframe that include an `artifactId` / `id` / `artifact_id` field
 *      are REJECTED (`rejectsArtifactIdInMessage`). Without this, a
 *      buggy / hostile artifact could address other artifacts.
 *   3. Message-shape validation is strict (`isIncomingMessage`).
 *      Unknown types / missing fields are dropped silently.
 *
 * Parent-side unit tests for these invariants are gated on a happy-dom
 * dep that's not currently in `apps/workbench/`. The iframe-side
 * `state-bridge-client.test.ts` in `@nautilo/workbench-components`
 * pins the wire shape from the OTHER side (those tests use happy-dom
 * which workbench-components already depends on). Live acceptance must
 * additionally exercise the full iframe-to-host round-trip.
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * The sandboxed `srcDoc` iframe (artifact runtime, the `<nw-*>` Lit
 * components) gets two RPC methods exposed via `window.nwState` in
 * its own page context (see `state-bridge-client.ts` in the
 * workbench-components runtime bundle). When the artifact's JS calls
 * `nwState.get(key)` / `nwState.set(key, value)` / `nwState.emit(topic, payload)` /
 * `nwState.ping(topic, payload)`,
 * the runtime postMessages `{type: "nw.state.req", ...}`,
 * `{type: "nw.event.emit", ...}`, or `{type: "nw.event.ping", ...}` to the parent.
 * THIS module receives those
 * messages, attaches the bearer + the bound `artifactId` (from closure — the
 * iframe never supplies the artifact id; it's locked at mount time), forwards to
 * the workbench API, and posts back a
 * `{type: "nw.state.res", requestId, ok, value?, error?}`.
 * Event emits reuse the same response envelope name (not a separate
 * `nw.event.res`) so the iframe client keeps one listener path.
 *
 * Security-critical invariants:
 *
 *   1. **Source equality, NOT origin equality.** The `srcDoc` iframe
 *      has opaque origin `"null"`; `event.origin` is `"null"` for
 *      every legitimate message from it. Trusting origin would
 *      accept messages from ANY null-origin source. We verify
 *      `event.source === iframe.contentWindow` instead — that
 *      identifies the specific iframe we mounted.
 *
 *   2. **`artifactId` from closure.** The bridge is per-render; we
 *      bind the artifact id at mount time and use it for every
 *      forwarded request. The iframe's message shape DOES NOT carry
 *      an `artifactId`; if one is present we reject the message so
 *      a buggy / hostile artifact can't address other artifacts.
 *
 *   3. **Strict message-shape validation.** Reject any message
 *      that's not the exact `{type, requestId, op, key, value?}`
 *      shape. Defense in depth — the message channel is the only
 *      way the sandbox interacts with the host.
 *
 *   4. **Per-request timeout on the iframe side, not here.** We
 *      respond as soon as the fetch settles; if the response is
 *      slow, the iframe-side client times out after 5s and rejects
 *      its own promise. We don't track in-flight requests here.
 */

import { apiClient } from "../../lib/api";

export interface StateBridgeOptions {
  iframe: HTMLIFrameElement;
  artifactId: string;
  /** Forwarded to apiClient as `?roomId=` for envelope scoping. */
  roomId?: string;
  /** Advisory UI projection; server write admission remains authoritative. */
  readOnly?: boolean;
}

/**
 * Message shapes. Mirrored in `state-bridge-client.ts` on the
 * iframe side; keep in sync.
 */
const TOPIC_MAX_LEN = 128;

type IncomingStateMessage =
  | {
      type: "nw.state.req";
      requestId: string;
      op: "get";
      key: string;
    }
  | {
      type: "nw.state.req";
      requestId: string;
      op: "set";
      key: string;
      value: unknown;
    };

type IncomingEmitMessage = {
  type: "nw.event.emit";
  requestId: string;
  topic: string;
  payload: unknown;
};

type IncomingPingMessage = {
  type: "nw.event.ping";
  requestId: string;
  topic: string;
  payload: unknown;
};

type IncomingMessage = IncomingStateMessage | IncomingEmitMessage | IncomingPingMessage;

function isIncomingStateMessage(x: unknown): x is IncomingStateMessage {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o["type"] !== "nw.state.req") return false;
  if (typeof o["requestId"] !== "string" || (o["requestId"]).length === 0) return false;
  if (typeof o["key"] !== "string" || (o["key"]).length === 0) return false;
  if (o["op"] === "get") return true;
  if (o["op"] === "set") return "value" in o; // value may be null
  return false;
}

function isIncomingEmitMessage(x: unknown): x is IncomingEmitMessage {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o["type"] !== "nw.event.emit") return false;
  if (typeof o["requestId"] !== "string" || o["requestId"].length === 0) return false;
  if (typeof o["topic"] !== "string" || o["topic"].length === 0) return false;
  if (o["topic"].length > TOPIC_MAX_LEN) return false;
  return "payload" in o; // payload may be null
}

function isIncomingPingMessage(x: unknown): x is IncomingPingMessage {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o["type"] !== "nw.event.ping") return false;
  if (typeof o["requestId"] !== "string" || o["requestId"].length === 0) return false;
  if (typeof o["topic"] !== "string" || o["topic"].length === 0) return false;
  if (o["topic"].length > TOPIC_MAX_LEN) return false;
  return "payload" in o; // payload may be null
}

function isIncomingMessage(x: unknown): x is IncomingMessage {
  return isIncomingStateMessage(x) || isIncomingEmitMessage(x) || isIncomingPingMessage(x);
}

function rejectsArtifactIdInMessage(x: Record<string, unknown>): boolean {
  return "artifactId" in x || "artifact_id" in x || "id" in x;
}

/**
 * Install the postMessage handler on the parent window. Returns a
 * teardown function the caller invokes on unmount.
 *
 * The handler short-circuits when `event.source` is not the bound
 * iframe (some other frame's message — ignore silently). Any other
 * malformed input from the BOUND iframe is logged as a renderer
 * console error so it surfaces via `electron_console_logs` during
 * live debug. Successful round-trips don't log (would be noisy).
 */
export function installStateBridge(opts: StateBridgeOptions): () => void {
  const { iframe, artifactId, roomId, readOnly = false } = opts;
  const handler = (event: MessageEvent): void => {
    // Source-equality check. event.source can be null after the
    // iframe unmounts; treat as "not our message" and bail.
    if (event.source !== iframe.contentWindow) return;

    const data: unknown = event.data;
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;
    const msgType = obj["type"];
    // Ignore other message kinds (e.g. devtools, framework chatter).
    if (
      msgType !== "nw.state.req" &&
      msgType !== "nw.event.emit" &&
      msgType !== "nw.event.ping"
    ) {
      return;
    }

    if (rejectsArtifactIdInMessage(obj)) {
      console.error(
        "[nw-state-bridge] rejected message with artifactId field — iframe must not address other artifacts",
        obj,
      );
      return;
    }
    if (!isIncomingMessage(obj)) {
      console.error("[nw-state-bridge] rejected malformed message", obj);
      return;
    }

    void handleRequest(obj).catch((err: unknown) => {
      console.error("[nw-state-bridge] handler threw", err);
    });
  };

  async function handleRequest(msg: IncomingMessage): Promise<void> {
    const respond = (
      payload:
        | { ok: true; value: unknown }
        | { ok: false; error: string; status?: number },
    ): void => {
      const target = iframe.contentWindow;
      if (!target) return; // unmounted between request + response
      target.postMessage(
        { type: "nw.state.res", requestId: msg.requestId, ...payload },
        "*",
      );
    };
    const scopedOpts: { roomId?: string } | undefined =
      roomId !== undefined && roomId.length > 0 ? { roomId } : undefined;

    try {
      if (
        readOnly &&
        (msg.type === "nw.event.emit" ||
          msg.type === "nw.event.ping" ||
          (msg.type === "nw.state.req" && msg.op === "set"))
      ) {
        respond({ ok: false, error: "write_artifacts_required", status: 403 });
        return;
      }
      if (msg.type === "nw.event.emit") {
        const res = await apiClient.emitArtifactEvent(
          artifactId,
          msg.topic,
          msg.payload,
          scopedOpts,
        );
        respond({ ok: true, value: res });
      } else if (msg.type === "nw.event.ping") {
        const res = await apiClient.pingArtifactEvent(
          artifactId,
          msg.topic,
          msg.payload,
          scopedOpts,
        );
        respond({ ok: true, value: res });
      } else if (msg.op === "get") {
        try {
          const res = await apiClient.getArtifactState(artifactId, msg.key, scopedOpts);
          respond({ ok: true, value: res.value });
        } catch (err: unknown) {
          // 404 → key unset; respond ok with value=undefined so the
          // iframe-side client can branch on `value === undefined`.
          const status = (err as { status?: number } | null)?.status;
          if (status === 404) {
            respond({ ok: true, value: undefined });
          } else {
            respond({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              ...(typeof status === "number" ? { status } : {}),
            });
          }
        }
      } else if (msg.op === "set") {
        const res = await apiClient.setArtifactState(
          artifactId,
          msg.key,
          msg.value,
          scopedOpts,
        );
        respond({ ok: true, value: res.value });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number } | null)?.status;
      respond({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(typeof status === "number" ? { status } : {}),
      });
    }
  }

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
