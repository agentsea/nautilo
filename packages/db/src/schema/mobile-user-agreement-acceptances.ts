import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * M297 — append-oriented acceptance history for the mandatory Mobile
 * agreement. At most one row per Human is current; withdrawal closes that row
 * and a later acceptance creates a new audit fact.
 */
export const mobileUserAgreementAcceptances = pgTable(
  "mobile_user_agreement_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agreementVersion: varchar("agreement_version", { length: 96 }).notNull(),
    policyVersion: varchar("policy_version", { length: 96 }).notNull(),
    recipientManifestVersion: varchar("recipient_manifest_version", { length: 96 }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uniq_mobile_agreement_active_user")
      .on(table.userId)
      .where(sql`${table.withdrawnAt} IS NULL`),
    index("idx_mobile_agreement_user_time").on(table.userId, table.acceptedAt),
  ],
);

export type MobileUserAgreementAcceptance = typeof mobileUserAgreementAcceptances.$inferSelect;
export type NewMobileUserAgreementAcceptance = typeof mobileUserAgreementAcceptances.$inferInsert;
