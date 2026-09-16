import { describe, expect, test } from "bun:test";
import type { HumanArtifactExactAccessAuthority } from "@nautilo/lattice-bridge/server";

import {
  createHumanArtifactExactAccessTargetResolver,
  type HumanArtifactExactAccessTargetDependencies,
} from "../../src/routes/protected-artifact-exact-access-target";

const ARTIFACT = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "20000000-0000-4000-8000-000000000003";
const PRIVATE = "20000000-0000-4000-8000-000000000004";
const authority: HumanArtifactExactAccessAuthority = {
  userId: "user-1", subjectHumanId: "human-1", actorId: "alice", agentId: null,
  readableNamespaceIds: [A, B], mutableNamespaceIds: [A, B],
  writableNamespaceIds: [A, B, C, PRIVATE],
};

function dependencies(): HumanArtifactExactAccessTargetDependencies {
  return {
    getArtifactNamespaceIds: async () => [A, B],
    findActorByOwnerId: async () => ({
      id: "alice", displayName: "Alice", trustState: "trusted",
    }),
    findActorByHandle: async (handle) => handle === "bob"
      ? { actorId: "bob", kind: "user", displayName: "Bob" } : null,
    findActorById: async (id) => id === "bob"
      ? { id, ownerId: "user-2", displayName: "Bob", kind: "user", agentId: null }
      : null,
    getRoomWithAccess: async () => ({
      namespaceId: C, humanActorIds: ["alice", "bob"],
      isPublicNamespaceBoundary: false,
    }),
    findRoomByNamespaceId: async (id) => id === B
      ? { roomId: "room-b", label: "AB", humanActorIds: ["alice", "bob"] }
      : { roomId: "room-a", label: "A", humanActorIds: ["alice"] },
    findOrCreateAccessNamespace: async (actors) => ({
      namespaceId: actors.length === 1 ? PRIVATE : C,
      roomId: "access-room", minted: true,
    }),
    findAgentOwnerPrivateRoom: async () => ({
      roomId: "private", namespaceId: PRIVATE,
    }),
  };
}

describe("Human Artifact exact-access semantic target", () => {
  test("grants, re-homes revoke/private, and preserves inaccessible audiences", async () => {
    const deps = dependencies();
    const resolve = createHumanArtifactExactAccessTargetResolver({
      agentId: "agent-1", getArtifactNamespaceIds: deps.getArtifactNamespaceIds,
      dependencies: deps,
    });
    expect(await resolve({ authority, artifactId: ARTIFACT,
      operation: { kind: "grant_user", userHandle: "@Bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, B, C],
    });
    expect(await resolve({ authority, artifactId: ARTIFACT,
      operation: { kind: "revoke_user", userHandle: "bob" } })).toEqual({
      kind: "replace_exact", namespaceIds: [A, PRIVATE],
    });
    expect(await resolve({ authority: { ...authority, mutableNamespaceIds: [A] },
      artifactId: ARTIFACT, operation: { kind: "make_private" } })).toEqual({
      kind: "replace_exact", namespaceIds: [B, PRIVATE],
    });
    expect(await resolve({ authority, artifactId: ARTIFACT,
      operation: { kind: "delete_authorized_view" } })).toEqual({
      kind: "delete_authorized_view",
    });
  });

  test("returns target-not-ready before signing a newly provisioned audience", async () => {
    const deps = dependencies();
    const resolve = createHumanArtifactExactAccessTargetResolver({
      agentId: "agent-1", getArtifactNamespaceIds: deps.getArtifactNamespaceIds,
      dependencies: deps,
    });
    expect(await resolve({ authority: { ...authority,
      writableNamespaceIds: [A, B] }, artifactId: ARTIFACT,
      operation: { kind: "grant_user", userHandle: "bob" } })).toEqual({
      dtoVersion: 1, status: "unavailable", reason: "target_encryption_not_ready",
    });
  });
});
