import { describe, test, expect, mock } from "bun:test";

/**
 * M042B — focused unit tests for the room threading:
 *
 * 1. When `findDefaultRoomForActor` returns a room, the resolver
 *    derives `laneKey = "room:<id>"` and stamps `roomId`, `roomType`,
 *    and `graphThreadId` on both the context and the embedded
 *    envelope. The `graphThreadId` is the saver key handed to
 *    LangGraph — it is NOT the same as the laneKey for the seeded
 *    default room (graphThreadId stays `"app:default"`).
 *
 * 2. When no room is found, the resolver falls back to the pre-M042B
 *    `"<channel>:<externalId>"` laneKey and populates `roomId` /
 *    `roomType` / `graphThreadId` as empty strings. Non-owner
 *    (stranger) path always falls back to empty, regardless of the
 *    room mock.
 *
 * 3. `buildEnvelope` accepts an optional `roomId` parameter and
 *    stamps it on the returned envelope. Passing empty / omitting
 *    keeps it empty.
 *
 * M042C update: `resolveContext` now takes a federated `@handle@server`
 * externalId and resolves it via `channel_identities` → actor.
 * Fixtures below mock that lookup.
 */

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

delete process.env["NAUTILO_HOSTNAME"];

const OWNER_ID = "user-1";
const OWNER_ACTOR_ID = "actor-owner";
const DEFAULT_AGENT_ID = "agent-genie";
const OWNER_FED_ID = "@owner@nautilo.local";

const mockFindActor = mock(() =>
  Promise.resolve({
    id: OWNER_ACTOR_ID,
    displayName: "Owner",
    trustState: "verified",
  }),
);
// M045: `findAgentById` return shape no longer carries `ownerId`
// (canonical ownership is M:N via the `agent_ownership` Group; no
// production caller ever read the field).
const mockFindAgent = mock(() =>
  Promise.resolve({
    id: DEFAULT_AGENT_ID,
    handle: "genie",
    displayName: "Genie",
  } as { id: string; handle: string; displayName: string } | null),
);
const mockFindDefaultRoomForActor = mock(() =>
  Promise.resolve(
    null as { id: string; type: string; graphThreadId: string } | null,
  ),
);
// M045: rename of the pre-M045 owner-keyed `findAgentActorByOwnerId`.
// Agent-kind mirror Actor lookup keyed on `agentId` (REL-ACT-AGT 1:1 is
// deterministic).
const mockFindAgentActorForAgent = mock(() =>
  Promise.resolve(
    null as { id: string; displayName: string; agentId: string } | null,
  ),
);
const mockLoadRoomRoster = mock(() => Promise.resolve([]));
const mockGetMemberships = mock(() =>
  Promise.resolve(
    [] as Array<{
      groupId: string;
      groupType: string;
      groupLabel: string;
      roleSlug: string;
    }>,
  ),
);
// M128 — pre-M128 mockGetCapabilities removed; resolver uses
// getUserCapabilities via the dedicated mock further below.

// M044 — Room-subset rule mocks. Default: no Room matches (room-plumbing
// tests care about laneKey/roomId/graphThreadId, not namespaces).
const mockGetRoomWithAccess = mock(
  (_roomId: string): Promise<{ namespaceId: string; humanActorIds: string[] } | null> =>
    Promise.resolve(null),
);
const mockFindReadableNamespacesForSubset = mock(
  (_humanActorIds: string[]): Promise<string[]> => Promise.resolve([]),
);
const mockUpdateRoomHumanActors = mock(
  (_roomId: string): Promise<void> => Promise.resolve(),
);
const mockFindRoomForUserAndAgentMembers = mock(
  (): Promise<{ id: string; type: string; graphThreadId: string } | null> =>
    Promise.resolve(null),
);

// M128 — server-wide query mocks (replace ownership-group API).
const OWNER_ID_ALIAS = OWNER_ID; // alias for closure clarity in mocks
// M128 full 25-cap owner bundle
const ALL_OWNER_CAPS = [
  "manage_members", "manage_groups", "manage_roles", "manage_agents",
  "manage_rooms", "read_server_settings", "manage_server_settings",
  "manage_server_security", "view_audit_log", "use_high_impact_tools",
  "use_destructive_tools", "use_research_tools", "use_image_generation",
  "use_transcription", "read_memories", "manage_memories",
  "use_share_artifact", "control_desktop", "control_browser", "use_terminal", "use_google_workspace", "control_home", "approve_spending",
  "manage_billing", "manage_standing_approvals", "approve_destructive_actions",
];
const mockFindUserHighestRoleSlug = mock(
  (userId: string): Promise<string | null> => {
    if (userId === OWNER_ID_ALIAS) return Promise.resolve("owner");
    return Promise.resolve(null);
  },
);
const mockGetUserCapabilities = mock(
  (userId: string): Promise<string[]> => {
    if (userId === OWNER_ID_ALIAS) return Promise.resolve(ALL_OWNER_CAPS);
    return Promise.resolve([]);
  },
);
const mockFindUsersWithCapability = mock(
  (capabilitySlug: string): Promise<string[]> => {
    if (capabilitySlug === "approve_destructive_actions") return Promise.resolve([OWNER_ID_ALIAS]);
    return Promise.resolve([]);
  },
);
// Legacy mocks kept for shim compatibility (not called by M128 resolver)
void "group-ownership-genie";
void "role-owner";
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

// M042C / M043 mocks for the new user-keyed lookup path.
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
const mockFindActorById = mock((actorId: string) => {
  if (actorId === OWNER_ACTOR_ID) {
    return Promise.resolve({
      id: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
      displayName: "Owner",
      kind: "user" as const,
      agentId: null,
    });
  }
  return Promise.resolve(null);
});
const mockFindUserById = mock((userId: string) => {
  if (userId === OWNER_ID) {
    // M047: `server: null` = local-origin Human.
    return Promise.resolve({
      id: OWNER_ID,
      name: "Owner",
      handle: "owner",
      server: null,
      serverRole: "admin" as const,
    });
  }
  return Promise.resolve(null);
});

mock.module("../../src/queries", () => ({
  findActorByOwnerId: mockFindActor,
  findAgentById: mockFindAgent,
  findAgentActorForAgent: mockFindAgentActorForAgent,
  findDefaultRoomForActor: mockFindDefaultRoomForActor,
  findRoomForUserAndAgentMembers: mockFindRoomForUserAndAgentMembers,
  loadRoomRoster: mockLoadRoomRoster,
  getUserMemberships: mockGetMemberships,
  // M128 — server-wide queries
  getUserCapabilities: mockGetUserCapabilities,
  findUserHighestRoleSlug: mockFindUserHighestRoleSlug,
  findUsersWithCapability: mockFindUsersWithCapability,
  findUserByChannelIdentity: mockFindUserByChannelIdentity,
  findActorById: mockFindActorById,
  findUserById: mockFindUserById,
  // Legacy mocks (not called by M128 resolver)
  findOwnershipGroupForAgent: mockFindOwnershipGroupForAgent,
  getUserRoleInGroup: mockGetUserRoleInGroup,
  findUserAgentRoleSlug: mock(async (userId: string, _agentId: string) =>
    mockFindUserHighestRoleSlug(userId),
  ),
  findUsersWithRoleInGroup: mockFindUsersWithRoleInGroup,
  getUserCapabilitiesInGroup: mockGetUserCapabilitiesInGroup,
  // M044
  getRoomWithAccess: mockGetRoomWithAccess,
  findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
  updateRoomHumanActors: mockUpdateRoomHumanActors,
}));

import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";

// ===========================================================================
// 1. resolveContext — owner path with a resolved room
// ===========================================================================

describe("resolveContext — owner path with resolved room (M042B)", () => {
  test("stamps roomId, roomType, graphThreadId; derives laneKey = room:<id>", async () => {
    const ROOM_ID = "room-default-abc";
    const GRAPH_THREAD_ID = "app:default"; // seeded default keeps legacy key
    mockFindDefaultRoomForActor.mockReturnValueOnce(
      Promise.resolve({
        id: ROOM_ID,
        type: "private",
        graphThreadId: GRAPH_THREAD_ID,
      }),
    );

    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, DEFAULT_AGENT_ID);

    // Context — all four room fields populated.
    expect(ctx.roomId).toBe(ROOM_ID);
    expect(ctx.roomType).toBe("private");
    expect(ctx.graphThreadId).toBe(GRAPH_THREAD_ID);
    expect(ctx.laneKey).toBe(`room:${ROOM_ID}`);

    // Envelope — roomId flows through buildEnvelope.
    expect(ctx.memoryAccess.roomId).toBe(ROOM_ID);

    // Regression: laneKey must NOT equal graphThreadId for the
    // seeded default room. Confirms the decoupling holds.
    expect(ctx.laneKey).not.toBe(ctx.graphThreadId);
  });

  test("new room created post-M042B — laneKey and graphThreadId coincide", async () => {
    const ROOM_ID = "room-new-xyz";
    const GRAPH_THREAD_ID = `room:${ROOM_ID}`;
    mockFindDefaultRoomForActor.mockReturnValueOnce(
      Promise.resolve({
        id: ROOM_ID,
        type: "shared",
        graphThreadId: GRAPH_THREAD_ID,
      }),
    );

    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, DEFAULT_AGENT_ID);

    // For a room created with the new format, the two strings are
    // expected to match. This is a convenience, not a coupling —
    // Iteration 2+ shared rooms also use this shape.
    expect(ctx.laneKey).toBe(ctx.graphThreadId);
    expect(ctx.roomType).toBe("shared");
  });
});

// ===========================================================================
// 2. resolveContext — fallback paths
// ===========================================================================

describe("resolveContext — fallback (no room) paths (M042B)", () => {
  test("owner path with no room falls back to channel:externalId laneKey", async () => {
    // Default mock returns null → no room found.
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, DEFAULT_AGENT_ID);

    expect(ctx.roomId).toBe("");
    expect(ctx.roomType).toBe("");
    expect(ctx.graphThreadId).toBe("");
    expect(ctx.laneKey).toBe(`tui:${OWNER_FED_ID}`);
    expect(ctx.memoryAccess.roomId).toBe("");
  });

  test("stranger path ignores the room mock and stamps empty room fields", async () => {
    // Even if the mock returns a room, the stranger branch must never
    // route into room lookup. Guards against accidental room bleed.
    mockFindDefaultRoomForActor.mockReturnValueOnce(
      Promise.resolve({
        id: "room-should-be-unused",
        type: "private",
        graphThreadId: "app:default",
      }),
    );

    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext(
      "telegram",
      "unknown-stranger",
      DEFAULT_AGENT_ID,
    );

    expect(ctx.actorRole).toBe("guest"); // M128 — `stranger` sentinel retired
    expect(ctx.roomId).toBe("");
    expect(ctx.roomType).toBe("");
    expect(ctx.graphThreadId).toBe("");
    expect(ctx.laneKey).toBe("telegram:unknown-stranger");
    expect(ctx.memoryAccess.roomId).toBe("");
  });
});

// ===========================================================================
// 3. buildEnvelope — roomId parameter threads through
// ===========================================================================

describe("buildEnvelope — roomId plumbing (M042B)", () => {
  test("explicit roomId lands on the envelope", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "room:room-xyz",
      DEFAULT_AGENT_ID,
      "room-xyz",
    );
    expect(envelope.roomId).toBe("room-xyz");
  });

  test("omitted roomId defaults to empty string (pre-M042B callers)", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "tui:default",
      DEFAULT_AGENT_ID,
    );
    expect(envelope.roomId).toBe("");
  });
});
