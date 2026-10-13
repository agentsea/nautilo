import { getEncryptionTransitionPolicy, getSharedDirectDb, roomMembers, rooms, actors, eq, and, isNull, sql } from "@nautilo/db";
import type { MemoryAccessEnvelope, NamespaceMemoryEnvelope } from "./types";
import { getRoomWithAccess, findActorById } from "./queries";

export type ExternalRoomPolicy = Readonly<{ roomId: string; namespaceId: string }>;

/** Durable Room state owns the boundary, including inherited Subthreads. */
export async function getExternalRoomPolicy(roomId: string): Promise<ExternalRoomPolicy | null> {
  if (!roomId) return null;
  const room = await getRoomWithAccess(roomId);
  return room?.externalContext === true
    ? Object.freeze({ roomId, namespaceId: room.namespaceId })
    : null;
}

/** Narrow an admitted Human envelope without borrowing their wider resources. */
export function restrictExternalRoomEnvelope(
  envelope: MemoryAccessEnvelope,
  namespaceId: string,
): NamespaceMemoryEnvelope {
  if (!namespaceId || envelope.memoryMode === "scope") {
    throw new Error("external_room_scope_unavailable");
  }
  return {
    ...envelope,
    externalContext: true,
    readableNamespaces: [namespaceId],
    mutableNamespaces: [namespaceId],
    writableNamespaces: [namespaceId],
    toolPolicy: Object.fromEntries(Object.keys(envelope.toolPolicy).map((name) => [name, "forbidden" as const])),
  };
}

/** External ingress has no foreground device authorization for protected modes. */
export async function assertExternalRoomTextMode(): Promise<void> {
  const policy = await getEncryptionTransitionPolicy(getSharedDirectDb());
  if (policy.mode !== "plaintext_only") throw new Error("external_room_content_mode_unsupported");
}

/** Sponsor admission is current, separate from externally authored content. */
export async function assertExternalRoomSubject(policy: ExternalRoomPolicy, envelope: MemoryAccessEnvelope): Promise<void> {
  const actor = await findActorById(envelope.actorId);
  const room = await getRoomWithAccess(policy.roomId, envelope.actorId);
  if (actor?.kind !== "user" || actor.ownerId !== envelope.ownerId || !room?.externalContext
    || room.namespaceId !== policy.namespaceId) throw new Error("external_room_subject_unavailable");
  const [member] = await getSharedDirectDb().select({ roomId: roomMembers.roomId })
    .from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId)).where(and(
      eq(roomMembers.roomId, policy.roomId), eq(actors.kind, "agent"), eq(actors.agentId, envelope.agentId),
      isNull(rooms.archivedAt), sql`NOT EXISTS (SELECT 1 FROM rooms AS external_parent
        WHERE external_parent.namespace_id = ${rooms.namespaceId}
          AND external_parent.kind <> 'subthread' AND external_parent.archived_at IS NOT NULL)`,
    )).limit(1);
  if (!member) throw new Error("external_room_agent_unavailable");
}

export type ExternalRoomExecutionDependencies = Readonly<{
  policy(roomId: string): Promise<ExternalRoomPolicy | null>;
  assertTextMode(): Promise<void>;
  assertAccess(policy: ExternalRoomPolicy, envelope: MemoryAccessEnvelope): Promise<void>;
}>;

export const externalRoomExecutionDependencies: ExternalRoomExecutionDependencies = Object.freeze({
  policy: getExternalRoomPolicy, assertTextMode: assertExternalRoomTextMode, assertAccess: assertExternalRoomSubject,
});
