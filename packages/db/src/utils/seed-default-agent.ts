import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, count, eq, isNull } from "drizzle-orm";
import { agents } from "../schema/agents";
import { actors } from "../schema/trust";
import { sessions } from "../schema/sessions";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";
import { findDefaultAgentForOwnerWithDb } from "./find-default-agent";

const DEFAULT_AGENT_HANDLE = "genie";
const DEFAULT_AGENT_DISPLAY_NAME = "Genie";

/**
 * Ensures a default agent row exists and backfills any NULL agent_id
 * values on memories + sessions with the seeded agent's UUID.
 *
 * M042B additions:
 *   - Mints an `actors` row with `kind='agent'` and `agent_id=<agent.id>`
 *     so the agent is addressable through the same trust machinery as
 *     human actors (room_members, groups, approvals all join on
 *     actors.id uniformly). Idempotent: checks for the existing row by
 *     agent_id before inserting.
 *
 * M045: `agents.owner_id` was dropped in migration
 * `0017_agent_ownership_cleanup.sql`. Ownership of a personal Agent is
 * the **`actors` mirror** (M042B): `actors.owner_id = users.id AND
 * actors.kind = 'agent' AND actors.agent_id = agents.id`. The
 * authoritative "who owns this Agent?" resolution is
 * `findDefaultAgentForOwnerWithDb` / `findPersonalAgentsForUser`, which
 * join `actors` — NOT any `agent_ownership` Group (that group type and
 * `groups.agent_id` were dropped in migration `0062_m128`). See
 * `entity-model/relationships/REL-AGT-HUM.md`. The
 * idempotency key is now `agents.handle` alone, backed by the new
 * `UNIQUE(handle)` constraint. `ownerId` is retained on the signature
 * because it is still needed for (a) `actors.owner_id` on the mirror
 * agent-actor row (different table, different semantics — bootstrap
 * author attribution for the agent-kind actor), (b) the `sessions`
 * `owner_id` backfill filters below. It is NOT written to `agents` anymore.
 * M081 removed `memories.owner_id`; memories missing `agent_id` are
 * backfilled without filtering by owner user id.
 *
 * Runs after ensureDatabase (migrations) and seedDefaultOwner (owner row).
 * Idempotent — safe to call on every startup.
 *
 * Returns the default agent's UUID so bin/nautilo-server can publish
 * it via `setBootstrapDefaultAgentId` (D120 A1.P1b — was previously
 * exported through a now-retired env var; see bootstrap-state-cache
 * for the migration shape).
 *
 * M042A — part of the "thread agentId through the context flow" pivot.
 */
export async function seedDefaultAgent(
  ownerId: string,
  log?: (message: string) => void,
): Promise<string> {
  const print = log ?? (() => {});
  const directConnection = resolveDirectDatabaseConnectionString();

  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);

  try {
    // 1. Default agent row resolution. Predicate order (D140 +
    //    reviewer Finding 1 — closes the boot-time re-seed loop on
    //    post-claim instances WITHOUT the "oldest agent" guess that
    //    misfires in multi-agent DBs).
    //
    //    1a. `handle = DEFAULT_AGENT_HANDLE` (idempotent on
    //        UNIQUE(handle) — M045) → fresh-install lookup.
    //    1b. `findDefaultAgentForOwnerWithDb(ownerId)` → joins
    //        `agents → actors (kind='agent', owner_id=ownerId,
    //        agent_id IS NOT NULL)`, oldest-first. (Post-M128 there
    //        is no `agent_ownership` Group; the user→agent link is
    //        the actors mirror minted by the redeem-invite tx.) The
    //        claim helper minted exactly this mirror row for the
    //        renamed seed; in a multi-agent DB this resolves to the
    //        owner's first (oldest) agent.
    //    1c. Zero agents → INSERT fresh seed (genuinely empty
    //        `agents` table, e.g. first boot on a clean DB).
    //    1d. Agents exist but none are owned by `ownerId` →
    //        REFUSE. This is the "oldest agent" guess the reviewer
    //        flagged: in a multi-agent DB where someone else owns
    //        the only agents, picking the oldest one and
    //        backfilling memories/sessions/mirror-actor to it would
    //        cross-pollute identities. Throw with a repair hint
    //        instead.
    let agentId: string;
    const [byHandle] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.handle, DEFAULT_AGENT_HANDLE))
      .limit(1);
    if (byHandle) {
      agentId = byHandle.id;
    } else {
      const ownedAgentId = await findDefaultAgentForOwnerWithDb(db, ownerId);
      if (ownedAgentId) {
        agentId = ownedAgentId;
      } else {
        const [agentTally] = await db.select({ total: count() }).from(agents);
        const totalAgents = agentTally?.total ?? 0;
        if (totalAgents === 0) {
          print(`Creating default agent (handle=${DEFAULT_AGENT_HANDLE})...`);
          const [created] = await db
            .insert(agents)
            .values({
              handle: DEFAULT_AGENT_HANDLE,
            })
            .returning({ id: agents.id });
          if (!created) throw new Error("Failed to create default agent");
          agentId = created.id;
          print(`Default agent created: ${agentId}`);
        } else {
          throw new Error(
            `seedDefaultAgent: ambiguous default — handle '${DEFAULT_AGENT_HANDLE}' is absent ` +
              `and owner ${ownerId} has no agent_ownership group, but ${totalAgents} agent(s) ` +
              `exist in the DB. Refusing to pick one to avoid cross-pollinating memories / ` +
              `sessions / mirror-actor onto the wrong agent. To repair: run ` +
              `\`nautilo-dev repair-orphan-default-agent --keep-agent-id <correct-agent-id> ` +
              `--keep-user-id ${ownerId} --apply\`, or restore the agent_ownership group ` +
              `connecting the intended default agent to this owner, then restart.`,
          );
        }
      }
    }

    // M042B: mirror the agent as an `actors` row so it can be a
    // member of rooms/groups/approvals through the same tables as
    // human actors. Idempotent — match on agent_id.
    const [existingAgentActor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.agentId, agentId))
      .limit(1);
    if (!existingAgentActor) {
      print(`Creating mirror actor row for agent ${agentId}...`);
      await db.insert(actors).values({
        ownerId,
        displayName: DEFAULT_AGENT_DISPLAY_NAME,
        trustState: "verified",
        kind: "agent",
        agentId,
      });
    }

    // 2. Memory `agent_id` backfill retired in M127 — `memories.agent_id`
    // is gone; Namespace membership is the sole content-scope axis.
    // Pre-M127 rows that had a NULL agent_id are naturally consistent
    // with the new model.

    // 3. Backfill sessions that have no agent_id
    const [sessionNullCount] = await db
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.agentId)));

    if ((sessionNullCount?.total ?? 0) > 0) {
      print(`Backfilling ${sessionNullCount?.total} sessions with default agent...`);
      await db
        .update(sessions)
        .set({ agentId })
        .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.agentId)));
    }

    // M043: the pre-M043 "agent" pseudo-channel channel_identities row
    // was seeded here so `@handle@server` lookups resolved agents
    // through the same table as humans. Per REL-CHN-HUM, Channels are
    // Human transport only — Agent addressability goes through
    // `agents.handle` directly (see `findActorByHandle` in
    // trust/queries.ts). No agent row is written to channel_identities
    // anymore; the migration's FK change to `users.id` makes such a
    // row structurally impossible in any case.

    print("Default agent seed complete.");
    return agentId;
  } finally {
    await sql.end();
  }
}
