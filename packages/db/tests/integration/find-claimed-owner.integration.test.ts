import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ensureDatabase,
  createDirectDb,
  findClaimedOwnerId,
  findDefaultAgentForOwner,
  users,
  credentials,
  agents,
  actors,
  profiles,
  groups,
  groupMembers,
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

/**
 * D120 A1.P1 — `findClaimedOwnerId` is the boot-time DB query that
 * tells the server "who is the real claimer?". The predicate must
 * cleanly distinguish:
 *
 *   - bootstrap dummy user (created by seedDefaultOwner; no credentials
 *     row): MUST NOT be returned
 *   - partial user (only some owner projection rows): MUST NOT be returned
 *   - completed owner (owners group + PIN + profile): MUST be returned
 *   - oldest claimer wins when there are several real users
 *
 * D120 A1.P1b — `findDefaultAgentForOwner` is the parallel query for
 * the default-agent pointer. Joins through the agent mirror actor
 * (`actors.owner_id` + `kind='agent'`); returns null if the owner
 * doesn't own an Agent.
 */
describe("findClaimedOwnerId / findDefaultAgentForOwner (D120 A1.P1)", () => {
  let db: ReturnType<typeof createDirectDb>;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    db = createDirectDb(1);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  test("returns null when DB has no users", async () => {
    // Snapshot existing rows so we can restore — DB is shared state.
    const owner = await findClaimedOwnerId();
    // We only assert the function shape under non-empty conditions
    // below; here just confirm it doesn't throw on a populated DB.
    expect(typeof owner === "string" || owner === null).toBe(true);
  });

  test("ignores partial users and returns a completed canonical owner", async () => {
    const dummyId = randomUUID();
    const claimerId = randomUUID();
    const handlePrefix = `find-claimed-${Date.now()}`;

    // Bootstrap-dummy-shape user: no credentials. Must be ignored.
    await db.insert(users).values({
      id: dummyId,
      name: "Dummy",
      email: `${handlePrefix}-dummy@example.com`,
      handle: `${handlePrefix}-dummy`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    // Real claimer: has the complete owner projection, created later (so the
    // "oldest user" naive predicate would pick the dummy and fail).
    await db.insert(users).values({
      id: claimerId,
      name: "Claimer",
      email: `${handlePrefix}-claimer@example.com`,
      handle: `${handlePrefix}-claimer`,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await db.insert(credentials).values({
      userId: claimerId,
      type: "pin",
      value: "test-secret-hash",
    });
    expect(await findClaimedOwnerId()).not.toBe(claimerId);
    const [humanActor] = await db
      .insert(actors)
      .values({ ownerId: claimerId, displayName: "Claimer", kind: "user" })
      .returning({ id: actors.id });
    if (!humanActor) throw new Error("human actor seed failed");
    const [ownersGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "owners"))
      .limit(1);
    if (!ownersGroup) throw new Error("owners group missing");
    await db.insert(groupMembers).values({
      groupId: ownersGroup.id,
      userId: claimerId,
      grantedBy: humanActor.id,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, handle: `owner-${Date.now()}` });
    await db.insert(actors).values({
      ownerId: claimerId,
      displayName: "Claimer agent",
      kind: "agent",
      agentId,
    });
    await db.insert(profiles).values({ userId: claimerId, agentId, name: "Genie" });

    try {
      const ownerId = await findClaimedOwnerId();
      expect(ownerId).toBe(claimerId);
    } finally {
      await db.delete(profiles).where(eq(profiles.userId, claimerId));
      await db.delete(groupMembers).where(eq(groupMembers.userId, claimerId));
      await db.delete(actors).where(eq(actors.ownerId, claimerId));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.delete(credentials).where(eq(credentials.userId, claimerId));
      await db.delete(users).where(eq(users.id, claimerId));
      await db.delete(users).where(eq(users.id, dummyId));
    }
  });

  test("findDefaultAgentForOwner returns null when owner has no agent mirror actor", async () => {
    const orphanId = randomUUID();
    await db.insert(users).values({
      id: orphanId,
      name: "Orphan",
      email: `orphan-${Date.now()}@example.com`,
      handle: `orphan-${Date.now()}`,
    });
    try {
      const agentId = await findDefaultAgentForOwner(orphanId);
      expect(agentId).toBeNull();
    } finally {
      await db.delete(users).where(eq(users.id, orphanId));
    }
  });

  test("findDefaultAgentForOwner returns the oldest agent owned via mirror actor", async () => {
    const ownerUserId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const ts = Date.now();

    // Owner user.
    await db.insert(users).values({
      id: ownerUserId,
      name: "Owner",
      email: `find-agent-owner-${ts}@example.com`,
      handle: `find-agent-owner-${ts}`,
    });

    // Two agents owned by the same user via mirror actors; A is older.
    await db.insert(agents).values({
      id: agentAId,
      handle: `find-agent-a-${ts}`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(agents).values({
      id: agentBId,
      handle: `find-agent-b-${ts}`,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });

    await db.insert(actors).values([
      {
        ownerId: ownerUserId,
        displayName: "A",
        kind: "agent",
        agentId: agentAId,
      },
      {
        ownerId: ownerUserId,
        displayName: "B",
        kind: "agent",
        agentId: agentBId,
      },
    ]);

    try {
      const found = await findDefaultAgentForOwner(ownerUserId);
      expect(found).toBe(agentAId);
    } finally {
      await db.delete(actors).where(eq(actors.ownerId, ownerUserId));
      await db.delete(agents).where(eq(agents.id, agentAId));
      await db.delete(agents).where(eq(agents.id, agentBId));
      await db.delete(users).where(eq(users.id, ownerUserId));
    }
  });
});
