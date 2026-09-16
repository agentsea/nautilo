/**
 * D403 (ISSUE-D403) Phase 4 — in-memory credential staging.
 *
 * Deliberately **Electron-free** (no `electron` import) so it can be reasoned
 * about and unit-tested as a pure helper, mirroring the `kdbx-store.ts` posture.
 * `ipc.ts` re-exports these for its consumers.
 *
 * KEYED BY ORIGIN (P4): a submitted credential is staged under its origin, NOT
 * the guest webContents id. This is what lets the "Save password?" offer survive
 * the post-submit navigation — a login submit swaps the guest webContents (new
 * id) but the origin is stable, so `commitSave` still finds the staged
 * credential on the page the user lands on. Mirrors how Chrome/Firefox hold a
 * provisional credential across the login navigation.
 *
 * SECURITY (R6): a staged credential holds the plaintext password ONLY in
 * main-process memory, only until the human's Save/Dismiss decision (or a TTL
 * backstop). It is never persisted here nor returned to any renderer/agent
 * surface.
 */

/** A credential captured on submit, held in memory only until commit/dismiss. */
export interface StagedCredential {
  origin: string;
  username: string;
  password: string;
}

interface StagedEntry extends StagedCredential {
  /** Wall-clock ms when staged; used for the TTL backstop. */
  stagedAt: number;
}

export interface PasswordStagingMapOptions {
  /** Max age a staged credential survives before it's treated as gone. */
  ttlMs?: number;
  /** Clock injection (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Backstop so an ignored offer can't pin a plaintext password forever. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory staging store for submitted credentials, keyed by ORIGIN. Nothing
 * here is persisted; the plaintext lives only for the window between submit and
 * the human's Save/Dismiss decision (bounded by `ttlMs`), and never leaves the
 * main process via this map.
 */
export class PasswordStagingMap {
  private readonly byOrigin = new Map<string, StagedEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: PasswordStagingMapOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Drop the origin's entry if it has aged past the TTL. Returns the live entry. */
  private live(origin: string): StagedEntry | undefined {
    const entry = this.byOrigin.get(origin);
    if (!entry) return undefined;
    if (this.now() - entry.stagedAt > this.ttlMs) {
      this.byOrigin.delete(origin);
      return undefined;
    }
    return entry;
  }

  private static toCred(entry: StagedEntry): StagedCredential {
    return { origin: entry.origin, username: entry.username, password: entry.password };
  }

  /** Stage (or replace) the credential for its origin. */
  stage(cred: StagedCredential): void {
    this.byOrigin.set(cred.origin, { ...cred, stagedAt: this.now() });
  }

  /** Non-destructive read of the staged credential for an origin (TTL-aware). */
  peek(origin: string): StagedCredential | undefined {
    const entry = this.live(origin);
    return entry ? PasswordStagingMap.toCred(entry) : undefined;
  }

  /** Remove and return the staged credential (commit path), if fresh. */
  take(origin: string): StagedCredential | undefined {
    const entry = this.live(origin);
    this.byOrigin.delete(origin);
    return entry ? PasswordStagingMap.toCred(entry) : undefined;
  }

  /** Drop any staged credential for an origin (dismiss / teardown path). */
  clear(origin: string): boolean {
    return this.byOrigin.delete(origin);
  }

  /** Count of staged origins (may include not-yet-swept expired entries). */
  get size(): number {
    return this.byOrigin.size;
  }
}
