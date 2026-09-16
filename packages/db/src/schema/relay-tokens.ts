/**
 * M056 — Relay device tokens.
 *
 * One row per paired Electron desktop (or future mac-relay daemon).
 * Plaintext token (`rty_<32 base64url chars>`) is shown to the user
 * once at pair time and persisted on the device via Electron
 * `safeStorage`; the server only ever stores `sha256(token)`.
 *
 * Lifecycle:
 *   - INSERT on `POST /api/relay/pair` (authenticated by Logto JWT).
 *   - SELECT-by-hash on `relay:register` token validation.
 *   - UPDATE `last_seen_at` (best-effort) on every successful
 *     register validation.
 *   - UPDATE `revoked_at` on `DELETE /api/relay/devices/:id` or on
 *     cascade from `users` / `actors` deletion.
 *
 * Tokens are intentionally LONG-LIVED with no TTL (M056 §Risks).
 * Revocation is the only delete path. Token TTLs are deferred to
 * the Enterprise tier (M2+).
 */
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { actors } from "./trust";

export const relayTokens = pgTable(
  "relay_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** SHA-256 of the plaintext token (hex). UNIQUE so a token can
     *  identify exactly one row. */
    tokenHash: text("token_hash").notNull().unique(),
    /** User-visible label — defaults to the device hostname at pair
     *  time. Capped to 200 chars by the route handler. */
    label: text("label").notNull(),
    /** Advisory display data only. The live capability set comes
     *  from the relay's per-connection `relay:register.capabilities`;
     *  this column powers the Manage Devices UI badges. */
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Updated best-effort on every successful relay:register
     *  validation. NULL until the relay first connects with this
     *  token. */
    lastSeenAt: timestamp("last_seen_at"),
    /** Set on revocation. Active rows have this NULL — partial
     *  indexes below filter the active set for fast lookups. */
    revokedAt: timestamp("revoked_at"),
    /**
     * D418 — stable desktop pairing identity. Optional opaque UUID
     * minted by the Electron client per installation (persisted via
     * `safeStorage`). When present and well-formed, `pair` revokes any
     * existing active row for the same (user_id, installation_id)
     * transactionally before inserting a new one, so re-pairing the
     * same installation yields a single active row instead of a
     * growing duplicate set. NULL is the legacy path: legacy rows
     * and legacy clients (no installation id) keep the original
     * one-row-per-pair behaviour and MAY legitimately duplicate.
     */
    installationId: uuid("installation_id"),
    /**
     * D480 — non-authoritative, server-scoped physical-device grouping
     * pseudonym. It is deliberately independent of installation_id: several
     * isolated tuple installations may share one group while retaining
     * independently rotatable credentials.
     */
    deviceGroupId: uuid("device_group_id"),
    /**
     * Server-issued opaque management target for deviceGroupId. Never return
     * device_group_id itself to a client.
     */
    deviceManagementId: text("device_management_id"),
  },
  (table) => [
    index("idx_relay_tokens_user_id").on(table.userId),
    index("idx_relay_tokens_actor_id").on(table.actorId),
    // D418 — at most one active (non-revoked) row per
    // (user_id, installation_id) when an installation id is present.
    // NULL installation_id is excluded so legacy rows can duplicate.
    uniqueIndex("uq_relay_tokens_user_installation_active")
      .on(table.userId, table.installationId)
      .where(
        sql`"relay_tokens"."installation_id" IS NOT NULL AND "relay_tokens"."revoked_at" IS NULL`,
      ),
    // D480 — supports caller-owned grouped projection and exact grouped
    // lifecycle mutations. Both indexes intentionally exclude revoked rows.
    index("idx_relay_tokens_user_device_group_active")
      .on(table.userId, table.deviceGroupId)
      .where(
        sql`"relay_tokens"."device_group_id" IS NOT NULL AND "relay_tokens"."revoked_at" IS NULL`,
      ),
    index("idx_relay_tokens_user_device_management_active")
      .on(table.userId, table.deviceManagementId)
      .where(
        sql`"relay_tokens"."device_management_id" IS NOT NULL AND "relay_tokens"."revoked_at" IS NULL`,
      ),
    check(
      "relay_tokens_device_group_management_pair_check",
      sql`("device_group_id" IS NULL AND "device_management_id" IS NULL) OR ("device_group_id" IS NOT NULL AND "device_management_id" IS NOT NULL)`,
    ),
  ],
);

export type RelayToken = typeof relayTokens.$inferSelect;
export type NewRelayToken = typeof relayTokens.$inferInsert;
