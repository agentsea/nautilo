import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { PersonalCapabilityPreferenceOverrides } from "@nautilo/types";
import { users } from "./users";

/**
 * One sparse, account-wide non-embedding preference map per Human. Defaults
 * remain owned by their execution subsystems and are never materialized here.
 */
export const personalCapabilityPreferences = pgTable(
  "personal_capability_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    overrides: jsonb("overrides")
      .$type<PersonalCapabilityPreferenceOverrides>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "personal_capability_preferences_revision_check",
      sql`${table.revision} >= 1`,
    ),
    check(
      "personal_capability_preferences_overrides_object_check",
      sql`jsonb_typeof(${table.overrides}) = 'object'`,
    ),
  ],
);

export type PersonalCapabilityPreferencesRow =
  typeof personalCapabilityPreferences.$inferSelect;
