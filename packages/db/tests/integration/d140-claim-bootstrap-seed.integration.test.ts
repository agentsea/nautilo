/**
 * D140 — `claimBootstrapSeedAgentInTx` integration tests against
 * live Postgres.
 *
 * Pins the Success Criterion #5 invariant from the issue: after a
 * claim handoff, `SELECT count(*) FROM agents` returns the same
 * number as before claim (no duplicate row inserted). Also verifies
 * the predicate behavior (negation of `findDefaultAgentForOwner`'s
 * mirror-actor condition: "no actors row with kind='agent'") and the
 * fallback path (return null when no seed agent exists).
 *
 * D140 post-rebase: tests no longer reference `agents.is_bootstrap_seed`
 * (column removed in favor of M100's helpers; D140 helpers use the
 * credentials/group predicates internally).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  agents,
  actors,
  users,
  claimBootstrapSeedAgentInTx,
  eq,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  // Wipe leftover test fixtures only. The predicate we test
  // (claimBootstrapSeedAgentInTx) is scoped to the inviteeUserId, so it
  // is already DB-state-independent; we just need to clear THIS test's
  // own leftover agents from a crashed prior run. NEVER blanket-delete
  // `genie_%` — on a populated instance that targets the operator's real
  // Genie agent (and trips sessions_agent_id_agents_id_fk). Scope to
  // agents whose mirror actor is owned by a d140 test user (covers both
  // the `d140%` seed handle and the post-claim `genie_claimer` rename).
  await db.execute(
    sql`DELETE FROM agents WHERE handle LIKE 'd140%'
      OR id IN (
        SELECT a.agent_id FROM actors a
        JOIN users u ON u.id = a.owner_id
        WHERE a.kind = 'agent' AND a.agent_id IS NOT NULL
          AND u.email LIKE 'd140-owner-%@test.local'
      )`,
  );
  await db.execute(
    sql`DELETE FROM actors WHERE display_name IN ('Jeannie','d140-owner','Claimer') AND kind IN ('agent','user')`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE email LIKE 'd140-%@test.local' OR email LIKE 'claimer-%@test.local'`,
  );
});

afterAll(async () => {
  if (db) await db.end();
});

async function seedFakeBootstrapAgent(handle: string): Promise<{
  agentId: string;
  agentActorId: string;
  ownerId: string;
}> {
  const ts = Date.now().toString(36);
  const [owner] = await db
    .insert(users)
    .values({
      name: "d140-owner",
      email: `d140-owner-${ts}-${handle}@test.local`,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("owner seed");

  const [agent] = await db
    .insert(agents)
    .values({ handle })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent seed");

  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: owner.id,
      displayName: "Jeannie",
      trustState: "verified",
      kind: "agent",
      agentId: agent.id,
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("actor seed");

  return { agentId: agent.id, agentActorId: agentActor.id, ownerId: owner.id };
}

async function cleanup(agentId: string, ownerId: string): Promise<void> {
  await db.delete(actors).where(eq(actors.agentId, agentId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(eq(users.id, ownerId));
}

describe("D140 — claimBootstrapSeedAgentInTx", () => {
  test("UPDATE-in-place: agent count unchanged across claim", async () => {
    // Production-flow fixture: `claimBootstrapSeedUserInTx` runs
    // BEFORE `claimBootstrapSeedAgentInTx` in `redeem-invite.ts` and
    // UPDATEs the dummy user in place (same `users.id`, new identity
    // fields). So at the time `claimBootstrapSeedAgentInTx` runs,
    // `args.inviteeUserId` equals the (formerly-dummy now-claimer)
    // user id — the SAME id that owns the seed agent's mirror actor.
    //
    // The fixture below encodes that invariant: the `seeded.ownerId`
    // IS the inviteeUserId we pass in. A test that passes a different
    // claimer.id here would exercise the fallback-null path, not the
    // happy claim-seed path.
    const seedHandle = `d140seed${Date.now().toString(36)}`;
    const seeded = await seedFakeBootstrapAgent(seedHandle);

    const beforeRows = (await db.execute(
      sql`SELECT count(*)::int AS c FROM ${agents}`,
    )) as unknown as Array<{ c: number }>;
    const before = beforeRows[0]?.c ?? 0;

    // The "claimer" actor is the SEED owner's user-actor — minted
    // here to satisfy the inviteeActorId arg (used for
    // group_members.granted_by audit). In production this is the
    // user-actor of the just-claimed dummy.
    const [claimerActor] = await db
      .insert(actors)
      .values({
        ownerId: seeded.ownerId,
        displayName: "Claimer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!claimerActor) throw new Error("claimer actor seed");

    let result: Awaited<ReturnType<typeof claimBootstrapSeedAgentInTx>> = null;
    await db.transaction(async (tx) => {
      result = await claimBootstrapSeedAgentInTx(tx, {
        inviteeUserId: seeded.ownerId,
        inviteeActorId: claimerActor.id,
        handleSeed: "claimer",
        displayName: "Claimer",
      });
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("claim-seed");
    expect(result!.agentId).toBe(seeded.agentId);
    expect(result!.agentActorId).toBe(seeded.agentActorId);

    const afterRows = (await db.execute(
      sql`SELECT count(*)::int AS c FROM ${agents}`,
    )) as unknown as Array<{ c: number }>;
    const after = afterRows[0]?.c ?? 0;
    expect(after).toBe(before);

    // Post-state: the seed agent's handle was renamed. M128 —
    // claimBootstrapSeedAgentInTx no longer mints per-agent ownership
    // groups; the invitee's server seat is added via the invite's
    // target_group_id in redeemInviteAtomically instead.
    const [updated] = await db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .limit(1);
    expect(updated?.handle).toMatch(/^genie_/);

    // The agent's mirror actor's display_name was updated (its
    // owner_id was already the inviteeUserId, that's how the
    // predicate found it).
    const [actorRow] = await db
      .select({ ownerId: actors.ownerId, displayName: actors.displayName })
      .from(actors)
      .where(eq(actors.id, seeded.agentActorId))
      .limit(1);
    expect(actorRow?.ownerId).toBe(seeded.ownerId);

    await cleanup(seeded.agentId, seeded.ownerId);
    await db.delete(actors).where(eq(actors.id, claimerActor.id));
  });

  test("returns null when no bootstrap-seed agent exists (fallback path)", async () => {
    // Predicate (`actors.owner_id = inviteeUserId AND kind = 'agent'`)
    // returns null when the user owns no agent yet — the brand-new
    // INSERTed user case (kind=agent / kind=room invites, or
    // pre-D140 Logto-claim's INSERT path before this PR).
    const ts = Date.now().toString(36);
    const [claimer] = await db
      .insert(users)
      .values({
        name: "Claimer",
        email: `claimer-noseed-${ts}@test.local`,
        handle: `noseed${ts}`.slice(0, 20),
      })
      .returning({ id: users.id });
    if (!claimer) throw new Error("claimer seed");

    const [claimerActor] = await db
      .insert(actors)
      .values({
        ownerId: claimer.id,
        displayName: "Claimer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!claimerActor) throw new Error("claimer actor seed");

    let result: Awaited<ReturnType<typeof claimBootstrapSeedAgentInTx>> = null;
    await db.transaction(async (tx) => {
      result = await claimBootstrapSeedAgentInTx(tx, {
        inviteeUserId: claimer.id,
        inviteeActorId: claimerActor.id,
        handleSeed: "noseed",
        displayName: "No Seed",
      });
    });
    // The brand-new claimer owns no agent → predicate returns null.
    // This is the load-bearing fallback assertion: the helper must
    // be safe to call on non-claim invite paths.
    expect(result).toBeNull();

    await db.delete(actors).where(eq(actors.id, claimerActor.id));
    await db.delete(users).where(eq(users.id, claimer.id));
  });
});
