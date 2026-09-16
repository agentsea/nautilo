import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * M120 — short-lived recovery sessions for the HTTP Email connector relay.
 *
 * This module is the product replacement for the Phase 0 spike's global
 * "last code" stash. A recovery session is created only after the caller
 * proves a Nautilo recovery code (see `logto-recover-with-code.ts`). Logto's
 * ForgotPassword verification code (delivered through the `http-email`
 * connector to `POST /api/internal/logto/email-webhook`) is bound to the
 * pending session whose synthetic email matches the webhook `to`, and is
 * released ONLY to the holder of that session's unguessable `sessionToken`.
 *
 * Security invariants:
 * - The Logto verification `code` is never logged and never returned by any
 *   endpoint that is not authenticated with the session token.
 * - A bare `handle` or `sessionId` can never reveal a code; the `sessionToken`
 *   bearer is required and compared in constant time.
 * - Sessions and bound codes expire quickly (TTL below); expiry is a feature
 *   loss (user restarts recovery), not a security hole.
 *
 * Storage is a process-local `Map` on purpose: recovery is a single-server,
 * seconds-to-minutes interactive flow, and there is no DB schema change
 * (M120 Requirement 8). A relayed code that does not survive a server restart
 * is acceptable.
 */

const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_ID_BYTES = 18;
const SESSION_TOKEN_BYTES = 32;
/**
 * Hard cap on concurrent recovery sessions (A-5 process-lifetime-map rule).
 * In practice bounded far below this by the localhost-only + 24/15min-per-IP
 * rate limit on `recover-with-code`, but an explicit cap keeps the store from
 * growing without bound. When exceeded we evict the oldest sessions.
 */
export const MAX_SESSIONS = 2000;

export interface RecoverySession {
  readonly id: string;
  readonly sessionToken: string;
  readonly syntheticEmail: string;
  readonly userId: string;
  readonly recoveryCodeRowId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  code?: string;
  codeReceivedAt?: number;
  codeConsumedAt?: number;
}

export interface CreatedRecoverySession {
  readonly id: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
}

export type ConsumeCodeResult =
  | {
      status: "ready";
      code: string;
      userId: string;
      recoveryCodeRowId: string;
      firstRead: boolean;
    }
  | { status: "pending" }
  | { status: "not_found" };

const sessionsById = new Map<string, RecoverySession>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isExpired(session: RecoverySession, now: number): boolean {
  return now >= session.expiresAt;
}

function pruneExpired(now: number): void {
  for (const [id, session] of sessionsById) {
    if (isExpired(session, now)) {
      sessionsById.delete(id);
    }
  }
}

/**
 * Enforce the {@link MAX_SESSIONS} cap by evicting the oldest sessions
 * (by `createdAt`) until under the cap. Call AFTER {@link pruneExpired} and
 * BEFORE inserting a new session, so the freshest in-flight recoveries win.
 */
function evictToCap(): void {
  if (sessionsById.size < MAX_SESSIONS) return;
  const oldestFirst = [...sessionsById.values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  const toEvict = sessionsById.size - MAX_SESSIONS + 1;
  for (let i = 0; i < toEvict && i < oldestFirst.length; i++) {
    const victim = oldestFirst[i];
    if (victim) sessionsById.delete(victim.id);
  }
}

/**
 * Create a pending recovery session after a successful Nautilo recovery-code
 * proof. Returns the opaque `id` (safe to surface to the client for polling)
 * and the secret `sessionToken` (bearer required to read the relayed code).
 */
export function createRecoverySession(args: {
  userId: string;
  syntheticEmail: string;
  recoveryCodeRowId: string;
  now?: () => number;
}): CreatedRecoverySession {
  const now = (args.now ?? Date.now)();
  pruneExpired(now);
  evictToCap();

  const id = randomBytes(SESSION_ID_BYTES).toString("base64url");
  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;

  sessionsById.set(id, {
    id,
    sessionToken,
    syntheticEmail: normalizeEmail(args.syntheticEmail),
    userId: args.userId,
    recoveryCodeRowId: args.recoveryCodeRowId,
    createdAt: now,
    expiresAt,
  });

  return { id, sessionToken, expiresAt };
}

/**
 * Bind a Logto-delivered verification code to the most-recent pending,
 * unexpired session whose synthetic email matches `email`. Returns whether a
 * session matched so the webhook can record a redacted warning on a miss.
 *
 * Does not overwrite an already-bound code (first webhook wins) to avoid a
 * later resend clobbering a code the user is mid-entry on.
 */
export function bindCodeForEmail(
  email: string,
  code: string,
  now: () => number = Date.now,
): boolean {
  const ts = now();
  pruneExpired(ts);

  const target = normalizeEmail(email);
  let best: RecoverySession | undefined;
  for (const session of sessionsById.values()) {
    if (session.syntheticEmail !== target) continue;
    if (session.code !== undefined) continue;
    if (isExpired(session, ts)) continue;
    if (!best || session.createdAt > best.createdAt) {
      best = session;
    }
  }

  if (!best) return false;
  best.code = code;
  best.codeReceivedAt = ts;
  return true;
}

/**
 * Read the relayed code for a session, authenticated by `sessionToken`.
 * Constant-time token compare. `not_found` is returned both for an unknown
 * session id and for a token mismatch (no oracle on which one failed).
 */
export function consumeCodeForSession(
  sessionId: string,
  sessionToken: string,
  now: () => number = Date.now,
): ConsumeCodeResult {
  const ts = now();
  pruneExpired(ts);

  const session = sessionsById.get(sessionId);
  if (!session || isExpired(session, ts)) {
    return { status: "not_found" };
  }
  if (!safeEqual(sessionToken, session.sessionToken)) {
    return { status: "not_found" };
  }
  if (session.code === undefined) {
    return { status: "pending" };
  }
  const firstRead = session.codeConsumedAt === undefined;
  if (firstRead) {
    session.codeConsumedAt = ts;
  }
  return {
    status: "ready",
    code: session.code,
    userId: session.userId,
    recoveryCodeRowId: session.recoveryCodeRowId,
    firstRead,
  };
}

export function consumedRecoverySessionBelongsToUser(
  args: {
    sessionId: string;
    sessionToken: string;
    userId: string;
  },
  now: () => number = Date.now,
): boolean {
  const ts = now();
  pruneExpired(ts);

  const session = sessionsById.get(args.sessionId);
  if (!session || isExpired(session, ts)) return false;
  if (session.userId !== args.userId) return false;
  if (session.codeConsumedAt === undefined) return false;
  return safeEqual(args.sessionToken, session.sessionToken);
}

export function resetRecoverySessionsForTests(): void {
  sessionsById.clear();
}

function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
