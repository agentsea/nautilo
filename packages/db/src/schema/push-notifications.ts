/**
 * D468 — durable, content-free admission for important-message push.
 *
 * A candidate proves that canonical message persistence crossed the only
 * durable admission seam. It intentionally carries no message text, labels,
 * sender identity, Room identity, or free-form metadata: later trusted
 * classification re-reads the existing canonical structural facts by
 * `message_id` after commit.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { sessionMessages } from "./sessions";
import { users } from "./users";

export const PUSH_MESSAGE_CANDIDATE_STATES = [
  "pending",
  "claimed",
  "terminal",
] as const;
export type PushMessageCandidateState =
  (typeof PUSH_MESSAGE_CANDIDATE_STATES)[number];

/**
 * One idempotent durable push-admission marker for an eligible canonical
 * message. `terminal` is the worker's explicit no-op/handled state; no
 * provider, token, delivery, or receipt data belongs here. `claimed` carries
 * only a short-lived worker lease so a restart can safely retry admission.
 */
export const pushMessageCandidates = pgTable(
  "push_message_candidates",
  {
    messageId: integer("message_id")
      .primaryKey()
      .references(() => sessionMessages.id, { onDelete: "cascade" }),
    state: text("state", { enum: PUSH_MESSAGE_CANDIDATE_STATES })
      .notNull()
      .default("pending"),
    claimOwner: varchar("claim_owner", { length: 128 }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_push_message_candidates_pending").on(
      table.createdAt,
      table.messageId,
    ).where(sql`${table.state} IN ('pending', 'claimed')`),
    check(
      "push_message_candidates_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'terminal')`,
    ),
    check(
      "push_message_candidates_lease_shape_check",
      sql`(
        ${table.state} = 'claimed'
        AND ${table.claimOwner} IS NOT NULL
        AND ${table.claimExpiresAt} IS NOT NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} = 'pending'
        AND ${table.claimOwner} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} = 'terminal'
        AND ${table.claimOwner} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PushMessageCandidate = typeof pushMessageCandidates.$inferSelect;
export type NewPushMessageCandidate =
  typeof pushMessageCandidates.$inferInsert;

/**
 * The only server-local record that can address one Mobile installation for
 * push. The Expo token never appears in plaintext: it is the versioned
 * AES-GCM envelope owned by the server push adapter. `revokeVerifierDigest`
 * is a domain-separated one-way digest of the Mobile-only revoke proof.
 *
 * A revoked row is intentionally retained as terminal lifecycle evidence.
 * Registration must never turn it active again; a client which needs a new
 * binding mints a new binding UUID.
 */
export const PUSH_INSTALLATION_BINDING_STATES = [
  "active",
  "disabled",
  "revoked",
] as const;
export type PushInstallationBindingState =
  (typeof PUSH_INSTALLATION_BINDING_STATES)[number];

export const PUSH_INSTALLATION_PLATFORMS = ["ios", "android"] as const;
export type PushInstallationPlatform =
  (typeof PUSH_INSTALLATION_PLATFORMS)[number];

export const PUSH_INSTALLATION_PERMISSIONS = [
  "granted",
  "denied",
  "undetermined",
] as const;
export type PushInstallationPermission =
  (typeof PUSH_INSTALLATION_PERMISSIONS)[number];

export const pushInstallationBindings = pgTable(
  "push_installation_bindings",
  {
    /** Client-minted per-server opaque routing identity; never a server URL. */
    bindingId: uuid("binding_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** One stable, SecureStore-backed app installation UUID. */
    installationId: uuid("installation_id").notNull(),
    platform: varchar("platform", { length: 16, enum: PUSH_INSTALLATION_PLATFORMS })
      .notNull(),
    tokenGeneration: integer("token_generation").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Whether real iOS message pushes may update the app icon badge. */
    badgeEnabled: boolean("badge_enabled").notNull().default(false),
    permission: varchar("permission", { length: 16, enum: PUSH_INSTALLATION_PERMISSIONS })
      .notNull(),
    state: varchar("state", { length: 16, enum: PUSH_INSTALLATION_BINDING_STATES })
      .notNull()
      .default("active"),
    appVersion: varchar("app_version", { length: 128 }).notNull(),
    /** Versioned AES-256-GCM envelope; no raw Expo capability material. */
    tokenKeyVersion: integer("token_key_version").notNull(),
    tokenNonceBase64: varchar("token_nonce_base64", { length: 64 }).notNull(),
    tokenCiphertextBase64: text("token_ciphertext_base64").notNull(),
    tokenAuthTagBase64: varchar("token_auth_tag_base64", { length: 64 }).notNull(),
    /** SHA-256 over a protocol domain separator and the high-entropy proof. */
    revokeVerifierDigest: varchar("revoke_verifier_digest", { length: 64 }).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One live server binding per Human × app installation. */
    uniqueIndex("uq_push_installation_bindings_user_installation_live")
      .on(table.userId, table.installationId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_push_installation_bindings_user_live")
      .on(table.userId, table.updatedAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "push_installation_bindings_generation_check",
      sql`${table.tokenGeneration} > 0`,
    ),
    check(
      "push_installation_bindings_platform_check",
      sql`${table.platform} IN ('ios', 'android')`,
    ),
    check(
      "push_installation_bindings_permission_check",
      sql`${table.permission} IN ('granted', 'denied', 'undetermined')`,
    ),
    check(
      "push_installation_bindings_state_check",
      sql`${table.state} IN ('active', 'disabled', 'revoked')`,
    ),
    check(
      "push_installation_bindings_revoke_digest_size_check",
      sql`octet_length(${table.revokeVerifierDigest}) = 64`,
    ),
    check(
      "push_installation_bindings_state_shape_check",
      sql`(
        ${table.state} = 'active'
        AND ${table.enabled} = true
        AND ${table.permission} = 'granted'
        AND ${table.disabledAt} IS NULL
        AND ${table.revokedAt} IS NULL
      ) OR (
        ${table.state} = 'disabled'
        AND ${table.enabled} = false
        AND ${table.revokedAt} IS NULL
      ) OR (
        ${table.state} = 'revoked'
        AND ${table.enabled} = false
        AND ${table.revokedAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PushInstallationBinding =
  typeof pushInstallationBindings.$inferSelect;
export type NewPushInstallationBinding =
  typeof pushInstallationBindings.$inferInsert;

/**
 * A bounded, generic user-requested test. It proves only that delivery work
 * was accepted for later processing; it stores no title, body, target URL,
 * message text, or provider receipt.
 */
export const PUSH_NOTIFICATION_TEST_INTENT_STATES = [
  "pending",
  "claimed",
  "terminal",
] as const;
export type PushNotificationTestIntentState =
  (typeof PUSH_NOTIFICATION_TEST_INTENT_STATES)[number];

export const pushNotificationTestIntents = pgTable(
  "push_notification_test_intents",
  {
    notificationId: uuid("notification_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => pushInstallationBindings.bindingId, { onDelete: "restrict" }),
    tokenGeneration: integer("token_generation").notNull(),
    state: varchar("state", { length: 16, enum: PUSH_NOTIFICATION_TEST_INTENT_STATES })
      .notNull()
      .default("pending"),
    claimOwner: varchar("claim_owner", { length: 128 }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_push_notification_test_intents_binding_created").on(
      table.bindingId,
      table.createdAt,
    ),
    check(
      "push_notification_test_intents_generation_check",
      sql`${table.tokenGeneration} > 0`,
    ),
    check(
      "push_notification_test_intents_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'terminal')`,
    ),
    check(
      "push_notification_test_intents_terminal_shape_check",
      sql`(
        ${table.state} = 'pending'
        AND ${table.claimOwner} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} = 'claimed'
        AND ${table.claimOwner} IS NOT NULL
        AND ${table.claimExpiresAt} IS NOT NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} = 'terminal'
        AND ${table.claimOwner} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PushNotificationTestIntent =
  typeof pushNotificationTestIntents.$inferSelect;
export type NewPushNotificationTestIntent =
  typeof pushNotificationTestIntents.$inferInsert;

/** D468 durable logical push-delivery lifecycle, one per binding generation. */
export const PUSH_NOTIFICATION_DELIVERY_KINDS = [
  "important_message",
  "needs_you",
  "test",
] as const;
export type PushNotificationDeliveryKind =
  (typeof PUSH_NOTIFICATION_DELIVERY_KINDS)[number];

export const PUSH_NOTIFICATION_DELIVERY_STATES = [
  "pending",
  "claimed",
  "receipt_pending",
  "retry",
  "delivered",
  "terminal",
] as const;
export type PushNotificationDeliveryState =
  (typeof PUSH_NOTIFICATION_DELIVERY_STATES)[number];

export const PUSH_NOTIFICATION_DELIVERY_CLAIM_PURPOSES = [
  "send",
  "receipt",
] as const;
export type PushNotificationDeliveryClaimPurpose =
  (typeof PUSH_NOTIFICATION_DELIVERY_CLAIM_PURPOSES)[number];

/**
 * One logical outbound notification. This retains opaque routing identities
 * and provider ticket IDs only; the Expo capability remains encrypted on the
 * owned binding. No message text, sender/Room label, URL, or copy may enter.
 */
export const pushNotificationDeliveries = pgTable(
  "push_notification_deliveries",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => pushInstallationBindings.bindingId, { onDelete: "restrict" }),
    tokenGeneration: integer("token_generation").notNull(),
    kind: varchar("kind", { length: 32, enum: PUSH_NOTIFICATION_DELIVERY_KINDS })
      .notNull(),
    /** Canonical message ID or generic test intent UUID, never content. */
    eventId: varchar("event_id", { length: 128 }).notNull(),
    roomId: uuid("room_id"),
    topLevelRoomId: uuid("top_level_room_id"),
    messageId: integer("message_id"),
    attentionRequestId: uuid("attention_request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    state: varchar("state", { length: 32, enum: PUSH_NOTIFICATION_DELIVERY_STATES })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    receiptAttemptCount: integer("receipt_attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ticketId: varchar("ticket_id", { length: 256 }),
    ticketAcceptedAt: timestamp("ticket_accepted_at", { withTimezone: true }),
    claimOwner: varchar("claim_owner", { length: 128 }),
    claimPurpose: varchar("claim_purpose", { length: 16, enum: PUSH_NOTIFICATION_DELIVERY_CLAIM_PURPOSES }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastFailureCode: varchar("last_failure_code", { length: 64 }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_push_notification_deliveries_logical_generation").on(
      table.kind,
      table.eventId,
      table.bindingId,
      table.tokenGeneration,
    ),
    index("idx_push_notification_deliveries_due").on(
      table.nextAttemptAt,
      table.createdAt,
    ).where(sql`${table.state} IN ('pending', 'retry', 'receipt_pending')`),
    index("idx_push_notification_deliveries_terminal_retention").on(
      table.terminalAt,
    ).where(sql`${table.terminalAt} IS NOT NULL`),
    check(
      "push_notification_deliveries_generation_check",
      sql`${table.tokenGeneration} > 0`,
    ),
    check(
      "push_notification_deliveries_kind_check",
      sql`${table.kind} IN ('important_message', 'needs_you', 'test')`,
    ),
    check(
      "push_notification_deliveries_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'receipt_pending', 'retry', 'delivered', 'terminal')`,
    ),
    check(
      "push_notification_deliveries_attempt_bounds_check",
      sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 8
        AND ${table.receiptAttemptCount} >= 0 AND ${table.receiptAttemptCount} <= 24`,
    ),
    check(
      "push_notification_deliveries_target_shape_check",
      sql`(
        ${table.kind} = 'important_message'
        AND ${table.roomId} IS NOT NULL
        AND ${table.topLevelRoomId} IS NOT NULL
        AND ${table.messageId} IS NOT NULL
        AND ${table.attentionRequestId} IS NULL
      ) OR (
        ${table.kind} = 'needs_you'
        AND ${table.roomId} IS NOT NULL
        AND ${table.topLevelRoomId} IS NOT NULL
        AND ${table.messageId} IS NULL
        AND ${table.attentionRequestId} IS NOT NULL
      ) OR (
        ${table.kind} = 'test'
        AND ${table.roomId} IS NULL
        AND ${table.topLevelRoomId} IS NULL
        AND ${table.messageId} IS NULL
        AND ${table.attentionRequestId} IS NULL
      )`,
    ),
    check(
      "push_notification_deliveries_expiry_bound_check",
      sql`${table.expiresAt} > ${table.createdAt}
        AND ${table.expiresAt} <= ${table.createdAt} + interval '2 days'`,
    ),
    check(
      "push_notification_deliveries_lease_shape_check",
      sql`(
        ${table.state} = 'claimed'
        AND ${table.claimOwner} IS NOT NULL
        AND ${table.claimPurpose} IN ('send', 'receipt')
        AND ${table.claimExpiresAt} IS NOT NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} IN ('pending', 'retry', 'receipt_pending')
        AND ${table.claimOwner} IS NULL
        AND ${table.claimPurpose} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} IN ('delivered', 'terminal')
        AND ${table.claimOwner} IS NULL
        AND ${table.claimPurpose} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.terminalAt} IS NOT NULL
      )`,
    ),
  ],
);

export type PushNotificationDelivery =
  typeof pushNotificationDeliveries.$inferSelect;
export type NewPushNotificationDelivery =
  typeof pushNotificationDeliveries.$inferInsert;
