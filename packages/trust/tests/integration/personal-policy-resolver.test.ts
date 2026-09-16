import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";
import {
  createDirectDb,
  eq,
  sql,
  users,
  actors,
  agents,
  namespaces,
  groups,
  groupRoles,
  groupMembers,
  capabilities,
  roles,
  roleCapabilities,
  channelIdentities,
  rooms,
  roomMembers,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { composeFederatedId, getServerHostname } from "@nautilo/config";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: ReturnType<typeof createDirectDb>;

let ownerId: string;
let ownerActorId: string;
let testAgentId: string;
let ownerFederatedId: string;
let testHandle: string;

// M044: Namespace is Room-derived (REL-NSP-RMS 1:1). Tests build two
// Rooms:
//   PRIVATE_ROOM — H = {owner} → namespace = privateRoomNsId
//   HOUSEHOLD_ROOM — H = {owner, household} → namespace = householdRoomNsId
// Subset rule: owner in PRIVATE_ROOM sees BOTH (H(HOUSEHOLD) ⊇
// H(PRIVATE)); household in HOUSEHOLD_ROOM sees ONLY HOUSEHOLD_NS.
let privateRoomId: string;
let privateRoomNsId: string;
let householdRoomId: string;
let householdRoomNsId: string;

// M043: household + stranger now tracked by userId (channel/subject)
// and actorId (only used for buildEnvelope public surface). Post-M044
// the household path requires a Room to test namespace access.
let strangerActorId: string;
let strangerUserId: string;

let householdActorId: string;
let householdUserId: string;

let resolver: PersonalPolicyResolver;

// ---------------------------------------------------------------------------
// Setup: create a complete test trust environment
// ---------------------------------------------------------------------------

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  // 1. Create test owner user with handle.
  testHandle = `trustowner${Date.now().toString(36).slice(-6)}`;
  const [user] = await db
    .insert(users)
    .values({
      name: "trust-test-owner",
      email: `trust-test-${Date.now()}@test.local`,
      handle: testHandle,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  ownerId = user.id;
  ownerFederatedId = composeFederatedId(testHandle, getServerHostname());

  // 1b. Create test household user (distinct user row so we can
  //     exercise the non-owner path against the same ownership
  //     group in M043's users-id-keyed model).
  const [householdUser] = await db
    .insert(users)
    .values({
      name: "trust-test-household",
      email: `trust-household-${Date.now()}@test.local`,
    })
    .returning({ id: users.id });
  if (!householdUser) throw new Error("Failed to create household user");
  householdUserId = householdUser.id;

  const [strangerUser] = await db
    .insert(users)
    .values({
      name: "trust-test-stranger",
      email: `trust-stranger-${Date.now()}@test.local`,
    })
    .returning({ id: users.id });
  if (!strangerUser) throw new Error("Failed to create stranger user");
  strangerUserId = strangerUser.id;

  // 2. Create owner actor (kind='user').
  const [ownerActor] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Test Owner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!ownerActor) throw new Error("Failed to create owner actor");
  ownerActorId = ownerActor.id;

  // 2b. M042C / M043: channel_identity FKs to users.id directly.
  await db.insert(channelIdentities).values({
    channel: "tui",
    externalId: ownerFederatedId,
    userId: ownerId,
    verifiedAt: new Date(),
  });

  // 3. M044: no pre-seeded Namespaces at boot. The private Room's
  //    Namespace is minted with the Room below; the old `system` NS
  //    concept is gone entirely (REL-NSP-RMS).

  // 4. Seed capabilities (idempotent via ON CONFLICT on slug).
  const capSlugs = [
    { slug: "approve_spending", description: "Approve spending", category: "billing" },
    { slug: "manage_billing", description: "Manage billing", category: "billing" },
    { slug: "control_devices", description: "Control devices", category: "devices" },
    { slug: "write_shared_memory", description: "Write shared memory", category: "knowledge" },
    { slug: "approve_shared_memory", description: "Approve shared memory", category: "knowledge" },
    { slug: "manage_members", description: "Manage members", category: "identity" },
    { slug: "use_high_impact_tools", description: "High impact tools", category: "tools" },
    { slug: "manage_standing_approvals", description: "Standing approvals", category: "billing" },
  ];
  await db.insert(capabilities).values(capSlugs).onConflictDoNothing();
  const allCaps = await db.select().from(capabilities);
  const capMap = new Map(allCaps.map((c) => [c.slug, c.id]));

  // 5. M043: seed global Role rows (one per slug). UNIQUE(slug) so
  //    ON CONFLICT DO NOTHING is safe.
  await db
    .insert(roles)
    .values([
      { slug: "owner", label: "Owner", isSystem: true },
      { slug: "member", label: "Member", isSystem: true },
      { slug: "household", label: "Household", isSystem: true },
      { slug: "teammate", label: "Teammate", isSystem: true },
      { slug: "guest", label: "Guest", isSystem: true },
      { slug: "stranger", label: "Stranger", isSystem: true },
    ])
    .onConflictDoNothing();

  const allRoles = await db.select().from(roles);
  const rolesBySlug = new Map(allRoles.map((r) => [r.slug, r.id]));
  const ownerRoleId = rolesBySlug.get("owner");
  const memberRoleId = rolesBySlug.get("member");
  const householdRoleId = rolesBySlug.get("household");
  if (!ownerRoleId || !memberRoleId || !householdRoleId) {
    throw new Error("M128 role seeds missing");
  }

  await db
    .insert(roleCapabilities)
    .values(allCaps.map((c) => ({ roleId: ownerRoleId, capabilityId: c.id })))
    .onConflictDoNothing();

  const memberCaps = [
    "control_devices",
    "write_shared_memory",
    "approve_shared_memory",
  ];
  await db
    .insert(roleCapabilities)
    .values(
      memberCaps
        .map((slug) => {
          const capId = capMap.get(slug);
          return capId
            ? { roleId: memberRoleId, capabilityId: capId }
            : null;
        })
        .filter(
          (m): m is { roleId: string; capabilityId: string } => m !== null,
        ),
    )
    .onConflictDoNothing();

  const householdCaps = [
    "control_devices",
    "write_shared_memory",
    "approve_shared_memory",
  ];
  await db
    .insert(roleCapabilities)
    .values(
      householdCaps
        .map((slug) => {
          const capId = capMap.get(slug);
          return capId
            ? { roleId: householdRoleId, capabilityId: capId }
            : null;
        })
        .filter(
          (m): m is { roleId: string; capabilityId: string } => m !== null,
        ),
    )
    .onConflictDoNothing();

  // 6. M128 — canonical members Group (household/teammate collapse).
  //    Namespace access for the household path comes from Room membership.
  await db
    .insert(groups)
    .values({
      ownerId,
      type: "members",
      label: "Members",
      trustPreset: "personal",
    })
    .onConflictDoNothing({ target: groups.type });
  const [membersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "members"))
    .limit(1);
  if (!membersGroup) throw new Error("Failed to resolve members group");

  // M131: map the Group to its Role via the group_roles junction.
  await db
    .insert(groupRoles)
    .values({ groupId: membersGroup.id, roleId: memberRoleId })
    .onConflictDoNothing();

  await db.insert(groupMembers).values({
    groupId: membersGroup.id,
    userId: householdUserId,
    grantedBy: ownerActorId,
  });

  // 7. M043: create a household-side actor too, for buildEnvelope's
  //    public interface (which still takes actorId → translated to
  //    userId internally via findActorById).
  const [householdActor] = await db
    .insert(actors)
    .values({
      ownerId: householdUserId,
      displayName: "Test Partner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!householdActor) throw new Error("Failed to create household actor");
  householdActorId = householdActor.id;

  // 8. Stranger user-side actor (no group membership).
  const [stranger] = await db
    .insert(actors)
    .values({
      ownerId: strangerUserId,
      displayName: "Stranger",
      trustState: "unknown",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!stranger) throw new Error("Failed to create stranger actor");
  strangerActorId = stranger.id;

  // 9. Create a test agent (M042A).
  //    M045: `agents.owner_id` dropped — insert payload has no owner.
  //    Ownership is M:N via the agent_ownership group seeded in step 10.
  const [agent] = await db
    .insert(agents)
    .values({ handle: `genie-test-${Date.now()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create test agent");
  testAgentId = agent.id;

  // 10. M128 — seed canonical owners Group membership for the test owner.
  await db
    .insert(groups)
    .values({
      ownerId,
      type: "owners",
      label: "Owners",
      trustPreset: "personal",
    })
    .onConflictDoNothing({ target: groups.type });
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("Failed to resolve owners group");

  // M131: map the Group to its Role via the group_roles junction.
  await db
    .insert(groupRoles)
    .values({ groupId: ownersGroup.id, roleId: ownerRoleId })
    .onConflictDoNothing();

  await db.insert(groupMembers).values({
    groupId: ownersGroup.id,
    userId: ownerId,
    grantedBy: ownerActorId,
  });

  // 11. M044: mint the agent's mirror actor so the Room fixtures
  //     below can add it as a member (kind='agent' → does NOT feed
  //     the human_actor_ids denormalization; subset rule is human-set
  //     only). In production this is done by seedDefaultAgent; the
  //     integration test pre-dates that helper so we inline it.
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Test Genie Actor",
      trustState: "verified",
      kind: "agent",
      agentId: testAgentId,
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("Failed to create agent actor");

  // 12. M044: mint a private Room (owner + agent) with its Namespace.
  //     `human_actor_ids = [ownerActorId]` — agent doesn't count.
  const [privateNs] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "Private" })
    .returning({ id: namespaces.id });
  if (!privateNs) throw new Error("Failed to create private room namespace");
  privateRoomNsId = privateNs.id;

  const [privateRoom] = await db
    .insert(rooms)
    .values({
      ownerId,
      type: "private",
      label: "Owner · Test Genie",
      graphThreadId: "app:default",
      namespaceId: privateNs.id,
      humanActorIds: [ownerActorId],
      createdBy: ownerActorId,
    })
    .returning({ id: rooms.id });
  if (!privateRoom) throw new Error("Failed to create private room");
  privateRoomId = privateRoom.id;

  await db.insert(roomMembers).values([
    { roomId: privateRoomId, actorId: ownerActorId, roomRole: "admin" },
    { roomId: privateRoomId, actorId: agentActor.id, roomRole: "member" },
  ]);

  // 13. M044: mint a second Room (owner + household + agent) to
  //     exercise the subset-rule positive case. H = [owner, household]
  //     — a superset of the private Room's H = [owner], so owner
  //     speaking in the private Room can read the household Room's NS.
  const [householdNs] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: "Household" })
    .returning({ id: namespaces.id });
  if (!householdNs) throw new Error("Failed to create household room namespace");
  householdRoomNsId = householdNs.id;

  const [householdRoom] = await db
    .insert(rooms)
    .values({
      ownerId,
      type: "shared",
      label: "Household Room",
      graphThreadId: `room:household-${Date.now()}`,
      namespaceId: householdNs.id,
      // Sort so the @> containment lookup stays deterministic.
      humanActorIds: [ownerActorId, householdActorId].sort(),
      createdBy: ownerActorId,
    })
    .returning({ id: rooms.id });
  if (!householdRoom) throw new Error("Failed to create household room");
  householdRoomId = householdRoom.id;

  await db.insert(roomMembers).values([
    { roomId: householdRoomId, actorId: ownerActorId, roomRole: "admin" },
    { roomId: householdRoomId, actorId: householdActorId, roomRole: "member" },
    { roomId: householdRoomId, actorId: agentActor.id, roomRole: "member" },
  ]);

  // 14. Create the resolver.
  resolver = new PersonalPolicyResolver(ownerId, testAgentId);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  // M045: `agents.owner_id` was dropped — the user-delete no longer
  // cascades to agents. Delete the test agent row first so the
  // mirror `actors.agent_id` row cascades with it, then clean up
  // users (which still cascade to their own actors, group_members,
  // credentials, etc. via the M043-canonical FKs to users.id).
  if (db && testAgentId) {
    await db.delete(agents).where(eq(agents.id, testAgentId));
  }
  if (db && ownerId) {
    await db.delete(users).where(eq(users.id, ownerId));
  }
  if (db && householdUserId) {
    await db.delete(users).where(eq(users.id, householdUserId));
  }
  if (db && strangerUserId) {
    await db.delete(users).where(eq(users.id, strangerUserId));
  }
  if (db) {
    await db.end();
  }
});

// ===========================================================================
// resolveContext
// ===========================================================================

describe("resolveContext", () => {
  test("returns owner context for the account owner", async () => {
    const ctx = await resolver.resolveContext("tui", ownerFederatedId, testAgentId);

    expect(ctx.actorId).toBe(ownerActorId);
    expect(ctx.actorRole).toBe("owner");
    expect(ctx.speakerTrust).toBe("verified");
    expect(ctx.laneScope).toBe("private");
    expect(ctx.actorLabel).toBe("Test Owner");
    // M044: namespace access is Room-derived. The owner's resolved
    // room is PRIVATE_ROOM (owner+agent), so the envelope's
    // readableNamespaces includes privateRoomNsId + (via subset rule)
    // householdRoomNsId.
    expect(ctx.memoryAccess.readableNamespaces).toContain(privateRoomNsId);
    expect(ctx.memoryAccess.readableNamespaces).toContain(householdRoomNsId);
    expect(ctx.memoryAccess.mutableNamespaces.sort()).toEqual(
      ctx.memoryAccess.readableNamespaces.slice().sort(),
    );
    // M042C — federated id threads through.
    expect(ctx.actorFederatedId).toBe(ownerFederatedId);
  });

  // NOTE: the unknown-external-id / guest path and all capability-decision
  // behavior (checkToolAccess, routeApproval, envelope toolPolicy) are
  // covered deterministically in the mocked sibling
  // `tests/unit-isolated/personal-policy-resolver.test.ts`. Those
  // assertions are intentionally NOT duplicated here: post-M128 they
  // depend on the server-wide capability/role/group graph and the
  // server-wide `findUsersWithCapability` approver pool, which cannot be
  // asserted deterministically against a populated/shared DB. This
  // integration file keeps only the cases that genuinely exercise live
  // SQL (channel-identity → user → actor → room resolution, Room-derived
  // namespace subset rule, and the M043/M045 FK/schema invariants).
});

// ===========================================================================
// buildEnvelope (M044 — Room-derived)
// ===========================================================================

describe("buildEnvelope", () => {
  test("owner in private Room: writable = [privateRoomNs], readable = subset-rule superset", async () => {
    const envelope = await resolver.buildEnvelope(
      ownerActorId,
      `room:${privateRoomId}`,
      testAgentId,
      privateRoomId,
    );

    expect(envelope.ownerId).toBe(ownerId);
    expect(envelope.actorId).toBe(ownerActorId);

    // M044 canonical: writes target the Room's Namespace alone
    // (REL-HUM-NSP). Exactly length-1 regardless of Role.
    expect(envelope.writableNamespaces).toEqual([privateRoomNsId]);

    // Subset rule: H(private) = [owner]; H(household) = [owner, household]
    // is a superset → householdRoomNs is readable from the private Room.
    expect(envelope.readableNamespaces).toContain(privateRoomNsId);
    expect(envelope.readableNamespaces).toContain(householdRoomNsId);
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
  });

  test("owner in household Room sees only its own NS (subset rule narrows)", async () => {
    // H(household) = [owner, household]. Private's H = [owner] is a
    // strict SUBSET, so NS(private) is NOT readable from household.
    const envelope = await resolver.buildEnvelope(
      ownerActorId,
      `room:${householdRoomId}`,
      testAgentId,
      householdRoomId,
    );

    expect(envelope.writableNamespaces).toEqual([householdRoomNsId]);
    expect(envelope.readableNamespaces).toContain(householdRoomNsId);
    expect(envelope.readableNamespaces).not.toContain(privateRoomNsId);
    expect(envelope.mutableNamespaces).toEqual(envelope.readableNamespaces);
  });

  test("household member in household Room: writable = [householdNs] (REL-HUM-NSP)", async () => {
    // Pre-M044 this path went through the ownership group's NS;
    // post-M044 it's the Room's NS, Role-agnostic.
    const envelope = await resolver.buildEnvelope(
      householdActorId,
      `room:${householdRoomId}`,
      testAgentId,
      householdRoomId,
    );

    expect(envelope.writableNamespaces).toEqual([householdRoomNsId]);
    // H(household) = [owner, household] — same room, same readable
    // lookup, same result.
    expect(envelope.readableNamespaces).toContain(householdRoomNsId);
    expect(envelope.readableNamespaces).not.toContain(privateRoomNsId);
    expect(envelope.mutableNamespaces).toEqual(envelope.readableNamespaces);
  });

  test("no roomId → empty namespace lists", async () => {
    const envelope = await resolver.buildEnvelope(
      ownerActorId,
      "tui:default",
      testAgentId,
    );

    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
  });

  test("gives stranger empty namespace access", async () => {
    const envelope = await resolver.buildEnvelope(strangerActorId, "telegram:stranger", testAgentId);

    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
  });
});

// ===========================================================================
// checkToolAccess / routeApproval / envelope-toolPolicy
// ===========================================================================
//
// REMOVED (2026-06-06): the capability-decision assertions that used to
// live here were stale (pre-M128: `stranger` sentinel, per-agent
// ownership-group approver scoping) AND non-deterministic against a
// populated/shared DB. Post-M128 these depend on the server-wide
// capability/role/group graph + the server-wide
// `findUsersWithCapability("approve_destructive_actions")` approver pool,
// so exact assertions like `approvers === [ownerId]` and
// `search_memory → read_only` cannot hold on an instance that already
// carries unrelated Humans/Groups. The full decision matrix is
// covered deterministically with mocked queries in
// `tests/unit-isolated/personal-policy-resolver.test.ts`; the live
// capability-graph SQL is covered by `tests/unit/server-wide-rbac.test.ts`
// + `packages/db/tests/integration/server-wide-rbac.integration.test.ts`.

// ===========================================================================
// M043 — FK invariant: agent-actors cannot become group members
// ===========================================================================
//
// Issue §Tests: "Add a schema-level test that rejects inserting an
// `actors.kind='agent'` row as a `group_members.user_id` — the FK
// change makes this a compile-time impossibility, but add a runtime
// assertion to lock the invariant."
//
// Post-M043 `group_members.user_id` FKs `users.id` directly. An
// `actors.kind='agent'` row lives in the `actors` table, not `users`,
// so its uuid cannot appear in any `users.id`. The FK constraint is
// what enforces this; we exercise it here so a future refactor that
// (e.g.) accidentally broadens the FK target or reintroduces the
// polymorphic `actor_id` path gets a loud runtime failure here.

describe("M043 — group_members FK rejects agent-actor uuids", () => {
  test("inserting an actors.kind='agent' uuid as group_members.user_id raises FK violation", async () => {
    // Mint a throwaway agent + its mirror actor (kind='agent') so
    // the test is self-contained. M045: `agents.owner_id` was dropped
    // — the insert payload is handle + displayName only. Ownership
    // is M:N via groups; this test doesn't care about ownership at
    // all (it only needs the agent row + its mirror actor). Cleanup
    // below walks `DELETE FROM agents` → mirror actor cascade.
    const [agent] = await db
      .insert(agents)
      .values({
        handle: `fk-invariant-${Date.now()}`,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error("Failed to create throwaway agent");

    const [agentActor] = await db
      .insert(actors)
      .values({
        ownerId,
        displayName: "FK Invariant Agent Actor",
        trustState: "verified",
        kind: "agent",
        agentId: agent.id,
      })
      .returning({ id: actors.id });
    if (!agentActor) throw new Error("Failed to create agent-kind actor");

    // Target any existing group (the ownership group seeded in
    // beforeAll). The FK violation fires on `user_id`, so the group
    // id doesn't matter — it just has to be a real group so the
    // violation can't be attributed to `group_id` instead.
    const [anyGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "owners"))
      .limit(1);
    if (!anyGroup) throw new Error("No owners group found to target");

    // Attempt the forbidden insert. Postgres must raise a
    // `foreign_key_violation` (SQLSTATE 23503) because `agentActor.id`
    // does not exist in `users.id`.
    let threw = false;
    let message = "";
    try {
      await db.insert(groupMembers).values({
        groupId: anyGroup.id,
        userId: agentActor.id,
        grantedBy: null,
      });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }

    expect(threw).toBe(true);
    // Postgres surfaces FK violations directly; Drizzle often wraps as
    // "failed query: insert ...". Accept either shape so the test stays
    // portable across drivers / ORM layers.
    expect(message.toLowerCase()).toMatch(/failed query|foreign key|violates|users/);

    // Clean up the throwaway rows. ON DELETE CASCADE on the agent
    // column walks the actor row too.
    await db.delete(agents).where(eq(agents.id, agent.id));
  });
});

// ===========================================================================
// M045 — agent-ownership-cleanup invariants
// ===========================================================================
//
// Two invariants the cleanup is there to lock in:
//
//   1. `findAgentActorForAgent(agentId)` is multi-agent-safe. One user
//      owns (in the group-membership sense) two Agents → the two
//      lookups return distinct mirror Actor rows. Pre-M045 the
//      equivalent call was keyed on `ownerId` with `.limit(1)`,
//      non-deterministic under multi-agent.
//
//   2. `routeApproval(_, _, _, agentId)` scopes approver discovery to
//      the ownership group of the requested Agent — not to the union
//      of every ownership group in the system. When two Agents have
//      two different owner sets, the challenge routes to the correct
//      owner set (and only that set).
//
// Both are direct exercises of M043's `findUsersWithRoleInGroup`
// primitive composed with the new `findAgentActorForAgent` helper.
//
// NOTE (cleanup): the two throwaway Agents + the extra owner user
// created here are cleaned up inline at the end of each test — the
// suite-level `afterAll` only sweeps the original `testAgentId` +
// `ownerId` / `householdUserId` / `strangerUserId`. Failure to clean
// up would leak between test runs on a persistent dev DB.

describe("M045 — agent-ownership-cleanup invariants", () => {
  test("findAgentActorForAgent disambiguates two Agents owned by one user", async () => {
    const { findAgentActorForAgent } = await import("../../src/queries");

    // Mint two throwaway Agents with distinct handles (UNIQUE(handle))
    // and two mirror Actor rows — both attributed to `ownerId` (the
    // actors.ownerId column, unchanged post-M045).
    const handleA = `m045-dup-a-${Date.now()}`;
    const handleB = `m045-dup-b-${Date.now()}`;
    const [agentA] = await db
      .insert(agents)
      .values({ handle: handleA })
      .returning({ id: agents.id });
    const [agentB] = await db
      .insert(agents)
      .values({ handle: handleB })
      .returning({ id: agents.id });
    if (!agentA || !agentB) throw new Error("Failed to create dup agents");

    const [actorA] = await db
      .insert(actors)
      .values({
        ownerId,
        displayName: "Dup Agent A Actor",
        trustState: "verified",
        kind: "agent",
        agentId: agentA.id,
      })
      .returning({ id: actors.id });
    const [actorB] = await db
      .insert(actors)
      .values({
        ownerId,
        displayName: "Dup Agent B Actor",
        trustState: "verified",
        kind: "agent",
        agentId: agentB.id,
      })
      .returning({ id: actors.id });
    if (!actorA || !actorB) throw new Error("Failed to create dup mirror actors");

    try {
      const hitA = await findAgentActorForAgent(agentA.id);
      const hitB = await findAgentActorForAgent(agentB.id);

      expect(hitA).not.toBeNull();
      expect(hitB).not.toBeNull();
      // Each lookup finds ONLY the mirror for its own Agent.
      expect(hitA!.id).toBe(actorA.id);
      expect(hitB!.id).toBe(actorB.id);
      // And the two results are distinct — the core invariant.
      expect(hitA!.id).not.toBe(hitB!.id);
      // agentId back-pointer matches the input key.
      expect(hitA!.agentId).toBe(agentA.id);
      expect(hitB!.agentId).toBe(agentB.id);
    } finally {
      // Cleanup: agent delete cascades to mirror actor.
      await db.delete(agents).where(eq(agents.id, agentA.id));
      await db.delete(agents).where(eq(agents.id, agentB.id));
    }
  });

  // M128 — per-agent groups retired; routeApproval is server-wide.
  // findUsersWithCapability("approve_destructive_actions") replaced per-Agent
  // ownership-group scoping (ISSUE-M128 §3.5).

  test("agents.owner_id column no longer exists", async () => {
    // Schema-invariant lock: pre-M045 `SELECT owner_id FROM agents` was
    // valid; post-M045 it raises SQLSTATE 42703 (undefined_column).
    let threw = false;
    let message = "";
    try {
      await db.execute(sql`SELECT owner_id FROM agents LIMIT 1`);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    // Don't pin exact wording — Postgres versions drift. Column-not-found
    // signal is enough.
    expect(message.toLowerCase()).toMatch(/owner_id|does not exist|column/);
  });

  test("agents.handle is UNIQUE post-M045", async () => {
    // Schema-invariant lock: inserting the same handle twice must raise
    // a unique_violation. The constraint replaces pre-M045's
    // idx_agents_owner_handle (which only scoped uniqueness within
    // one owner).
    const handle = `m045-unique-probe-${Date.now()}`;
    const [first] = await db
      .insert(agents)
      .values({ handle })
      .returning({ id: agents.id });
    if (!first) throw new Error("Failed to create first probe agent");

    let threw = false;
    let message = "";
    try {
      await db
        .insert(agents)
        .values({ handle });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }

    try {
      expect(threw).toBe(true);
      expect(message.toLowerCase()).toMatch(
        /unique|duplicate|agents_handle_unique/,
      );
    } finally {
      await db.delete(agents).where(eq(agents.id, first.id));
    }
  });
});
