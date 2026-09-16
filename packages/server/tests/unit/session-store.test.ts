import { describe, test, expect } from "bun:test";
import { SessionStore } from "../helpers/test-session-store";

describe("SessionStore", () => {
  test("createSession returns a record with token", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    const session = store.createSession("actor-1", "owner-1", "owner-1");
    expect(session.token).toBeTruthy();
    expect(session.actorId).toBe("actor-1");
    expect(session.ownerId).toBe("owner-1");
    expect(session.expiresAt).toBeGreaterThan(session.createdAt);
  });

  test("validateSession returns the session for a valid token", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    const session = store.createSession("actor-1", "owner-1", "owner-1");
    const result = store.validateSession(session.token);
    expect(result).not.toBeNull();
    expect(result!.actorId).toBe("actor-1");
  });

  test("validateSession returns null for unknown token", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    const result = store.validateSession("nonexistent-token");
    expect(result).toBeNull();
  });

  test("validateSession returns null for expired token", () => {
    const store = new SessionStore(1, { persistPath: null }); // 1ms TTL
    const session = store.createSession("actor-1", "owner-1", "owner-1");

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const result = store.validateSession(session.token);
    expect(result).toBeNull();
  });

  test("revokeSession removes the session", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    const session = store.createSession("actor-1", "owner-1", "owner-1");
    expect(store.validateSession(session.token)).not.toBeNull();

    store.revokeSession(session.token);
    expect(store.validateSession(session.token)).toBeNull();
  });

  test("size tracks active sessions", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    expect(store.size).toBe(0);

    store.createSession("actor-1", "owner-1", "owner-1");
    expect(store.size).toBe(1);

    const s2 = store.createSession("actor-2", "owner-1", "owner-1");
    expect(store.size).toBe(2);

    store.revokeSession(s2.token);
    expect(store.size).toBe(1);
  });

  test("multiple sessions can exist for the same actor", () => {
    const store = new SessionStore(undefined, { persistPath: null });
    const s1 = store.createSession("actor-1", "owner-1", "owner-1");
    const s2 = store.createSession("actor-1", "owner-1", "owner-1");

    expect(s1.token).not.toBe(s2.token);
    expect(store.validateSession(s1.token)).not.toBeNull();
    expect(store.validateSession(s2.token)).not.toBeNull();
  });

  test("onLastSessionCleared fires when the last session is revoked", () => {
    let cleared = 0;
    const store = new SessionStore(undefined, {
      persistPath: null,
      onLastSessionCleared: () => {
        cleared++;
      },
    });
    const first = store.createSession("actor-1", "owner-1", "owner-1");
    const second = store.createSession("actor-2", "owner-1", "owner-1");
    store.revokeSession(first.token);
    expect(cleared).toBe(0);
    store.revokeSession(second.token);
    expect(cleared).toBe(1);
  });
});
