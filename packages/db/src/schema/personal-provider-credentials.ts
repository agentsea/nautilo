import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const PERSONAL_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "xai",
  "fireworks",
  "together",
  "venice",
] as const;

export type PersonalProviderId = (typeof PERSONAL_PROVIDER_IDS)[number];

/**
 * One current encrypted provider credential per Human and direct provider.
 * Plaintext credentials and historical envelopes never belong in this table.
 */
export const personalProviderCredentials = pgTable(
  "personal_provider_credentials",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", {
      length: 32,
      enum: PERSONAL_PROVIDER_IDS,
    }).notNull(),
    revision: integer("revision").notNull(),
    formatVersion: integer("format_version").notNull(),
    keyId: uuid("key_id").notNull(),
    nonceBase64: text("nonce_base64").notNull(),
    ciphertextBase64: text("ciphertext_base64").notNull(),
    authTagBase64: text("auth_tag_base64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_personal_provider_credentials_user_provider").on(
      table.userId,
      table.provider,
    ),
    check(
      "personal_provider_credentials_provider_check",
      sql`${table.provider} in ('anthropic', 'openai', 'openrouter', 'google', 'xai', 'fireworks', 'together', 'venice')`,
    ),
    check(
      "personal_provider_credentials_revision_check",
      sql`${table.revision} >= 1`,
    ),
    check(
      "personal_provider_credentials_format_check",
      sql`${table.formatVersion} = 1`,
    ),
    check(
      "personal_provider_credentials_envelope_nonempty",
      sql`octet_length(${table.nonceBase64}) > 0 and octet_length(${table.ciphertextBase64}) > 0 and octet_length(${table.authTagBase64}) > 0`,
    ),
  ],
);

export type PersonalProviderCredentialRow =
  typeof personalProviderCredentials.$inferSelect;
