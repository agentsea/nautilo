import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./users";

/**
 * D379 — Agent slash-commands (on-demand instruction modules).
 *
 * A command is a packaged instruction module surfaced via slash-command
 * invocation, mirrored from the skills subsystem minus skill-only fields.
 * Commands are never auto-injected and have no tool-gating, so they carry
 * no `requiresTools`.
 *
 * **Speaker-scoped agent-config**, keyed `(agent_id, user_id)` — modeled
 * on `agent_scopes` `(parent_agent_id, speaker_user_id)`, NOT agent-global.
 * A command therefore never surfaces for another Human on a shared Agent
 * (the shared-agent leak), and any private context in a body stays with
 * its author. It is the Soul/Profile config family, **not** namespace
 * content: no `namespace_id`, no junction, no subset-rule gating.
 *
 * Query and ownership checks live in `../queries/commands.ts`.
 */
export const commands = pgTable(
  "commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The running Agent this command belongs to.
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // R1: the authoring/speaking Human — the speaker dimension.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Frontmatter name; [a-z0-9-], <=64 (enforced at the tool/validator layer).
    name: text("name").notNull(),
    // Level-0 catalog line (<=1024); shown in the per-turn `## Available commands` block.
    description: text("description").notNull(),
    // COMMAND.md markdown body (M2: encrypt under the owner identity key).
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // 'user' (owner-authored) | 'agent' (Genie-authored via command_manage).
    source: text("source").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Per-(agent, author) name uniqueness among live rows.
    uniqueIndex("uniq_commands_agent_user_name")
      .on(table.agentId, table.userId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Hot path: the selector's enabled-commands-for-speaker read.
    index("idx_commands_agent_user_enabled")
      .on(table.agentId, table.userId)
      .where(sql`${table.enabled} AND ${table.deletedAt} IS NULL`),
  ],
);

export type Command = typeof commands.$inferSelect;
export type NewCommand = typeof commands.$inferInsert;
