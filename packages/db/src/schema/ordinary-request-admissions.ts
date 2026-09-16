import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { remoteControllerInstallations } from "./remote-control";
import { actors } from "./trust";
import { users } from "./users";

/**
 * Short-lived replay receipt at the canonical ordinary-message boundary.
 * This is not a Remote command/run queue and stores no message or Tool data.
 */
export const ordinaryRequestAdmissions = pgTable(
  "ordinary_request_admissions",
  {
    requestId: uuid("request_id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
    controllerInstallationId: uuid("controller_installation_id")
      .notNull()
      .references(() => remoteControllerInstallations.id, { onDelete: "cascade" }),
    installationGeneration: integer("installation_generation").notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_ordinary_request_admissions_expiry").on(table.expiresAt),
    check(
      "ordinary_request_admissions_generation_positive",
      sql`${table.installationGeneration} > 0`,
    ),
    check(
      "ordinary_request_admissions_body_digest_canonical",
      sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type OrdinaryRequestAdmission = typeof ordinaryRequestAdmissions.$inferSelect;
