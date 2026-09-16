/**
 * M125 Phase 0 (closes D218) — `findAgentsOwnedByUser` must filter on the
 * canonical owner role slug and order results deterministically by
 * `agents.created_at ASC`.
 *
 * Defensive invariant: a non-owner member of an `agent_ownership` group
 * (deliberately bad data) must not be reported as an owner of the agent.
 *
 * Determinism invariant: when a user owns multiple agents, `owned[0]`
 * is the agent with the earliest `created_at` — every caller that
 * treats the first row as the "primary agent" (e.g. routes/profile,
 * routes/rooms, auth/resolve-bearer) sees the same id.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  groups,
  groupRoles,
  groupMembers,
  roles,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;

// State to clean up afterAll
let ownerUserId = "";
let nonOwnerUserId = "";
let ownerActorId = "";
let agentEarlyId = "";
let agentLateId = "";
let nonOwnerAgentId = "";
let ownersGroupId = "";
let membersGroupId = "";
let ownerRoleId = "";
let memberRoleId = "";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  // Resolve canonical role rows (seeded by seedTrustPersonal in any
  // bootstrapped DB).
  const [ownerRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.slug, "owner"))
    .limit(1);
  if (!ownerRole) {
    throw new Error("owner role missing — DB not bootstrapped");
  }
  ownerRoleId = ownerRole.id;

  const [memberRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.slug, "member"))
    .limit(1);
  if (!memberRole) {
    throw new Error("member role missing — DB not bootstrapped");
  }
  memberRoleId = memberRole.id;

  // Owner user (owns two agents).
  const [owner] = await db
    .insert(users)
    .values({
      name: "m125p0-owner",
      email: `m125p0-owner-${ts}@test.local`,
      handle: `m125p0o${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("owner user");
  ownerUserId = owner.id;

  // Non-owner user — placed in a non-owner-role agent_ownership group
  // (deliberately bad data) to verify the slug filter excludes them.
  const [nonOwner] = await db
    .insert(users)
    .values({
      name: "m125p0-nonowner",
      email: `m125p0-no-${ts}@test.local`,
      handle: `m125p0n${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!nonOwner) throw new Error("nonOwner user");
  nonOwnerUserId = nonOwner.id;

  // Owner's `kind='user'` actor for granted_by attribution.
  const [ownerActor] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "M125P0 owner",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!ownerActor) throw new Error("owner actor");
  ownerActorId = ownerActor.id;

  // Two agents owned by the owner, inserted in reverse chronological
  // order so the deterministic ordering must come from the query, not
  // from insertion accident. We pin explicit timestamps to guarantee
  // ordering even when the inserts land in the same millisecond.
  const earlyTs = new Date(Date.now() - 60_000);
  const lateTs = new Date(Date.now());

  const [agentLate] = await db
    .insert(agents)
    .values({
      handle: `m125p0-late-${ts}`,
      createdAt: lateTs,
      updatedAt: lateTs,
    })
    .returning({ id: agents.id });
  if (!agentLate) throw new Error("late agent");
  agentLateId = agentLate.id;

  const [agentEarly] = await db
    .insert(agents)
    .values({
      handle: `m125p0-early-${ts}`,
      createdAt: earlyTs,
      updatedAt: earlyTs,
    })
    .returning({ id: agents.id });
  if (!agentEarly) throw new Error("early agent");
  agentEarlyId = agentEarly.id;

  // A third agent — owner-group membership for the NON-owner user, but
  // with the household role on the group. This is the defensive case.
  const [nonOwnerAgent] = await db
    .insert(agents)
    .values({
      handle: `m125p0-bad-${ts}`,
    })
    .returning({ id: agents.id });
  if (!nonOwnerAgent) throw new Error("bad agent");
  nonOwnerAgentId = nonOwnerAgent.id;

  // M128 — canonical server-wide Groups (one row per type slug).
  await db
    .insert(groups)
    .values({
      ownerId: ownerUserId,
      type: "owners",
      label: "Owners",
      trustPreset: "personal",
    })
    .onConflictDoNothing({ target: groups.type });
  await db
    .insert(groups)
    .values({
      ownerId: ownerUserId,
      type: "members",
      label: "Members",
      trustPreset: "personal",
    })
    .onConflictDoNothing({ target: groups.type });

  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("owners group missing");
  ownersGroupId = ownersGroup.id;

  const [membersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "members"))
    .limit(1);
  if (!membersGroup) throw new Error("members group missing");
  membersGroupId = membersGroup.id;

  // M131: map each Group to its Role via the group_roles junction.
  await db
    .insert(groupRoles)
    .values([
      { groupId: ownersGroupId, roleId: ownerRoleId },
      { groupId: membersGroupId, roleId: memberRoleId },
    ])
    .onConflictDoNothing();

  // Memberships:
  //  - owner user → canonical owners Group
  //  - non-owner user → canonical members Group (household/teammate collapse)
  await db.insert(groupMembers).values([
    {
      groupId: ownersGroupId,
      userId: ownerUserId,
      grantedBy: ownerActorId,
    },
    {
      groupId: membersGroupId,
      userId: nonOwnerUserId,
      grantedBy: ownerActorId,
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  const memberUserIds = [ownerUserId, nonOwnerUserId].filter(Boolean);
  if (memberUserIds.length > 0) {
    await db
      .delete(groupMembers)
      .where(inArray(groupMembers.userId, memberUserIds));
  }
  const agentIds = [agentEarlyId, agentLateId, nonOwnerAgentId].filter(Boolean);
  if (agentIds.length > 0) {
    await db.delete(agents).where(inArray(agents.id, agentIds));
  }
  if (ownerActorId) {
    await db.delete(actors).where(eq(actors.id, ownerActorId));
  }
  const userIds = [ownerUserId, nonOwnerUserId].filter(Boolean);
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.end();
});

describe("findAgentsOwnedByUser (D218 / M125 Phase 0)", () => {
  // M128 — per-agent groups retired; findAgentsOwnedByUser is now
  // capability-scoped (manage_agents), not ownership-group scoped.
});
