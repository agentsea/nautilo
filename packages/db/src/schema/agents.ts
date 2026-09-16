import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * M045: dropped `agents.owner_id → users.id ON DELETE CASCADE`; there is
 * no `owner_id` column on this table.
 *
 * Ownership of a personal Agent is the **`actors` mirror** (M042B): the
 * row where `actors.owner_id = users.id AND actors.kind = 'agent' AND
 * actors.agent_id = agents.id`. The authoritative "who owns this Agent?"
 * resolution is `findPersonalAgentsForUser` /
 * `findDefaultAgentForOwnerWithDb` (in `packages/trust/`), which join
 * `actors`, NOT any `agent_ownership` Group — that group type and
 * `groups.agent_id` were dropped in migration `0062_m128`.
 * `manage_agents` is a server-wide Capability for creating/deleting
 * Agents (future surface), NOT an ownership edge.
 *
 * M132: the Profile is 1:1 with the Agent it describes via
 * `profiles.agent_id` (NOT NULL UNIQUE). See
 * `entity-model/relationships/REL-AGT-HUM.md`.
 *
 * `UNIQUE(handle)` replaces the dropped `idx_agents_owner_handle` index.
 * Two roles:
 *   - Idempotency key for `seedDefaultAgent` (no more owner scoping).
 *   - Per-server uniqueness for federated-id routing (`@handle@server`) —
 *     `findActorByHandle` / `findHandleOwner` rely on a single-row match.
 */

/**
 * D141 P2 / LD-1 — per-agent customization envelope.
 *
 * This jsonb column is the customize-in-place container that D140 will
 * also write to for personality / voice persistence. D141 adds the
 * `fallback` field; D140 will add `personalityTone`, `voiceId`, etc.
 * without schema collision. Both stacks coordinate by *extending* the
 * shape (open interface), never rewriting it.
 *
 * Shape contract:
 *   - `fallback.enabled?: boolean` — per-agent override of
 *     `profiles.fallbackEnabled`. Absent = inherit from user.
 *   - `fallback.chain?: string[]` — per-agent ordered list of catalog
 *     model IDs. Absent = inherit from user.
 *   - Future D140 fields (personalityTone, voiceId, etc.) live alongside
 *     `fallback` with their own dot-paths.
 *
 * `resolveFallbackPolicy(userId, agentId)` is the only reader for the
 * `fallback` field; see `packages/agent/src/utils/resolve-fallback-policy.ts`.
 *
 * D140 coordination note: as of 2026-05-18, D140 has not yet landed any
 * `customization` column to main (Stack 13 in progress; no merged PR in
 * the #157..#176 window). D141 P2 owns the column shape; if D140 lands
 * mid-stack, the agents-customization-aware code in this stack must NOT
 * be rewritten — D140 adds new keys on the same envelope, doesn't
 * redefine existing ones.
 */
export interface AgentCustomization {
  fallback?: {
    enabled?: boolean;
    chain?: string[];
  };
  // D140 will extend this interface with personalityTone, voiceId, etc.
}

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    // M156 — `display_name` removed. The Agent's name is single-sourced
    // on `profiles.name` (1:1 via profiles.agent_id, M132). The agent
    // mirror `actors.display_name` is a synced cache of that name.
    // `handle_customized` gates auto-derivation: once the user edits the
    // handle by hand, renaming the Agent no longer re-derives it.
    handleCustomized: boolean("handle_customized").notNull().default(false),
    customization: jsonb("customization").$type<AgentCustomization>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("agents_handle_unique").on(table.handle)],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
