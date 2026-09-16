import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { eq, and, getSharedDirectDb, credentials, withTrustContext } from "@nautilo/db";
import { hashPin, verifyPin } from "./pin-hash";

/**
 * D168 P3 — `PinChallengeProvider` is the credentials chokepoint.
 *
 * Every read/write against `credentials` (PIN values) in the runtime
 * code path goes through this class. The `verify-identity.ts` agent
 * tool calls `isEnrolled()` here instead of querying credentials
 * directly; the lint rule in `eslint.config.mjs` bans
 * `import { credentials } from "@nautilo/db"` from anywhere outside
 * this file, tests, and the operator's `bin/nautilo-reset-pin/` CLI.
 *
 * Once migration `0051_d168_p3_force_rls_credentials.sql` lands,
 * `ALTER TABLE credentials FORCE ROW LEVEL SECURITY` makes the Path C
 * RLS policy fire even for the `nautilo` superuser role (which
 * `getSharedDirectDb()` uses — the `nautilo_agent` role has no GRANT on
 * `credentials` per D129 P3). Every method here MUST wrap its DB ops
 * in `withTrustContext({ userId })` so the policy lets the caller's
 * row through.
 *
 * Forgetting to wrap = 0 rows returned (fail-closed at runtime, NOT
 * silent). The smoke test asserts `relforcerowsecurity=true` so a
 * future engineer who flips FORCE off accidentally trips a tripwire
 * BEFORE the security boundary degrades.
 */

// ---------------------------------------------------------------------------
// ChallengeProvider — abstract identity verification mechanism
// ---------------------------------------------------------------------------
//
// M043: challenges key on `users.id`. PINs / passkeys / future
// credentials belong to the Human Subject — Agents don't authenticate.
// Pre-M043 the id parameter was an `actors.id`; the interface is now
// `userId` to match the `credentials.user_id` FK.

export interface ChallengeProvider {
  isEnrolled(userId: string): Promise<boolean>;
  verifyProof(userId: string, proof: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Lockout schedule — exponential backoff
// Each entry is: { after this many cumulative failures, lock for this long }
// ---------------------------------------------------------------------------

const LOCKOUT_SCHEDULE: Array<{ failures: number; durationMs: number }> = [
  { failures: 5,  durationMs: 30_000 },               // 30 seconds
  { failures: 10, durationMs: 5 * 60_000 },            // 5 minutes
  { failures: 15, durationMs: 60 * 60_000 },           // 1 hour
  { failures: 20, durationMs: 24 * 60 * 60_000 },      // 24 hours
  { failures: 25, durationMs: 7 * 24 * 60 * 60_000 },  // 7 days
];

function lockoutDurationForFailures(totalFailures: number): number {
  // Walk schedule in reverse — find the highest threshold we've crossed
  for (let i = LOCKOUT_SCHEDULE.length - 1; i >= 0; i--) {
    if (totalFailures >= LOCKOUT_SCHEDULE[i]!.failures) {
      return LOCKOUT_SCHEDULE[i]!.durationMs;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// PinChallengeProvider — PIN-based authentication
// ---------------------------------------------------------------------------

type LockoutRecord = {
  totalFailures: number;
  lockedUntil: number | null;
};

function defaultLockoutPath(): string {
  return join(homedir(), ".nautilo", "lockout.json");
}

export class PinChallengeProvider implements ChallengeProvider {
  private lockouts = new Map<string, LockoutRecord>();
  private readonly persistPath: string | null;

  constructor(options?: { persistPath?: string | null }) {
    this.persistPath = options?.persistPath !== undefined
      ? options.persistPath
      : defaultLockoutPath();

    this.loadFromDisk();
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const db = getSharedDirectDb();
    return await withTrustContext({ userId }, async (tx) => {
      const [row] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")))
        .limit(1);
      return !!row;
    }, db);
  }

  async enroll(userId: string, pin: string): Promise<void> {
    const db = getSharedDirectDb();
    await withTrustContext({ userId }, async (tx) => {
      const existing = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")))
        .limit(1);

      if (existing.length > 0) {
        throw new PinAlreadyEnrolledError();
      }

      const hashed = await hashPin(pin);
      await tx.insert(credentials).values({
        userId,
        type: "pin",
        value: hashed,
      });
    }, db);
  }

  async verifyProof(userId: string, proof: string): Promise<boolean> {
    if (this.isLockedOut(userId)) {
      throw new LockoutError(this.lockoutRemainingMs(userId));
    }

    const db = getSharedDirectDb();
    const row = await withTrustContext({ userId }, async (tx) => {
      const [r] = await tx
        .select({ value: credentials.value })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")))
        .limit(1);
      return r;
    }, db);

    if (!row) return false;

    const valid = await verifyPin(proof, row.value);
    if (valid) {
      this.resetLockout(userId);
    } else {
      this.recordFailure(userId);
    }
    return valid;
  }

  async changePin(userId: string, currentPin: string, newPin: string): Promise<void> {
    const valid = await this.verifyProof(userId, currentPin);
    if (!valid) throw new InvalidPinError();

    const hashed = await hashPin(newPin);
    const db = getSharedDirectDb();
    await withTrustContext({ userId }, async (tx) => {
      await tx
        .update(credentials)
        .set({ value: hashed, updatedAt: new Date() })
        .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")));
    }, db);
  }

  /**
   * M101 — overwrite the enrolled PIN when the HTTP route has already
   * enforced a fresh Logto access token (`max_age` step-up). Skips
   * `verifyProof` / lockout counters (the IdP re-auth is the proof).
   */
  async setPinAfterFreshJwt(userId: string, newPin: string): Promise<void> {
    const hashed = await hashPin(newPin);
    const db = getSharedDirectDb();
    // Single transaction: probe-then-update-or-insert all within
    // one trust-context wrapper so the GUC is set once and we avoid
    // a race between two separate transactions.
    await withTrustContext({ userId }, async (tx) => {
      const [existing] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")))
        .limit(1);

      if (existing) {
        await tx
          .update(credentials)
          .set({ value: hashed, updatedAt: new Date() })
          .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")));
      } else {
        await tx.insert(credentials).values({
          userId,
          type: "pin",
          value: hashed,
        });
      }
    }, db);
  }

  // -------------------------------------------------------------------------
  // Lockout logic — exponential backoff with cumulative failure tracking
  // Keys are opaque — pre-M043 lockout records on disk keyed on actor id
  // will age out naturally on their next expiry (lockouts are transient).
  // -------------------------------------------------------------------------

  isLockedOut(userId: string): boolean {
    const record = this.lockouts.get(userId);
    if (!record?.lockedUntil) return false;
    if (Date.now() >= record.lockedUntil) {
      // Lockout window expired — clear the window but keep failure count
      record.lockedUntil = null;
      this.lockouts.set(userId, record);
      this.saveToDisk();
      return false;
    }
    return true;
  }

  lockoutRemainingMs(userId: string): number {
    const record = this.lockouts.get(userId);
    if (!record?.lockedUntil) return 0;
    return Math.max(0, record.lockedUntil - Date.now());
  }

  private recordFailure(userId: string): void {
    const record = this.lockouts.get(userId) ?? { totalFailures: 0, lockedUntil: null };
    record.totalFailures += 1;

    const duration = lockoutDurationForFailures(record.totalFailures);
    if (duration > 0) {
      record.lockedUntil = Date.now() + duration;
    }

    this.lockouts.set(userId, record);
    this.saveToDisk();
  }

  private resetLockout(userId: string): void {
    this.lockouts.delete(userId);
    this.saveToDisk();
  }

  // -------------------------------------------------------------------------
  // Persistence — same pattern as SessionStore
  // -------------------------------------------------------------------------

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const entries = JSON.parse(raw) as Record<string, LockoutRecord>;
      const now = Date.now();
      for (const [id, record] of Object.entries(entries)) {
        // Skip records where lockout has fully expired AND failures are 0
        if (record.totalFailures === 0) continue;
        // Clear expired windows but keep failure count
        if (record.lockedUntil && record.lockedUntil < now) {
          record.lockedUntil = null;
        }
        this.lockouts.set(id, record);
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
      const entries: Record<string, LockoutRecord> = {};
      for (const [id, record] of this.lockouts.entries()) {
        entries[id] = record;
      }
      writeFileSync(this.persistPath, JSON.stringify(entries, null, 2), "utf-8");
    } catch {
      // Best-effort — don't crash if we can't write
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PinAlreadyEnrolledError extends Error {
  constructor() {
    super("PIN is already enrolled for this user");
    this.name = "PinAlreadyEnrolledError";
  }
}

export class InvalidPinError extends Error {
  constructor() {
    super("Invalid PIN");
    this.name = "InvalidPinError";
  }
}

export class LockoutError extends Error {
  readonly remainingMs: number;
  constructor(remainingMs: number) {
    super(`Too many failed attempts. Locked for ${Math.ceil(remainingMs / 1000)}s`);
    this.name = "LockoutError";
    this.remainingMs = remainingMs;
  }
}
