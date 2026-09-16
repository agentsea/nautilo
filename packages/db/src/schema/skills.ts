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
 * D263 — Agent skills (on-demand instruction modules).
 *
 * A skill is the third behavior surface beyond the system prompt and
 * tools: packaged, on-demand *knowledge* injected up front in `pre-model`
 * so it reads as latent competence.
 *
 * **Speaker-scoped agent-config**, keyed `(agent_id, user_id)` — modeled
 * on `agent_scopes` `(parent_agent_id, speaker_user_id)`, NOT agent-global.
 * A skill therefore never surfaces for another Human on a shared Agent
 * (the shared-agent leak), and any private context in a body stays with
 * its author. It is the Soul/Profile config family, **not** namespace
 * content: no `namespace_id`, no junction, no subset-rule gating.
 *
 * Load-bearing invariant (R9): a skill is **instructions only**. Injection
 * is appended prompt text and never mutates the per-turn trust envelope
 * (`toolPolicy` / namespaces), so a skill cannot grant tools or widen
 * access by construction. Authoring is gated by the `manage_agents`
 * two-gate (no new capability), like `manage_profile` / `regenerate_soul`.
 *
 * Query and ownership checks live in `../queries/skills.ts`.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The running Agent this skill belongs to.
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // R1: the authoring/speaking Human — the speaker dimension.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Frontmatter name; [a-z0-9-], <=64 (enforced at the tool/validator layer).
    name: text("name").notNull(),
    // Level-0 catalog line (<=1024); shown in the per-turn `## Available skills` block.
    description: text("description").notNull(),
    // SKILL.md markdown body (M2: encrypt under the owner identity key).
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // R15: optional per-skill tool prerequisites; the selector withholds the
    // skill when any are absent from the turn's filtered tool set.
    requiresTools: text("requires_tools").array().notNull().default([]),
    // 'user' (owner-authored) | 'agent' (Genie-authored via skill_manage).
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
    uniqueIndex("uniq_skills_agent_user_name")
      .on(table.agentId, table.userId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Hot path: the selector's enabled-skills-for-speaker read.
    index("idx_skills_agent_user_enabled")
      .on(table.agentId, table.userId)
      .where(sql`${table.enabled} AND ${table.deletedAt} IS NULL`),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
