import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { ClaudeConnectionAccount, ClaudeConnectionCatalog, ClaudeConnectionRuntime } from "@nautilo/types";
import { users } from "./users";

/** Safe facts only. Credentials, paths, relay/session ids, provider flags, and cost never persist here. */
export type { ClaudeConnectionAccount, ClaudeConnectionCatalog, ClaudeConnectionModel, ClaudeConnectionRuntime } from "@nautilo/types";

/** One durable, user-scoped opaque Claude profile. `profileRef` is server-minted and never browser input. */
export const claudeConnections = pgTable(
  "claude_connections",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    profileRef: uuid("profile_ref").notNull().defaultRandom(),
    enabled: boolean("enabled").notNull().default(false),
    /** Retained owner preference; currently admitted only against a fresh complete catalog. */
    selectedModel: varchar("selected_model", { length: 320 }),
    runtime: jsonb("runtime").$type<ClaudeConnectionRuntime | null>(),
    account: jsonb("account").$type<ClaudeConnectionAccount | null>(),
    catalog: jsonb("catalog").$type<ClaudeConnectionCatalog | null>(),
    observationRevision: integer("observation_revision").notNull().default(0),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_claude_connections_profile_ref").on(table.profileRef),
    check("claude_connections_observation_revision_check", sql`${table.observationRevision} >= 0`),
  ],
);

export type ClaudeConnection = typeof claudeConnections.$inferSelect;
