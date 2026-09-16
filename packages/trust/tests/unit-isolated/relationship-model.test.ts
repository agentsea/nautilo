import { describe, test, expect, mock } from "bun:test";
import { CAPABILITY_SLUGS } from "@nautilo/types";

/**
 * M042D / M043 / M044 — unit tests for the ownership-group-driven
 * tool-policy flow + Room-derived namespace access.
 *
 * M043: Subject queries keyed on `users.id` (was actors.id via the
 * `kind='user'` join pre-M043). The resolver takes `actorId` at its
 * public surface and translates via `findActorById` internally; the
 * mocked `findActorById` maps each actor-test-id to its owning user id.
 *
 * M044: Namespace access moves off the ownership-group Role branch
 * and onto the Room (REL-NSP-RMS + REL-HUM-NSP subset rule). Tests
 * that previously asserted "household member → ownership-group-NS"
 * now assert against Room-derived fixtures. Tool-policy tests remain
 * Role-driven (M043 capability path, untouched by M044).
 *
 * Tests run zero-DB by mocking `../../src/queries` before importing
 * the resolver.
 */

delete process.env["NAUTILO_HOSTNAME"];

const OWNER_ID = "user-1";
const MEMBER_USER_ID = "user-2"; // M128: was HOUSEHOLD_USER_ID
const SECOND_OWNER_USER_ID = "user-3";

const OWNER_ACTOR_ID = "actor-owner";
const MEMBER_ACTOR_ID = "actor-member"; // M128: was HOUSEHOLD_ACTOR_ID
const SECOND_OWNER_ACTOR_ID = "actor-owner-2";
const STRANGER_ACTOR_ID = "actor-stranger";
const AGENT_ID = "agent-genie";
void "group-ownership-genie"; // M128 — legacy fixture, retained for context
void "role-owner";
const OWNER_FED_ID = "@owner@nautilo.local";

// M044 — Room fixtures. A shared Room where the owner + member user
// are both present; `buildEnvelope(memberActor, _, _, MEMBER_ROOM_ID)`
// resolves writable = [MEMBER_ROOM_NS_ID] (the Room's NS).
const MEMBER_ROOM_ID = "room-member"; // M128: was HOUSEHOLD_ROOM_ID
const MEMBER_ROOM_NS_ID = "ns-room-member"; // M128: was HOUSEHOLD_ROOM_NS_ID
const PRIVATE_ROOM_ID = "room-private-owner";
const PRIVATE_ROOM_NS_ID = "ns-room-private";

// Owner receives the full canonical capability catalogue.
const ALL_OWNER_CAPS = [...CAPABILITY_SLUGS];

// D556 — exact ordinary Member product-surface bundle. Administrative and
// approval capabilities remain above Member.
const MEMBER_CAPS = [
  "invoke_agents",
  "create_rooms",
  "use_project_content",
  "use_project_execution",
  "use_workstation",
  "use_remote_hosts",
  "use_connections",
  "use_media_generation",
  "use_research_tools",
  "use_image_generation",
  "use_transcription",
  "write_artifacts",
  "use_share_artifact",
  "read_memories",
  "manage_memories",
  "control_desktop",
  "control_browser",
  "use_google_workspace",
  "control_home",
];

// --- Shared mocks (repeat of personal-policy-resolver.test.ts minimal set) ---

const mockFindActor = mock(() => Promise.resolve({ id: OWNER_ACTOR_ID, displayName: "Owner", trustState: "verified" }));
// M045: `findAgentById` return shape no longer carries `ownerId`.
const mockFindAgent = mock(() => Promise.resolve({
  id: AGENT_ID,
  handle: "genie",
  displayName: "Genie",
}));
const mockGetMemberships = mock(() => Promise.resolve([] as Array<{ groupId: string; groupType: string; groupLabel: string; roleSlug: string }>));
// M128 — pre-M128 mockGetCapabilities removed; resolver uses a dedicated
// mockGetUserCapabilities below per the M128 server-wide cap union.
const mockFindDefaultRoomForActor = mock(() =>
  Promise.resolve(null as { id: string; type: string; graphThreadId: string } | null),
);
// M045: rename of the pre-M045 owner-keyed `findAgentActorByOwnerId`.
const mockFindAgentActorForAgent = mock(() =>
  Promise.resolve(null as { id: string; displayName: string; agentId: string } | null),
);
const mockLoadRoomRoster = mock(() => Promise.resolve([]));

type UserBinding = {
  userId: string;
  verifiedAt: Date | null;
};
const mockFindUserByChannelIdentity = mock(
  (_channel: string, externalId: string): Promise<UserBinding | null> => {
    if (externalId === OWNER_FED_ID) {
      return Promise.resolve({
        userId: OWNER_ID,
        verifiedAt: new Date(),
      });
    }
    return Promise.resolve(null);
  },
);
// M043: resolver translates actorId → userId via findActorById before
// every Subject query. Map each test actor id to its owning user id.
const ACTOR_TO_USER: Record<string, string> = {
  [OWNER_ACTOR_ID]: OWNER_ID,
  [MEMBER_ACTOR_ID]: MEMBER_USER_ID,
  [SECOND_OWNER_ACTOR_ID]: SECOND_OWNER_USER_ID,
};
const mockFindActorById = mock((actorId: string) => {
  const ownerId = ACTOR_TO_USER[actorId];
  if (!ownerId) return Promise.resolve(null);
  return Promise.resolve({
    id: actorId,
    ownerId,
    displayName: actorId,
    kind: "user" as const,
    agentId: null,
  });
});
const mockFindUserById = mock((userId: string) =>
  // M047: `server: null` = local-origin Human.
  userId === OWNER_ID
    ? Promise.resolve({
        id: OWNER_ID,
        name: "Owner",
        handle: "owner",
        server: null,
        serverRole: "admin" as const,
      })
    : Promise.resolve(null),
);

// --- M128 server-wide query mocks (replace ownership-group API) ---

// findUserHighestRoleSlug: owner → "owner", member user → "member", others → null
const mockFindUserHighestRoleSlug = mock(
  (userId: string): Promise<string | null> => {
    if (userId === OWNER_ID) return Promise.resolve("owner");
    if (userId === MEMBER_USER_ID) return Promise.resolve("member");
    if (userId === SECOND_OWNER_USER_ID) return Promise.resolve("owner");
    return Promise.resolve(null);
  },
);
// getUserCapabilities: returns per-user M128 cap bundle
const mockGetUserCapabilities = mock(
  (userId: string): Promise<string[]> => {
    if (userId === OWNER_ID) return Promise.resolve(ALL_OWNER_CAPS);
    if (userId === MEMBER_USER_ID) return Promise.resolve(MEMBER_CAPS);
    return Promise.resolve([]);
  },
);
// findUsersWithCapability: approve_destructive_actions → both owners
const mockFindUsersWithCapability = mock(
  (capabilitySlug: string): Promise<string[]> => {
    if (capabilitySlug === "approve_destructive_actions")
      return Promise.resolve([OWNER_ID]);
    return Promise.resolve([]);
  },
);
// Legacy mocks kept so delegation in findUserAgentRoleSlug shim still compiles
const mockFindOwnershipGroupForAgent = mock((_agentId: string) =>
  Promise.resolve(null as { id: string; roleId: string } | null),
);
const mockGetUserRoleInGroup = mock(
  (_userId: string, _groupId: string): Promise<string | null> => Promise.resolve(null),
);
const mockFindUsersWithRoleInGroup = mock(
  (_groupId: string, _roleSlug: string): Promise<string[]> => Promise.resolve([]),
);
const mockGetUserCapabilitiesInGroup = mock(
  (userId: string, _groupId: string): Promise<string[]> => mockGetUserCapabilities(userId),
);

// --- M044 Room-subset mocks ---
//
// Two rooms in the fixture:
//   PRIVATE_ROOM — H = [owner]             NS = PRIVATE_ROOM_NS
//   MEMBER_ROOM  — H = [owner, member]     NS = MEMBER_ROOM_NS
//
// Subset rule:
//   H(PRIVATE) ⊆ H(MEMBER_ROOM) — owner in PRIVATE_ROOM sees both NS.
//   Member speaking in MEMBER_ROOM: lookup on H=[owner,member]
//   finds only MEMBER_ROOM (PRIVATE has only [owner], not ⊇).

const mockGetRoomWithAccess = mock(
  (roomId: string): Promise<{ namespaceId: string; humanActorIds: string[] } | null> => {
    if (roomId === PRIVATE_ROOM_ID) {
      return Promise.resolve({
        namespaceId: PRIVATE_ROOM_NS_ID,
        humanActorIds: [OWNER_ACTOR_ID],
      });
    }
    if (roomId === MEMBER_ROOM_ID) {
      return Promise.resolve({
        namespaceId: MEMBER_ROOM_NS_ID,
        humanActorIds: [OWNER_ACTOR_ID, MEMBER_ACTOR_ID],
      });
    }
    return Promise.resolve(null);
  },
);
const mockFindReadableNamespacesForSubset = mock(
  (humanActorIds: string[]): Promise<string[]> => {
    if (humanActorIds.length === 0) return Promise.resolve([]);
    const results: string[] = [];
    // PRIVATE_ROOM: H=[owner] — superset iff input ⊆ {owner}.
    if (humanActorIds.every((id) => id === OWNER_ACTOR_ID)) {
      results.push(PRIVATE_ROOM_NS_ID);
    }
    // MEMBER_ROOM: H=[owner, member] — superset iff input ⊆ both.
    if (
      humanActorIds.every(
        (id) => id === OWNER_ACTOR_ID || id === MEMBER_ACTOR_ID,
      )
    ) {
      results.push(MEMBER_ROOM_NS_ID);
    }
    return Promise.resolve([...new Set(results)]);
  },
);
const mockUpdateRoomHumanActors = mock(
  (_roomId: string): Promise<void> => Promise.resolve(),
);

const mockFindRoomForUserAndAgentMembers = mock(
  (): Promise<{ id: string; type: string; graphThreadId: string } | null> =>
    Promise.resolve(null),
);

mock.module("../../src/queries", () => ({
  findActorByOwnerId: mockFindActor,
  findAgentById: mockFindAgent,
  findAgentActorForAgent: mockFindAgentActorForAgent,
  findDefaultRoomForActor: mockFindDefaultRoomForActor,
  findRoomForUserAndAgentMembers: mockFindRoomForUserAndAgentMembers,
  loadRoomRoster: mockLoadRoomRoster,
  getUserMemberships: mockGetMemberships,
  // M128 — server-wide query replacements
  getUserCapabilities: mockGetUserCapabilities,
  findUserHighestRoleSlug: mockFindUserHighestRoleSlug,
  findUsersWithCapability: mockFindUsersWithCapability,
  findUserByChannelIdentity: mockFindUserByChannelIdentity,
  findActorById: mockFindActorById,
  findUserById: mockFindUserById,
  // Legacy mocks kept for shim delegate (not called by M128 resolver)
  findOwnershipGroupForAgent: mockFindOwnershipGroupForAgent,
  getUserRoleInGroup: mockGetUserRoleInGroup,
  findUserAgentRoleSlug: mock(async (userId: string, _agentId: string) =>
    mockFindUserHighestRoleSlug(userId),
  ),
  findUsersWithRoleInGroup: mockFindUsersWithRoleInGroup,
  getUserCapabilitiesInGroup: mockGetUserCapabilitiesInGroup,
  getRoomWithAccess: mockGetRoomWithAccess,
  findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
  updateRoomHumanActors: mockUpdateRoomHumanActors,
}));

import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";

function makeResolver() {
  return new PersonalPolicyResolver(OWNER_ID, AGENT_ID);
}

// ===========================================================================
// §9 Test 1 — Owner with role='owner' in ownership group
// ===========================================================================

describe("M042D — owner role resolution", () => {
  test("owner gets actorRole='owner' + destructive tools stay prove_it", async () => {
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, AGENT_ID);

    expect(ctx.actorRole).toBe("owner");
    expect(ctx.memoryAccess.toolPolicy["update_config"]).toBe("require_prove_it");
    expect(ctx.memoryAccess.toolPolicy["run_shell"]).toBe("require_prove_it");
  });
});

// ===========================================================================
// §9 Test 2 — Unknown actor (no channel binding, no group membership)
// ===========================================================================

describe("M042D — guest path (M128: stranger retired)", () => {
  test("unknown externalId → actorRole='guest' + destructive = forbidden", async () => {
    // M128 — `stranger` sentinel retired; unauthenticated path returns `guest`
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("telegram", "unknown-123", AGENT_ID);

    expect(ctx.actorRole).toBe("guest");
    expect(ctx.memoryAccess.toolPolicy["update_config"]).toBe("forbidden");
    expect(ctx.memoryAccess.readableNamespaces).toEqual([]);
    expect(ctx.memoryAccess.mutableNamespaces).toEqual([]);
    expect(ctx.memoryAccess.writableNamespaces).toEqual([]);
  });
});

// ===========================================================================
// §9 Test 3 — Member with role='member' (M128 replacement for 'household')
// ===========================================================================

describe("M042D — member role (tool policy) (M128: household → member)", () => {
  test("member → current member caps (manage_memories ✓, use_workstation ✓)", async () => {
    // M128 — `household` role retired; `member` is the migration target.
    // D556 gives Members the coherent workstation surface, so run_shell is
    // require_prove_it rather than forbidden.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      MEMBER_ACTOR_ID,
      `room:${MEMBER_ROOM_ID}`,
      AGENT_ID,
      MEMBER_ROOM_ID,
    );

    // manage_memory requires `manage_memories` — member has it → allow
    expect(envelope.toolPolicy["manage_memory"]).toBe("allow");
    // run_shell requires `use_workstation` — Member has it.
    // → destructive → require_prove_it (not forbidden)
    expect(envelope.toolPolicy["run_shell"]).toBe("require_prove_it");
  });
});

// ===========================================================================
// §9 Test 4 — routeApproval (single owner) returns one user
// ===========================================================================

describe("M042D — routeApproval single-owner (M128: server-wide approve_destructive_actions)", () => {
  test("returns the single user with approve_destructive_actions cap", async () => {
    // M128 — routeApproval uses findUsersWithCapability("approve_destructive_actions")
    const resolver = makeResolver();
    const route = await resolver.routeApproval(
      MEMBER_ACTOR_ID,
      "run_shell",
      { toolName: "run_shell", params: {}, impact: "destructive" },
      AGENT_ID,
    );

    expect(route.type).toBe("prove_it");
    if (route.type === "prove_it") {
      expect(route.approvers).toEqual([OWNER_ID]);
    }
  });
});

// ===========================================================================
// §9 Test 5 — routeApproval with two owners returns both
// ===========================================================================

describe("M042D — routeApproval multi-owner (M128: all approve_destructive_actions holders)", () => {
  test("returns all users with approve_destructive_actions (0..N invariant)", async () => {
    // M128 — override findUsersWithCapability to return two approvers
    mockFindUsersWithCapability.mockReturnValueOnce(
      Promise.resolve([OWNER_ID, SECOND_OWNER_USER_ID]),
    );

    const resolver = makeResolver();
    const route = await resolver.routeApproval(
      MEMBER_ACTOR_ID,
      "run_shell",
      { toolName: "run_shell", params: {}, impact: "destructive" },
      AGENT_ID,
    );

    expect(route.type).toBe("prove_it");
    if (route.type === "prove_it") {
      expect(route.approvers).toEqual([OWNER_ID, SECOND_OWNER_USER_ID]);
    }
  });
});

// ===========================================================================
// §9 Test 6 — buildEnvelope for non-member returns empty access
// ===========================================================================

describe("M042D — non-member envelope", () => {
  test("non-member gets empty namespaces + guest tool policy", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      STRANGER_ACTOR_ID,
      "telegram:x",
      AGENT_ID,
    );

    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
    expect(envelope.toolPolicy["update_config"]).toBe("forbidden");
    // guest-allowed tools still allowed
    expect(envelope.toolPolicy["verify_identity"]).toBe("allow");
  });
});

// ===========================================================================
// M044 — member in a shared Room: writable = [RoomNS]
// (M128: household → member; same REL-HUM-NSP semantics)
// ===========================================================================

describe("M044 — member in shared Room (M128: was household)", () => {
  test("member writable/readable = Room's NS (REL-HUM-NSP)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      MEMBER_ACTOR_ID,
      `room:${MEMBER_ROOM_ID}`,
      AGENT_ID,
      MEMBER_ROOM_ID,
    );

    // Writable is exactly one — the Room's NS (REL-HUM-NSP invariant).
    expect(envelope.writableNamespaces).toEqual([MEMBER_ROOM_NS_ID]);
    // Readable is MEMBER_NS only. H(MEMBER_ROOM) = [owner, member] —
    // the private Room's H = [owner] is a strict SUBSET, so NS_PRIVATE
    // is NOT readable from the member Room.
    expect(envelope.readableNamespaces).toEqual([MEMBER_ROOM_NS_ID]);
    expect(envelope.readableNamespaces).not.toContain(PRIVATE_ROOM_NS_ID);
    expect(envelope.mutableNamespaces).toEqual(envelope.readableNamespaces);
  });
});

// ===========================================================================
// M044 — owner speaking in private Room sees HOUSEHOLD NS via subset rule
// ===========================================================================

describe("M044 — owner in private Room sees superset Rooms (subset rule)", () => {
  test("owner in PRIVATE_ROOM: readable includes MEMBER_ROOM's NS too", async () => {
    // H(PRIVATE) = [owner]. H(MEMBER_ROOM) = [owner, member] — a
    // superset of PRIVATE's humans. So owner-in-PRIVATE can read both
    // NSes. Writes still target PRIVATE's NS alone.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${PRIVATE_ROOM_ID}`,
      AGENT_ID,
      PRIVATE_ROOM_ID,
    );

    expect(envelope.writableNamespaces).toEqual([PRIVATE_ROOM_NS_ID]);
    expect(envelope.readableNamespaces.sort()).toEqual(
      [PRIVATE_ROOM_NS_ID, MEMBER_ROOM_NS_ID].sort(),
    );
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
  });
});

// ===========================================================================
// M044 — owner writable invariant (memory-write target stability)
// ===========================================================================

describe("M044 — owner writable namespace is exactly the Room's NS", () => {
  test("owner in private Room: writable = [privateRoomNs] (single element)", async () => {
    // Post-M044 writableNamespaces[0] is THE Room's NS — there is no
    // "Role-specific write target" concept anymore (REL-HUM-NSP:
    // "Everyone who's in the Room writes directly to its Namespace").
    // Migration 0016 reuses the owner's pre-M044 `scope='private'` NS
    // row as the Room's NS, so the UUID is stable across the
    // migration → `manage_memory.writableNamespaces[0]` keeps pointing
    // at the same row, existing memories keep resolving.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${PRIVATE_ROOM_ID}`,
      AGENT_ID,
      PRIVATE_ROOM_ID,
    );

    expect(envelope.writableNamespaces).toHaveLength(1);
    expect(envelope.writableNamespaces[0]).toBe(PRIVATE_ROOM_NS_ID);
    // readable includes the current Room + all superset Rooms.
    expect(envelope.readableNamespaces).toContain(PRIVATE_ROOM_NS_ID);
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
  });
});

// ===========================================================================
// M043 — owner tool-policy parity (regression test for the removed
// buildToolPolicyForSlug short-circuit). Before M043 the owner slug
// hit a special branch that ignored caps and used impact alone. After
// M043 every role walks the capability path; the owner Role's seeded
// bundle carries all 8 caps so the output map is identical. Pin it.
// ===========================================================================

describe("M043 — owner tool-policy parity (removed short-circuit)", () => {
  test("owner's capability-driven policy matches pre-M043 buildOwnerToolPolicy semantics", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "tui:default",
      AGENT_ID,
    );

    // Destructive tools → require_prove_it (same as pre-M043 owner branch).
    expect(envelope.toolPolicy["run_shell"]).toBe("require_prove_it");
    expect(envelope.toolPolicy["update_config"]).toBe("require_prove_it");
    // M128 — search_memory has requiredCapability=read_memories; owner has it
    // → allow (buildToolPolicyFromCapabilities only returns read_only for null-cap tools).
    expect(envelope.toolPolicy["search_memory"]).toBe("allow");
    // null-cap read-only tools → read_only.
    expect(envelope.toolPolicy["run_web_search"]).toBe("read_only");
    // High-impact tools without per-invocation approval → allow when capped.
    expect(envelope.toolPolicy["run_deep_research"]).toBe("allow");
    expect(envelope.toolPolicy["manage_memory"]).toBe("allow");
    // Guest-visible tools still allow.
    expect(envelope.toolPolicy["verify_identity"]).toBe("allow");
  });

  test("capability-driven path matches slug-driven path for owner — no downgrade", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "tui:default",
      AGENT_ID,
    );

    // The owner's envelope's toolPolicy should have NO `forbidden`
    // entries — owner's cap bundle covers every gated tool. If this
    // regresses, a seeded cap is missing from the owner Role.
    const forbiddenEntries = Object.entries(envelope.toolPolicy).filter(
      ([, access]) => access === "forbidden",
    );
    expect(forbiddenEntries).toEqual([]);
  });
});
