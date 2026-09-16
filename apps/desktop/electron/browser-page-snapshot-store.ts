import { randomBytes } from "node:crypto";
import type {
  BrowserPageReadEvictedPageReference,
  BrowserPageReadResult,
} from "@nautilo/relay";

/** Electron-local identity; it is installed by the authenticated relay client. */
export type BrowserPageSnapshotOwnerBinding = {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string | null;
};

export const BROWSER_PAGE_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const BROWSER_PAGE_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
const BROWSER_PAGE_SNAPSHOT_MAX_ENTRIES = 16;
const BROWSER_PAGE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

type SnapshotEntry = {
  readonly owner: BrowserPageSnapshotOwnerBinding;
  readonly page: BrowserPageReadResult;
  readonly bytes: number;
  expiresAtMs: number;
  expiryGeneration: number;
  timer?: ReturnType<typeof setTimeout>;
};

type SnapshotTombstone = {
  readonly owner: BrowserPageSnapshotOwnerBinding;
  readonly reason: BrowserPageSnapshotUnavailableReason;
  readonly expiresAtMs: number;
};

export type BrowserPageSnapshotReference = {
  readonly version: 1;
  readonly reference: string;
  readonly expiresAt: string;
  readonly bytes: number;
};

export type BrowserPageSnapshotCreateResult =
  | {
    readonly ok: true;
    readonly snapshot: BrowserPageSnapshotReference;
    /** Never contains metadata for a snapshot owned by somebody else. */
    readonly evicted: readonly BrowserPageReadEvictedPageReference[];
  }
  | { readonly ok: false; readonly reason: "item-too-large" };

export type BrowserPageSnapshotUnavailableReason =
  | "snapshot_expired"
  | "snapshot_evicted"
  | "snapshot_unavailable";

export type BrowserPageSnapshotAccessResult =
  | {
    readonly ok: true;
    readonly page: BrowserPageReadResult;
    readonly expiresAt: string;
  }
  | { readonly ok: false; readonly reason: BrowserPageSnapshotUnavailableReason };

export type BrowserPageSnapshotStoreOptions = {
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Test seam only; production uses the process timer functions. */
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  /** Test seam paired with `setTimeout`. */
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Tombstones carry no page text and remain bounded independently of snapshots. */
const BROWSER_PAGE_SNAPSHOT_TOMBSTONE_MAX_ENTRIES = 32;

function sameOwner(left: BrowserPageSnapshotOwnerBinding, right: BrowserPageSnapshotOwnerBinding): boolean {
  return left.instanceId === right.instanceId &&
    left.userId === right.userId &&
    left.relayId === right.relayId &&
    left.desktopSessionId === right.desktopSessionId;
}

function clonePage(page: BrowserPageReadResult): BrowserPageReadResult {
  return {
    ...page,
    blocks: page.blocks.map((block) => ({
      ...block,
      ...(block.links === undefined
        ? {}
        : { links: block.links.map((link) => ({ ...link })) }),
    })),
    ...(page.continuation === undefined ? {} : { continuation: { ...page.continuation } }),
    ...(page.pageReference === undefined ? {} : { pageReference: { ...page.pageReference } }),
    ...(page.evictedPageReferences === undefined
      ? {}
      : { evictedPageReferences: page.evictedPageReferences.map((evicted) => ({ ...evicted })) }),
    extraction: { ...page.extraction },
    timing: { ...page.timing },
    challenge: { ...page.challenge, signals: [...page.challenge.signals] },
    diagnostics: [...page.diagnostics],
  };
}

/**
 * A deliberately short-lived, process-local page cache. It stores already
 * extracted semantic Markdown only; it never owns a browser target, a URL
 * fetcher, or durable state. Insertion-order eviction is deterministic.
 */
export class BrowserPageSnapshotStore {
  private readonly entries = new Map<string, SnapshotEntry>();
  private readonly tombstones = new Map<string, SnapshotTombstone>();
  private retainedBytes = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimeout: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: BrowserPageSnapshotStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? BROWSER_PAGE_SNAPSHOT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
  }

  create(owner: BrowserPageSnapshotOwnerBinding, page: BrowserPageReadResult): BrowserPageSnapshotCreateResult {
    this.prune();
    const bytes = Buffer.byteLength(page.content, "utf8");
    if (bytes > BROWSER_PAGE_SNAPSHOT_MAX_BYTES) return { ok: false, reason: "item-too-large" };

    const evicted: BrowserPageReadEvictedPageReference[] = [];
    while (
      this.entries.size >= BROWSER_PAGE_SNAPSHOT_MAX_ENTRIES ||
      this.retainedBytes + bytes > BROWSER_PAGE_SNAPSHOT_TOTAL_BYTES
    ) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      const removed = this.delete(oldest, "snapshot_evicted");
      if (removed !== undefined && sameOwner(removed.owner, owner)) {
        evicted.push({
          version: 1,
          reference: oldest,
          title: removed.page.title,
          finalUrl: removed.page.finalUrl,
        });
      }
    }

    const reference = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    const entry: SnapshotEntry = {
      owner: { ...owner },
      page: clonePage(page),
      bytes,
      expiresAtMs,
      expiryGeneration: 0,
    };
    this.entries.set(reference, entry);
    this.armExpiry(reference, entry);
    this.retainedBytes += bytes;
    return {
      ok: true,
      snapshot: { version: 1, reference, expiresAt: new Date(expiresAtMs).toISOString(), bytes },
      evicted,
    };
  }

  /**
   * Reads an owner-bound snapshot and refreshes its sliding lifetime. The
   * typed miss deliberately reveals no page metadata to a different owner.
   */
  access(
    reference: string,
    owner: BrowserPageSnapshotOwnerBinding,
    expectedTargetRole?: BrowserPageReadResult["targetRole"],
    options: { readonly touch?: boolean } = {},
  ): BrowserPageSnapshotAccessResult {
    this.prune();
    const entry = this.entries.get(reference);
    if (entry !== undefined) {
      if (
        !sameOwner(entry.owner, owner) ||
        (expectedTargetRole !== undefined && entry.page.targetRole !== expectedTargetRole)
      ) return { ok: false, reason: "snapshot_unavailable" };
      if (options.touch !== false) this.touch(reference, entry);
      return {
        ok: true,
        page: clonePage(entry.page),
        expiresAt: new Date(entry.expiresAtMs).toISOString(),
      };
    }
    const tombstone = this.tombstones.get(reference);
    return tombstone !== undefined && sameOwner(tombstone.owner, owner)
      ? { ok: false, reason: tombstone.reason }
      : { ok: false, reason: "snapshot_unavailable" };
  }

  /** Compatibility convenience for existing continuation consumers. */
  read(reference: string, owner: BrowserPageSnapshotOwnerBinding):
    | { readonly page: BrowserPageReadResult; readonly expiresAt: string }
    | null {
    const result = this.access(reference, owner);
    return result.ok ? { page: result.page, expiresAt: result.expiresAt } : null;
  }

  clear(): void {
    for (const reference of [...this.entries.keys()]) this.delete(reference, "snapshot_unavailable");
  }

  close(): void {
    this.clear();
  }

  /** Narrow test observability only. */
  debugState(): { readonly entries: number; readonly retainedBytes: number } {
    this.prune();
    return { entries: this.entries.size, retainedBytes: this.retainedBytes };
  }

  /** Narrow test observability only; tombstones intentionally retain no text. */
  debugTombstones(): { readonly entries: number; readonly reasons: readonly BrowserPageSnapshotUnavailableReason[] } {
    this.prune();
    return { entries: this.tombstones.size, reasons: [...this.tombstones.values()].map((entry) => entry.reason) };
  }

  private prune(): void {
    const now = this.now();
    for (const [reference, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.delete(reference, "snapshot_expired");
    }
    for (const [reference, tombstone] of this.tombstones) {
      if (tombstone.expiresAtMs <= now) this.tombstones.delete(reference);
    }
  }

  private touch(reference: string, entry: SnapshotEntry): void {
    entry.expiresAtMs = this.now() + this.ttlMs;
    this.armExpiry(reference, entry);
  }

  private armExpiry(reference: string, entry: SnapshotEntry): void {
    if (entry.timer !== undefined) this.cancelTimeout(entry.timer);
    const generation = ++entry.expiryGeneration;
    const delayMs = Math.max(0, entry.expiresAtMs - this.now());
    const timer = this.scheduleTimeout(() => {
      const current = this.entries.get(reference);
      if (
        current !== undefined &&
        current.expiryGeneration === generation &&
        current.expiresAtMs <= this.now()
      ) {
        this.delete(reference, "snapshot_expired");
      }
    }, delayMs);
    timer.unref?.();
    entry.timer = timer;
  }

  private delete(reference: string, reason: BrowserPageSnapshotUnavailableReason): SnapshotEntry | undefined {
    const entry = this.entries.get(reference);
    if (entry === undefined) return undefined;
    if (entry.timer !== undefined) this.cancelTimeout(entry.timer);
    this.entries.delete(reference);
    this.retainedBytes -= entry.bytes;
    this.rememberTombstone(reference, entry.owner, reason);
    return entry;
  }

  private rememberTombstone(
    reference: string,
    owner: BrowserPageSnapshotOwnerBinding,
    reason: BrowserPageSnapshotUnavailableReason,
  ): void {
    // Callers prune before normal access/creation. Do not recurse through
    // `prune()` here: expiry pruning itself deletes entries into tombstones.
    this.pruneExpiredTombstones();
    this.tombstones.delete(reference);
    while (this.tombstones.size >= BROWSER_PAGE_SNAPSHOT_TOMBSTONE_MAX_ENTRIES) {
      const oldest = this.tombstones.keys().next().value;
      if (typeof oldest !== "string") break;
      this.tombstones.delete(oldest);
    }
    this.tombstones.set(reference, {
      owner: { ...owner },
      reason,
      expiresAtMs: this.now() + this.ttlMs,
    });
  }

  private pruneExpiredTombstones(): void {
    const now = this.now();
    for (const [reference, tombstone] of this.tombstones) {
      if (tombstone.expiresAtMs <= now) this.tombstones.delete(reference);
    }
  }
}
