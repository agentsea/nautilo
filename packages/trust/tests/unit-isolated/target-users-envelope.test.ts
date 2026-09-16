/**
 * M165 Phase 1 — `buildEnvelopeForTargetUsers` with mocked query deps.
 * Mirrors the M137 `wide-envelope.test.ts` harness: `mock.restore()` +
 * cache-busted dynamic import so `mock.module` on `./queries` does not leak
 * into other unit tests in the same process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ToolAccess } from "../../src/types";

const REQUESTER = { userId: "user-alice", actorId: "a-alice" };
const PEER = { userId: "user-bob", actorId: "a-bob" };
const AGENT_ID = "agent-genie";
const TOOL_POLICY: Record<string, ToolAccess> = { save_memory: "allow" };

let mockFindAgentOwnerPrivateRoom: ReturnType<typeof mock>;
let mockFindRoomByExactHumanActorSet: ReturnType<typeof mock>;
let mockFindReadableNamespacesForSubset: ReturnType<typeof mock>;
let mockGetRoomWithAccess: ReturnType<typeof mock>;
let mockCreateRoomFromMembers: ReturnType<typeof mock>;

beforeEach(() => {
  mock.restore();
  mockFindAgentOwnerPrivateRoom = mock(async () => null);
  mockFindRoomByExactHumanActorSet = mock(async () => null);
  mockFindReadableNamespacesForSubset = mock(async () => []);
  mockGetRoomWithAccess = mock(async () => null);
  mockCreateRoomFromMembers = mock(async () => ({ id: "room-minted" }));
});

afterEach(() => {
  mock.restore();
});

async function loadFresh(): Promise<
  typeof import("../../src/target-users-envelope")
> {
  mock.module("../../src/queries", () => ({
    findAgentOwnerPrivateRoom: mockFindAgentOwnerPrivateRoom,
    findRoomByExactHumanActorSet: mockFindRoomByExactHumanActorSet,
    findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
    getRoomWithAccess: mockGetRoomWithAccess,
    createRoomFromMembers: mockCreateRoomFromMembers,
  }));
  const href = new URL("../../src/target-users-envelope.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<
    typeof import("../../src/target-users-envelope")
  >;
}

describe("buildEnvelopeForTargetUsers (M165 Phase 1)", () => {
  test("single user (requester) → own private namespace; never mints", async () => {
    mockFindAgentOwnerPrivateRoom = mock(async () => ({
      roomId: "room-priv",
      namespaceId: "ns-priv",
    }));
    mockFindReadableNamespacesForSubset = mock(async () => ["ns-priv", "ns-group"]);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.minted).toBe(false);
    expect(result.namespaceRoomId).toBe("room-priv");
    expect(result.envelope.writableNamespaces).toEqual(["ns-priv"]);
    expect(result.envelope.readableNamespaces).toContain("ns-priv");
    expect(result.envelope.readableNamespaces).toContain("ns-group");
    expect(result.envelope.mutableNamespaces).toEqual(
      result.envelope.readableNamespaces,
    );
    expect(result.envelope.memoryMode).toBe("namespace");
    expect(result.envelope.ownerId).toBe(REQUESTER.userId);
    expect(result.envelope.actorId).toBe(REQUESTER.actorId);
    expect(result.envelope.agentId).toBe(AGENT_ID);
    expect(result.envelope.roomId).toBe("room-priv");
    expect(result.envelope.toolPolicy).toBe(TOOL_POLICY);

    expect(mockFindAgentOwnerPrivateRoom).toHaveBeenCalledWith(
      REQUESTER.userId,
      AGENT_ID,
    );
    expect(mockFindRoomByExactHumanActorSet).not.toHaveBeenCalled();
    expect(mockCreateRoomFromMembers).not.toHaveBeenCalled();
  });

  test("two users with an existing exact-set room → that shared namespace; no mint", async () => {
    mockFindRoomByExactHumanActorSet = mock(async () => ({
      roomId: "room-shared",
      namespaceId: "ns-shared",
    }));
    mockFindReadableNamespacesForSubset = mock(async () => ["ns-shared"]);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER, PEER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.minted).toBe(false);
    expect(result.namespaceRoomId).toBe("room-shared");
    expect(result.envelope.writableNamespaces).toEqual(["ns-shared"]);
    expect(result.envelope.readableNamespaces).toEqual(["ns-shared"]);
    // Exact-set lookup uses the SORTED actor ids.
    expect(mockFindRoomByExactHumanActorSet).toHaveBeenCalledWith(
      ["a-alice", "a-bob"],
    );
    expect(mockFindAgentOwnerPrivateRoom).not.toHaveBeenCalled();
    expect(mockCreateRoomFromMembers).not.toHaveBeenCalled();
  });

  test("two users, no existing room, allowMint → mints {agent, requester, peer}", async () => {
    mockFindRoomByExactHumanActorSet = mock(async () => null);
    mockCreateRoomFromMembers = mock(async () => ({ id: "room-minted" }));
    mockGetRoomWithAccess = mock(async () => ({
      namespaceId: "ns-minted",
      humanActorIds: ["a-alice", "a-bob"],
    }));
    mockFindReadableNamespacesForSubset = mock(async () => []);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER, PEER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
      mintLabel: "DM namespace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.minted).toBe(true);
    expect(result.namespaceRoomId).toBe("room-minted");
    expect(result.envelope.writableNamespaces).toEqual(["ns-minted"]);
    // Minted NS is always readable even though the pre-mint superset was empty.
    expect(result.envelope.readableNamespaces).toEqual(["ns-minted"]);

    const call = mockCreateRoomFromMembers.mock.calls[0]![0] as {
      ownerUserId: string;
      ownerActorId: string;
      label: string;
      members: Array<{ kind: string; id: string }>;
    };
    expect(call.ownerUserId).toBe(REQUESTER.userId);
    expect(call.ownerActorId).toBe(REQUESTER.actorId);
    expect(call.label).toBe("DM namespace");
    expect(call.members).toContainEqual({ kind: "agent", id: AGENT_ID });
    expect(call.members).toContainEqual({ kind: "user", id: REQUESTER.userId });
    expect(call.members).toContainEqual({ kind: "user", id: PEER.userId });
  });

  test("two users, no existing room, allowMint=false → no_namespace", async () => {
    mockFindRoomByExactHumanActorSet = mock(async () => null);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER, PEER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
      allowMint: false,
    });

    expect(result).toEqual({ ok: false, reason: "no_namespace" });
    expect(mockCreateRoomFromMembers).not.toHaveBeenCalled();
  });

  test("duplicate requester in targetUsers collapses to the single-user path", async () => {
    mockFindAgentOwnerPrivateRoom = mock(async () => ({
      roomId: "room-priv",
      namespaceId: "ns-priv",
    }));
    mockFindReadableNamespacesForSubset = mock(async () => ["ns-priv"]);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER, REQUESTER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mockFindAgentOwnerPrivateRoom).toHaveBeenCalledTimes(1);
    expect(mockFindRoomByExactHumanActorSet).not.toHaveBeenCalled();
  });

  test("no resolvable target users → no_target_users", async () => {
    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: { userId: "", actorId: "" },
      targetUsers: [],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result).toEqual({ ok: false, reason: "no_target_users" });
  });

  test("single user but no private room → no_namespace (fail-safe)", async () => {
    mockFindAgentOwnerPrivateRoom = mock(async () => null);

    const { buildEnvelopeForTargetUsers } = await loadFresh();
    const result = await buildEnvelopeForTargetUsers({
      requester: REQUESTER,
      targetUsers: [REQUESTER],
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    // Single-user never mints (allowMint default does not apply — no exact-set
    // path); a missing private room is the fail-safe no_namespace outcome.
    expect(result).toEqual({ ok: false, reason: "no_namespace" });
    expect(mockCreateRoomFromMembers).not.toHaveBeenCalled();
  });
});
