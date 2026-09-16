import { describe, expect, mock, test } from "bun:test";
import type {
  HumanMemoryExactAccessAuthority,
} from "@nautilo/lattice-bridge/server";

import {
  createM173HumanMemoryExactAccessTargetResolver,
  type M173HumanMemoryExactAccessTargetDependencies,
} from "../../src/routes/protected-memory-exact-access-target";

const MEMORY = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "20000000-0000-4000-8000-000000000003";
const PRIVATE = "20000000-0000-4000-8000-000000000004";
const authority: HumanMemoryExactAccessAuthority = {
  userId: "user-1",
  subjectHumanId: "human-1",
  actorId: "alice",
  agentId: null,
  readableNamespaceIds: [A, B],
  mutableNamespaceIds: [A, B],
  writableNamespaceIds: [A, B, C, PRIVATE],
};

function dependencies(): M173HumanMemoryExactAccessTargetDependencies {
  return {
    getMemoryNamespaces: async () => [A, B],
    findActorByOwnerId: async () => ({
      id: "alice", displayName: "Alice", trustState: "trusted",
    }),
    findActorByHandle: async (handle) => handle === "bob"
      ? { actorId: "bob", kind: "user", displayName: "Bob" }
      : null,
    findActorById: async (id) => id === "bob"
      ? { id, ownerId: "user-2", displayName: "Bob", kind: "user", agentId: null }
      : null,
    getRoomWithAccess: async () => ({
      namespaceId: C,
      humanActorIds: ["alice", "bob"],
      isPublicNamespaceBoundary: false,
    }),
    findRoomByNamespaceId: async (id) => id === B
      ? { roomId: "room-b", label: "AB", humanActorIds: ["alice", "bob"] }
      : { roomId: "room-a", label: "A", humanActorIds: ["alice"] },
    findOrCreateAccessNamespace: async (actors) => ({
      namespaceId: actors.length === 1 ? PRIVATE : C,
      roomId: "access-room",
      minted: true,
    }),
    findAgentOwnerPrivateRoom: async () => ({ roomId: "private", namespaceId: PRIVATE }),
  };
}

describe("M173 exact-access semantic target resolver", () => {
  test("reads attachments with the authenticated Human's trust context", async () => {
    const readNamespaces = mock(async () => [A, B]);
    const resolve = createM173HumanMemoryExactAccessTargetResolver({
      agentId: "agent-1",
      dependencies: { ...dependencies(), getMemoryNamespaces: readNamespaces },
    });
    await resolve({ authority, memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "bob" } });
    expect(readNamespaces).toHaveBeenCalledWith(MEMORY, { userId: authority.userId });
  });

  test("maps Room/User grants and public targets without signing selectors", async () => {
    const deps = dependencies();
    const resolve = createM173HumanMemoryExactAccessTargetResolver({
      agentId: "agent-1", dependencies: deps,
    });
    expect(await resolve({ authority, memoryId: MEMORY,
      operation: { kind: "grant_room", roomId: MEMORY } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, B, C],
    });
    expect(await resolve({ authority: { ...authority,
      mutableNamespaceIds: [A, B, C], writableNamespaceIds: [A] },
      memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "@Bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, B, C],
    });
    expect(await resolve({ authority: { ...authority,
      mutableNamespaceIds: [A, B], writableNamespaceIds: [A, B] },
      memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "@Bob" } })).toEqual({
      kind: "namespace_readiness_required", anchorNamespaceId: A,
      namespaceIds: [C],
    });
    expect(await resolve({ authority, memoryId: MEMORY,
      operation: { kind: "grant_user", userHandle: "@Bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, B, C],
    });
    const publicDeps = {
      ...dependencies(),
      getRoomWithAccess: async () => ({
        namespaceId: C, humanActorIds: ["alice"], isPublicNamespaceBoundary: true,
      }),
    };
    const publicResolve = createM173HumanMemoryExactAccessTargetResolver({
      agentId: "agent-1", dependencies: publicDeps,
    });
    expect(await publicResolve({ authority, memoryId: MEMORY,
      operation: { kind: "grant_room", roomId: MEMORY } })).toMatchObject({
      status: "unavailable", reason: "target_encryption_not_ready",
    });
  });

  test("re-homes revoke, makes private, and preserves inaccessible audiences", async () => {
    const resolve = createM173HumanMemoryExactAccessTargetResolver({
      agentId: "agent-1", dependencies: dependencies(),
    });
    expect(await resolve({ authority, memoryId: MEMORY,
      operation: { kind: "revoke_user", userHandle: "bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, PRIVATE],
    });
    expect(await resolve({ authority: { ...authority,
      mutableNamespaceIds: [A, B, C], writableNamespaceIds: [A, B, C] }, memoryId: MEMORY,
      operation: { kind: "revoke_user", userHandle: "bob" } })).toEqual({
      kind: "namespace_readiness_required", anchorNamespaceId: A,
      namespaceIds: [PRIVATE],
    });
    expect(await resolve({ authority: { ...authority, mutableNamespaceIds: [A] },
      memoryId: MEMORY, operation: { kind: "make_private" } })).toEqual({
      kind: "replace_exact", namespaceIds: [B, PRIVATE],
    });
    expect(await resolve({ authority, memoryId: MEMORY,
      operation: { kind: "delete_authorized_view" } })).toEqual({
      kind: "delete_authorized_view",
    });

    let emptyProvisioningAttempted = false;
    const soleAudienceResolve = createM173HumanMemoryExactAccessTargetResolver({
      agentId: "agent-1",
      dependencies: {
        ...dependencies(),
        findRoomByNamespaceId: async (id) => id === B
          ? { roomId: "room-b", label: "B", humanActorIds: ["bob"] }
          : { roomId: "room-a", label: "A", humanActorIds: ["alice"] },
        findOrCreateAccessNamespace: async (actors) => {
          if (actors.length === 0) emptyProvisioningAttempted = true;
          return { namespaceId: C, roomId: "access-room", minted: true };
        },
      },
    });
    expect(await soleAudienceResolve({ authority, memoryId: MEMORY,
      operation: { kind: "revoke_user", userHandle: "bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A],
    });
    expect(emptyProvisioningAttempted).toBe(false);
  });
});
