/**
 * D458 Wave 7 — durable remote-controller pairing state.
 *
 * Pairing verifier material is deliberately represented only by HMAC digests.
 * Plaintext QR/manual secrets are generated at the ceremony edge and are never
 * persisted in these tables.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { actors } from "./trust";
import { relayTokens } from "./relay-tokens";
import { users } from "./users";

/** A stable mobile-controller installation, independently revocable. */
export const remoteControllerInstallations = pgTable(
  "remote_controller_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** Immutable D458 server authority scope for this controller record. */
    serverInstanceId: uuid("server_instance_id").notNull(),
    serverBindingGeneration: integer("server_binding_generation").notNull(),
    /** Client-minted, safe-storage-backed stable installation UUID. */
    installationId: uuid("installation_id").notNull(),
    /** Server-owned lifecycle epoch; key replacement/reinstall advances it. */
    installationGeneration: integer("installation_generation").notNull().default(1),
    /**
     * Algorithm-agile public proof material. The later route validates bounded
     * algorithm/key encodings; persistence alone is never proof verification.
     * Private key material must never enter this table.
     */
    proofKeyAlgorithm: varchar("proof_key_algorithm", { length: 128 }).notNull(),
    proofKey: varchar("proof_key", { length: 8192 }).notNull(),
    proofKeyFingerprint: varchar("proof_key_fingerprint", { length: 256 }).notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_remote_controller_installations_scoped_installation")
      .on(
        table.userId,
        table.serverInstanceId,
        table.serverBindingGeneration,
        table.installationId,
      ),
    index("idx_remote_controller_installations_user_active")
      .on(table.userId)
      .where(sql`"remote_controller_installations"."revoked_at" IS NULL`),
  ],
);

/** A short-lived, one-time pairing ceremony issued by an enrolled host. */
export const remotePairingChallenges = pgTable(
  "remote_pairing_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** CAS version. Every consume checks the exact version it validated. */
    version: integer("version").notNull().default(1),
    /** Immutable Server UUID copied from nautilo_instance_identity. */
    serverInstanceId: uuid("server_instance_id").notNull(),
    /** Exact server authority generation captured when the challenge is shown. */
    serverBindingGeneration: integer("server_binding_generation").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** Relay enrollment remains the durable host identity for Wave 7. */
    relayTokenId: uuid("relay_token_id")
      .notNull()
      .references(() => relayTokens.id, { onDelete: "cascade" }),
    hostInstallationId: uuid("host_installation_id").notNull(),
    /** Electron's per-main-process-launch opaque id; it is not a UUID. */
    desktopSessionId: text("desktop_session_id").notNull(),
    /**
     * The validated relay_tokens.id UUID. This is the existing relay
     * pairing-generation identity, not a new integer generation sequence.
     */
    pairingGeneration: uuid("pairing_generation").notNull(),
    /** HMAC-SHA256 hex only — plaintext ceremony secrets never enter DB. */
    qrVerifierDigest: text("qr_verifier_digest").notNull(),
    /** Optional normalized manual-code HMAC for the same challenge. */
    manualVerifierDigest: text("manual_verifier_digest"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Failed verifier attempts only; the fifth failure revokes the challenge. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_remote_pairing_challenges_expiry").on(table.expiresAt),
    index("idx_remote_pairing_challenges_relay_active")
      .on(table.relayTokenId)
      .where(
        sql`"remote_pairing_challenges"."consumed_at" IS NULL AND "remote_pairing_challenges"."revoked_at" IS NULL`,
      ),
    check(
      "remote_pairing_challenges_pairing_generation_matches_relay",
      sql`"pairing_generation" = "relay_token_id"`,
    ),
  ],
);

/** A mobile controller's active durable authority over one desktop relay. */
export const remoteControllerBindings = pgTable(
  "remote_controller_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    /** Server binding epoch at issuance. */
    serverBindingGeneration: integer("server_binding_generation").notNull(),
    controllerInstallationId: uuid("controller_installation_id")
      .notNull()
      .references(() => remoteControllerInstallations.id, { onDelete: "cascade" }),
    installationGeneration: integer("installation_generation").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    relayTokenId: uuid("relay_token_id")
      .notNull()
      .references(() => relayTokens.id, { onDelete: "cascade" }),
    hostInstallationId: uuid("host_installation_id").notNull(),
    desktopSessionId: text("desktop_session_id").notNull(),
    pairingGeneration: uuid("pairing_generation").notNull(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => remotePairingChallenges.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_remote_controller_bindings_challenge").on(table.challengeId),
    uniqueIndex("uq_remote_controller_bindings_controller_relay_active")
      .on(table.controllerInstallationId, table.relayTokenId)
      .where(sql`"remote_controller_bindings"."revoked_at" IS NULL`),
    index("idx_remote_controller_bindings_relay_active")
      .on(table.relayTokenId)
      .where(sql`"remote_controller_bindings"."revoked_at" IS NULL`),
    index("idx_remote_controller_bindings_user_active")
      .on(table.userId)
      .where(sql`"remote_controller_bindings"."revoked_at" IS NULL`),
    check(
      "remote_controller_bindings_pairing_generation_matches_relay",
      sql`"pairing_generation" = "relay_token_id"`,
    ),
  ],
);

export type RemoteControllerInstallation =
  typeof remoteControllerInstallations.$inferSelect;
export type RemotePairingChallenge = typeof remotePairingChallenges.$inferSelect;
export type RemoteControllerBinding = typeof remoteControllerBindings.$inferSelect;
