import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { rooms } from "./rooms";

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  requestorId: uuid("requestor_id")
    .notNull()
    .references(() => users.id),
  laneKey: varchar("lane_key", { length: 255 }),
  // Nullable in M042B; seedDefaultRoom backfills existing owner rows.
  // Guest and background jobs stay NULL.
  roomId: uuid("room_id").references(() => rooms.id),
  type: varchar("type", { length: 50 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("queued"),
  input: jsonb("input").$type<Record<string, unknown>>(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  message: text("message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
