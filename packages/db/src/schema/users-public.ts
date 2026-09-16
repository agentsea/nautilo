import { pgView, text, uuid, varchar, timestamp } from "drizzle-orm/pg-core";

/**
 * M033 Phase 3 — sanitized user identity readable by `nautilo_agent`.
 * Created in Postgres by `infra/postgres-init.sh` / `agent-role-grants.ts`;
 * Drizzle declares it with `.existing()` so `db:push` does not recreate it.
 */
export const usersPublic = pgView("users_public", {
  id: uuid("id").notNull(),
  handle: text("handle"),
  name: varchar("name", { length: 255 }).notNull(),
  server: text("server"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}).existing();
