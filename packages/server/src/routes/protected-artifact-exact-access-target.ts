import type {
  ProtectedArtifactAccessOperationV1,
  ProtectedArtifactUnavailableResponseV1,
} from "@nautilo/api-client";
import {
  findActorByHandle,
  findActorById,
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
  findOrCreateAccessNamespace,
  findRoomByNamespaceId,
  getRoomWithAccess,
} from "@nautilo/trust";
import type {
  HumanArtifactExactAccessAuthority,
  HumanArtifactExactAccessTarget,
} from "@nautilo/lattice-bridge/server";

type Unavailable = ProtectedArtifactUnavailableResponseV1;

export type HumanArtifactExactAccessTargetDependencies = Readonly<{
  getArtifactNamespaceIds(artifactId: string): Promise<readonly string[]>;
  findActorByHandle: typeof findActorByHandle;
  findActorById: typeof findActorById;
  findActorByOwnerId: typeof findActorByOwnerId;
  findAgentOwnerPrivateRoom: typeof findAgentOwnerPrivateRoom;
  findOrCreateAccessNamespace: typeof findOrCreateAccessNamespace;
  findRoomByNamespaceId: typeof findRoomByNamespaceId;
  getRoomWithAccess: typeof getRoomWithAccess;
}>;

const trustDependencies = {
  findActorByHandle,
  findActorById,
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
  findOrCreateAccessNamespace,
  findRoomByNamespaceId,
  getRoomWithAccess,
};

function unavailable(reason: Unavailable["reason"]): Unavailable {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function canonical(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

/** Converts Human selectors to one exact Artifact Namespace target. */
export function createHumanArtifactExactAccessTargetResolver(input: Readonly<{
  agentId: string;
  getArtifactNamespaceIds(artifactId: string): Promise<readonly string[]>;
  dependencies?: Omit<
    HumanArtifactExactAccessTargetDependencies,
    "getArtifactNamespaceIds"
  >;
}>) {
  const dependencies = {
    ...trustDependencies,
    ...input.dependencies,
    getArtifactNamespaceIds: input.getArtifactNamespaceIds,
  };
  return async (request: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    artifactId: string;
    operation: ProtectedArtifactAccessOperationV1;
  }>): Promise<HumanArtifactExactAccessTarget | Unavailable> => {
    const current = canonical(
      await dependencies.getArtifactNamespaceIds(request.artifactId),
    );
    if (!current.some((id) => request.authority.readableNamespaceIds.includes(id))) {
      return unavailable("authorization_required");
    }
    if (request.operation.kind === "delete_authorized_view") {
      return Object.freeze({ kind: "delete_authorized_view" as const });
    }
    const requester = await dependencies.findActorByOwnerId(request.authority.userId);
    if (requester === null || requester.id !== request.authority.actorId) {
      return unavailable("authorization_required");
    }
    if (request.operation.kind === "grant_room") {
      const room = await dependencies.getRoomWithAccess(request.operation.roomId);
      if (room === null || room.isPublicNamespaceBoundary
        || !room.humanActorIds.includes(requester.id)
        || !request.authority.writableNamespaceIds.includes(room.namespaceId)) {
        return unavailable(room?.isPublicNamespaceBoundary === true
          ? "target_encryption_not_ready" : "authorization_required");
      }
      return Object.freeze({ kind: "replace_exact" as const,
        namespaceIds: canonical([...current, room.namespaceId]) });
    }
    if (request.operation.kind === "grant_user") {
      const hit = await dependencies.findActorByHandle(
        request.operation.userHandle.replace(/^@/u, "").toLowerCase(),
      );
      if (hit === null || hit.kind !== "user" || hit.actorId === requester.id) {
        return unavailable("authorization_required");
      }
      const destination = await dependencies.findOrCreateAccessNamespace(
        [requester.id, hit.actorId],
        { requesterUserId: request.authority.userId, requesterActorId: requester.id },
      );
      if (!request.authority.writableNamespaceIds.includes(destination.namespaceId)) {
        return unavailable("target_encryption_not_ready");
      }
      return Object.freeze({ kind: "replace_exact" as const,
        namespaceIds: canonical([...current, destination.namespaceId]) });
    }
    const privateRoom = async () => dependencies.findAgentOwnerPrivateRoom(
      request.authority.userId,
      input.agentId,
    );
    if (request.operation.kind === "make_private") {
      const destination = await privateRoom();
      if (destination === null
        || !request.authority.writableNamespaceIds.includes(destination.namespaceId)) {
        return unavailable("target_encryption_not_ready");
      }
      const retained = current.filter((id) =>
        !request.authority.mutableNamespaceIds.includes(id));
      return Object.freeze({ kind: "replace_exact" as const,
        namespaceIds: canonical([...retained, destination.namespaceId]) });
    }
    const hit = await dependencies.findActorByHandle(
      request.operation.userHandle.replace(/^@/u, "").toLowerCase(),
    );
    if (hit === null || hit.kind !== "user" || hit.actorId === requester.id) {
      return unavailable("authorization_required");
    }
    const targetActor = await dependencies.findActorById(hit.actorId);
    if (targetActor === null || targetActor.kind !== "user") {
      return unavailable("authorization_required");
    }
    const target = new Set(current);
    for (const namespaceId of current) {
      const room = await dependencies.findRoomByNamespaceId(namespaceId);
      if (room === null || !room.humanActorIds.includes(targetActor.id)
        || !request.authority.mutableNamespaceIds.includes(namespaceId)) continue;
      const remaining = room.humanActorIds.filter((id) => id !== targetActor.id);
      target.delete(namespaceId);
      if (remaining.length === 0) continue;
      const destination = remaining.length === 1 && remaining[0] === requester.id
        ? (await privateRoom())?.namespaceId ?? null
        : (await dependencies.findOrCreateAccessNamespace(remaining, {
            requesterUserId: request.authority.userId,
            requesterActorId: requester.id,
          })).namespaceId;
      if (destination === null
        || !request.authority.writableNamespaceIds.includes(destination)) {
        return unavailable("target_encryption_not_ready");
      }
      target.add(destination);
    }
    return Object.freeze({ kind: "replace_exact" as const,
      namespaceIds: canonical(target) });
  };
}
