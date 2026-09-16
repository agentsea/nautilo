import { describe, test, it, expect, mock, afterEach } from "bun:test";
import * as nautiloLogger from "@nautilo/logger";

/**
 * Unit tests for PersonalPolicyResolver logic. Mocks all DB queries
 * so these run without Postgres.
 *
 * M043: Subject queries now key on `users.id`
 * (`findUserByChannelIdentity`, `getUserRoleInGroup`,
 * `findUsersWithRoleInGroup`, `getUserCapabilitiesInGroup`) — pre-M043
 * equivalents that ran through the `actors (kind='user')` indirection
 * are gone. The resolver translates actorId → userId at the
 * `buildEnvelope` / `checkToolAccess` interface boundary via
 * `findActorById`. Approvers returned by `routeApproval` carry
 * `users.id` (not `actors.id`) — downstream PIN flow reads
 * `credentials.user_id`.
 *
 * M044: Namespace access is Room-derived (REL-NSP-RMS + REL-HUM-NSP
 * subset rule). The pre-M044 `getNamespacesForOwner` mock is gone,
 * replaced by `getRoomWithAccess` (Room → NS + human-member set) and
 * `findReadableNamespacesForSubset` (H(R) → superset Room NSes).
 * `findOwnershipGroupForAgent` no longer surfaces `namespaceId` (Groups
 * don't own Namespaces per REL-GRP-NSP). `sharedWriteMode` is gone
 * from the envelope type.
 */

// Pretend the configured hostname is the default for these tests.
delete process.env["NAUTILO_HOSTNAME"];

const NAUTILO_FEDERATION_HOST_SUFFIX = process.env["NAUTILO_INSTANCE_ID"]
  ? `${process.env["NAUTILO_INSTANCE_ID"]}.local`
  : "nautilo.local";

const warnSpy = mock((..._args: unknown[]) => {});
/**
 * Silence `log` / `warn` only. Do **not** mock `@nautilo/config` wholesale —
 * M071 routes `getServerHostname()` through `resolveInstance()`; replacing
 * the entire config module poisons the shared module graph and breaks
 * integration tests in the same `bun test` process.
 */
mock.module("@nautilo/logger", () => ({
  ...nautiloLogger,
  log: mock(() => {}),
  warn: warnSpy,
}));

const OWNER_ID = "user-1";
const OWNER_ACTOR_ID = "actor-owner";
const TEST_AGENT_ID = "agent-genie";
void "group-ownership-genie"; // M128 — legacy fixture id, retained for context
const OWNERSHIP_NAMESPACE_ID = "ns-ownership-genie";
const OWNER_HANDLE = "owner";
const OWNER_FED_ID = `@owner@${NAUTILO_FEDERATION_HOST_SUFFIX}`;

/** M077 — distinct verified user (not the deployment owner). */
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_FED_ID = `@otheruser@${NAUTILO_FEDERATION_HOST_SUFFIX}`;
const GENIE_FED_ID = `@genie@${NAUTILO_FEDERATION_HOST_SUFFIX}`;

// Full owner bundle used by this isolated resolver fixture.
const ALL_OWNER_CAPS = [
  "manage_members",
  "manage_groups",
  "manage_roles",
  "manage_agents",
  "manage_rooms",
  "read_server_settings",
  "manage_server_operations",
  "manage_server_settings",
  "manage_server_security",
  "view_audit_log",
  "use_project_content",
  "use_project_execution",
  "use_workstation",
  "use_remote_hosts",
  "use_connections",
  "use_media_generation",
  "invoke_agents",
  "use_research_tools",
  "use_image_generation",
  "use_transcription",
  "read_memories",
  "manage_memories",
  "use_share_artifact",
  "control_desktop",
  "control_browser",
  "use_google_workspace",
  "control_home",
  "approve_spending",
  "manage_billing",
  "manage_standing_approvals",
  "approve_destructive_actions",
];

// M044 test fixture: a private Room with NS = PRIVATE_ROOM_NS_ID whose
// human-member set = [OWNER_ACTOR_ID]. The default `buildEnvelope`
// call with `roomId=PRIVATE_ROOM_ID` returns writable=[PRIVATE_ROOM_NS],
// readable=[PRIVATE_ROOM_NS] (subset rule trivially returns just the
// current Room's NS in the single-Room fixture).
const PRIVATE_ROOM_ID = "room-private-owner";
const PRIVATE_ROOM_NS_ID = "ns-private";

// Mock the queries module before importing the resolver
const mockFindActor = mock((ownerId: string) => {
  if (ownerId === OWNER_ID) {
    return Promise.resolve({
      id: OWNER_ACTOR_ID,
      displayName: "Owner",
      trustState: "verified",
    });
  }
  if (ownerId === OTHER_USER_ID) {
    return Promise.resolve({
      id: OTHER_ACTOR_ID,
      displayName: "Other",
      trustState: "verified",
    });
  }
  return Promise.resolve(null);
});
// M045: `findAgentById` return shape no longer carries `ownerId`.
const mockFindAgent = mock((agentId: string) => {
  if (!agentId) {
    return Promise.resolve(null);
  }
  return Promise.resolve({
    id: TEST_AGENT_ID,
    handle: "genie",
    displayName: "Genie",
  });
});
const mockGetMemberships = mock(() => Promise.resolve([] as Array<{ groupId: string; groupType: string; groupLabel: string; roleSlug: string }>));
// M128 — getUserCapabilities is server-wide (not per-group). Owner returns full bundle.
const mockGetCapabilities = mock((userId: string) => {
  if (userId === OWNER_ID) return Promise.resolve(ALL_OWNER_CAPS);
  return Promise.resolve([] as string[]);
});

// M042B: room queries — default to null/empty so existing tests keep
// pre-M042B laneKey + empty room semantics.
const mockFindDefaultRoomForActor = mock(() =>
  Promise.resolve(
    null as { id: string; type: string; graphThreadId: string } | null,
  ),
);
// M045: rename of the pre-M045 owner-keyed `findAgentActorByOwnerId`.
const mockFindAgentActorForAgent = mock(() =>
  Promise.resolve(
    null as { id: string; displayName: string; agentId: string } | null,
  ),
);
const mockLoadRoomRoster = mock(() => Promise.resolve([]));

// M042C / M043: channel_identities + user lookups. The owner path
// expects a verified user binding; the stranger path expects null.
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
    if (externalId === OTHER_FED_ID) {
      return Promise.resolve({
        userId: OTHER_USER_ID,
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
  if (actorId === OTHER_ACTOR_ID) {
    return Promise.resolve({
      id: OTHER_ACTOR_ID,
      ownerId: OTHER_USER_ID,
      displayName: "Other",
      kind: "user" as const,
      agentId: null,
    });
  }
  return Promise.resolve(null);
});
const mockFindUserById = mock((userId: string) => {
  if (userId === OWNER_ID) {
    // M047: findUserById now returns `server: string | null`. Local
    // owner → NULL (the canonical default).
    return Promise.resolve({
      id: OWNER_ID,
      name: "Owner",
      handle: OWNER_HANDLE,
      server: null,
      serverRole: "admin" as const,
    });
  }
  if (userId === OTHER_USER_ID) {
    return Promise.resolve({
      id: OTHER_USER_ID,
      name: "Other",
      handle: "otheruser",
      server: null,
      serverRole: "user" as const,
    });
  }
  return Promise.resolve(null);
});

// M128 — new server-wide query mocks (replace ownership-group API).
// findUserHighestRoleSlug: returns best-rank Role slug or null.
const mockFindUserHighestRoleSlug = mock(
  (userId: string): Promise<string | null> => {
    if (userId === OWNER_ID) return Promise.resolve("owner");
    return Promise.resolve(null);
  },
);
// findUsersWithCapability: returns list of userIds who hold the cap.
const mockFindUsersWithCapability = mock(
  (capabilitySlug: string): Promise<string[]> => {
    if (capabilitySlug === "approve_destructive_actions") return Promise.resolve([OWNER_ID]);
    return Promise.resolve([]);
  },
);
// Kept for completeness (not called by the M128 resolver, but kept in
// mock.module so tests that override via mockReturnValueOnce still compile).
const mockFindOwnershipGroupForAgent = mock((_agentId: string) =>
  Promise.resolve(null as { id: string; roleId: string } | null),
);
const mockGetUserRoleInGroup = mock(
  (_userId: string, _groupId: string): Promise<string | null> => Promise.resolve(null),
);
const mockFindUserAgentRoleSlug = mock(
  (userId: string, _agentId: string): Promise<string | null> =>
    mockFindUserHighestRoleSlug(userId),
);
const mockFindUsersWithRoleInGroup = mock(
  (_groupId: string, _roleSlug: string): Promise<string[]> => Promise.resolve([]),
);
const mockGetUserCapabilitiesInGroup = mock(
  (userId: string, _groupId: string): Promise<string[]> => mockGetCapabilities(userId),
);

// M044 — Room-subset queries. Default fixture: a single private Room
// containing just the owner. `buildEnvelope(roomId=PRIVATE_ROOM_ID)`
// returns writable=[PRIVATE_ROOM_NS_ID], readable=[PRIVATE_ROOM_NS_ID]
// (subset rule returns the current Room's NS at minimum).
const mockGetRoomWithAccess = mock(
  (roomId: string): Promise<{ namespaceId: string; humanActorIds: string[] } | null> => {
    if (roomId === PRIVATE_ROOM_ID) {
      return Promise.resolve({
        namespaceId: PRIVATE_ROOM_NS_ID,
        humanActorIds: [OWNER_ACTOR_ID],
      });
    }
    return Promise.resolve(null);
  },
);
const mockFindReadableNamespacesForSubset = mock(
  (
    humanActorIds: string[],
    _sourcePolicy?: { isPublicNamespaceBoundary: boolean },
  ): Promise<string[]> => {
    if (humanActorIds.length === 0) return Promise.resolve([]);
    // Default: return the private Room's NS iff the owner actor is
    // in the set (H(private) = [owner] ⊆ input).
    if (humanActorIds.includes(OWNER_ACTOR_ID)) {
      return Promise.resolve([PRIVATE_ROOM_NS_ID]);
    }
    return Promise.resolve([]);
  },
);
const mockUpdateRoomHumanActors = mock(
  (_roomId: string): Promise<void> => Promise.resolve(),
);
const mockFindRoomForUserAndAgentMembers = mock(
  (): Promise<{ id: string; type: string; graphThreadId: string } | null> =>
    Promise.resolve(null),
);
const mockFindRoomForUserMember = mock(
  (): Promise<{ id: string; type: string; graphThreadId: string } | null> =>
    Promise.resolve(null),
);

mock.module("../../src/queries", () => ({
  findActorByOwnerId: mockFindActor,
  findAgentById: mockFindAgent,
  findAgentActorForAgent: mockFindAgentActorForAgent,
  findDefaultRoomForActor: mockFindDefaultRoomForActor,
  findRoomForUserAndAgentMembers: mockFindRoomForUserAndAgentMembers,
  findRoomForUserMember: mockFindRoomForUserMember,
  loadRoomRoster: mockLoadRoomRoster,
  getUserMemberships: mockGetMemberships,
  // M128 — server-wide capability + role queries
  getUserCapabilities: mockGetCapabilities,
  findUserHighestRoleSlug: mockFindUserHighestRoleSlug,
  findUsersWithCapability: mockFindUsersWithCapability,
  findUserByChannelIdentity: mockFindUserByChannelIdentity,
  findActorById: mockFindActorById,
  findUserById: mockFindUserById,
  // Legacy mocks kept so overrides in individual tests still work (not called by M128 resolver)
  findOwnershipGroupForAgent: mockFindOwnershipGroupForAgent,
  getUserRoleInGroup: mockGetUserRoleInGroup,
  findUserAgentRoleSlug: mockFindUserAgentRoleSlug,
  findUsersWithRoleInGroup: mockFindUsersWithRoleInGroup,
  getUserCapabilitiesInGroup: mockGetUserCapabilitiesInGroup,
  // M044
  getRoomWithAccess: mockGetRoomWithAccess,
  findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
  updateRoomHumanActors: mockUpdateRoomHumanActors,
}));

import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";

afterEach(() => {
  warnSpy.mockClear();
});

function makeResolver() {
  // M042D: constructor now `(ownerId, defaultAgentId)` — `ownerActorId`
  // removed; approvers come from the ownership-group query.
  return new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
}

const makeTool = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
  id: "test-id",
  type: "tool_call" as const,
});

// ===========================================================================
// resolveContext
// ===========================================================================

describe("resolveContext", () => {
  test("returns owner context when externalId is owner's federated id", async () => {
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, TEST_AGENT_ID);

    expect(ctx.actorId).toBe(OWNER_ACTOR_ID);
    expect(ctx.actorRole).toBe("owner");
    expect(ctx.speakerTrust).toBe("verified");
    expect(ctx.laneScope).toBe("private");
    expect(ctx.actorFederatedId).toBe(OWNER_FED_ID);
    expect(ctx.agentFederatedId).toBe(GENIE_FED_ID);
  });

  test("returns guest context for unknown externalId", async () => {
    // M128 — `stranger` sentinel retired; unauthenticated path returns `guest`
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("telegram", "unknown-123", TEST_AGENT_ID);

    expect(ctx.actorRole).toBe("guest");
    expect(ctx.speakerTrust).toBe("unverified");
    expect(ctx.memoryAccess.readableNamespaces).toEqual([]);
    expect(ctx.memoryAccess.mutableNamespaces).toEqual([]);
    expect(ctx.memoryAccess.writableNamespaces).toEqual([]);
    expect(ctx.actorFederatedId).toBe("");
    // Agent federated id stamps on guest path too.
    expect(ctx.agentFederatedId).toBe(GENIE_FED_ID);
  });

  test("empty externalId falls through to guest path", async () => {
    // M128 — `stranger` retired; empty externalId produces `guest` context
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("tui", "", TEST_AGENT_ID);

    expect(ctx.actorRole).toBe("guest");
    expect(ctx.actorFederatedId).toBe("");
  });
});

describe("resolveContext — M065 requestedRoomId", () => {
  const REQ_UUID = "33333333-3333-4333-8333-333333333333";

  test("uses requested room when membership query succeeds", async () => {
    mockFindRoomForUserAndAgentMembers.mockResolvedValueOnce({
      id: REQ_UUID,
      type: "private",
      graphThreadId: `room:${REQ_UUID}`,
    });
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext(
      "tui",
      OWNER_FED_ID,
      TEST_AGENT_ID,
      REQ_UUID,
    );
    expect(ctx.roomId).toBe(REQ_UUID);
    expect(ctx.laneKey).toBe(`room:${REQ_UUID}`);
  });

  test("falls back to findDefaultRoomForActor when membership fails", async () => {
    mockFindRoomForUserAndAgentMembers.mockResolvedValueOnce(null);
    mockFindDefaultRoomForActor.mockResolvedValueOnce({
      id: "room-default-fallback",
      type: "private",
      graphThreadId: "app:default",
    });
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext(
      "tui",
      OWNER_FED_ID,
      TEST_AGENT_ID,
      REQ_UUID,
    );
    expect(ctx.roomId).toBe("room-default-fallback");
    expect(mockFindDefaultRoomForActor.mock.calls.length).toBeGreaterThan(0);
  });

  test("requested room with no membership logs tui.room_request_not_member (user-only / agent-missing shape)", async () => {
    mockFindRoomForUserAndAgentMembers.mockResolvedValueOnce(null);
    mockFindDefaultRoomForActor.mockResolvedValueOnce({
      id: "room-default-fallback",
      type: "private",
      graphThreadId: "app:default",
    });
    const resolver = makeResolver();
    await resolver.resolveContext("tui", OWNER_FED_ID, TEST_AGENT_ID, REQ_UUID);
    const warnCalls = warnSpy.mock.calls.map((c) => {
      const x = c[0];
      return typeof x === "string" ? x : "";
    });
    expect(warnCalls.some((m) => m.includes("tui.room_request_not_member"))).toBe(true);
    expect(warnCalls.some((m) => m.includes(`room=${REQ_UUID}`))).toBe(true);
  });
});

// ===========================================================================
// buildEnvelope
// ===========================================================================

describe("buildEnvelope", () => {
  test("explicit Human-only reauthorization never inherits the configured default Agent", async () => {
    const resolver = makeResolver();
    const human = await resolver.buildEnvelope(OWNER_ACTOR_ID, "workbench", undefined, PRIVATE_ROOM_ID);
    expect(human.agentId).toBe("");
    expect(human.actorId).toBe(OWNER_ACTOR_ID);
    expect(human.roomId).toBe(PRIVATE_ROOM_ID);
    expect(human.readableNamespaces).toEqual([PRIVATE_ROOM_NS_ID]);
    const legacy = await resolver.buildEnvelope(OWNER_ACTOR_ID, "workbench", "", PRIVATE_ROOM_ID);
    expect(legacy.agentId).toBe(TEST_AGENT_ID);
  });
  test("owner in private Room gets writable = [RoomNS], readable includes RoomNS (M044 subset rule)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "room:private",
      TEST_AGENT_ID,
      PRIVATE_ROOM_ID,
    );

    expect(envelope.ownerId).toBe(OWNER_ID);
    expect(envelope.actorId).toBe(OWNER_ACTOR_ID);
    // CRITICAL M044 invariant: writable is the Room's Namespace
    // (exactly one — REL-HUM-NSP "writes always target Namespace(R)").
    // This preserves the pre-M044 `manage_memory.writableNamespaces[0]`
    // invariant since migration 0016 reuses the owner's old private
    // NS row in place as the Room's NS.
    expect(envelope.writableNamespaces).toEqual([PRIVATE_ROOM_NS_ID]);
    expect(envelope.readableNamespaces).toContain(PRIVATE_ROOM_NS_ID);
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
    // Single-Room fixture: subset rule returns just the current Room's
    // NS. No pre-M044 `system` NS, no pre-M044 ownership-group NS in
    // the readable set — those concepts are gone under REL-NSP-RMS.
    expect(envelope.readableNamespaces).toHaveLength(1);
    expect(envelope.readableNamespaces).not.toContain("ns-system");
    expect(envelope.readableNamespaces).not.toContain(OWNERSHIP_NAMESPACE_ID);
  });

  test("buildEnvelope without roomId returns empty namespaces (M044 non-room path)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    // No roomId → subset rule can't fire → empty namespace lists.
    // Tool policy path still resolves (owner caps → full policy).
    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
    expect(envelope.toolPolicy["run_shell"]).toBe("require_prove_it");
    expect(envelope.toolPolicy["apply_patch"]).toBe("require_prove_it");
  });

  test("non-member in room gets empty namespaces + guest tool policy (M044)", async () => {
    // M043: resolver translates actorId → userId via findActorById.
    // For an unknown actor, findActorById returns null → subjectUserId
    // is null → ownership-group path yields no caps → guest tool
    // policy. Namespace path: no roomId → empty.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope("actor-stranger", "telegram:x", TEST_AGENT_ID);

    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
    // Stranger envelope has no cap grants → forbidden on gated tools.
    expect(envelope.toolPolicy["run_shell"]).toBe("forbidden");
    expect(envelope.toolPolicy["browser_read_page"]).toBe("read_only");
    expect(envelope.toolPolicy["browser_click"]).toBe("allow");
  });

  test("buildEnvelope with unknown roomId returns empty namespaces (M044 defensive)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "room:unknown",
      TEST_AGENT_ID,
      "room-does-not-exist",
    );
    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
  });

  // M155 — Option A guard. An `agent`-kind actor has no capability subject
  // (the M128/M133 capability model is human-keyed). Pre-M155 such an actor
  // silently collapsed `toolPolicy` to the guest 5-set (the D300 regression).
  // The guard must fail loud with a grep-able error instead of degrading.
  test("buildEnvelope throws agent_actor_has_no_capability_subject for an agent actor (M155)", async () => {
    const AGENT_ACTOR_ID = "actor-genie-agent";
    mockFindActorById.mockResolvedValueOnce({
      id: AGENT_ACTOR_ID,
      ownerId: null,
      displayName: "Genie",
      kind: "agent",
      agentId: TEST_AGENT_ID,
    } as unknown as Awaited<ReturnType<typeof mockFindActorById>>);
    const resolver = makeResolver();
    let thrown: unknown;
    try {
      await resolver.buildEnvelope(AGENT_ACTOR_ID, "room:x", TEST_AGENT_ID, PRIVATE_ROOM_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("agent_actor_has_no_capability_subject");
  });

  test("buildEnvelope still falls through to guest for a null (unknown) actor — not a guard hit (M155)", async () => {
    // A null actor is the legitimate guest/unknown defensive path; the
    // M155 guard only fires for a *known non-human* actor.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope("actor-nobody", "telegram:x", TEST_AGENT_ID);
    expect(envelope.toolPolicy["run_shell"]).toBe("forbidden");
  });
});

// ===========================================================================
// M044 — Room-subset rule (positive + negative pins)
// ===========================================================================
//
// REL-HUM-NSP / REL-NSP-RMS: a Human speaking in Room R can read
// Namespace(R') for every R' where H(R') ⊇ H(R). Writes target
// Namespace(R) alone.

describe("M044 — Room-subset rule", () => {
  const ROOM_A = "room-A-owner-only"; // H = {owner}
  const ROOM_B = "room-B-owner-alice"; // H = {owner, alice}
  const NS_A = "ns-room-A";
  const NS_B = "ns-room-B";
  const ALICE_ACTOR_ID = OTHER_ACTOR_ID;

  test("public Room passes the virtual-cosmos source policy to the subset query", async () => {
    mockGetRoomWithAccess.mockImplementationOnce(() =>
      Promise.resolve({
        namespaceId: NS_B,
        humanActorIds: [OWNER_ACTOR_ID, ALICE_ACTOR_ID],
        isPublicNamespaceBoundary: true,
      }),
    );
    mockFindReadableNamespacesForSubset.mockImplementationOnce(() =>
      Promise.resolve([NS_B]),
    );

    const resolver = makeResolver();
    await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${ROOM_B}`,
      TEST_AGENT_ID,
      ROOM_B,
    );

    expect(mockFindReadableNamespacesForSubset).toHaveBeenLastCalledWith(
      [OWNER_ACTOR_ID, ALICE_ACTOR_ID],
      { isPublicNamespaceBoundary: true },
    );
  });

  test("small room (owner-only) sees its own NS + every larger room containing owner", async () => {
    // Setup: two rooms, owner is in both.
    //   R_A: H = {owner}       → NS_A
    //   R_B: H = {owner,alice} → NS_B   (superset of R_A's humans)
    // Owner-in-R_A subset lookup on H(R_A)=[owner]: R_B passes
    // (H(R_B)=[owner,alice] ⊇ [owner]) → readable = [NS_A, NS_B].
    mockGetRoomWithAccess.mockImplementationOnce((roomId: string) => {
      if (roomId === ROOM_A) {
        return Promise.resolve({ namespaceId: NS_A, humanActorIds: [OWNER_ACTOR_ID] });
      }
      return Promise.resolve(null);
    });
    mockFindReadableNamespacesForSubset.mockImplementationOnce(
      (humans: string[]) => {
        // H(R_A) = [owner] — every room whose H ⊇ [owner] is readable.
        if (humans.length === 1 && humans[0] === OWNER_ACTOR_ID) {
          return Promise.resolve([NS_A, NS_B]);
        }
        return Promise.resolve([]);
      },
    );

    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${ROOM_A}`,
      TEST_AGENT_ID,
      ROOM_A,
    );

    expect(envelope.writableNamespaces).toEqual([NS_A]);
    expect(envelope.readableNamespaces.sort()).toEqual([NS_A, NS_B].sort());
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
  });

  test("large room (owner+alice) sees only its own NS, not the owner-only room", async () => {
    // Owner speaking in R_B (H=[owner,alice]) looks for rooms whose
    // H ⊇ [owner,alice]. R_A has H=[owner] — strict SUBSET of R_B's,
    // not a superset → NS_A is NOT readable from R_B. Canonical
    // "scope narrows as the conversation widens."
    mockGetRoomWithAccess.mockImplementationOnce((roomId: string) => {
      if (roomId === ROOM_B) {
        return Promise.resolve({
          namespaceId: NS_B,
          humanActorIds: [OWNER_ACTOR_ID, ALICE_ACTOR_ID],
        });
      }
      return Promise.resolve(null);
    });
    mockFindReadableNamespacesForSubset.mockImplementationOnce(
      (humans: string[]) => {
        // H(R_B) = [owner, alice] — no other room in fixture has both.
        if (
          humans.length === 2 &&
          humans.includes(OWNER_ACTOR_ID) &&
          humans.includes(ALICE_ACTOR_ID)
        ) {
          return Promise.resolve([NS_B]);
        }
        return Promise.resolve([]);
      },
    );

    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${ROOM_B}`,
      TEST_AGENT_ID,
      ROOM_B,
    );

    expect(envelope.writableNamespaces).toEqual([NS_B]);
    expect(envelope.readableNamespaces).toEqual([NS_B]);
    expect(envelope.readableNamespaces).not.toContain(NS_A);
    expect(envelope.mutableNamespaces).toEqual(envelope.readableNamespaces);
  });

  test("writes always target exactly one Namespace regardless of Role (REL-HUM-NSP)", async () => {
    // household-role member in a shared room: writable is still just
    // the Room's NS, not a per-Role namespace. Pre-M044 this was
    // `propose` to the ownership-group NS; post-M044 the write-mode
    // concept is dead and writes go straight to the Room NS.
    mockGetRoomWithAccess.mockImplementationOnce(() =>
      Promise.resolve({
        namespaceId: NS_B,
        humanActorIds: [OWNER_ACTOR_ID, ALICE_ACTOR_ID],
      }),
    );
    mockFindReadableNamespacesForSubset.mockImplementationOnce(() =>
      Promise.resolve([NS_B]),
    );

    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      ALICE_ACTOR_ID,
      `room:${ROOM_B}`,
      TEST_AGENT_ID,
      ROOM_B,
    );

    expect(envelope.ownerId).toBe(OTHER_USER_ID);
    expect(envelope.writableNamespaces).toHaveLength(1);
    expect(envelope.writableNamespaces).toEqual([NS_B]);
    expect(envelope.mutableNamespaces).toEqual(envelope.readableNamespaces);
  });

  test("findReadableNamespacesForSubset always returns current Room NS (union + dedupe)", async () => {
    // Defensive: even if the denormalized column briefly lags behind
    // and the @> lookup doesn't return the current Room's NS, the
    // resolver unions it back in. Simulate the lag by mocking an
    // empty superset result — the envelope should STILL include the
    // current Room's NS.
    mockGetRoomWithAccess.mockImplementationOnce(() =>
      Promise.resolve({
        namespaceId: PRIVATE_ROOM_NS_ID,
        humanActorIds: [OWNER_ACTOR_ID],
      }),
    );
    mockFindReadableNamespacesForSubset.mockImplementationOnce(() =>
      Promise.resolve([]),
    );

    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      `room:${PRIVATE_ROOM_ID}`,
      TEST_AGENT_ID,
      PRIVATE_ROOM_ID,
    );

    expect(envelope.readableNamespaces).toContain(PRIVATE_ROOM_NS_ID);
    expect(envelope.writableNamespaces).toEqual([PRIVATE_ROOM_NS_ID]);
    expect(envelope.mutableNamespaces.sort()).toEqual(
      envelope.readableNamespaces.slice().sort(),
    );
  });
});

// ===========================================================================
// buildEnvelope — toolPolicy for destructive tools
// ===========================================================================

describe("buildEnvelope toolPolicy", () => {
  test("owner toolPolicy has require_prove_it for destructive tools", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    expect(envelope.toolPolicy["run_shell"]).toBe("require_prove_it");
    expect(envelope.toolPolicy["update_config"]).toBe("require_prove_it");
    // M078 — catalog must declare `requiredCapabilities: ["write_shared_memory"]`
    // so buildToolPolicyFromCapabilities does not classify share_memory as bare `allow`.
    expect(envelope.toolPolicy["share_memory"]).toBe("require_prove_it");
  });

  test("Admin operations authority enables mini_app without granting owner-only settings", async () => {
    mockGetCapabilities.mockReturnValueOnce(Promise.resolve([
      "manage_server_operations",
      "approve_destructive_actions",
    ]));
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "tui:default",
      TEST_AGENT_ID,
    );

    expect(envelope.toolPolicy["mini_app"]).toBe("require_prove_it");
    expect(envelope.toolPolicy["update_config"]).toBe("forbidden");
  });

  test("owner-only settings authority does not substitute for Admin operations authority", async () => {
    mockGetCapabilities.mockReturnValueOnce(Promise.resolve([
      "manage_server_settings",
      "approve_destructive_actions",
    ]));
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(
      OWNER_ACTOR_ID,
      "tui:default",
      TEST_AGENT_ID,
    );

    expect(envelope.toolPolicy["mini_app"]).toBe("forbidden");
    expect(envelope.toolPolicy["update_config"]).toBe("require_prove_it");
  });

  test("owner toolPolicy has allow for non-destructive gated tools", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    expect(envelope.toolPolicy["run_deep_research"]).toBe("allow");
    expect(envelope.toolPolicy["manage_memory"]).toBe("allow");
  });

  test("owner toolPolicy has read_only for cap-free read-only tools and allow for capped read-only tools", async () => {
    // M128 — run_web_search / session_search have null requiredCapability → read_only.
    // search_memory has requiredCapability=read_memories; owner has it → allow
    // (buildToolPolicyFromCapabilities only returns read_only for null-cap read-only tools).
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    expect(envelope.toolPolicy["search_memory"]).toBe("allow");
    expect(envelope.toolPolicy["run_web_search"]).toBe("read_only");
  });

  test("D419 memory capability removal forbids core memory tools without widening unrelated discovery", async () => {
    mockGetCapabilities.mockReturnValueOnce(Promise.resolve(
      ALL_OWNER_CAPS.filter(
        (capability) => capability !== "read_memories" && capability !== "manage_memories",
      ),
    ));
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    expect(envelope.toolPolicy["search_memory"]).toBe("forbidden");
    expect(envelope.toolPolicy["manage_memory"]).toBe("forbidden");
    // Capability removal is a narrow policy change; public discovery remains
    // available so the progressive flow can explain the denied surface.
    expect(envelope.toolPolicy["discover_tools"]).toBe("read_only");
  });

  test("authenticated actors still require control_browser for every browser tool", async () => {
    mockGetCapabilities.mockReturnValueOnce(Promise.resolve(
      ALL_OWNER_CAPS.filter((capability) => capability !== "control_browser"),
    ));
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);

    for (const name of Object.keys(envelope.toolPolicy).filter((toolName) => toolName.startsWith("browser_"))) {
      expect(envelope.toolPolicy[name]).toBe("forbidden");
    }
  });
});

// ===========================================================================
// checkToolAccess with envelope — prove_it path
// ===========================================================================

describe("checkToolAccess with envelope", () => {
  test("owner with envelope gets require_approval for destructive tool", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(OWNER_ACTOR_ID, makeTool("run_shell"), envelope);

    expect(result.type).toBe("require_approval");
    if (result.type === "require_approval") {
      expect(result.route.type).toBe("prove_it");
    }
  });

  test("apply_patch is owner-approved and guest fail-closed", async () => {
    const resolver = makeResolver();
    const ownerEnvelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const ownerResult = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }),
      ownerEnvelope,
    );
    expect(ownerResult.type).toBe("require_approval");
    if (ownerResult.type === "require_approval") {
      expect(ownerResult.route.type).toBe("prove_it");
    }

    const guestEnvelope = await resolver.buildEnvelope("actor-stranger", "tui:default", TEST_AGENT_ID);
    expect(guestEnvelope.toolPolicy["apply_patch"]).toBe("forbidden");
    expect(await Promise.resolve(
      resolver.checkToolAccess(
        "actor-stranger",
        makeTool("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }),
        guestEnvelope,
      ),
    )).toMatchObject({ type: "forbidden" });
  });

  test("owner with envelope gets require_approval for share_memory (M078 hybrid gate)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("share_memory", {
        memory_id: "mem-1",
        target_handle: "@alice",
        sensitivity: "normal",
      }),
      envelope,
    );
    expect(result.type).toBe("require_approval");
    if (result.type === "require_approval") {
      expect(result.route.type).toBe("prove_it");
    }
  });

  test("owner with envelope gets allow for non-destructive gated tool", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(OWNER_ACTOR_ID, makeTool("run_deep_research"), envelope);

    expect(result.type).toBe("allow");
  });

  test("owner with envelope must approve transcribe_audio despite high-impact capability", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("transcribe_audio", { path: "meeting.wav", zone: "workspace" }),
      envelope,
    );

    expect(result.type).toBe("require_approval");
    if (result.type === "require_approval") {
      expect(result.route.type).toBe("prove_it");
    }
  });

  test("owner with envelope gets allow for search_memory (capped read-only tool)", async () => {
    // M128 — search_memory requires read_memories; owner has it → allow
    // (not read_only, since buildToolPolicyFromCapabilities only assigns read_only for null-cap tools)
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(OWNER_ACTOR_ID, makeTool("search_memory"), envelope);

    expect(result.type).toBe("allow");
  });

  test("owner with envelope gets read_only for null-cap read-only tool", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(OWNER_ACTOR_ID, makeTool("run_web_search"), envelope);

    expect(result.type).toBe("read_only");
  });

  test("transcribe_audio requires approval when actor lacks use_transcription (envelope-less path)", async () => {
    // M128 — transcribe_audio now requires use_transcription; override caps to empty so actor has none
    mockGetCapabilities.mockReturnValueOnce(Promise.resolve([]));
    const resolver = makeResolver();
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("transcribe_audio", { path: "meeting.wav", zone: "workspace" }),
      undefined,
    );
    expect(result.type).toBe("require_approval");
    if (result.type === "require_approval") {
      expect(result.route.type).toBe("prove_it");
    }
  });

  // D079 Phase 4 — file tool's per-command short-circuit (2026-04-22
  // live-verify catch). Without this short-circuit, EVERY `file.list`
  // / `file.read` / `file.grep` / `file.stat` call would trigger an
  // approval dock because the tool-level impact is `destructive`, even
  // though the command-level impact is `read_only`. Trust must honor
  // the per-command severity at this layer — otherwise the verb-map/
  // trust disagreement path escalates to ask for every directory
  // listing. These tests lock the four read-only commands.

  // D306 — the `convert` tool gates on network egress, not artifact creation.
  // Local-backend conversions auto-approve (no dock); only CloudConvert cloud
  // egress is HIL-gated. Mirrors the file workspace-write carve-out above.
  test("convert local backend (inline markdown→pdf) auto-approves — no egress", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("convert", { markdown: "# hi", format: "pdf", destinationPath: "out.pdf" }),
      envelope,
    );
    expect(result.type).toBe("allow");
  });

  test("convert explicit backend=local auto-approves", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("convert", {
        backend: "local",
        markdown: "# hi",
        format: "docx",
        destinationPath: "out.docx",
      }),
      envelope,
    );
    expect(result.type).toBe("allow");
  });

  test("convert explicit backend=cloud requires approval (network egress)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("convert", {
        backend: "cloud",
        html: "<p>hi</p>",
        format: "pdf",
        destinationPath: "out.pdf",
      }),
      envelope,
    );
    expect(result.type).toBe("require_approval");
  });

  test("convert auto backend with non-local pair (html→pdf) is cloud egress → require_approval", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("convert", { html: "<p>hi</p>", format: "pdf", destinationPath: "out.pdf" }),
      envelope,
    );
    expect(result.type).toBe("require_approval");
  });

  // D503 — install enters the exact-effect approval path for ordinary
  // verified users; legacy enable remains gated for compatibility.
  test("manage_local_mcp install → require_approval", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("manage_local_mcp", { action: "install", request: { version: "local-mcp-install-v1" } }),
      envelope,
    );
    expect(result.type).toBe("require_approval");
  });
  test("manage_local_mcp enable → require_approval", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("manage_local_mcp", { action: "enable", name: "gh" }),
      envelope,
    );
    expect(result.type).toBe("require_approval");
  });

  for (const action of ["register", "disable", "list", "status"]) {
    test(`manage_local_mcp ${action} → allow (no approval dock)`, async () => {
      const resolver = makeResolver();
      const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("manage_local_mcp", { action, name: "gh" }),
        envelope,
      );
      expect(result.type).toBe("allow");
    });
  }

  test("file.list short-circuits to read_only even though tool-level impact is destructive", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "list", path: ".", zone: "workspace" }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  test("file.read short-circuits to read_only", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "read", path: "x.md", zone: "workspace" }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  test("file.grep short-circuits to read_only", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "grep", path: ".", zone: "workspace", query: "x" }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  test("file.stat short-circuits to read_only", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "stat", path: "x.md", zone: "workspace" }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  // D087 Phase 1 §1.3 — write / insert / str_replace reclassified as
  // `read_only` at the command-policy layer: they no longer mutate disk
  // at call time; they STAGE a patch that the workbench DiffView
  // presents for Accept/Reject. The Accept click IS the HIL gate, so
  // the trust layer short-circuits to `read_only` regardless of zone
  // (workspace / current / absolute / home / scratch). The historical
  // destructive-zone distinction is preserved for commands that DO
  // still mutate disk at call time (move / copy / delete — see
  // §1.3.5 pending), and for actual reads (gated in absolute zone to
  // block data-exposure to guest actors).
  test("file.write in any zone short-circuits to read_only (staging, not HIL)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    for (const zone of ["workspace", "current", "home", "scratch", "absolute"] as const) {
      const path = zone === "absolute" ? "/tmp/x.md" : "x.md";
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", { command: "write", path, zone, content: "hi" }),
        envelope,
      );
      expect(result.type).toBe("read_only");
    }
  });

  test("file.str_replace in any zone short-circuits to read_only (staging)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", {
        command: "str_replace",
        path: "drafts/x.md",
        zone: "workspace",
        oldString: "a",
        newString: "b",
      }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  test("file.insert in any zone short-circuits to read_only (staging)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", {
        command: "insert",
        path: "drafts/x.md",
        zone: "workspace",
        lineNumber: 1,
        content: "new line\n",
      }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  // D087 §1.3.5 — move / copy / delete stage through the substrate,
  // just like write / insert / str_replace. No per-zone gate needed
  // at the trust layer; DiffView Accept is the HIL gate.
  test("file.copy in any zone short-circuits to read_only (staging)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    for (const zone of ["workspace", "current", "home", "scratch", "absolute"] as const) {
      const path = zone === "absolute" ? "/tmp/x.md" : "x.md";
      const destinationPath = zone === "absolute" ? "/tmp/y.md" : "y.md";
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", { command: "copy", path, zone, destinationPath }),
        envelope,
      );
      expect(result.type).toBe("read_only");
    }
  });

  test("file.move in any zone short-circuits to read_only (staging)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    for (const zone of ["workspace", "current", "home", "scratch"] as const) {
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", {
          command: "move",
          path: "x.md",
          zone,
          destinationPath: "y.md",
        }),
        envelope,
      );
      expect(result.type).toBe("read_only");
    }
  });

  test("file.delete short-circuits to read_only via staging (D087 §1.3.5)", async () => {
    // The previous `destructive_high — HIL always` posture is gone as
    // of §1.3.5. Delete now stages; the DiffView lets the user preview
    // exactly what bytes are about to disappear and click Reject /
    // Accept. apply_patch handles the unlink under the external-change
    // guard. Test covers workspace + absolute because `delete` used
    // to be the only command gated even inside the workspace.
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    for (const zone of ["workspace", "absolute"] as const) {
      const path = zone === "absolute" ? "/tmp/x.md" : "x.md";
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", { command: "delete", path, zone }),
        envelope,
      );
      expect(result.type).toBe("read_only");
    }
  });

  // ---------------------------------------------------------------------
  // Staging × forbidden envelope — INTENT PINNING
  // ---------------------------------------------------------------------
  //
  // The D087 staging-command carve-out in checkToolAccess deliberately
  // runs BEFORE the `envelope.toolPolicy` check, so a staging command
  // submitted with a `toolPolicy["file"] === "forbidden"` envelope STILL
  // short-circuits to `read_only`.
  //
  // This is intentional. The security gate for forbidden actors is the
  // UPSTREAM catalog filter at
  // `packages/catalog/src/tool-catalog.ts::getFiltered` — it drops every
  // tool entry whose `toolPolicy[name] === "forbidden"` before the LLM
  // ever sees it. A forbidden-envelope actor therefore never reaches
  // this resolver with `tool.name === "file"`.
  //
  // The tests below pin the deliberate-return-read_only behavior so a
  // future refactor that drops the catalog filter doesn't silently
  // widen the attack surface through this short-circuit. If the
  // catalog filter is ever removed, these tests MUST be updated to
  // assert `{ type: "forbidden" }` and the resolver code MUST be
  // extended to gate the STAGING_COMMANDS block on envelope policy.
  describe("staging × forbidden envelope (catalog filter is THE gate)", () => {
    const STAGING_COMMANDS = [
      "write",
      "insert",
      "str_replace",
      "delete",
      "move",
      "copy",
    ] as const;

    /**
     * Hand-rolled envelope fixture with `toolPolicy["file"] = "forbidden"`
     * to exercise the short-circuit under the forbidden branch. Fields
     * match the MemoryAccessEnvelope shape at packages/trust/src/types.ts.
     */
    function forbiddenFileEnvelope() {
      return {
        ownerId: OWNER_ID,
        actorId: OWNER_ACTOR_ID,
        agentId: TEST_AGENT_ID,
        roomId: "",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { file: "forbidden" as const },
      };
    }

    for (const command of STAGING_COMMANDS) {
      test(`${command} + forbidden envelope still returns read_only (catalog filter is the gate)`, async () => {
        const resolver = makeResolver();
        const envelope = forbiddenFileEnvelope();
        // Path-bearing commands get a path; the agent-layer verbs
        // (apply_patch/list_patches) don't. Both should hit the same
        // short-circuit branch.
        const args: Record<string, unknown> = { command, path: "/tmp/x.md", zone: "absolute" };
        if (command === "str_replace") {
          args["oldString"] = "a";
          args["newString"] = "b";
        }
        if (command === "insert") {
          args["content"] = "x";
          args["lineNumber"] = 1;
        }
        if (command === "write") {
          args["content"] = "x";
        }
        if (command === "move" || command === "copy") {
          args["destinationPath"] = "/tmp/y.md";
        }
        const result = await resolver.checkToolAccess(
          OWNER_ACTOR_ID,
          makeTool("file", args),
          envelope,
        );
        expect(result.type).toBe("read_only");
      });
    }

    test("file.read + forbidden envelope falls through (NOT a staging command)", async () => {
      // Negative boundary: file.read is NOT in STAGING_COMMANDS, so the
      // forbidden-envelope check at the fall-through branch should
      // produce a non-read_only outcome. Pinning this keeps the
      // staging-vs-reads branch boundary explicit — if someone flips
      // `read` into STAGING_COMMANDS by accident, this test flips too.
      const resolver = makeResolver();
      const envelope = forbiddenFileEnvelope();
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", { command: "read", path: "/etc/passwd", zone: "absolute" }),
        envelope,
      );
      expect(result.type).not.toBe("read_only");
    });
  });

  // D079 PR-011 security port — the guardrail is that ABSOLUTE-zone
  // reads must not hand guest / stranger actors a blanket read
  // primitive over arbitrary paths. The D087 UX pass refined this: if
  // the envelope policy for `file` is anything OTHER than `forbidden`,
  // the actor is trusted to read (owner, household-with-cap) and we
  // short-circuit to `read_only` — no approval dock, no confusing
  // "auto-approved" reason line. The security test is about guests
  // (envelope `file: forbidden`) and about envelope-less fallthrough.

  test("file.read in absolute zone short-circuits for owner (non-forbidden envelope)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "read", path: "/etc/passwd", zone: "absolute" }),
      envelope,
    );
    // Owner's envelope policy for file is `require_prove_it`
    // (destructive impact per tool-policies.ts). That's NOT `forbidden`,
    // so the actor is trusted to read. The deny-list in
    // validateBeforeExecution still gates sensitive paths at runtime.
    expect(result.type).toBe("read_only");
  });

  test("file.grep in absolute zone short-circuits for owner", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "grep", path: "/", zone: "absolute", query: "AKIA" }),
      envelope,
    );
    expect(result.type).toBe("read_only");
  });

  // Guest-actor behavior for file.READ in absolute zone — when the
  // envelope's `toolPolicy["file"] === "forbidden"`, the short-circuit
  // falls through past the zone-bounded branch and the envelope check
  // below correctly blocks. The staging-command × forbidden-envelope
  // cases above pin the DELIBERATE read_only return (catalog filter is
  // the real gate); the non-staging read case here pins the
  // fall-through-blocks behavior. Integration coverage in
  // `packages/trust/tests/integration/personal-policy-resolver.test.ts`
  // round-trips this against a real capability graph.

  test("file.read in absolute zone from an actor with no envelope falls through to envelope-less path (security port)", async () => {
    const resolver = makeResolver();
    // envelope === null exercises the catalog-fallback path at the
    // end of checkToolAccess. Without the B-1b fix the short-circuit
    // returned { type: "read_only" } here regardless — now it falls
    // through so the catalog's project-content policy decides.
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "read", path: "/etc/passwd", zone: "absolute" }),
      null,
    );
    expect(result.type).not.toBe("read_only");
  });

  test("file.read in bounded zones still short-circuits to read_only (happy path preserved)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    for (const zone of ["workspace", "current", "home", "scratch"] as const) {
      const result = await resolver.checkToolAccess(
        OWNER_ACTOR_ID,
        makeTool("file", { command: "read", path: "x.md", zone }),
        envelope,
      );
      expect(result.type).toBe("read_only");
    }
  });

  test("legacy zone aliases (home, scratch) — all mutating commands short-circuit via staging", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    // D087 Phase 1 §1.3 + §1.3.5 — write AND copy AND every other
    // mutating command stage through the substrate regardless of
    // zone. The old "copy = allow" behavior is gone; every stage is
    // a read_only short-circuit.
    for (const zone of ["home", "scratch"] as const) {
      for (const command of ["write", "str_replace", "insert", "copy", "move", "delete"]) {
        const args: Record<string, unknown> = { command, path: "x.md", zone };
        if (command === "write") args["content"] = "hi";
        if (command === "insert") {
          args["lineNumber"] = 1;
          args["content"] = "hi\n";
        }
        if (command === "str_replace") {
          args["oldString"] = "a";
          args["newString"] = "b";
        }
        if (command === "copy" || command === "move") args["destinationPath"] = "y.md";
        const result = await resolver.checkToolAccess(
          OWNER_ACTOR_ID,
          makeTool("file", args),
          envelope,
        );
        expect(result.type).toBe("read_only");
      }
    }
  });

  test("file with unknown command fails closed (no read_only short-circuit)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", { command: "nuke_everything", path: "/", zone: "absolute" }),
      envelope,
    );
    // Unknown command → isDestructiveFileCommand returns true → no
    // short-circuit. Decision is whatever the normal policy path
    // produces.
    expect(result.type).not.toBe("read_only");
  });

  test("file with no command arg falls through (no short-circuit)", async () => {
    const resolver = makeResolver();
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", TEST_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("file", {}),
      envelope,
    );
    expect(result.type).not.toBe("read_only");
  });
});

// ===========================================================================
// routeApproval
// ===========================================================================

describe("routeApproval", () => {
  test("routes to ownership-group owner-role members", async () => {
    const resolver = makeResolver();
    const route = await resolver.routeApproval("actor-partner", "run_shell", {
      toolName: "run_shell",
      params: {},
      impact: "high",
    }, TEST_AGENT_ID);

    expect(route.type).toBe("prove_it");
    if (route.type === "prove_it") {
      // M043: approvers are now users.id — the downstream PIN flow
      // reads credentials.user_id, so user-id alignment end-to-end.
      expect(route.approvers).toEqual([OWNER_ID]);
    }
  });

  test("returns forbidden when no user holds approve_destructive_actions", async () => {
    // M128 — routeApproval uses findUsersWithCapability("approve_destructive_actions"); empty pool → forbidden
    mockFindUsersWithCapability.mockReturnValueOnce(Promise.resolve([]));
    const resolver = makeResolver();
    const route = await resolver.routeApproval(
      "actor-partner",
      "run_shell",
      { toolName: "run_shell", params: {}, impact: "high" },
      TEST_AGENT_ID,
    );
    expect(route.type).toBe("forbidden");
  });

  // TODO(M128 follow-up): rewrite against server-wide findUsersWithCapability
  // approver pool — per-agent ownership group absence is no longer an error path.
  it.skip("returns forbidden when ownership group is missing even if NAUTILO_OWNER_ACTOR_ID is set", () => {
    // M128 — approvers are server-wide (findUsersWithCapability("approve_destructive_actions"));
    // per-agent ownership group scoping is retired. See ISSUE-M128 §3.5.
  });
});

// ===========================================================================
// M077 — multi-user / empty-default-agent (ISSUE-M077 §1.9)
// ===========================================================================

describe("M077 multi-user resolver", () => {
  test("deployment owner with empty agent id still resolves to owner role", async () => {
    const prev = process.env["NAUTILO_DEFAULT_AGENT_ID"];
    delete process.env["NAUTILO_DEFAULT_AGENT_ID"];
    try {
      const resolver = new PersonalPolicyResolver(OWNER_ID, "");
      const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, "");
      expect(ctx.actorRole).toBe("owner");
    } finally {
      if (prev === undefined) delete process.env["NAUTILO_DEFAULT_AGENT_ID"];
      else process.env["NAUTILO_DEFAULT_AGENT_ID"] = prev;
    }
  });

  test("verified non-owner with no group membership falls back to guest (M128)", async () => {
    // M128 — unaffiliated verified user gets `guest` (not `household`/`stranger`).
    // findUserHighestRoleSlug(OTHER_USER_ID) returns null → serverRole='user' fallback
    // → no admin privilege → guest.
    const prev = process.env["NAUTILO_DEFAULT_AGENT_ID"];
    delete process.env["NAUTILO_DEFAULT_AGENT_ID"];
    try {
      const resolver = new PersonalPolicyResolver(OWNER_ID, "");
      const ctx = await resolver.resolveContext("tui", OTHER_FED_ID, "");
      expect(ctx.actorRole).toBe("guest");
    } finally {
      if (prev === undefined) delete process.env["NAUTILO_DEFAULT_AGENT_ID"];
      else process.env["NAUTILO_DEFAULT_AGENT_ID"] = prev;
    }
  });

  test("verified peer with owner role in a server group resolves actorRole owner", async () => {
    // M128 — actorRole comes from findUserHighestRoleSlug (server-wide, not per-agent)
    mockFindUserHighestRoleSlug.mockReturnValueOnce(Promise.resolve("owner"));
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("tui", OTHER_FED_ID, TEST_AGENT_ID);
    expect(ctx.actorRole).toBe("owner");
  });

  test("verified peer with member role in a server group resolves actorRole member", async () => {
    // M128 — household → member (migration mapping per permission-model.md §7.8)
    mockFindUserHighestRoleSlug.mockReturnValueOnce(Promise.resolve("member"));
    const resolver = makeResolver();
    const ctx = await resolver.resolveContext("tui", OTHER_FED_ID, TEST_AGENT_ID);
    expect(ctx.actorRole).toBe("member");
  });
});
