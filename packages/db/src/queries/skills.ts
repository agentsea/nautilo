import { and, eq, isNull, sql } from "drizzle-orm";
import { skills } from "../schema/skills";
import type { Skill } from "../schema/skills";
import { getSharedDirectDb } from "../config/direct-database";

/**
 * D263 — skills store. All reads/writes are scoped to `(agentId, userId)`
 * (the running Agent + the speaking Human) so a skill is never visible to
 * another Human on the same Agent. Soft-delete via `deleted_at`.
 *
 * Skill persistence and ownership are defined by `../schema/skills.ts`.
 */

function db() {
  return getSharedDirectDb();
}

/** A single Level-0 catalog row — name + description only, never the body. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
}

/** The selector's read: an enabled skill's injectable body + gating metadata. */
export interface SkillBody {
  id: string;
  name: string;
  description: string;
  body: string;
  requiresTools: string[];
}

export interface UpsertSkillInput {
  agentId: string;
  userId: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
  requiresTools?: string[];
  source?: "user" | "agent";
}

/**
 * Level-0 catalog for the system-prompt block — enabled, live skills for
 * `(agentId, userId)`. Selects `name, description` only (cheap at any scale).
 */
export async function listCatalog(
  agentId: string,
  userId: string,
): Promise<SkillCatalogEntry[]> {
  return db()
    .select({ name: skills.name, description: skills.description })
    .from(skills)
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        eq(skills.enabled, true),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(skills.name);
}

/**
 * The v0 selector's read — enabled, live skill bodies (+ requiresTools) for
 * `(agentId, userId)`. The selector decides which of these fit the budget.
 */
export async function getEnabledBodies(
  agentId: string,
  userId: string,
): Promise<SkillBody[]> {
  return db()
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      body: skills.body,
      requiresTools: skills.requiresTools,
    })
    .from(skills)
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        eq(skills.enabled, true),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(skills.name);
}

/** Fetch one live skill by name for `(agentId, userId)` (the `view_skill` read). */
export async function getByName(
  agentId: string,
  userId: string,
  name: string,
): Promise<Skill | null> {
  const [row] = await db()
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        eq(skills.name, name),
        isNull(skills.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Create or update a skill, keyed by `(agentId, userId, name)`. Re-creating a
 * soft-deleted name creates a new live row; prior soft-deleted rows are
 * retained as history. Caller is responsible for the `manage_agents` two-gate
 * (self-edit-or-cap) before invoking.
 */
export async function upsertSkill(input: UpsertSkillInput): Promise<Skill> {
  const values = {
    agentId: input.agentId,
    userId: input.userId,
    name: input.name,
    description: input.description,
    body: input.body,
    enabled: input.enabled ?? true,
    requiresTools: input.requiresTools ?? [],
    source: input.source ?? "user",
    updatedAt: new Date(),
    deletedAt: null,
  };
  const [row] = await db()
    .insert(skills)
    .values(values)
    .onConflictDoUpdate({
      target: [skills.agentId, skills.userId, skills.name],
      targetWhere: isNull(skills.deletedAt),
      set: {
        description: values.description,
        body: values.body,
        enabled: values.enabled,
        requiresTools: values.requiresTools,
        source: values.source,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error("upsertSkill: insert returned no row");
  return row;
}

/** Toggle enabled/disabled for one skill (scoped to its owner). */
export async function setSkillEnabled(
  agentId: string,
  userId: string,
  name: string,
  enabled: boolean,
): Promise<Skill | null> {
  const [row] = await db()
    .update(skills)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        eq(skills.name, name),
        isNull(skills.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Soft-delete a skill (scoped to its owner). Returns true if a row was deleted. */
export async function softDeleteSkill(
  agentId: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await db()
    .update(skills)
    .set({ deletedAt: sql`now()`, updatedAt: new Date() })
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        eq(skills.name, name),
        isNull(skills.deletedAt),
      ),
    )
    .returning({ id: skills.id });
  return rows.length > 0;
}
