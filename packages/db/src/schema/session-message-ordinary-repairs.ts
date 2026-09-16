import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sessionMessageCryptoRevisions } from "./session-message-crypto-revisions";
import { sessions } from "./sessions";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

const nautiloProductRole = pgRole("nautilo").existing();
const nautiloAgentRole = pgRole("nautilo_agent").existing();

/**
 * M318 append-only evidence for one exact reverse-Shadow Message repair.
 * Authority remains the mapped protected revision plus the current caller;
 * this receipt grants no independent content or key access.
 */
export const sessionMessageOrdinaryRepairs = pgTable(
  "session_message_ordinary_repairs",
  {
    sessionId: uuid("session_id").notNull(),
    messageId: integer("message_id").notNull(),
    editRevision: integer("edit_revision").notNull(),
    cryptoObjectId: text("crypto_object_id").notNull(),
    expectedKeyClass: text("expected_key_class", {
      enum: ["ai", "human"],
    }).notNull(),
    authorityActorId: uuid("authority_actor_id").notNull(),
    repairIdentityDigest: bytea("repair_identity_digest").notNull(),
    attestationDigest: bytea("attestation_digest").notNull(),
    publisherKind: text("publisher_kind", {
      enum: ["authenticated_runtime", "device_attested"],
    }).notNull(),
    publisherId: text("publisher_id").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => {
    const currentAgentRevision = sql`${table.publisherKind} = 'authenticated_runtime'
      and ${table.expectedKeyClass} = 'ai'
      and ${table.authorityActorId} = app_current_agent_id()
      and exists (
        select 1
          from ${sessionMessageCryptoRevisions} lifecycle
          join ${sessions} session_row
            on session_row.id = lifecycle.session_id
         where lifecycle.session_id = ${table.sessionId}
           and lifecycle.message_id = ${table.messageId}
           and lifecycle.edit_revision = ${table.editRevision}
           and lifecycle.crypto_object_id = ${table.cryptoObjectId}
           and lifecycle.key_class = ${table.expectedKeyClass}
           and lifecycle.completion = 'complete'
           and lifecycle.disposition = 'mapped'
           and session_row.room_id = lifecycle.room_id
           and app_agent_in_room(lifecycle.room_id)
      )`;
    return [
      primaryKey({
        columns: [table.sessionId, table.messageId, table.editRevision],
      }),
      foreignKey({
        name: "session_message_ordinary_repairs_revision_object_fk",
        columns: [
          table.sessionId,
          table.messageId,
          table.editRevision,
          table.cryptoObjectId,
        ],
        foreignColumns: [
          sessionMessageCryptoRevisions.sessionId,
          sessionMessageCryptoRevisions.messageId,
          sessionMessageCryptoRevisions.editRevision,
          sessionMessageCryptoRevisions.cryptoObjectId,
        ],
      }).onDelete("cascade"),
      unique("uq_session_message_ordinary_repairs_identity")
        .on(table.repairIdentityDigest),
      check(
        "session_message_ordinary_repairs_revision_nonnegative",
        sql`${table.editRevision} >= 0`,
      ),
      check(
        "session_message_ordinary_repairs_key_class",
        sql`${table.expectedKeyClass} in ('ai', 'human')`,
      ),
      check(
        "session_message_ordinary_repairs_identity_digest_size",
        sql`octet_length(${table.repairIdentityDigest}) = 32`,
      ),
      check(
        "session_message_ordinary_repairs_attestation_digest_size",
        sql`octet_length(${table.attestationDigest}) = 32`,
      ),
      check(
        "session_message_ordinary_repairs_publisher_kind",
        sql`${table.publisherKind} in ('authenticated_runtime', 'device_attested')`,
      ),
      check(
        "session_message_ordinary_repairs_publisher_id",
        sql`length(${table.publisherId}) between 1 and 255`,
      ),
      check(
        "session_message_ordinary_repairs_policy_revision",
        sql`${table.policyRevision} > 0`,
      ),
      pgPolicy("session_message_ordinary_repairs_product_all", {
        for: "all",
        to: nautiloProductRole,
        using: sql`true`,
        withCheck: sql`true`,
      }),
      pgPolicy("session_message_ordinary_repairs_agent_select", {
        for: "select",
        to: nautiloAgentRole,
        using: currentAgentRevision,
      }),
      pgPolicy("session_message_ordinary_repairs_agent_insert", {
        for: "insert",
        to: nautiloAgentRole,
        withCheck: currentAgentRevision,
      }),
    ];
  },
).enableRLS();

export type SessionMessageOrdinaryRepair =
  typeof sessionMessageOrdinaryRepairs.$inferSelect;
