import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Admission receipts for the bounded server-funded personal setup service. */
export const soulGenerationAttempts = pgTable(
  "soul_generation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    humanUserId: uuid("human_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_soul_generation_attempts_human_time").on(table.humanUserId, table.startedAt)],
);
