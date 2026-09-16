import { sql, type SQL } from "drizzle-orm";
import {
  customType,
  check,
  index,
  integer,
  real,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cryptoObjects } from "./crypto-storage";
import { namespaces } from "./trust";

const vector = customType<{
  data: number[];
  dpiType: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === "string") {
      return JSON.parse(value) as number[];
    }
    return value as number[];
  },
});

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({ dataType: () => "bytea" });

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tier: integer("tier").notNull().default(1),
    // Authored type is confidential payload, like content. Full-mode rows
    // obtain it from their authenticated protected representation.
    type: text("type").default("general"),
    content: text("content"),
    importance: real("importance").notNull().default(0.5),
    embedding: vector("embedding", { dimensions: 1536 }),
    /**
     * Opaque, server-derived idempotency key for writes that must create a
     * distinct Memory (rather than using semantic deduplication). Ordinary
     * Memories leave this NULL; PostgreSQL permits multiple NULLs in a unique
     * index, preserving the existing save path.
     */
    creationKey: text("creation_key"),
    /**
     * M243 — nullable shadow/current mapping to the one canonical encrypted
     * Memory revision. Legacy plaintext remains authoritative while global
     * activation is disabled.
     */
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    /** Monotonic confidential-content revision; zero denotes a legacy row. */
    contentRevision: integer("content_revision").notNull().default(0),
    /** Current object-access manifest revision; genesis is revision zero. */
    cryptoAccessRevision: integer("crypto_access_revision")
      .notNull()
      .default(0),
    /** Exact current product attachment authority, never a content digest. */
    cryptoRequiredNamespaceFingerprint: bytea(
      "crypto_required_namespace_fingerprint",
    ),
    /** Whether the retained crypto coordinates are currently selectable. */
    cryptoMappingState: text("crypto_mapping_state", {
      enum: ["unmapped", "verified", "stale"],
    }).notNull().default("unmapped"),
    /** Revision whose plaintext vector is coherent with the encrypted body. */
    embeddingRevision: integer("embedding_revision"),
    embeddingProvider: text("embedding_provider", {
      enum: ["openai", "openrouter", "venice"],
    }),
    /** Actual provider-returned canonical model identity. */
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    embeddingContractVersion: integer("embedding_contract_version"),
    /**
     * Singular exact creation authority for an origin='scope' Memory. This is
     * deliberately Memory-level, not one coordinate per memory_scopes edge.
     */
    scopeOriginNamespaceId: uuid("scope_origin_namespace_id").references(
      () => namespaces.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    demotedAt: timestamp("demoted_at", { withTimezone: true }),
    demotedFrom: integer("demoted_from"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_memories_tier_created").on(table.tier, table.createdAt),
    uniqueIndex("uq_memories_creation_key").on(table.creationKey),
    unique("uq_memories_crypto_object_id").on(table.cryptoObjectId),
    check(
      "memories_content_revision_nonnegative",
      sql`${table.contentRevision} >= 0`,
    ),
    check(
      "memories_crypto_mapping_revision_coherent",
      sql`(
        ${table.cryptoObjectId} is null
        and ${table.cryptoRequiredNamespaceFingerprint} is null
        and ${table.cryptoMappingState} = 'unmapped'
      ) or (
        ${table.cryptoObjectId} is not null
        and ${table.cryptoMappingState} in ('verified', 'stale')
        and ${table.contentRevision} > 0
        and ${table.cryptoAccessRevision} >= 0
        and octet_length(${table.cryptoRequiredNamespaceFingerprint}) = 32
      )`,
    ),
    check(
      "memories_crypto_access_revision_nonnegative",
      sql`${table.cryptoAccessRevision} >= 0`,
    ),
    check(
      "memories_embedding_provenance_coherent",
      sql`(
        ${table.embeddingRevision} is null
        and ${table.embeddingProvider} is null
        and ${table.embeddingModel} is null
        and ${table.embeddingDimensions} is null
        and ${table.embeddingContractVersion} is null
      ) or (
        ${table.embedding} is not null
        and ${table.embeddingRevision} is not null
        and ${table.embeddingRevision} >= 0
        and ${table.embeddingRevision} <= ${table.contentRevision}
        and ${table.embeddingProvider} in ('openai', 'openrouter', 'venice')
        and octet_length(${table.embeddingModel}) between 1 and 256
        and ${table.embeddingDimensions} = 1536
        and ${table.embeddingContractVersion} = 1
      )`,
    ),
  ],
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

/**
 * Raw SQL for HNSW vector index — Drizzle doesn't generate this
 * automatically. Add to the migration manually if not present:
 *
 *   CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
 *   ON memories USING hnsw (embedding vector_cosine_ops);
 */
export const HNSW_INDEX_SQL: SQL = sql`
  CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops)
`;
