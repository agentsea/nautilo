/**
 * D362 §3.4.6 — office session lifecycle manager.
 *
 * The `office` tool's `inPlace:true` path used to open a NEW coolwsd
 * WebSocket session per tool call (mint → connect → load doc → 1-3 UNO
 * ops → save → close). That reloaded the doc on every call and spammed
 * "Genie (assistant) joined/left" toasts in the human's open editor —
 * 3 edits = 3 join/leave flashes. This manager reuses live sessions
 * across tool calls, idle-closes them after a window, and verifies
 * liveness before reuse so a rare early death (engine restart) is
 * invisible to the caller.
 *
 * Timeout budget (already researched; do NOT re-probe): WOPI lock TTL
 * 30 min, coolwsd per_view idle 15 min / per_document idle 1h. A ~90s
 * idle-close window is therefore safe with NO keepalive/heartbeat.
 *
 * Concurrency: overlapping `acquire`s for the same key share ONE
 * in-flight connect promise (no double-open). The manager is bounded
 * (default 8 sessions) with LRU eviction — when full, the
 * least-recently-acquired session is closed + evicted before a new one
 * is opened.
 *
 * Symmetric with `session-broker.ts`: module-global lazy singleton via
 * `getOfficeSessionManager()` so the agent package never imports
 * `@nautilo/server`; tests reset with
 * `resetOfficeSessionManagerForTests()`.
 */
import type { CoolSessionLike, CoolSessionOptions } from "@nautilo/loffice";
import type { OfficeSessionMint } from "./session-broker";

/** Default idle TTL — see file header for the budget rationale. */
const DEFAULT_IDLE_TTL_MS = 90_000;
/** Default bound on cached sessions. */
const DEFAULT_MAX_SESSIONS = 8;

/**
 * Acquire a live session for `key`.
 *
 * - `key`: the artifact's INTERNAL row id (the broker mints per-row).
 * - `mint`: thunk that calls the broker; resolved lazily ONLY when a
 *   new session is needed (cache hit → never called). Returns the
 *   mint triple or `{ error }`.
 * - `make`: factory that wraps the mint triple in a `CoolSessionLike`.
 *   Called only on cache miss.
 *
 * Returns the live `CoolSessionLike` (cached + `isAlive()`) or
 * `{ error }` (mint failure, connect failure). On any error, no entry
 * is left in the cache.
 */
export interface OfficeSessionManager {
  acquire(
    key: string,
    mint: () => Promise<OfficeSessionMint | { error: string }>,
    make: (opts: CoolSessionOptions) => CoolSessionLike,
  ): Promise<CoolSessionLike | { error: string }>;
  /** Close + evict one session. No-op if not cached. */
  invalidate(key: string): void;
  /** Close + evict ALL cached sessions. */
  closeAll(): void;
}

interface CachedEntry {
  session: CoolSessionLike;
  /** Idle-close timer; reset on each acquire. */
  idleTimer: ReturnType<typeof setTimeout>;
  /** Last acquire ms — used for LRU eviction. */
  lastUsed: number;
}

class OfficeSessionManagerImpl implements OfficeSessionManager {
  private readonly cache = new Map<string, CachedEntry>();
  private readonly inflight = new Map<string, Promise<CoolSessionLike | { error: string }>>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;

  constructor(opts: { idleTtlMs?: number; maxSessions?: number } = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  async acquire(
    key: string,
    mint: () => Promise<OfficeSessionMint | { error: string }>,
    make: (opts: CoolSessionOptions) => CoolSessionLike,
  ): Promise<CoolSessionLike | { error: string }> {
    // Cache hit + alive → reuse, reset idle timer.
    const cached = this.cache.get(key);
    if (cached && cached.session.isAlive()) {
      cached.lastUsed = Date.now();
      this.resetIdleTimer(key, cached);
      // LRU: re-insert to mark most-recently-used in Map insertion order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.session;
    }
    if (cached && !cached.session.isAlive()) {
      // Dead cached session — drop + recreate below.
      this.evict(key);
    }

    // Overlapping acquire for the same key → share ONE in-flight connect.
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async (): Promise<CoolSessionLike | { error: string }> => {
      try {
        // Bound: evict LRU before opening a new session if at cap.
        if (this.cache.size >= this.maxSessions) {
          this.evictLru();
        }
        const minted = await mint();
        if (!("wsBaseUrl" in minted)) {
          return { error: minted.error };
        }
        const session = make({
          wsBaseUrl: minted.wsBaseUrl,
          docUrl: minted.docUrl,
          wopiSrc: minted.wopiSrc,
          serviceRoot: minted.serviceRoot,
          origin: minted.origin,
        });
        try {
          await session.connect();
        } catch (err) {
          try {
            session.close();
          } catch {
            // ignore
          }
          return {
            error: `session connect failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        // Defensive: connect() resolved but the socket died immediately.
        if (!session.isAlive()) {
          try {
            session.close();
          } catch {
            // ignore
          }
          return { error: "session connect failed: socket not open after connect" };
        }
        const entry: CachedEntry = {
          session,
          lastUsed: Date.now(),
          idleTimer: undefined as unknown as ReturnType<typeof setTimeout>,
        };
        entry.idleTimer = this.makeIdleTimer(key);
        // `unref` so the timer never keeps the process alive on its own.
        entry.idleTimer.unref?.();
        this.cache.set(key, entry);
        return session;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  invalidate(key: string): void {
    this.evict(key);
  }

  closeAll(): void {
    for (const key of Array.from(this.cache.keys())) {
      this.evict(key);
    }
  }

  // ─── internals ────────────────────────────────────────────────────

  private makeIdleTimer(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.evict(key);
    }, this.idleTtlMs);
  }

  private resetIdleTimer(key: string, entry: CachedEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.makeIdleTimer(key);
    entry.idleTimer.unref?.();
  }

  private evict(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.cache.delete(key);
    try {
      entry.session.close();
    } catch {
      // ignore — close() is best-effort
    }
  }

  /** Evict the least-recently-used entry (Map insertion order = LRU order). */
  private evictLru(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey === undefined) return;
    this.evict(oldestKey);
  }
}

let _manager: OfficeSessionManager | null = null;

/**
 * Lazy singleton. The first call constructs the default manager; later
 * calls return the same instance. Tests that need a fresh manager with
 * custom TTL/cap should call `resetOfficeSessionManagerForTests()` and
 * then `setOfficeSessionManagerForTests(new OfficeSessionManagerImpl(...))`.
 */
export function getOfficeSessionManager(): OfficeSessionManager {
  if (!_manager) _manager = new OfficeSessionManagerImpl();
  return _manager;
}

/** Test-only: clear the singleton so the next `get` constructs fresh. */
export function resetOfficeSessionManagerForTests(): void {
  if (_manager) {
    (_manager as OfficeSessionManagerImpl).closeAll?.();
  }
  _manager = null;
}

/**
 * Test-only: install a custom manager (e.g. with a tiny idle TTL or
 * small cap). Caller is responsible for `reset…ForTests()` after.
 */
export function setOfficeSessionManagerForTests(m: OfficeSessionManager | null): void {
  _manager = m;
}

/** Exposed for tests that want to construct a manager with custom opts. */
export function createOfficeSessionManager(opts: {
  idleTtlMs?: number;
  maxSessions?: number;
} = {}): OfficeSessionManager {
  return new OfficeSessionManagerImpl(opts);
}
