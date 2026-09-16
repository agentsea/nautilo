import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "@nautilo/logger";

export type SessionRecord = {
  token: string;
  /**
   * The Actor acting on this session (polymorphic Participant —
   * user-kind today, agent-kind when M040 lands the multi-actor
   * flow). Used for memory attribution + audit rows.
   */
  actorId: string;
  /**
   * Server owner\u0027s user id — the Humans.id of whoever owns this
   * Nautilo install. Threaded through pre-M043 for memory access
   * scoping + resource ownership. NOT the "authenticated user\u0027s
   * user id" — for that, see `userId` below.
   */
  ownerId: string;
  /**
   * Authenticated user\u0027s user id (post-M043 `users.id` FK target).
   * For owner sessions today this equals `ownerId`; when household /
   * teammate sessions ship, this will be the session user\u0027s own
   * user id while `ownerId` stays the server owner\u0027s id.
   *
   * Consumed by D060 G5.5 `PUT /api/security/posture` for
   * Capability lookup + PIN verify — both are user-id keyed
   * post-M043.
   */
  userId: string;
  createdAt: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function defaultPersistPath(): string {
  return join(homedir(), ".nautilo", "sessions.json");
}

export type SessionStoreOptions = {
  persistPath?: string | null;
  /**
   * D041 - invoked when the in-memory session map becomes empty after
   * `revokeSession`, expiry eviction in `validateSession`, or the
   * periodic cleanup sweep. Used to lock the Connection vault + clear
   * registered redaction secrets so ciphertext keys leave RAM.
   */
  onLastSessionCleared?: () => void;
};

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly persistPath: string | null;
  private readonly onLastSessionCleared: (() => void) | undefined;

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    options?: SessionStoreOptions,
  ) {
    this.persistPath = options?.persistPath !== undefined
      ? options.persistPath
      : defaultPersistPath();
    this.onLastSessionCleared = options?.onLastSessionCleared;

    this.loadFromDisk();
  }

  private notifyIfNoSessions(): void {
    if (this.sessions.size === 0) {
      this.onLastSessionCleared?.();
    }
  }

  /**
   * Create a session. `userId` is REQUIRED — every caller must
   * consciously decide which authenticated user the session
   * represents. For owner auth flows (auth.ts today) this equals
   * `ownerId`. For future household / teammate flows, it will be
   * the household member\u0027s own user id while `ownerId` stays the
   * server owner\u0027s id.
   *
   * Keeping the param required (rather than defaulting to ownerId)
   * prevents a future non-owner endpoint from silently inheriting
   * the server owner\u0027s user id — the D060 Sprint 1 self-review
   * called this out as a footgun.
   */
  createSession(
    actorId: string,
    ownerId: string,
    userId: string,
  ): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      token: randomUUID(),
      actorId,
      ownerId,
      userId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(record.token, record);
    this.saveToDisk();
    return record;
  }

  validateSession(token: string): SessionRecord | null {
    const record = this.sessions.get(token);
    if (!record) return null;
    if (Date.now() >= record.expiresAt) {
      this.sessions.delete(token);
      this.saveToDisk();
      this.notifyIfNoSessions();
      return null;
    }
    return record;
  }

  revokeSession(token: string): boolean {
    const deleted = this.sessions.delete(token);
    if (deleted) {
      this.saveToDisk();
      this.notifyIfNoSessions();
    }
    return deleted;
  }

  get size(): number {
    return this.sessions.size;
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [token, record] of this.sessions) {
        if (now >= record.expiresAt) {
          this.sessions.delete(token);
          changed = true;
        }
      }
      if (changed) {
        this.saveToDisk();
        this.notifyIfNoSessions();
      }
    }, CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const entries = JSON.parse(raw) as SessionRecord[];
      const now = Date.now();
      // PR-017 MINOR #7 — count legacy-session backfills so an
      // operator can see at a glance on the first post-upgrade
      // boot how many sessions needed normalization. A silent
      // migration here is exactly the class H-003 warns about;
      // one log line per startup makes the rollout inspectable.
      let backfillCount = 0;
      for (const record of entries) {
        if (record.token && record.expiresAt > now) {
          // Backfill `userId` for sessions persisted before the
          // D060 G5 multi-user threading — older records only had
          // (actorId, ownerId). Treat userId === ownerId as the
          // legacy default; matches what createSession produces
          // when the third arg is omitted. Safe today because
          // only owner sessions existed pre-G5; household sessions
          // would never hit this branch (they didn't exist).
          if (record.userId === undefined) {
            backfillCount++;
          }
          const normalized: SessionRecord = {
            ...record,
            userId: record.userId ?? record.ownerId,
          };
          this.sessions.set(normalized.token, normalized);
        }
      }
      if (backfillCount > 0) {
        log(
          `[session-store] backfilled userId=ownerId on ${backfillCount} ` +
            `legacy session record(s) loaded from ${this.persistPath} ` +
            `(D060 G5 pre-multi-user threading migration). Safe: owner ` +
            `sessions are the only pre-G5 shape that hit this branch. ` +
            `Persisting normalized shape now so subsequent loads observe ` +
            `0 backfills (idempotent — no-op on future boots).`,
        );
        // Persist the normalized shape immediately so a short-lived
        // process that never mutates sessions (e.g. a CLI one-shot
        // or a crash before first createSession) still flushes the
        // backfill to disk. Idempotent: runs exactly once per record
        // across all future boots.
        this.saveToDisk();
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = this.persistPath.replace(/[/\\][^/\\]+$/, "");
      mkdirSync(dir, { recursive: true });
      const entries = Array.from(this.sessions.values());
      writeFileSync(this.persistPath, JSON.stringify(entries, null, 2), "utf-8");
    } catch {
      // Best-effort — don't crash if we can't write
    }
  }
}
