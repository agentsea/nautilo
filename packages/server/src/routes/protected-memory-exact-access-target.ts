import type {
  ProtectedMemoryAccessOperationV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import { getMemoryNamespaces } from "@nautilo/agent";
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
  HumanMemoryExactAccessAuthority,
  HumanMemoryExactAccessReadinessRequired,
  HumanMemoryExactAccessTarget,
} from "@nautilo/lattice-bridge/server";

type Unavailable = ProtectedMemoryUnavailableResponseV1;

export type M173HumanMemoryExactAccessTargetDependencies = Readonly<{
  getMemoryNamespaces(
    memoryId: string,
    trust: Readonly<{ userId: string }>,
  ): Promise<readonly string[]>;
  findActorByHandle: typeof findActorByHandle;
  findActorById: typeof findActorById;
  findActorByOwnerId: typeof findActorByOwnerId;
  findAgentOwnerPrivateRoom: typeof findAgentOwnerPrivateRoom;
  findOrCreateAccessNamespace: typeof findOrCreateAccessNamespace;
  findRoomByNamespaceId: typeof findRoomByNamespaceId;
  getRoomWithAccess: typeof getRoomWithAccess;
}>;

const defaults: M173HumanMemoryExactAccessTargetDependencies = {
  getMemoryNamespaces,
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

/**
 * Concrete M173 semantic adapter. Human/Room selectors remain ordinary
 * product facts and are converted to one exact target before signing. Newly
 * minted access Namespaces deliberately flow into product planning, whose
 * binding/delivery resolver returns `target_encryption_not_ready` until ready.
 */
export function createM173HumanMemoryExactAccessTargetResolver(input: Readonly<{
  agentId: string;
  dependencies?: M173HumanMemoryExactAccessTargetDependencies;
}>) {
  const dependencies = input.dependencies ?? defaults;
  return async (operation: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    memoryId: string;
    operation: ProtectedMemoryAccessOperationV1;
  }>): Promise<HumanMemoryExactAccessTarget | HumanMemoryExactAccessReadinessRequired
    | Unavailable> => {
    const current = canonical(
      await dependencies.getMemoryNamespaces(operation.memoryId, {
        userId: operation.authority.userId,
      }),
    );
    if (!current.some((id) => operation.authority.readableNamespaceIds.includes(id))) {
      return unavailable("authorization_required");
    }
    const anchorNamespaceId = current.find((id) =>
      operation.authority.readableNamespaceIds.includes(id)
    )!;
    if (operation.operation.kind === "delete_authorized_view") {
      return Object.freeze({ kind: "delete_authorized_view" as const });
    }
    const requester = await dependencies.findActorByOwnerId(
      operation.authority.userId,
    );
    if (requester === null || requester.id !== operation.authority.actorId) {
      return unavailable("authorization_required");
    }
    if (operation.operation.kind === "grant_room") {
      const room = await dependencies.getRoomWithAccess(operation.operation.roomId);
      if (
        room === null
        || room.isPublicNamespaceBoundary
        || !room.humanActorIds.includes(requester.id)
        || (!operation.authority.mutableNamespaceIds.includes(room.namespaceId)
          && !operation.authority.writableNamespaceIds.includes(room.namespaceId))
      ) return unavailable(room?.isPublicNamespaceBoundary === true
          ? "target_encryption_not_ready"
          : "authorization_required");
      return Object.freeze({
        kind: "replace_exact" as const,
        namespaceIds: canonical([...current, room.namespaceId]),
      });
    }
    if (operation.operation.kind === "grant_user") {
      const hit = await dependencies.findActorByHandle(
        operation.operation.userHandle.replace(/^@/u, "").toLowerCase(),
      );
      if (hit === null || hit.kind !== "user" || hit.actorId === requester.id) {
        return unavailable("authorization_required");
      }
      const destination = await dependencies.findOrCreateAccessNamespace(
        [requester.id, hit.actorId],
        { requesterUserId: operation.authority.userId, requesterActorId: requester.id },
      );
      if (!operation.authority.mutableNamespaceIds.includes(destination.namespaceId)
        && !operation.authority.writableNamespaceIds.includes(destination.namespaceId)) {
        return Object.freeze({ kind: "namespace_readiness_required" as const,
          anchorNamespaceId,
          namespaceIds: [destination.namespaceId] });
      }
      return Object.freeze({
        kind: "replace_exact" as const,
        namespaceIds: canonical([...current, destination.namespaceId]),
      });
    }
    const privateRoom = async () => dependencies.findAgentOwnerPrivateRoom(
      operation.authority.userId,
      input.agentId,
    );
    if (operation.operation.kind === "make_private") {
      const destination = await privateRoom();
      if (destination === null) return unavailable("target_encryption_not_ready");
      if (!operation.authority.mutableNamespaceIds.includes(destination.namespaceId)
        && !operation.authority.writableNamespaceIds.includes(destination.namespaceId)) {
        return Object.freeze({ kind: "namespace_readiness_required" as const,
          anchorNamespaceId,
          namespaceIds: [destination.namespaceId] });
      }
      const retained = current.filter((id) =>
        !operation.authority.mutableNamespaceIds.includes(id)
      );
      return Object.freeze({
        kind: "replace_exact" as const,
        namespaceIds: canonical([...retained, destination.namespaceId]),
      });
    }
    const hit = await dependencies.findActorByHandle(
      operation.operation.userHandle.replace(/^@/u, "").toLowerCase(),
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
      if (room === null || !room.humanActorIds.includes(targetActor.id)) continue;
      if (!operation.authority.mutableNamespaceIds.includes(namespaceId)) continue;
      const remaining = room.humanActorIds.filter((id) => id !== targetActor.id);
      target.delete(namespaceId);
      if (remaining.length === 0) continue;
      let destination: string | null;
      if (remaining.length === 1 && remaining[0] === requester.id) {
        destination = (await privateRoom())?.namespaceId ?? null;
      } else {
        destination = (await dependencies.findOrCreateAccessNamespace(
          remaining,
          { requesterUserId: operation.authority.userId,
            requesterActorId: requester.id },
        )).namespaceId;
      }
      if (destination === null) return unavailable("target_encryption_not_ready");
      if (!operation.authority.mutableNamespaceIds.includes(destination)
        && !operation.authority.writableNamespaceIds.includes(destination)) {
        return Object.freeze({ kind: "namespace_readiness_required" as const,
          anchorNamespaceId,
          namespaceIds: [destination] });
      }
      target.add(destination);
    }
    return Object.freeze({
      kind: "replace_exact" as const,
      namespaceIds: canonical(target),
    });
  };
}
