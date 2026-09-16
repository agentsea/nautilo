import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * D229 — persistent provider catalog cache.
 *
 * Stores Nautilo-normalized provider catalog payloads as JSONB. This is
 * intentionally not a relational mirror of third-party provider data:
 * callers need fast replay of previously-normalized rows, not ad-hoc SQL
 * queries over provider fields.
 */
export const providerCatalogCache = pgTable(
  "provider_catalog_cache",
  {
    provider: text("provider").notNull(),
    accountFingerprint: text("account_fingerprint").notNull(),
    schemaVersion: text("schema_version").notNull(),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.provider,
        table.accountFingerprint,
        table.schemaVersion,
        table.cacheKey,
      ],
    }),
  ],
);

export type ProviderCatalogCacheRow = typeof providerCatalogCache.$inferSelect;
export type NewProviderCatalogCacheRow = typeof providerCatalogCache.$inferInsert;
