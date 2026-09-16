/**
 * M120 — recovery-session store. Verifies per-session code binding,
 * session-token-gated release, expiry, and no cross-session leakage.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createRecoverySession,
  bindCodeForEmail,
  consumeCodeForSession,
  resetRecoverySessionsForTests,
  MAX_SESSIONS,
} from "../../src/lib/logto-recovery-session";

afterEach(() => {
  resetRecoverySessionsForTests();
});

describe("recovery-session store (M120)", () => {
  test("a created session is pending until a code is bound", () => {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    expect(consumeCodeForSession(s.id, s.sessionToken)).toEqual({ status: "pending" });

    expect(bindCodeForEmail("alice@nautilo.local", "424242")).toBe(true);
    expect(consumeCodeForSession(s.id, s.sessionToken)).toMatchObject({
      status: "ready",
      code: "424242",
      firstRead: true,
    });
  });

  test("releases the code ONLY to the correct session token", () => {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    bindCodeForEmail("alice@nautilo.local", "424242");

    // Wrong token is indistinguishable from an unknown session.
    expect(consumeCodeForSession(s.id, "not-the-token")).toEqual({ status: "not_found" });
    // Unknown session id.
    expect(consumeCodeForSession("nope", s.sessionToken)).toEqual({ status: "not_found" });
  });

  test("email match is case-insensitive and trimmed", () => {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "Alice@Nautilo.Local",
      recoveryCodeRowId: "rc1",
    });
    expect(bindCodeForEmail("  alice@nautilo.local  ", "121212")).toBe(true);
    expect(consumeCodeForSession(s.id, s.sessionToken)).toMatchObject({
      status: "ready",
      code: "121212",
    });
  });

  test("does not bind to a session for a different email", () => {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    expect(bindCodeForEmail("bob@nautilo.local", "999999")).toBe(false);
    expect(consumeCodeForSession(s.id, s.sessionToken)).toEqual({ status: "pending" });
  });

  test("binds to the most-recent pending session and does not clobber an already-bound code", () => {
    let t = 1000;
    const now = () => t;
    const older = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
      now,
    });
    t = 2000;
    const newer = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc2",
      now,
    });

    // First delivery binds to the newer session.
    expect(bindCodeForEmail("alice@nautilo.local", "111111", now)).toBe(true);
    // A second delivery binds to the still-pending older session, not the newer.
    expect(bindCodeForEmail("alice@nautilo.local", "222222", now)).toBe(true);

    expect(consumeCodeForSession(newer.id, newer.sessionToken, now)).toMatchObject({
      status: "ready",
      code: "111111",
    });
    expect(consumeCodeForSession(older.id, older.sessionToken, now)).toMatchObject({
      status: "ready",
      code: "222222",
    });
  });

  test("marks only the first successful read as firstRead", () => {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    bindCodeForEmail("alice@nautilo.local", "424242");

    expect(consumeCodeForSession(s.id, s.sessionToken)).toMatchObject({
      status: "ready",
      code: "424242",
      firstRead: true,
    });
    expect(consumeCodeForSession(s.id, s.sessionToken)).toMatchObject({
      status: "ready",
      code: "424242",
      firstRead: false,
    });
  });

  test("enforces a hard cap by evicting the oldest sessions (A-5)", () => {
    let t = 1000;
    const now = () => t++;
    // Create one past the cap; the very first (oldest) session must be evicted.
    const first = createRecoverySession({
      userId: "u0",
      syntheticEmail: "first@nautilo.local",
      recoveryCodeRowId: "rc0",
      now,
    });
    for (let i = 0; i < MAX_SESSIONS; i++) {
      createRecoverySession({
        userId: `u${i + 1}`,
        syntheticEmail: `u${i + 1}@nautilo.local`,
        recoveryCodeRowId: `rc${i + 1}`,
        now,
      });
    }
    // The oldest session was evicted; a later one survives.
    expect(consumeCodeForSession(first.id, first.sessionToken)).toEqual({
      status: "not_found",
    });
  });

  test("expired sessions are not found and cannot receive a code", () => {
    let t = 1000;
    const now = () => t;
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
      now,
    });
    t = 1000 + 11 * 60 * 1000; // past the 10-minute TTL
    expect(bindCodeForEmail("alice@nautilo.local", "333333", now)).toBe(false);
    expect(consumeCodeForSession(s.id, s.sessionToken, now)).toEqual({ status: "not_found" });
  });
});
