import { and, eq, isNull, sql } from "drizzle-orm";
import { commands } from "../schema/commands";
import type { Command } from "../schema/commands";
import { getSharedDirectDb } from "../config/direct-database";

/**
 * D379 — commands store. All reads/writes are scoped to `(agentId, userId)`
 * (the running Agent + the speaking Human) so a command is never visible to
 * another Human on the same Agent. Soft-delete via `deleted_at`.
 *
 * Command persistence and ownership are defined by `../schema/commands.ts`.
 */

function db() {
  return getSharedDirectDb();
}

/** A single Level-0 catalog row — name + description only, never the body. */
export interface CommandCatalogEntry {
  name: string;
  description: string;
}

/** The selector's read: an enabled command's injectable body. */
export interface CommandBody {
  id: string;
  name: string;
  description: string;
  body: string;
}

export interface UpsertCommandInput {
  agentId: string;
  userId: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
  source?: "user" | "agent";
}

/**
 * Level-0 catalog for the system-prompt block — enabled, live commands for
 * `(agentId, userId)`. Selects `name, description` only (cheap at any scale).
 */
export async function listCatalog(
  agentId: string,
  userId: string,
): Promise<CommandCatalogEntry[]> {
  return db()
    .select({ name: commands.name, description: commands.description })
    .from(commands)
    .where(
      and(
        eq(commands.agentId, agentId),
        eq(commands.userId, userId),
        eq(commands.enabled, true),
        isNull(commands.deletedAt),
      ),
    )
    .orderBy(commands.name);
}

/** Fetch one live command by name for `(agentId, userId)` (the `view_command` read). */
export async function getByName(
  agentId: string,
  userId: string,
  name: string,
): Promise<Command | null> {
  const [row] = await db()
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.agentId, agentId),
        eq(commands.userId, userId),
        eq(commands.name, name),
        isNull(commands.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Create or update a command, keyed by `(agentId, userId, name)`. Re-creating a
 * soft-deleted name creates a new live row; prior soft-deleted rows are
 * retained as history. Caller is responsible for the `manage_agents` two-gate
 * (self-edit-or-cap) before invoking.
 */
export async function upsertCommand(input: UpsertCommandInput): Promise<Command> {
  const values = {
    agentId: input.agentId,
    userId: input.userId,
    name: input.name,
    description: input.description,
    body: input.body,
    enabled: input.enabled ?? true,
    source: input.source ?? "user",
    updatedAt: new Date(),
    deletedAt: null,
  };
  const [row] = await db()
    .insert(commands)
    .values(values)
    .onConflictDoUpdate({
      target: [commands.agentId, commands.userId, commands.name],
      targetWhere: isNull(commands.deletedAt),
      set: {
        description: values.description,
        body: values.body,
        enabled: values.enabled,
        source: values.source,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error("upsertCommand: insert returned no row");
  return row;
}

/** Toggle enabled/disabled for one command (scoped to its owner). */
export async function setCommandEnabled(
  agentId: string,
  userId: string,
  name: string,
  enabled: boolean,
): Promise<Command | null> {
  const [row] = await db()
    .update(commands)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(
        eq(commands.agentId, agentId),
        eq(commands.userId, userId),
        eq(commands.name, name),
        isNull(commands.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Soft-delete a command (scoped to its owner). Returns true if a row was deleted. */
export async function softDeleteCommand(
  agentId: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await db()
    .update(commands)
    .set({ deletedAt: sql`now()`, updatedAt: new Date() })
    .where(
      and(
        eq(commands.agentId, agentId),
        eq(commands.userId, userId),
        eq(commands.name, name),
        isNull(commands.deletedAt),
      ),
    )
    .returning({ id: commands.id });
  return rows.length > 0;
}
