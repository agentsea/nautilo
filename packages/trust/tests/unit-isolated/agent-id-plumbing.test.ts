import { describe, test, it, expect, mock, beforeEach } from "bun:test";
import { CAPABILITY_SLUGS } from "@nautilo/types";

/**
 * M042A — focused unit tests for the agentId threading.
 *
 * Post-M042D the routeApproval + fallback flow changed shape (now
 * resolves via the ownership group + env var rather than a direct
 * agent → ownerId → actor chain). M043 further flipped every Subject
 * query to users.id; the resolver still takes `actorId` at its public
 * interface and translates via `findActorById`. These tests exercise
 * the agentId-propagation path and the env-var bootstrap fallback.
 */

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

delete process.env["NAUTILO_HOSTNAME"];
const OWNER_ID = "user-1";
const OWNER_ACTOR_ID = "actor-owner";
const DEFAULT_AGENT_ID = "agent-default";
const OWNERSHIP_GROUP_ID = "group-ownership-default";
const OWNERSHIP_ROLE_ID = "role-owner";
const OWNER_FED_ID = "@owner@nautilo.local";

// Owner receives the full canonical capability catalogue.
const ALL_OWNER_CAPS = [...CAPABILITY_SLUGS];

const mockFindActor = mock(() =>
  Promise.resolve({ id: OWNER_ACTOR_ID, displayName: "Owner", trustState: "verified" }),
);
// M045: `findAgentById` return shape no longer carries `ownerId`.
const mockFindAgent = mock(() =>
  Promise.resolve({
    id: DEFAULT_AGENT_ID,
    handle: "genie",
    displayName: "Genie",
  } as { id: string; handle: string; displayName: string } | null),
);
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
// M128 — getUserCapabilities is server-wide; owner gets full bundle
const mockGetCapabilities = mock((userId: string) => {
  if (userId === OWNER_ID) return Promise.resolve(ALL_OWNER_CAPS);
  return Promise.resolve([] as string[]);
});

// M044 — Room-subset rule. Default: no room match (tests in this file
// care about agentId threading + env fallback, not namespaces).
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
  if (actorId === "env-fallback-actor") {
    return Promise.resolve({
      id: "env-fallback-actor",
      ownerId: OWNER_ID,
      displayName: "Fallback",
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

// M128 — server-wide query mocks (replace ownership-group API)
const mockFindUserHighestRoleSlug = mock(
  (userId: string): Promise<string | null> => {
    if (userId === OWNER_ID) return Promise.resolve("owner");
    return Promise.resolve(null);
  },
);
const mockFindUsersWithCapability = mock(
  (capabilitySlug: string): Promise<string[]> => {
    if (capabilitySlug === "approve_destructive_actions") return Promise.resolve([OWNER_ID]);
    return Promise.resolve([]);
  },
);
// Legacy mocks kept for shim / override compatibility (not called by M128 resolver)
const mockFindOwnershipGroupForAgent = mock((agentId: string) =>
  Promise.resolve(
    agentId === DEFAULT_AGENT_ID
      ? { id: OWNERSHIP_GROUP_ID, roleId: OWNERSHIP_ROLE_ID }
      : (null as { id: string; roleId: string } | null),
  ),
);
const mockGetUserRoleInGroup = mock(
  (_userId: string, _groupId: string): Promise<string | null> => Promise.resolve(null),
);
const mockFindUsersWithRoleInGroup = mock(
  (_groupId: string, _roleSlug: string): Promise<string[]> => Promise.resolve([]),
);
const mockGetUserCapabilitiesInGroup = mock(
  (userId: string, _groupId: string): Promise<string[]> => mockGetCapabilities(userId),
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
  // M128 — server-wide queries
  getUserCapabilities: mockGetCapabilities,
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

const makeTool = (name: string) => ({
  name,
  args: {},
  id: "test-id",
  type: "tool_call" as const,
});

// Reset env tweaks between tests so each case starts from a known
// baseline (M077: NAUTILO_OWNER_ACTOR_ID must not change routeApproval).
const ORIGINAL_ENV_OWNER_ACTOR_ID = process.env["NAUTILO_OWNER_ACTOR_ID"];
beforeEach(() => {
  if (ORIGINAL_ENV_OWNER_ACTOR_ID !== undefined) {
    process.env["NAUTILO_OWNER_ACTOR_ID"] = ORIGINAL_ENV_OWNER_ACTOR_ID;
  } else {
    delete process.env["NAUTILO_OWNER_ACTOR_ID"];
  }
});

// ===========================================================================
// 1. agentId propagation through resolveContext + buildEnvelope
// ===========================================================================

describe("agentId propagation (M042A)", () => {
  const PROPAGATION_AGENT_ID = "agent-propagation-test";

  test("resolveContext (owner path) populates agentId on context and envelope", async () => {
    // Make the ownership-group mock accept the propagation agent id
    // for this case so the owner path resolves cleanly.
    // M044: no `namespaceId` in return shape (REL-GRP-NSP).
    mockFindOwnershipGroupForAgent.mockReturnValueOnce(
      Promise.resolve({
        id: OWNERSHIP_GROUP_ID,
        roleId: OWNERSHIP_ROLE_ID,
      }),
    );

    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext("tui", OWNER_FED_ID, PROPAGATION_AGENT_ID);

    expect(ctx.agentId).toBe(PROPAGATION_AGENT_ID);
    expect(ctx.memoryAccess.agentId).toBe(PROPAGATION_AGENT_ID);
  });

  test("resolveContext (guest path) populates agentId on context and envelope", async () => {
    // M128 — `stranger` retired; unauthenticated path returns `guest`
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const ctx = await resolver.resolveContext("telegram", "unknown-xyz", PROPAGATION_AGENT_ID);

    expect(ctx.actorRole).toBe("guest");
    expect(ctx.agentId).toBe(PROPAGATION_AGENT_ID);
    expect(ctx.memoryAccess.agentId).toBe(PROPAGATION_AGENT_ID);
  });

  test("buildEnvelope populates agentId on the envelope", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", DEFAULT_AGENT_ID);

    expect(envelope.agentId).toBe(DEFAULT_AGENT_ID);
    expect(envelope.ownerId).toBe(OWNER_ID);
    expect(envelope.actorId).toBe(OWNER_ACTOR_ID);
  });
});

// ===========================================================================
// 2. agentId fallback inside the resolver (M042D)
// ===========================================================================

describe("agentId defensive fallback (M042D)", () => {
  test("buildEnvelope with empty agentId falls back to defaultAgentId", async () => {
    // M042D fix: pre-M042D empty agentId would hit the isOwnerActor
    // owner branch; post-M042D it would silently guest-downgrade if
    // we didn't have the fallback. This test is the guard.
    // M044: sharedWriteMode is gone from the envelope; assert the
    // tool-policy arrives instead (owner caps → run_shell gated).
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const envelope = await resolver.buildEnvelope(OWNER_ACTOR_ID, "tui:default", "");

    // The fallback populates agentId from defaultAgentId, which drives
    // the ownership-group lookup, which lands on the owner role.
    expect(envelope.agentId).toBe(DEFAULT_AGENT_ID);
    expect(envelope.toolPolicy["run_shell"]).toBe("require_prove_it");
  });
});

// ===========================================================================
// 3. routeApproval when ownership group missing (M077)
// ===========================================================================

describe("routeApproval when ownership group missing (M077)", () => {
  // TODO(M128 follow-up): replace ownership-group-missing cases with tests for
  // empty findUsersWithCapability("approve_destructive_actions") pool.
  it.skip("returns forbidden when ownership group is missing even if NAUTILO_OWNER_ACTOR_ID is set", () => {
    // M128 — approvers are server-wide (findUsersWithCapability("approve_destructive_actions"));
    // per-agent ownership group scoping is retired. See ISSUE-M128 §3.5.
  });

  // TODO(M128 follow-up): same — env fallback no longer substitutes for ownership group.
  it.skip("returns forbidden when both ownership group AND env fallback are absent", () => {
    // M128 — approvers are server-wide (findUsersWithCapability("approve_destructive_actions"));
    // per-agent ownership group scoping is retired. See ISSUE-M128 §3.5.
  });
});

// ===========================================================================
// 4. checkToolAccess envelope-less fallback (M042D / M043)
// ===========================================================================

describe("checkToolAccess envelope-less fallback (M042D)", () => {
  test("require_approval path uses ownership group for capability lookup", async () => {
    // A non-owner with no caps calling a gated destructive tool,
    // without an envelope — exercises the envelope-less path that
    // queries getUserCapabilitiesInGroup. M043: the resolver
    // translates the caller's actorId → userId via findActorById
    // before the cap lookup; an unknown actor resolves to `null`
    // subjectUserId so caps are empty → require_approval.
    //
    // Default mock returns [] for non-owner → require_approval.
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const result = await resolver.checkToolAccess(
      "actor-non-owner",
      makeTool("run_shell"),
    );

    expect(result.type).toBe("require_approval");
    if (result.type === "require_approval") {
      expect(result.route.type).toBe("prove_it");
      if (result.route.type === "prove_it") {
        expect(result.route.approvers).toEqual([OWNER_ID]);
      }
    }
  });

  test("owner on research tool without envelope resolves to allow", async () => {
    // Owner has `use_research_tools`, so run_deep_research resolves to allow
    // via the capability check.
    const resolver = new PersonalPolicyResolver(OWNER_ID, DEFAULT_AGENT_ID);
    const result = await resolver.checkToolAccess(
      OWNER_ACTOR_ID,
      makeTool("run_deep_research"),
    );

    expect(result.type).toBe("allow");
  });
});
