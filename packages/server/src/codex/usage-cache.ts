import type {
  CodexUsageSnapshot,
  CodexUsageSnapshotPatch,
} from "@nautilo/db";

const DEFAULT_MAX_IN_FLIGHT = 64;
export const CODEX_USAGE_LIVE_MAX_AGE_MS = 60_000;
export const CODEX_USAGE_STALE_MAX_AGE_MS = 15 * 60_000;

export type CodexUsageRefreshIdentity = {
  readonly userId: string;
  readonly profileId: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly expectedRevision: number;
};

type SafeRateLimits = NonNullable<CodexUsageSnapshot["rateLimits"]>;
type SafeUsage = NonNullable<CodexUsageSnapshot["usage"]>;

export type CodexUsageRefreshOutcome<Row> = {
  readonly row: Row | undefined;
  readonly patch: CodexUsageSnapshotPatch;
  readonly usageError: Error | null;
  readonly rateLimitsError: Error | null;
};

export type CodexUsageRefreshPorts<Row> = {
  readonly readUsage: () => Promise<SafeUsage>;
  readonly readRateLimits: () => Promise<SafeRateLimits>;
  readonly persist: (input: {
    readonly identity: CodexUsageRefreshIdentity;
    readonly patch: CodexUsageSnapshotPatch;
    readonly observedAt: Date;
  }) => Promise<Row | undefined>;
};

export type CodexUsageCacheOptions = {
  readonly now?: () => Date;
  readonly maxInFlight?: number;
};

/**
 * Bounded, exact-generation singleflight for explicit Connections refreshes.
 *
 * This intentionally is not a timer, stream hook, or harness-selection
 * dependency. The database's one safe snapshot per profile is the retained
 * cache; this map only coalesces concurrent admin reads and deletes every
 * entry at terminal completion.
 */
export class CodexUsageCache {
  private readonly inFlight = new Map<string, Promise<CodexUsageRefreshOutcome<unknown>>>();
  private readonly now: () => Date;
  private readonly maxInFlight: number;

  constructor(options: CodexUsageCacheOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (!Number.isSafeInteger(this.maxInFlight) || this.maxInFlight <= 0) {
      throw new Error("invalid Codex usage refresh bound");
    }
  }

  refresh<Row>(
    identity: CodexUsageRefreshIdentity,
    ports: CodexUsageRefreshPorts<Row>,
  ): Promise<CodexUsageRefreshOutcome<Row>> {
    const key = refreshKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<CodexUsageRefreshOutcome<Row>>;
    if (this.inFlight.size >= this.maxInFlight) {
      return Promise.reject(new Error("Codex usage refresh capacity exhausted"));
    }
    const refresh = this.refreshOnce(identity, ports);
    this.inFlight.set(key, refresh as Promise<CodexUsageRefreshOutcome<unknown>>);
    const cleanup = () => {
      if (this.inFlight.get(key) === refresh) this.inFlight.delete(key);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  private async refreshOnce<Row>(
    identity: CodexUsageRefreshIdentity,
    ports: CodexUsageRefreshPorts<Row>,
  ): Promise<CodexUsageRefreshOutcome<Row>> {
    // The two official reads are intentionally independent. An unavailable
    // capability must not erase or block persistence of the successful half.
    const [usage, rateLimits] = await Promise.allSettled([
      ports.readUsage(),
      ports.readRateLimits(),
    ]);
    const patch: CodexUsageSnapshotPatch = {
      ...(rateLimits.status === "fulfilled" ? { rateLimits: rateLimits.value } : {}),
      ...(usage.status === "fulfilled" ? { usage: usage.value } : {}),
    };
    const row = Object.keys(patch).length === 0
      ? undefined
      : await ports.persist({ identity, patch, observedAt: this.now() });
    return {
      row,
      patch,
      usageError: usage.status === "rejected" ? asError(usage.reason) : null,
      rateLimitsError: rateLimits.status === "rejected" ? asError(rateLimits.reason) : null,
    };
  }
}

export function requestedUsageRefreshFailure(
  outcome: CodexUsageRefreshOutcome<unknown>,
  requested: "usage" | "rateLimits",
): Error | null {
  const error = requested === "usage" ? outcome.usageError : outcome.rateLimitsError;
  // Keep the existing control-plane error vocabulary for the explicitly
  // requested official read. The sibling read is opportunistic only.
  return error;
}

function refreshKey(identity: CodexUsageRefreshIdentity): string {
  return [
    identity.userId,
    identity.profileId,
    identity.profileGeneration,
    identity.accountGeneration,
    // A profile status/account mutation can advance revision without changing
    // either generation. Do not let a stale CAS writer share a newer row's
    // outcome or vice versa.
    identity.expectedRevision,
  ].join("\u0000");
}

type Freshness = "live" | "cached" | "stale";
type UsageRateLimits = NonNullable<CodexUsageSnapshot["rateLimits"]>;
type Usage = NonNullable<CodexUsageSnapshot["usage"]>;

export function withCodexUsageFreshness(
  snapshot: CodexUsageSnapshot,
  observedAt: Date | null,
  now?: Date,
): CodexUsageSnapshot;
export function withCodexUsageFreshness(
  projection: UsageRateLimits,
  observedAt: Date | null,
  now?: Date,
): UsageRateLimits;
export function withCodexUsageFreshness(
  projection: Usage,
  observedAt: Date | null,
  now?: Date,
): Usage;
/**
 * The host's safe freshness is a lower bound. A local cache entry can only
 * become less fresh as it ages; it can never become live just because a
 * browser rereads it.
 */
export function withCodexUsageFreshness(
  projection: CodexUsageSnapshot | UsageRateLimits | Usage,
  observedAt: Date | null,
  now: Date = new Date(),
): CodexUsageSnapshot | UsageRateLimits | Usage {
  if ("schemaVersion" in projection) {
    const snapshot = projection;
    const rateLimits = snapshot.rateLimits === undefined
      ? undefined
      : withCodexUsageFreshness(snapshot.rateLimits, observedAt, now);
    const usage = snapshot.usage === undefined
      ? undefined
      : withCodexUsageFreshness(snapshot.usage, observedAt, now);
    return {
      schemaVersion: 1,
      ...(rateLimits === undefined ? {} : { rateLimits }),
      ...(usage === undefined ? {} : { usage }),
    } as CodexUsageSnapshot;
  }
  const freshness = ageFreshness(projection.freshness, observedAt, now);
  if ("summary" in projection) {
    return {
      ...projection,
      daily: [...projection.daily],
      freshness,
    } as Usage;
  }
  return { ...projection, freshness } as UsageRateLimits;
}

function ageFreshness(
  providerFreshness: Freshness,
  observedAt: Date | null,
  now: Date,
): Freshness {
  const observedMs = observedAt?.getTime();
  const ageMs = observedMs === undefined || !Number.isFinite(observedMs)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, now.getTime() - observedMs);
  const local = ageMs <= CODEX_USAGE_LIVE_MAX_AGE_MS
    ? "live"
    : ageMs <= CODEX_USAGE_STALE_MAX_AGE_MS
      ? "cached"
      : "stale";
  return freshnessRank(providerFreshness) >= freshnessRank(local)
    ? providerFreshness
    : local;
}

function freshnessRank(value: Freshness): number {
  return value === "stale" ? 2 : value === "cached" ? 1 : 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Codex usage refresh failed");
}
