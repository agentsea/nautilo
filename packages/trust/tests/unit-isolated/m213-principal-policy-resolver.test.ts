/**
 * M213 Phase 3 — `resolveContextFromPrincipal` avoids duplicate identity/RBAC
 * DB reads while preserving PersonalPolicyResolver semantics.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import * as nautiloLogger from "@nautilo/logger";
import type { CanonicalPrincipal, RbacProjection } from "../../src/m213-read-models";

delete process.env["NAUTILO_HOSTNAME"];

const NAUTILO_FEDERATION_HOST_SUFFIX = process.env["NAUTILO_INSTANCE_ID"]
  ? `${process.env["NAUTILO_INSTANCE_ID"]}.local`
  : "nautilo.local";

const warnSpy = mock((..._args: unknown[]) => {});
mock.module("@nautilo/logger", () => ({
  ...nautiloLogger,
  log: mock(() => {}),
  warn: warnSpy,
}));

const OWNER_ID = "user-1";
const OWNER_ACTOR_ID = "actor-owner";
const TEST_AGENT_ID = "agent-genie";
const OWNER_FED_ID = `@owner@${NAUTILO_FEDERATION_HOST_SUFFIX}`;
const GENIE_FED_ID = `@genie@${NAUTILO_FEDERATION_HOST_SUFFIX}`;

const ALL_OWNER_CAPS = [
  "manage_members",
  "use_high_impact_tools",
  "use_research_tools",
  "approve_destructive_actions",
];

const mockFindActorByOwnerId = mock(() => Promise.resolve(null));
const mockFindUserByChannelIdentity = mock(() => Promise.resolve(null));
const mockFindUserById = mock(() => Promise.resolve(null));
const mockFindUserHighestRoleSlug = mock(() => Promise.resolve(null));
const mockFindActorById = mock(() => Promise.resolve(null));
const mockGetUserCapabilities = mock(() => Promise.resolve([] as string[]));
const mockFindAgentById = mock(() => Promise.resolve(null));

const mockFindDefaultRoomForActor = mock(() =>
  Promise.resolve(
    null as { id: string; type: string; graphThreadId: string } | null,
  ),
);
const mockFindRoomForUserAndAgentMembers = mock(() =>
  Promise.resolve(
    null as { id: string; type: string; graphThreadId: string } | null,
  ),
);
const mockFindRoomForUserMember = mock(() =>
  Promise.resolve(
    null as { id: string; type: string; graphThreadId: string } | null,
  ),
);
const mockGetRoomWithAccess = mock(() =>
  Promise.resolve(
    null as {
      namespaceId: string;
      humanActorIds: string[];
      isPublicNamespaceBoundary?: boolean;
    } | null,
  ),
);
const mockFindReadableNamespacesForSubset = mock(() => Promise.resolve([] as string[]));
const mockFindUsersWithCapability = mock(() => Promise.resolve([] as string[]));

mock.module("../../src/queries", () => ({
  findActorByOwnerId: mockFindActorByOwnerId,
  findUserByChannelIdentity: mockFindUserByChannelIdentity,
  findUserById: mockFindUserById,
  findUserHighestRoleSlug: mockFindUserHighestRoleSlug,
  findActorById: mockFindActorById,
  getUserCapabilities: mockGetUserCapabilities,
  findAgentById: mockFindAgentById,
  findDefaultRoomForActor: mockFindDefaultRoomForActor,
  findRoomForUserAndAgentMembers: mockFindRoomForUserAndAgentMembers,
  findRoomForUserMember: mockFindRoomForUserMember,
  getRoomWithAccess: mockGetRoomWithAccess,
  findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
  findUsersWithCapability: mockFindUsersWithCapability,
}));

import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";

afterEach(() => {
  warnSpy.mockClear();
  mockFindActorByOwnerId.mockClear();
  mockFindUserByChannelIdentity.mockClear();
  mockFindUserById.mockClear();
  mockFindUserHighestRoleSlug.mockClear();
  mockFindActorById.mockClear();
  mockGetUserCapabilities.mockClear();
  mockFindAgentById.mockClear();
  mockFindDefaultRoomForActor.mockClear();
  mockFindRoomForUserAndAgentMembers.mockClear();
  mockFindRoomForUserMember.mockClear();
  mockGetRoomWithAccess.mockClear();
  mockFindReadableNamespacesForSubset.mockClear();
});

function makeVerifiedPrincipal(
  overrides: Partial<CanonicalPrincipal> = {},
): CanonicalPrincipal {
  return {
    logtoSub: "logto-sub-owner",
    userId: OWNER_ID,
    disabledAt: null,
    actorId: OWNER_ACTOR_ID,
    actorDisplayName: "Owner",
    handle: "owner",
    displayName: "Owner",
    server: null,
    federatedId: OWNER_FED_ID,
    workbenchChannelBinding: {
      externalId: OWNER_FED_ID,
      verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      isVerified: true,
    },
    personalAgent: {
      agentId: TEST_AGENT_ID,
      handle: "genie",
      displayName: "Genie",
    },
    ...overrides,
  };
}

function makeOwnerRbac(overrides: Partial<RbacProjection> = {}): RbacProjection {
  return {
    highestRole: "owner",
    capabilitySlugs: ALL_OWNER_CAPS,
    groupChips: [],
    ...overrides,
  };
}

describe("resolveContextFromPrincipal — M213 duplicate-read avoidance", () => {
  test("verified principal uses RBAC projection without identity/RBAC query helpers", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal(),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.actorId).toBe(OWNER_ACTOR_ID);
    expect(ctx.actorRole).toBe("owner");
    expect(ctx.speakerTrust).toBe("verified");
    expect(ctx.actorFederatedId).toBe(OWNER_FED_ID);
    expect(ctx.agentFederatedId).toBe(GENIE_FED_ID);
    expect(ctx.memoryAccess.ownerId).toBe(OWNER_ID);
    expect(ctx.memoryAccess.toolPolicy["run_deep_research"]).toBe("allow");

    expect(mockFindUserByChannelIdentity).not.toHaveBeenCalled();
    expect(mockFindActorByOwnerId).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
    expect(mockFindUserHighestRoleSlug).not.toHaveBeenCalled();
    expect(mockFindActorById).not.toHaveBeenCalled();
    expect(mockGetUserCapabilities).not.toHaveBeenCalled();
    expect(mockFindAgentById).not.toHaveBeenCalled();
  });

  test("unverified workbench binding stays guest-shaped", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal({
        workbenchChannelBinding: {
          externalId: OWNER_FED_ID,
          verifiedAt: null,
          isVerified: false,
        },
      }),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.speakerTrust).toBe("unverified");
    expect(ctx.actorRole).toBe("guest");
    expect(ctx.actorId).toBe(OWNER_FED_ID);
    expect(ctx.actorFederatedId).toBe("");
    expect(ctx.memoryAccess.readableNamespaces).toEqual([]);

    expect(mockFindUserByChannelIdentity).not.toHaveBeenCalled();
    expect(mockFindActorByOwnerId).not.toHaveBeenCalled();
    expect(mockGetUserCapabilities).not.toHaveBeenCalled();
  });

  test("null workbench binding stays guest-shaped", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal({ workbenchChannelBinding: null }),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.speakerTrust).toBe("unverified");
    expect(ctx.actorRole).toBe("guest");
    expect(mockFindUserByChannelIdentity).not.toHaveBeenCalled();
  });

  test("role-less bootstrap owner falls back to owner slug", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal(),
      rbacProjection: { highestRole: null, capabilitySlugs: [], groupChips: [] },
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.actorRole).toBe("owner");
    expect(mockFindUserHighestRoleSlug).not.toHaveBeenCalled();
  });

  test("role-less non-owner falls back to guest with warn", async () => {
    const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal({ userId: otherUserId }),
      rbacProjection: { highestRole: null, capabilitySlugs: [], groupChips: [] },
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.actorRole).toBe("guest");
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  test("empty preferredAgentId is valid (no bootstrap agent fallback)", async () => {
    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal({ personalAgent: null }),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: "",
    });

    expect(ctx.agentId).toBe("");
    expect(ctx.agentFederatedId).toBe("");
    expect(mockFindAgentById).not.toHaveBeenCalled();
    expect(mockFindDefaultRoomForActor).not.toHaveBeenCalled();
  });

  test("Human-facing content scope accepts a requested Room without Agent membership", async () => {
    const roomId = "33333333-3333-4333-8333-333333333333";
    const namespaceId = "44444444-4444-4444-8444-444444444444";
    mockFindRoomForUserMember.mockResolvedValueOnce({
      id: roomId,
      type: "shared",
      graphThreadId: `room:${roomId}`,
    });
    mockGetRoomWithAccess.mockResolvedValueOnce({
      namespaceId,
      humanActorIds: [OWNER_ACTOR_ID],
      isPublicNamespaceBoundary: true,
    });
    mockFindReadableNamespacesForSubset.mockResolvedValueOnce([namespaceId]);

    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal({ personalAgent: null }),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: "",
      requestedRoomId: roomId,
      requestedRoomAdmission: "human",
    });

    expect(ctx.roomId).toBe(roomId);
    expect(ctx.memoryAccess.readableNamespaces).toEqual([namespaceId]);
    expect(mockFindRoomForUserMember).toHaveBeenCalledWith(
      roomId,
      OWNER_ACTOR_ID,
    );
    expect(mockFindRoomForUserAndAgentMembers).not.toHaveBeenCalled();
    expect(mockFindDefaultRoomForActor).not.toHaveBeenCalled();
  });

  test("Human-facing content scope fails closed instead of falling back for a non-member Room", async () => {
    const roomId = "55555555-5555-4555-8555-555555555555";
    mockFindRoomForUserMember.mockResolvedValueOnce(null);

    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal(),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: TEST_AGENT_ID,
      requestedRoomId: roomId,
      requestedRoomAdmission: "human",
    });

    expect(ctx.roomId).toBe("");
    expect(ctx.memoryAccess.readableNamespaces).toEqual([]);
    expect(mockFindDefaultRoomForActor).not.toHaveBeenCalled();
  });

  test("still resolves namespace via room queries independently", async () => {
    const roomId = "room-private-owner";
    const nsId = "ns-private";
    mockFindDefaultRoomForActor.mockResolvedValueOnce({
      id: roomId,
      type: "private",
      graphThreadId: "app:default",
    });
    mockGetRoomWithAccess.mockResolvedValueOnce({
      namespaceId: nsId,
      humanActorIds: [OWNER_ACTOR_ID],
    });
    mockFindReadableNamespacesForSubset.mockResolvedValueOnce([nsId]);

    const resolver = new PersonalPolicyResolver(OWNER_ID, TEST_AGENT_ID);
    const ctx = await resolver.resolveContextFromPrincipal({
      principal: makeVerifiedPrincipal(),
      rbacProjection: makeOwnerRbac(),
      preferredAgentId: TEST_AGENT_ID,
    });

    expect(ctx.roomId).toBe(roomId);
    expect(ctx.memoryAccess.writableNamespaces).toEqual([nsId]);
    expect(ctx.memoryAccess.readableNamespaces).toEqual([nsId]);
    expect(mockGetRoomWithAccess).toHaveBeenCalled();
    expect(mockFindReadableNamespacesForSubset).toHaveBeenCalled();
  });
});
