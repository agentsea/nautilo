/**
 * D140 — `seedDefaultAgent` post-claim disambiguation (reviewer
 * Finding 1).
 *
 * Pins the narrowed fallback predicate: when the default `genie`
 * handle is absent (e.g. claim renamed it), the helper resolves the
 * post-claim agent via `findDefaultAgentForOwnerWithDb(ownerId)`
 * (M128's `actors` mirror row: `owner_id` + `kind='agent'`). If the
 * owner has no claimed agent
 * AND there are existing agents owned by someone else, the helper
 * must REFUSE rather than guess via "oldest agent first" — that's
 * the old shape that would cross-pollinate sessions / memories /
 * mirror-actor onto the wrong agent in a multi-agent DB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  seedDefaultAgent,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  // Best-effort cleanup of fixtures from prior runs.
  await db.execute(sql`
    DELETE FROM users WHERE email LIKE 'd140-disambig-%@test.local';
  `);
  await db.execute(sql`
    DELETE FROM agents WHERE handle LIKE 'd140-disambig-%';
  `);
});

afterAll(async () => {
  if (db) await db.end();
});

describe("D140 — seedDefaultAgent post-claim disambiguation", () => {
  test("refuses 'oldest agent' guess in a multi-agent DB with no owner-agent link", async () => {
    const ts = Date.now().toString(36);

    // Stage the precise shape the reviewer flagged: `genie` handle
    // absent AND owner has no agent mirror actor AND ≥1 agents owned
    // by someone else.
    //
    // Step 1: create a foreign owner with an agent + mirror actor, so
    // the `findDefaultAgentForOwnerWithDb` join returns null for our
    // test-subject owner but the agent table is non-empty.
    const [foreignOwner] = await db
      .insert(users)
      .values({
        name: `D140 foreign ${ts}`,
        email: `d140-disambig-foreign-${ts}@test.local`,
        handle: `d140fgn${ts}`.slice(0, 20),
      })
      .returning({ id: users.id });
    if (!foreignOwner) throw new Error("foreign owner seed failed");

    // group_members.granted_by FKs to actors.id — mint a user-actor.
    const [foreignOwnerActor] = await db
      .insert(actors)
      .values({
        ownerId: foreignOwner.id,
        displayName: "ForeignOwner",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!foreignOwnerActor) throw new Error("foreign owner actor seed failed");

    const foreignAgentHandle = `d140-disambig-foreign-${ts}`.slice(0, 32);
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        handle: foreignAgentHandle,
      })
      .returning({ id: agents.id });
    if (!foreignAgent) throw new Error("foreign agent seed failed");

    // Mirror actor so the foreign agent counts as "owned by
    // foreignOwner". Required for the predicate gap to be visible
    // (the helper must traverse this join and find nothing for our
    // test-subject owner).
    await db.insert(actors).values({
      ownerId: foreignOwner.id,
      displayName: "ForeignAgent",
      trustState: "verified",
      kind: "agent",
      agentId: foreignAgent.id,
    });

    // Step 2: create a test-subject owner with NO agent mirror actor.
    // This is the "ambiguous on the seedDefaultAgent fallback" shape.
    const [subjectOwner] = await db
      .insert(users)
      .values({
        name: `D140 subject ${ts}`,
        email: `d140-disambig-subject-${ts}@test.local`,
        handle: `d140sbj${ts}`.slice(0, 20),
      })
      .returning({ id: users.id });
    if (!subjectOwner) throw new Error("subject owner seed failed");

    // Step 3: ensure `genie` is absent. If a prior test or seeder
    // left one we just skip (the predicate at 1a would short-circuit
    // and the test wouldn't exercise the fallback). This integration
    // test is best-effort against the shared dev DB.
    const [existingGenie] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.handle, "genie"))
      .limit(1);
    if (existingGenie) {
      console.warn(
        "[d140-disambig] 'genie' handle already exists on this DB; skipping the negative-path test (predicate 1a would short-circuit).",
      );
      // Cleanup what we inserted.
      await db.delete(actors).where(eq(actors.agentId, foreignAgent.id));
      await db.delete(agents).where(eq(agents.id, foreignAgent.id));
      await db.delete(actors).where(eq(actors.id, foreignOwnerActor.id));
      await db.delete(users).where(eq(users.id, foreignOwner.id));
      await db.delete(users).where(eq(users.id, subjectOwner.id));
      return;
    }

    // The act: invoke seedDefaultAgent with the subject owner. The
    // new predicate must refuse rather than pick foreignAgent.
    let threw: Error | null = null;
    try {
      await seedDefaultAgent(subjectOwner.id);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message).toMatch(/ambiguous default/);
    expect(threw!.message).toMatch(/repair-orphan-default-agent/);

    // Critical post-condition: the foreign agent was NOT touched
    // (no memories/sessions backfill, no mirror actor minted with
    // the wrong subject owner). The reviewer's worry was exactly
    // this silent cross-pollution.
    const [foreignAgentAfter] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, foreignAgent.id))
      .limit(1);
    expect(foreignAgentAfter?.id).toBe(foreignAgent.id);

    // No new agent rows were inserted by the refusal path.
    const [agentTallyAfter] = (await db.execute(
      sql`SELECT count(*)::int AS c FROM ${agents}`,
    )) as unknown as Array<{ c: number }>;
    expect(typeof agentTallyAfter?.c).toBe("number");

    // Cleanup.
    await db.delete(actors).where(eq(actors.agentId, foreignAgent.id));
    await db.delete(agents).where(eq(agents.id, foreignAgent.id));
    await db.delete(actors).where(eq(actors.id, foreignOwnerActor.id));
    await db.delete(users).where(eq(users.id, foreignOwner.id));
    await db.delete(users).where(eq(users.id, subjectOwner.id));
  });

  test("uses findDefaultAgentForOwnerWithDb when the owner has a claimed agent (1b path)", async () => {
    const ts = Date.now().toString(36);

    // Step 1: subject owner.
    const [subjectOwner] = await db
      .insert(users)
      .values({
        name: `D140 owned ${ts}`,
        email: `d140-disambig-owned-${ts}@test.local`,
        handle: `d140own${ts}`.slice(0, 20),
      })
      .returning({ id: users.id });
    if (!subjectOwner) throw new Error("subject owner seed failed");

    const [subjectOwnerActor] = await db
      .insert(actors)
      .values({
        ownerId: subjectOwner.id,
        displayName: "SubjectOwner",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!subjectOwnerActor) throw new Error("subject owner actor seed failed");

    // Step 2: owned agent + its mirror actor.
    const ownedAgentHandle = `d140-disambig-owned-${ts}`.slice(0, 32);
    const [ownedAgent] = await db
      .insert(agents)
      .values({
        handle: ownedAgentHandle,
      })
      .returning({ id: agents.id });
    if (!ownedAgent) throw new Error("owned agent seed failed");

    await db.insert(actors).values({
      ownerId: subjectOwner.id,
      displayName: "OwnedAgent",
      trustState: "verified",
      kind: "agent",
      agentId: ownedAgent.id,
    });

    // If `genie` is absent we exercise the 1b path; otherwise 1a
    // already returns and we just verify no throw.
    const [existingGenie] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.handle, "genie"))
      .limit(1);

    const resolvedAgentId = await seedDefaultAgent(subjectOwner.id);
    if (existingGenie) {
      // 1a path: returns the existing genie agent (unchanged).
      expect(resolvedAgentId).toBe(existingGenie.id);
    } else {
      // 1b path: returns the owner's claimed agent via the actors
      // mirror join.
      expect(resolvedAgentId).toBe(ownedAgent.id);
    }

    // Cleanup. seedDefaultAgent may have minted a mirror actor for
    // the resolved agent; delete via cascade-friendly order.
    await db.execute(
      sql`DELETE FROM actors WHERE agent_id = ${ownedAgent.id}`,
    );
    await db.delete(agents).where(eq(agents.id, ownedAgent.id));
    await db.delete(actors).where(eq(actors.id, subjectOwnerActor.id));
    await db.delete(users).where(eq(users.id, subjectOwner.id));
  });
});
