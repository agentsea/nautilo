/**
 * D362 §3.4.6 — hermetic unit tests for the office session lifecycle
 * manager (`session-manager.ts`).
 *
 * Mock strategy: fake `CoolSessionLike` instances with controllable
 * `isAlive`, recorded `connect`/`close` calls. No real WebSockets, no
 * `@nautilo/loffice` mock — the manager only depends on the
 * `CoolSessionLike` surface + the `OfficeSessionMint` shape, both
 * typed-only imports.
 *
 * Cases (per task spec):
 *   (a) 2nd acquire same key reuses → 1 connect total.
 *   (b) dead cached session → fresh connect.
 *   (c) idle TTL (tiny) closes + evicts.
 *   (d) invalidate closes + evicts.
 *   (e) concurrent acquire same key → 1 connect (shared in-flight).
 *   (f) LRU evict at cap (cap overridable).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoolSessionLike, CoolSessionOptions, UnoArgs } from "@nautilo/loffice";
import {
  createOfficeSessionManager,
  type OfficeSessionManager,
} from "./session-manager";
import type { OfficeSessionMint } from "./session-broker";

// ─── Fake session ────────────────────────────────────────────────────
// Records connect/close calls; `isAlive()` reads a mutable flag so tests
// can simulate a live or dead WS without a real socket.

interface FakeSession {
  connectCalls: number;
  closeCalls: number;
  setAlive(v: boolean): void;
}

function makeFakeSession(): CoolSessionLike & FakeSession {
  let alive = true;
  let connectCalls = 0;
  let closeCalls = 0;
  const s: CoolSessionLike & FakeSession = {
    async connect() {
      connectCalls++;
    },
    sendUno(_command: string, _args?: UnoArgs) {
      /* no-op */
    },
    async sendUnoAndWait(_command: string, _args?: UnoArgs) {
      return { commandName: _command, success: true };
    },
    async save() {
      /* no-op */
    },
    requestSave() {
      /* no-op */
    },
    saveToStorage() {
      /* no-op */
    },
    setClientPart() {
      /* no-op: session-manager tests don't exercise part switching */
    },
    sendMouse() {
      /* no-op: session-manager tests don't exercise mouse events */
    },
    sendTextInput() {
      /* no-op: session-manager tests don't exercise text input */
    },
    async getChildId() {
      /* no-op: session-manager tests don't exercise image insert */
      return "fake-child-id";
    },
    async postInsertFile() {
      /* no-op: session-manager tests don't exercise image insert */
    },
    sendInsertFile() {
      /* no-op: session-manager tests don't exercise image insert */
    },
    close() {
      closeCalls++;
    },
    isAlive() {
      return alive;
    },
    setAlive(v: boolean) {
      alive = v;
    },
    get connectCalls() {
      return connectCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
  return s;
}

const FAKE_MINT: OfficeSessionMint = {
  wsBaseUrl: "ws://fake:9980",
  docUrl: "http://host/wopi/files/abc?access_token=tok",
  wopiSrc: "http://host/wopi/files/abc",
  serviceRoot: "/office-engine",
  origin: "http://127.0.0.1:9999",
};

function makeMint(): () => Promise<OfficeSessionMint | { error: string }> {
  return async () => FAKE_MINT;
}

let manager: OfficeSessionManager | null = null;
// Track all fake sessions created by the `make` factory in a test so we
// can assert per-session connect/close counts.
let created: Array<CoolSessionLike & FakeSession> = [];

beforeEach(() => {
  created = [];
  manager = null;
});

afterEach(() => {
  if (manager) manager.closeAll();
  manager = null;
});

// `make` factory: returns a fresh fake session, records it in `created`.
function make(opts: CoolSessionOptions): CoolSessionLike {
  void opts;
  const s = makeFakeSession();
  created.push(s);
  return s;
}

describe("OfficeSessionManager", () => {
  test("(a) 2nd acquire same key reuses the cached session (1 connect total)", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 60_000, maxSessions: 8 });
    const k = "row-1";
    const s1 = await manager.acquire(k, makeMint(), make);
    expect("isAlive" in s1).toBe(true);
    const s2 = await manager.acquire(k, makeMint(), make);
    expect(s2).toBe(s1);
    // Only ONE session was created → only one connect.
    expect(created).toHaveLength(1);
    expect(created[0]!.connectCalls).toBe(1);
  });

  test("(b) dead cached session → drop + fresh connect", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 60_000, maxSessions: 8 });
    const k = "row-2";
    const s1 = await manager.acquire(k, makeMint(), make);
    // Simulate engine restart: the cached WS is no longer OPEN.
    created[0]!.setAlive(false);
    const s2 = await manager.acquire(k, makeMint(), make);
    expect(s2).not.toBe(s1);
    // The dead session was closed (evicted), and a fresh one connected.
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(created).toHaveLength(2);
    expect(created[1]!.connectCalls).toBe(1);
  });

  test("(c) idle TTL closes + evicts the session", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 40, maxSessions: 8 });
    const k = "row-3";
    const s1 = await manager.acquire(k, makeMint(), make);
    // Wait for the idle timer to fire (40ms + slack).
    await new Promise((r) => setTimeout(r, 120));
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    // A subsequent acquire must create a fresh session (cache was evicted).
    const s2 = await manager.acquire(k, makeMint(), make);
    expect(s2).not.toBe(s1);
    expect(created).toHaveLength(2);
  });

  test("(d) invalidate closes + evicts", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 60_000, maxSessions: 8 });
    const k = "row-4";
    await manager.acquire(k, makeMint(), make);
    manager.invalidate(k);
    expect(created[0]!.closeCalls).toBe(1);
    // Re-acquire → fresh session.
    await manager.acquire(k, makeMint(), make);
    expect(created).toHaveLength(2);
  });

  test("(e) concurrent acquire same key → 1 connect (shared in-flight)", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 60_000, maxSessions: 8 });
    const k = "row-5";
    // The two acquires overlap: the second hits the in-flight promise
    // before the first resolves (microtask ordering). Promise.all kicks
    // both off in the same tick.
    const [p1, p2] = await Promise.all([
      manager.acquire(k, makeMint(), make),
      manager.acquire(k, makeMint(), make),
    ]);
    expect(p1).toBe(p2);
    expect(created).toHaveLength(1);
    expect(created[0]!.connectCalls).toBe(1);
  });

  test("(f) LRU evict at cap (cap overridable)", async () => {
    manager = createOfficeSessionManager({ idleTtlMs: 60_000, maxSessions: 2 });
    const k1 = "row-a";
    const k2 = "row-b";
    const k3 = "row-c";
    await manager.acquire(k1, makeMint(), make);
    await manager.acquire(k2, makeMint(), make);
    // Cache is at cap (2). Acquiring a third key must LRU-evict k1
    // (least-recently-used) — its session is closed.
    await manager.acquire(k3, makeMint(), make);
    expect(created[0]!.closeCalls).toBe(1);
    // k2 and k3 should still be cached (reused, no new connects).
    await manager.acquire(k2, makeMint(), make);
    await manager.acquire(k3, makeMint(), make);
    expect(created).toHaveLength(3);
  });
});
