import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { agents } from "../schema/agents";
import { actors } from "../schema/trust";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";

/**
 * D120 A1.P1b — returns the oldest Agent the user owns the
 * mirror-actor pointer for, or `null` if none exists.
 *
 * Post-M128 there is no per-Agent `agent_ownership` Group anymore.
 * The user-to-agent link is the `actors` mirror row minted by
 * `seedPersonalAgentForInviteeInTx` /
 * `claimBootstrapSeedAgentInTx`: `actors.owner_id = ownerUserId AND
 * actors.kind = 'agent' AND actors.agent_id IS NOT NULL`.
 *
 * Used at server boot to repopulate the bootstrap-state-cache's
 * `defaultAgentId` field with the claimer's per-user Agent after a
 * restart. The redeem-invite tx mints exactly one personal Agent per
 * claimer (`seedPersonalAgentForInviteeInTx`), so this returns
 * either 0 or 1 rows today; the ORDER BY future-proofs the call
 * against shared-agent extensions.
 */
export async function findDefaultAgentForOwner(
  ownerUserId: string,
): Promise<string | null> {
  const directConnection = resolveDirectDatabaseConnectionString();
  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);
  try {
    return await findDefaultAgentForOwnerWithDb(db, ownerUserId);
  } finally {
    await sql.end();
  }
}

export async function findDefaultAgentForOwnerWithDb(
  db: ReturnType<typeof drizzle>,
  ownerUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(actors, eq(actors.agentId, agents.id))
    .where(
      and(
        eq(actors.ownerId, ownerUserId),
        eq(actors.kind, "agent"),
        isNotNull(actors.agentId),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return row?.id ?? null;
}
