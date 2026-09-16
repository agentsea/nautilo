import { createHash } from "node:crypto";
import {
  and,
  db,
  eq,
  providerCatalogCache,
} from "@nautilo/db";

export type ProviderCatalogCacheState = "fresh" | "stale";

/**
 * Server-side L2 cache for third-party provider catalog payloads.
 *
 * This helper owns the generic DB plumbing over `provider_catalog_cache`:
 * provider/account/schema/key lookup, hard expiry (`staleAt`), freshness
 * classification (`expiresAt`), and upsert. It deliberately does NOT know
 * how to normalize any provider response. Callers supply:
 *
 * - `provider`: stable provider namespace, e.g. "elevenlabs" or "venice".
 * - `kind`: caller-defined sub-cache within that provider.
 * - `cacheKey`: normalized filter/query key, excluding volatile paging when
 *   pages share one accumulated provider catalog.
 * - `schemaVersion`: caller-owned invalidation knob for payload shape and
 *   compatibility-rule changes.
 * - `validatePayload`: runtime guard for the provider-specific JSONB shape.
 *
 * The DB package intentionally owns only the table schema; this server helper
 * is the reusable behavior layer for provider catalogs.
 */
export interface ProviderCatalogCache<TPayload> {
  get(args: {
    kind: string;
    cacheKey: string;
    accountFingerprint: string;
    schemaVersion: string;
    now: number;
  }): Promise<{ payload: TPayload; state: ProviderCatalogCacheState } | null>;
  set(args: {
    kind: string;
    cacheKey: string;
    accountFingerprint: string;
    schemaVersion: string;
    payload: TPayload;
    now: number;
    ttlMs: number;
    staleMs: number;
  }): Promise<void>;
}

export function providerAccountFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 32);
}

function persistentCacheKey(kind: string, cacheKey: string): string {
  return `${kind}:${cacheKey}`;
}

function toDate(ms: number): Date {
  return new Date(ms);
}

function fromDate(raw: Date | string | number): number {
  return raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
}

export function createDbProviderCatalogCache<TPayload>(args: {
  provider: string;
  validatePayload: (kind: string, payload: unknown) => payload is TPayload;
}): ProviderCatalogCache<TPayload> {
  return {
    async get(input) {
      const [row] = await db
        .select({
          payload: providerCatalogCache.payload,
          expiresAt: providerCatalogCache.expiresAt,
          staleAt: providerCatalogCache.staleAt,
        })
        .from(providerCatalogCache)
        .where(
          and(
            eq(providerCatalogCache.provider, args.provider),
            eq(providerCatalogCache.accountFingerprint, input.accountFingerprint),
            eq(providerCatalogCache.schemaVersion, input.schemaVersion),
            eq(providerCatalogCache.cacheKey, persistentCacheKey(input.kind, input.cacheKey)),
          ),
        )
        .limit(1);
      if (!row) return null;
      const expiresAt = fromDate(row.expiresAt);
      const staleAt = fromDate(row.staleAt);
      if (staleAt <= input.now) return null;
      const payload: unknown = row.payload;
      if (!args.validatePayload(input.kind, payload)) return null;
      return { payload, state: expiresAt > input.now ? "fresh" : "stale" };
    },
    async set(input) {
      const cachedAt = input.now;
      const expiresAt = input.now + input.ttlMs;
      const staleAt = expiresAt + input.staleMs;
      await db
        .insert(providerCatalogCache)
        .values({
          provider: args.provider,
          accountFingerprint: input.accountFingerprint,
          schemaVersion: input.schemaVersion,
          cacheKey: persistentCacheKey(input.kind, input.cacheKey),
          payload: input.payload as Record<string, unknown>,
          cachedAt: toDate(cachedAt),
          expiresAt: toDate(expiresAt),
          staleAt: toDate(staleAt),
          updatedAt: toDate(input.now),
        })
        .onConflictDoUpdate({
          target: [
            providerCatalogCache.provider,
            providerCatalogCache.accountFingerprint,
            providerCatalogCache.schemaVersion,
            providerCatalogCache.cacheKey,
          ],
          set: {
            payload: input.payload as Record<string, unknown>,
            cachedAt: toDate(cachedAt),
            expiresAt: toDate(expiresAt),
            staleAt: toDate(staleAt),
            updatedAt: toDate(input.now),
          },
        });
    },
  };
}
