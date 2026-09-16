/**
 * D418 prerequisite — the single Electron-main desktop-filesystem-grant authority.
 *
 * One instance of this service is shared by the grant IPC handlers, the
 * desktop relay authority resolver, and the advisory grant snapshot builder.
 * It overlays ephemeral `once` / `session` / `policy_pack` grants on top of
 * the existing durable `DesktopFilesystemGrantStore` without persisting them, and
 * exposes a merged list view for enforcement and discovery.
 *
 * Lifecycle ownership:
 *   - Durable user grants continue to persist in `DesktopFilesystemGrantStore`
 *     unchanged. This service delegates durable create/revoke/touch to it.
 *   - `once`, `session`, and `policy_pack` grants are in-memory only. The
 *     overlay owns their lifecycle; they never reach the durable store.
 *
 * Merge / fail-closed rules:
 *   - The merged list is the durable list PLUS the overlay, filtered by user.
 *     Each record keeps its own truthful status — a revoked durable grant
 *     stays revoked even when an overlay grant covers the same root. The
 *     overlay is additive; it never masks, revives, or rewrites a durable
 *     record.
 *   - Authority is decided downstream by `guardDesktopFilesystemOperation` against
 *     the merged grant list; this service only provides the view.
 *   - Any durable-store read failure fails closed: the merged read returns the
 *     durable error and no overlay grants are admitted.
 */

import {
  parseDesktopFilesystemGrant,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantLifetime,
  type DesktopFilesystemGrantOrigin,
} from "@nautilo/desktop-filesystem-grants";
import {
  DesktopFilesystemGrantStore,
  type ListedDesktopFilesystemGrant,
  type DesktopFilesystemGrantStoreErrorCode,
  type DesktopFilesystemGrantStoreResult,
} from "./store.ts";

/** Lifetimes that may only live in the in-memory overlay. */
const EPHEMERAL_LIFETIMES: ReadonlySet<DesktopFilesystemGrantLifetime> = new Set(["once", "session"]);

/** Origins that may only live in the in-memory overlay (policy packs are session-bound). */
const EPHEMERAL_ORIGINS: ReadonlySet<DesktopFilesystemGrantOrigin> = new Set(["policy_pack"]);

/** True when a grant must be owned by the overlay rather than the durable store. */
export function isEphemeralDesktopFilesystemGrant(grant: DesktopFilesystemGrant): boolean {
  return EPHEMERAL_ORIGINS.has(grant.origin) || EPHEMERAL_LIFETIMES.has(grant.lifetime);
}

export interface DesktopFilesystemGrantAuthorityOptions {
  instanceId: string;
  /** The durable store. Durable grants persist here unchanged. */
  store: DesktopFilesystemGrantStore;
  /** Injected clock keeps lifetime/status checks deterministic in tests. */
  clock?: () => Date;
}

interface OverlayEntry {
  grant: DesktopFilesystemGrant;
  /** Set when consumed (once) or revoked; the record is retained for history parity with the durable store. */
  revokedAt?: string;
  /** Most recent successful use, kept in memory only (never persisted). */
  lastUsedAt?: string;
}

function resultError<T>(
  code: DesktopFilesystemGrantStoreErrorCode,
  message: string,
): DesktopFilesystemGrantStoreResult<T> {
  return { ok: false, code, message };
}

function overlayStatus(entry: OverlayEntry, now: Date): ListedDesktopFilesystemGrant["status"] {
  if (entry.revokedAt !== undefined) return "revoked";
  const expiresAt = entry.grant.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime()) return "expired";
  return "active";
}

/**
 * One main-process authority over durable grants + an ephemeral overlay.
 *
 * The public `create` / `list` / `revoke` / `touchLastUsed` signatures match
 * `DesktopFilesystemGrantStore` so the IPC handlers can treat the authority as a
 * drop-in store while the overlay is transparently merged in. `addEphemeral`,
 * `consumeOnce`, and `clearSession` are the overlay-lifecycle seams used by
 * the future Full Workstation / policy-pack compiler.
 */
export class DesktopFilesystemGrantAuthority {
  private readonly instanceId: string;
  private readonly store: DesktopFilesystemGrantStore;
  private readonly clock: () => Date;
  private readonly overlay = new Map<string, OverlayEntry>();
  /**
   * Monotonic merged generation. Bumped on every authority mutation (durable
   * or overlay) so the advisory snapshot can advertise a generation that
   * reflects overlay changes the durable store's own revision cannot see.
   */
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DesktopFilesystemGrantAuthorityOptions) {
    this.instanceId = options.instanceId;
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  private materialize(entry: OverlayEntry): DesktopFilesystemGrant {
    const grant = entry.grant;
    return {
      ...grant,
      ...(entry.revokedAt !== undefined ? { revokedAt: entry.revokedAt } : {}),
      ...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
    };
  }

  private async durableHasId(
    grantId: string,
    userId: string,
  ): Promise<DesktopFilesystemGrantStoreResult<boolean>> {
    const listed = await this.store.list({ userId, includeHistory: true });
    if (!listed.ok) return listed;
    return { ok: true, data: listed.data.grants.some((item) => item.grant.id === grantId) };
  }

  /**
   * Merged list view: durable grants (true statuses) plus overlay grants
   * (computed statuses), filtered by user. Revoked durables remain revoked.
   * Returns `revision` so the same shape satisfies both the authority-store
   * and snapshot-store interfaces consumed by the relay.
   */
  async list(input: {
    userId: string;
    /** Include expired or revoked records as non-authoritative history. */
    includeHistory?: boolean;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grants: ListedDesktopFilesystemGrant[]; revision: number }>> {
    return this.serialized(async () => {
      const durable = await this.store.list(input);
      if (!durable.ok) return durable;
      const now = this.clock();
      const overlayGrants: ListedDesktopFilesystemGrant[] = [];
      for (const entry of this.overlay.values()) {
        if (entry.grant.subject.userId !== input.userId) continue;
        const status = overlayStatus(entry, now);
        if (!input.includeHistory && status !== "active") continue;
        overlayGrants.push({ grant: this.materialize(entry), status });
      }
      return {
        ok: true,
        data: {
          grants: [...durable.data.grants, ...overlayGrants],
          revision: this.revision,
        },
      };
    });
  }

  /**
   * Routes by lifetime/origin: durable grants persist via the durable store;
   * ephemeral grants (`once` / `session` / `policy_pack`) are added to the
   * overlay only. Signature matches `DesktopFilesystemGrantStore.create` so the IPC
   * create handler can call this unchanged.
   */
  async create(input: {
    userId: string;
    grant: DesktopFilesystemGrant;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    if (isEphemeralDesktopFilesystemGrant(input.grant)) {
      return this.addEphemeral({ grant: input.grant, userId: input.userId });
    }
    return this.serialized(async () => {
      const created = await this.store.create(input);
      if (!created.ok) return created;
      this.revision += 1;
      return { ok: true, data: { grant: created.data.grant, revision: this.revision } };
    });
  }

  /**
   * Explicit overlay add. Rejects non-ephemeral grants, subject/instance
   * mismatch, and id collisions across the overlay and durable store. Used by
   * the future Full Workstation / policy-pack compiler; the IPC create handler
   * reaches the same path via `create`.
   */
  async addEphemeral(input: {
    grant: DesktopFilesystemGrant;
    userId?: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const parsed = parseDesktopFilesystemGrant(input.grant, { now: this.clock() });
      if (!parsed.ok) {
        return resultError("invalid_grant", `grant rejected: ${parsed.error.code}`);
      }
      if (parsed.grant.subject.instanceId !== this.instanceId) {
        return resultError("invalid_grant", "grant subject must bind to this authority instance");
      }
      if (input.userId !== undefined && parsed.grant.subject.userId !== input.userId) {
        return resultError("invalid_grant", "grant subject must match the caller");
      }
      if (!isEphemeralDesktopFilesystemGrant(parsed.grant)) {
        return resultError(
          "invalid_grant",
          "only once / session / policy_pack grants may live in the overlay",
        );
      }
      if (this.overlay.has(parsed.grant.id)) {
        return resultError("invalid_grant", "grant id already exists in the overlay");
      }
      // Fail closed: a durable-store read failure rejects the add rather than
      // risking a duplicate id across the two stores.
      const exists = await this.durableHasId(parsed.grant.id, parsed.grant.subject.userId);
      if (!exists.ok) return exists;
      if (exists.data) {
        return resultError("invalid_grant", "grant id already exists in the durable store");
      }
      this.overlay.set(parsed.grant.id, { grant: parsed.grant });
      this.revision += 1;
      return { ok: true, data: { grant: parsed.grant, revision: this.revision } };
    });
  }

  /**
   * Revokes a grant wherever it lives: overlay grants are marked revoked in
   * memory; durable grants delegate to the durable store. A revoked durable
   * grant stays revoked — the overlay cannot revive it.
   */
  async revoke(input: {
    userId: string;
    grantId: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const entry = this.overlay.get(input.grantId);
      if (entry !== undefined && entry.grant.subject.userId === input.userId) {
        if (entry.revokedAt === undefined) {
          entry.revokedAt = this.clock().toISOString();
          this.revision += 1;
        }
        return { ok: true, data: { grant: this.materialize(entry), revision: this.revision } };
      }
      const revoked = await this.store.revoke(input);
      if (!revoked.ok) return revoked;
      this.revision += 1;
      return { ok: true, data: { grant: revoked.data.grant, revision: this.revision } };
    });
  }

  /**
   * Records an authorized grant use for Settings history. Durable grants
   * persist `lastUsedAt` via the durable store; overlay grants track it in
   * memory only and never persist. Revoked or expired grants are not active
   * authority and cannot be touched.
   */
  async touchLastUsed(input: {
    userId: string;
    grantId: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const entry = this.overlay.get(input.grantId);
      if (entry !== undefined && entry.grant.subject.userId === input.userId) {
        const now = this.clock();
        if (overlayStatus(entry, now) !== "active") {
          return resultError("grant_not_found", "revoked or expired grant is not active authority");
        }
        entry.lastUsedAt = now.toISOString();
        this.revision += 1;
        return { ok: true, data: { grant: this.materialize(entry), revision: this.revision } };
      }
      const touched = await this.store.touchLastUsed(input);
      if (!touched.ok) return touched;
      this.revision += 1;
      return { ok: true, data: { grant: touched.data.grant, revision: this.revision } };
    });
  }

  /**
   * Atomically consumes a `once` grant: the grant is marked revoked under the
   * authority lock so a concurrent dispatch cannot replay it. Overlay once
   * grants are consumed in memory; a legacy persisted once grant (written
   * before this overlay owned once lifecycle) is consumed via the durable
   * store. Non-once grants are rejected.
   */
  async consumeOnce(input: {
    userId: string;
    grantId: string;
  }): Promise<
    DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number; consumed: true }>
  > {
    return this.serialized(async () => {
      const entry = this.overlay.get(input.grantId);
      if (entry !== undefined && entry.grant.subject.userId === input.userId) {
        if (entry.grant.lifetime !== "once") {
          return resultError("invalid_grant", "consume-once applies only to lifetime:once grants");
        }
        const now = this.clock();
        if (entry.revokedAt !== undefined) {
          return resultError("grant_not_found", "grant already consumed or revoked");
        }
        if (entry.grant.expiresAt !== undefined && Date.parse(entry.grant.expiresAt) <= now.getTime()) {
          return resultError("grant_not_found", "grant expired before consumption");
        }
        entry.revokedAt = now.toISOString();
        this.revision += 1;
        return { ok: true, data: { grant: this.materialize(entry), revision: this.revision, consumed: true } };
      }
      // Legacy once grant persisted before the overlay owned once lifecycle.
      const listed = await this.store.list({ userId: input.userId, includeHistory: true });
      if (!listed.ok) return listed;
      const item = listed.data.grants.find((candidate) => candidate.grant.id === input.grantId);
      if (item === undefined) {
        return resultError("grant_not_found", "grant not found for caller");
      }
      if (item.grant.lifetime !== "once") {
        return resultError("invalid_grant", "consume-once applies only to lifetime:once grants");
      }
      const revoked = await this.store.revoke(input);
      if (!revoked.ok) return revoked;
      this.revision += 1;
      return { ok: true, data: { grant: revoked.data.grant, revision: this.revision, consumed: true } };
    });
  }

  /**
   * App-session clear: drops ephemeral overlay grants. With a `userId`, clears
   * only that user's overlay grants; without, clears every overlay grant (app
   * restart / logout / server switch / relay identity change). Durable grants
   * are untouched.
   */
  async clearSession(input?: {
    userId?: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ cleared: number; revision: number }>> {
    return this.serialized(() => {
      let cleared = 0;
      if (input?.userId !== undefined) {
        for (const [id, entry] of this.overlay) {
          if (entry.grant.subject.userId === input.userId) {
            this.overlay.delete(id);
            cleared += 1;
          }
        }
      } else {
        cleared = this.overlay.size;
        this.overlay.clear();
      }
      if (cleared > 0) this.revision += 1;
      return Promise.resolve({ ok: true, data: { cleared, revision: this.revision } });
    });
  }
}
