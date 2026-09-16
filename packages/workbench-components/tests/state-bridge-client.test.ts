/**
 * D121-P3 — iframe-side `nwState` client tests.
 *
 * Pins the postMessage round-trip contract: requestId pairing,
 * source-equality on responses, timeout behavior, and that the
 * request envelope shape matches what the parent-side bridge
 * accepts (parent rejects anything else).
 */

import { describe, expect, test, beforeEach } from "vitest";
import { installNwState } from "../src/state-bridge-client";

interface CapturedMessage {
  type: string;
  requestId: string;
  op?: string;
  key?: string;
  value?: unknown;
  topic?: string;
  payload?: unknown;
}

interface TestState {
  capturedMessages: CapturedMessage[];
  origPostMessage: typeof Window.prototype.postMessage;
}

function setupParentStub(state: TestState): void {
  state.origPostMessage = window.parent.postMessage.bind(window.parent);
  window.parent.postMessage = (message: unknown) => {
    state.capturedMessages.push(message as CapturedMessage);
  };
}

function teardownParentStub(state: TestState): void {
  window.parent.postMessage = state.origPostMessage;
}

function respondAsParent(requestId: string, payload: object): void {
  const event = new MessageEvent("message", {
    data: { type: "nw.state.res", requestId, ...payload },
    source: window.parent,
  });
  window.dispatchEvent(event);
}

describe("D121-P3 nwState client (iframe side)", () => {
  let state: TestState;

  beforeEach(() => {
    delete (window as { nwState?: unknown }).nwState;
    state = { capturedMessages: [], origPostMessage: window.parent.postMessage };
    setupParentStub(state);
    installNwState();
  });

  test("installs window.nwState exposing get / set / emit / ping", () => {
    expect(typeof window.nwState).toBe("object");
    expect(typeof window.nwState?.get).toBe("function");
    expect(typeof window.nwState?.set).toBe("function");
    expect(typeof window.nwState?.emit).toBe("function");
    expect(typeof window.nwState?.ping).toBe("function");
  });

  test("get(): posts a {type, requestId, op:'get', key} request envelope", async () => {
    const p = window.nwState!.get("foo");
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nw.state.req");
    expect(msg.op).toBe("get");
    expect(msg.key).toBe("foo");
    expect(typeof msg.requestId).toBe("string");
    expect(msg.requestId.length).toBeGreaterThan(0);
    expect("artifactId" in msg).toBe(false);
    respondAsParent(msg.requestId, { ok: true, value: 42 });
    await expect(p).resolves.toBe(42);
    teardownParentStub(state);
  });

  test("set(): posts a {type, requestId, op:'set', key, value} request envelope", async () => {
    const p = window.nwState!.set("counter", 7);
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.op).toBe("set");
    expect(msg.key).toBe("counter");
    expect(msg.value).toBe(7);
    respondAsParent(msg.requestId, { ok: true, value: 7 });
    await expect(p).resolves.toBeUndefined();
    teardownParentStub(state);
  });

  test("multiple in-flight requests pair by requestId", async () => {
    const a = window.nwState!.get("a");
    const b = window.nwState!.get("b");
    expect(state.capturedMessages.length).toBe(2);
    const idA = state.capturedMessages[0]!.requestId;
    const idB = state.capturedMessages[1]!.requestId;
    expect(idA).not.toBe(idB);
    // Respond out of order
    respondAsParent(idB, { ok: true, value: "valueB" });
    respondAsParent(idA, { ok: true, value: "valueA" });
    await expect(a).resolves.toBe("valueA");
    await expect(b).resolves.toBe("valueB");
    teardownParentStub(state);
  });

  test("ok:false response rejects with the server error string + status", async () => {
    const p = window.nwState!.get("forbidden");
    const id = state.capturedMessages[0]!.requestId;
    respondAsParent(id, { ok: false, error: "No writable namespace", status: 403 });
    await expect(p).rejects.toThrow(/403.*No writable namespace/);
    teardownParentStub(state);
  });

  test("rejects empty-key calls before posting", async () => {
    // `get` and `set` are async; synchronous throws inside an async
    // function surface as Promise rejections, not synchronous throws.
    await expect(window.nwState!.get("")).rejects.toThrow(/non-empty string/);
    await expect(window.nwState!.set("", 1)).rejects.toThrow(/non-empty string/);
    expect(state.capturedMessages.length).toBe(0);
    teardownParentStub(state);
  });

  test("emit(): posts {type, requestId, topic, payload} without artifactId", async () => {
    const p = window.nwState!.emit("quiz_submitted", { score: 9 });
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nw.event.emit");
    expect(msg.topic).toBe("quiz_submitted");
    expect(msg.payload).toEqual({ score: 9 });
    expect(typeof msg.requestId).toBe("string");
    expect(msg.requestId.length).toBeGreaterThan(0);
    expect("artifactId" in msg).toBe(false);
    expect("id" in msg).toBe(false);
    expect("op" in msg).toBe(false);
    respondAsParent(msg.requestId, { ok: true, value: { enqueued: true } });
    await expect(p).resolves.toBeUndefined();
    teardownParentStub(state);
  });

  test("emit(): rejects empty or oversized topic before posting", async () => {
    await expect(window.nwState!.emit("", {})).rejects.toThrow(/non-empty string/);
    await expect(window.nwState!.emit("x".repeat(129), {})).rejects.toThrow(/at most 128/);
    expect(state.capturedMessages.length).toBe(0);
    teardownParentStub(state);
  });

  test("emit(): rejects non-JSON-serializable payload before posting", async () => {
    await expect(window.nwState!.emit("t", undefined)).rejects.toThrow(/JSON-serializable/);
    await expect(window.nwState!.emit("t", () => {})).rejects.toThrow(/JSON-serializable/);
    expect(state.capturedMessages.length).toBe(0);
    teardownParentStub(state);
  });

  test("emit(): multiple in-flight requests pair by requestId", async () => {
    const a = window.nwState!.emit("a", { n: 1 });
    const b = window.nwState!.emit("b", { n: 2 });
    expect(state.capturedMessages.length).toBe(2);
    const idA = state.capturedMessages[0]!.requestId;
    const idB = state.capturedMessages[1]!.requestId;
    expect(idA).not.toBe(idB);
    respondAsParent(idB, { ok: true, value: "b" });
    respondAsParent(idA, { ok: true, value: "a" });
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    teardownParentStub(state);
  });

  test("ping(): posts {type, requestId, topic, payload} without artifactId", async () => {
    const p = window.nwState!.ping("form_submitted", { ok: true });
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nw.event.ping");
    expect(msg.topic).toBe("form_submitted");
    expect(msg.payload).toEqual({ ok: true });
    expect(typeof msg.requestId).toBe("string");
    expect(msg.requestId.length).toBeGreaterThan(0);
    expect("artifactId" in msg).toBe(false);
    expect("id" in msg).toBe(false);
    expect("op" in msg).toBe(false);
    respondAsParent(msg.requestId, { ok: true, value: { woke: true } });
    await expect(p).resolves.toBeUndefined();
    teardownParentStub(state);
  });

  test("ping(): rejects empty or oversized topic before posting", async () => {
    await expect(window.nwState!.ping("", {})).rejects.toThrow(/non-empty string/);
    await expect(window.nwState!.ping("x".repeat(129), {})).rejects.toThrow(/at most 128/);
    expect(state.capturedMessages.length).toBe(0);
    teardownParentStub(state);
  });

  test("ping(): rejects non-JSON-serializable payload before posting", async () => {
    await expect(window.nwState!.ping("t", undefined)).rejects.toThrow(/JSON-serializable/);
    await expect(window.nwState!.ping("t", () => {})).rejects.toThrow(/JSON-serializable/);
    expect(state.capturedMessages.length).toBe(0);
    teardownParentStub(state);
  });

  test("ping(): multiple in-flight requests pair by requestId", async () => {
    const a = window.nwState!.ping("a", { n: 1 });
    const b = window.nwState!.ping("b", { n: 2 });
    expect(state.capturedMessages.length).toBe(2);
    const idA = state.capturedMessages[0]!.requestId;
    const idB = state.capturedMessages[1]!.requestId;
    expect(idA).not.toBe(idB);
    respondAsParent(idB, { ok: true, value: { woke: false } });
    respondAsParent(idA, { ok: true, value: { woke: true } });
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    teardownParentStub(state);
  });

  test("response from a non-parent source is IGNORED", async () => {
    const p = window.nwState!.get("key");
    const id = state.capturedMessages[0]!.requestId;
    // Synthetic message from a foreign source (null) — must NOT
    // resolve the pending promise.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "nw.state.res", requestId: id, ok: true, value: "spoof" },
        source: null,
      }),
    );
    // Real parent response — resolves normally.
    respondAsParent(id, { ok: true, value: "real" });
    await expect(p).resolves.toBe("real");
    teardownParentStub(state);
  });

  test("malformed response envelopes are silently dropped", async () => {
    const p = window.nwState!.get("key");
    const id = state.capturedMessages[0]!.requestId;
    // Missing `ok` field — invalid envelope.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "nw.state.res", requestId: id, value: "incomplete" },
        source: window.parent,
      }),
    );
    // Pending still resolves on the real response.
    respondAsParent(id, { ok: true, value: "valid" });
    await expect(p).resolves.toBe("valid");
    teardownParentStub(state);
  });
});
