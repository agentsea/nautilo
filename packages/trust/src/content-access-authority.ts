import { createHash } from "node:crypto";
import {
  and, asc, eq, inArray, isNotNull, isNull,
  acquireEncryptionConsumptionFence, namespaceSubsetPredicate,
  discoverRoomAuthorityInTx, lockDiscoveredRoomAuthorityInTx,
  actors, artifacts, artifactNamespaces, memories, memoryNamespaces,
  users, rooms, roomMembers, groupMembers, groups, groupRoles, roles,
  roleCapabilities, capabilities,
  type InviteSeedTx,
} from "@nautilo/db";
import type { AuthorizedContentAttachmentSnapshot, ContentObjectSnapshot } from "./content-access-plan";
import { discoverContentAccessPrivateTargetInTx, lockContentAccessHumansInTx,
  lockContentAccessRoomTargetInTx } from "./content-access-targets";

export type ContentAccessPrincipal = Readonly<{
  userId: string;
  actorId: string;
  /** Exact admitted context; never inferred from the object's attachments. */
  sourceRoomId: string;
}> & (
  | Readonly<{ kind: "human"; agentId?: string }>
  | Readonly<{ kind: "agent"; agentId: string }>
);

export class ContentAccessAuthorityError extends Error {
  override readonly name = "ContentAccessAuthorityError";
  constructor(readonly reason: "unavailable" | "denied" | "stale" | "wrong_mode") {
    super(`Content access ${reason}`);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Current ordinary authority, held through the caller's transaction. The
 * principal must originate in authenticated Human/Agent admission, not request
 * body fields. No Room, attachment, or receipt is written by this function.
 *
 * Uses the same inherited Room Human set and virtual-public containment as
 * PersonalPolicyResolver. Child membership gates entry; it does not replace a
 * subthread's inherited Namespace audience with its narrower member list.
 */
export async function lockContentAccessAuthorityInTx(
  tx: InviteSeedTx,
  input: Readonly<{
    principal: ContentAccessPrincipal;
    object: Readonly<{ kind: "memory" | "artifact"; id: string }>;
    expectedPolicyRevision?: number;
    /** Internal operation shape; never raw client Namespace authority. */
    intent?: Readonly<{
      additive: boolean;
      targetRoomId?: string;
      makePrivate?: boolean;
      selectedActorIds?: readonly string[];
      legacyPersonalGrant?: boolean;
    }>;
  }>,
) {
  const { principal } = input;
  // Canonical policy lock precedes identity, Room and object locks. This guard
  // cannot turn Shadow fallback or a missing protected port into No encryption.
  const policy = await acquireEncryptionConsumptionFence(tx);
  if (policy.mode !== "plaintext_only") throw new ContentAccessAuthorityError("wrong_mode");
  if (input.expectedPolicyRevision !== undefined && policy.revision !== input.expectedPolicyRevision) {
    throw new ContentAccessAuthorityError("stale");
  }
  // Discover structural Room dependencies before taking any identity, member,
  // object or junction locks. Source/target subthreads share this same phase.
  const [sourceCandidate] = await tx.select().from(rooms).where(eq(rooms.id, principal.sourceRoomId));
  if (!sourceCandidate || sourceCandidate.kind === "access") throw new ContentAccessAuthorityError("denied");
  const discoveredNamespaces = input.object.kind === "memory"
    ? (await tx.select({ id: memoryNamespaces.namespaceId }).from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, input.object.id))).map((row) => row.id)
    : (await tx.select({ id: artifactNamespaces.namespaceId }).from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, input.object.id))).map((row) => row.id);
  const targetSelection = input.intent?.makePrivate
    ? await discoverContentAccessPrivateTargetInTx(tx, principal)
    : input.intent?.targetRoomId ? { roomId: input.intent.targetRoomId } : undefined;
  const discovered = await discoverRoomAuthorityInTx(tx,
    [principal.sourceRoomId, ...(targetSelection ? [targetSelection.roomId] : [])], discoveredNamespaces);
  const boundaryRooms = await lockDiscoveredRoomAuthorityInTx(tx, discovered, "share");
  const source = boundaryRooms.find((room) => room.id === principal.sourceRoomId);
  const sourceOwners = boundaryRooms.filter((room) =>
    room.namespaceId === source?.namespaceId && room.kind !== "subthread");
  const sourceBoundary = sourceOwners[0];
  if (!source || source.kind === "access" || !source.humanActorIds.includes(principal.actorId)
    || sourceOwners.length !== 1 || !sourceBoundary || !sourceBoundary.humanActorIds.includes(principal.actorId)) {
    throw new ContentAccessAuthorityError("denied");
  }
  const sourceHumans = [...new Set(sourceBoundary.humanActorIds)].sort();
  const isPublicSource = sourceBoundary.kind === "open";
  const [human] = await tx.select({ actorId: actors.id }).from(actors)
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(eq(actors.id, principal.actorId), eq(actors.ownerId, principal.userId),
      eq(actors.kind, "user"), isNull(users.disabledAt), isNull(users.server)))
    .for("share");
  if (!human) throw new ContentAccessAuthorityError("denied");

  const requiredCapabilities = input.object.kind === "memory"
    ? ["manage_memories"]
    : principal.kind === "agent" ? ["write_artifacts", "use_share_artifact"] : ["write_artifacts"];
  for (const capability of requiredCapabilities) {
    // Hold the successful RBAC junction proof: revoking a Role/Group edge
    // cannot race a separate connection's preflight check and this commit.
    const proof = await tx.select({ capability: capabilities.slug }).from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
      .innerJoin(roles, eq(roles.id, groupRoles.roleId))
      .innerJoin(roleCapabilities, eq(roleCapabilities.roleId, roles.id))
      .innerJoin(capabilities, eq(capabilities.id, roleCapabilities.capabilityId))
      .where(and(eq(groupMembers.userId, principal.userId), eq(capabilities.slug, capability)))
      .orderBy(asc(groups.id), asc(roles.id)).for("share");
    if (!proof.length) throw new ContentAccessAuthorityError("denied");
  }

  const [membership] = await tx.select({ actorId: roomMembers.actorId }).from(roomMembers)
    .where(and(eq(roomMembers.roomId, source.id), eq(roomMembers.actorId, principal.actorId)))
    .for("share");
  if (!membership) throw new ContentAccessAuthorityError("denied");
  if (principal.kind === "agent") {
    const [agentMembership] = await tx.select({ actorId: actors.id }).from(actors)
      .innerJoin(roomMembers, eq(roomMembers.actorId, actors.id))
      .where(and(eq(actors.kind, "agent"), eq(actors.agentId, principal.agentId),
        eq(roomMembers.roomId, source.id))).for("share");
    if (!agentMembership) throw new ContentAccessAuthorityError("denied");
  }

  const target = targetSelection
    ? await lockContentAccessRoomTargetInTx(tx, principal, targetSelection.roomId,
      boundaryRooms, targetSelection.boundAgentActorId) : undefined;
  if (input.intent?.makePrivate && (target?.authority.ownerKind !== "private"
    || target.destination.humanActorIds.length !== 1
    || target.destination.humanActorIds[0] !== principal.actorId)) {
    throw new ContentAccessAuthorityError("stale");
  }
  const humans = input.intent?.selectedActorIds
    ? await lockContentAccessHumansInTx(tx, [
      ...(input.intent.legacyPersonalGrant ? [principal.actorId] : sourceHumans),
      ...input.intent.selectedActorIds,
    ]) : undefined;
  // Reused immutable attachments bypass construction, so prove their exact
  // canonical roster before any object locks too.
  for (const boundary of boundaryRooms.filter((room) => room.kind === "access")) {
    const members = await tx.select({ actorId: actors.id, kind: actors.kind })
      .from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, boundary.id)).orderBy(asc(actors.id)).for("share");
    const expected = [...new Set(boundary.humanActorIds)].sort();
    if (members.some((member) => member.kind !== "user")
      || JSON.stringify(members.map((member) => member.actorId).sort()) !== JSON.stringify(expected)) {
      throw new ContentAccessAuthorityError("stale");
    }
  }

  let object: ContentObjectSnapshot;
  let namespaceIds: string[];
  if (input.object.kind === "memory") {
    const [memory] = await tx.select({
      id: memories.id,
      revision: memories.contentRevision, updatedAt: memories.updatedAt,
    }).from(memories).where(and(eq(memories.id, input.object.id),
      isNotNull(memories.content), isNotNull(memories.type))).for("update");
    if (!memory) throw new ContentAccessAuthorityError("unavailable");
    object = { kind: "memory", id: memory.id, revision: digest(memory) };
    namespaceIds = (await tx.select({ id: memoryNamespaces.namespaceId }).from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, memory.id)).orderBy(asc(memoryNamespaces.namespaceId)).for("update")).map((row) => row.id);
  } else {
    const [artifact] = await tx.select({
      id: artifacts.id, revision: artifacts.revision, updatedAt: artifacts.updatedAt,
    }).from(artifacts).where(and(eq(artifacts.id, input.object.id), isNull(artifacts.deletedAt),
      isNotNull(artifacts.path), isNotNull(artifacts.mimeType),
      isNotNull(artifacts.size), isNotNull(artifacts.storageUri))).for("update");
    if (!artifact) throw new ContentAccessAuthorityError("unavailable");
    object = { kind: "artifact", id: artifact.id, revision: digest(artifact) };
    namespaceIds = (await tx.select({ id: artifactNamespaces.namespaceId }).from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, artifact.id)).orderBy(asc(artifactNamespaces.namespaceId)).for("update")).map((row) => row.id);
  }

  const knownNamespaces = new Set(boundaryRooms.map((room) => room.namespaceId));
  if (!input.intent?.additive && namespaceIds.some((id) => !knownNamespaces.has(id))) {
    throw new ContentAccessAuthorityError("stale");
  }
  // An unrelated additive grant may have committed while we waited on this
  // object's row. It is not needed to prove source access, cannot widen this
  // grant, and must not cause a late Room lock. Exact destination publication
  // remains idempotent even when that newly attached boundary is the target.
  namespaceIds = namespaceIds.filter((id) => knownNamespaces.has(id));
  const readableNamespaces = new Set([
    source.namespaceId,
    ...(await tx.select({ namespaceId: rooms.namespaceId }).from(rooms)
      .where(and(inArray(rooms.namespaceId, namespaceIds),
        namespaceSubsetPredicate(sourceHumans, isPublicSource))))
      .map((room) => room.namespaceId),
  ]);
  const attachments: AuthorizedContentAttachmentSnapshot[] = namespaceIds.map((namespaceId) => {
    // A Namespace is shared with subthreads. Its top-level Room owns dynamic
    // membership; selecting an arbitrary child would mislabel or narrow it.
    const owners = boundaryRooms.filter((room) => room.namespaceId === namespaceId && room.kind !== "subthread");
    const owner = owners[0];
    if (owners.length !== 1 || !owner) throw new ContentAccessAuthorityError("unavailable");
    const mutable = readableNamespaces.has(namespaceId);
    return Object.freeze({
      namespaceId, roomId: owner.id, kind: owner.kind === "access" ? "access" : "dynamic",
      humanActorIds: Object.freeze([...new Set(owner.humanActorIds)].sort()), mutable,
    });
  });
  if (!attachments.some((attachment) => attachment.mutable)) {
    throw new ContentAccessAuthorityError("denied");
  }
  // Read authored fields only after the locked namespace proof. The earlier
  // row lock selected structural identity, not confidential body/path data.
  let display: Readonly<{ kind: "memory"; content: string; type: string }>
    | Readonly<{ kind: "artifact"; path: string; mimeType: string; size: number }>;
  if (object.kind === "memory") {
    const [body] = await tx.select({ content: memories.content, type: memories.type })
      .from(memories).where(eq(memories.id, object.id));
    if (!body || body.content === null || body.type === null) throw new ContentAccessAuthorityError("unavailable");
    object = { ...object, revision: digest([object.revision, body]) };
    display = { kind: "memory", content: body.content, type: body.type };
  } else {
    const [body] = await tx.select({ path: artifacts.path, mimeType: artifacts.mimeType,
      size: artifacts.size, storageUri: artifacts.storageUri })
      .from(artifacts).where(eq(artifacts.id, object.id));
    if (!body || body.path === null || body.mimeType === null) throw new ContentAccessAuthorityError("unavailable");
    object = { ...object, revision: digest([object.revision, body]) };
    display = { kind: "artifact", path: body.path, mimeType: body.mimeType, size: Number(body.size ?? 0) };
  }
  return Object.freeze({
    policyRevision: policy.revision,
    target,
    humans,
    sourceAuthorityDigest: digest({
      roomId: source.id, namespaceId: source.namespaceId, kind: source.kind,
      namespaceAccessRevision: source.namespaceAccessRevision,
      ownerRoomId: sourceBoundary.id, ownerKind: sourceBoundary.kind,
      ownerAccessRevision: sourceBoundary.namespaceAccessRevision, humanActorIds: sourceHumans,
    }),
    object: Object.freeze(object),
    display: Object.freeze(display),
    sourceContext: Object.freeze({ roomId: source.id, humanActorIds: Object.freeze(sourceHumans) }),
    attachments: Object.freeze(attachments),
    isPublicSource,
  });
}
