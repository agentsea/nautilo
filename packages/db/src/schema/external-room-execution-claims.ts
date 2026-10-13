import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { rooms } from "./rooms";

/** Internal product authority; intentionally absent from Room DTO projections. */
export const externalRoomExecutionClaims = pgTable("external_room_execution_claims", {
  roomId: uuid("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade" }),
  // No Job or Human FK: deleting either must not release a live executor.
  jobId: uuid("job_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  token: uuid("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [pgPolicy("external_room_execution_claim_owner", {
  for: "all", to: "nautilo", using: sql`${t.ownerUserId} = nullif(current_setting('app.current_user_id', true), '')::uuid`,
  withCheck: sql`${t.ownerUserId} = nullif(current_setting('app.current_user_id', true), '')::uuid`,
})]).enableRLS();
