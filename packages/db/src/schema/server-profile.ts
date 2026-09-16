import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AvatarRef } from "@nautilo/types";

/**
 * D280 — server-scoped identity singleton (name / description / icon).
 * Distinct from agent-keyed `profiles`; one row per DB (`id='server'`).
 */
export const serverProfile = pgTable("server_profile", {
  id: text("id").primaryKey().default("server"),
  name: text("name"),
  description: text("description"),
  descriptionVisibility: text("description_visibility")
    .notNull()
    .default("public"),
  icon: jsonb("icon").$type<AvatarRef>(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ServerProfileRow = typeof serverProfile.$inferSelect;
export type NewServerProfileRow = typeof serverProfile.$inferInsert;
