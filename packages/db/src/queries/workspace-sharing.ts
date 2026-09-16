import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { db, type Database } from "../config/database";
import { artifacts } from "../schema/artifacts";
import { artifactNamespaces } from "../schema/artifact-namespaces";
import { users } from "../schema/users";
import { actors, namespaces } from "../schema/trust";
import { roomMembers, rooms } from "../schema/rooms";
import { createRoomJournalStateInTx, reconcileRoomJournalMembershipInTx } from "./room-journal-state";
import { findArtifactByInternalIdForNamespaces } from "./artifacts";

/** A directed sharing container uses canonical immutable, humans-only access Rooms.
 * The graph key deduplicates creation; membership remains the access authority.
 * No transcript, task, pending event, agent member, or notification is created.
 */
export async function shareWorkspaceArtifact(input: {
  artifactId: string;
  readableNamespaceIds: string[];
  senderUserId: string;
  senderActorId: string;
  recipientUserId: string;
  recipientActorId: string;
}, conn: Database = db): Promise<{ namespaceId: string; alreadyShared: boolean } | null> {
  const key = `workspace-share:${input.senderActorId}:${input.recipientActorId}`;
  return conn.transaction(async (tx) => {
    // Serialize concurrent/retried deliveries for this exact directed pair.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const source = await findArtifactByInternalIdForNamespaces({
      internalId: input.artifactId,
      readableNamespaceIds: input.readableNamespaceIds,
    }, tx as unknown as Database);
    if (!source) return null;
    const [sender] = await tx.select({ id: actors.id }).from(actors).where(and(
      eq(actors.id, input.senderActorId), eq(actors.ownerId, input.senderUserId), eq(actors.kind, "user"),
    ));
    const [recipient] = await tx.select({ id: actors.id }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
      eq(actors.id, input.recipientActorId), eq(actors.ownerId, input.recipientUserId), eq(actors.kind, "user"), isNull(users.disabledAt), isNull(users.server),
    ));
    if (!sender || !recipient || sender.id === recipient.id) return null;
    const [existing] = await tx.select({ id: rooms.id, namespaceId: rooms.namespaceId, kind: rooms.kind,
      humanActorIds: rooms.humanActorIds, createdBy: rooms.createdBy }).from(rooms).where(eq(rooms.graphThreadId, key));
    let namespaceId: string;
    if (existing) {
      if (existing.kind !== "access" || existing.createdBy !== sender.id ||
        existing.humanActorIds.length !== 2 || !existing.humanActorIds.includes(sender.id) ||
        !existing.humanActorIds.includes(recipient.id)) throw new Error("Workspace share audience changed");
      const members = await tx.select({ actorId: roomMembers.actorId }).from(roomMembers).where(eq(roomMembers.roomId, existing.id));
      if (members.length !== 2 || !members.some((m) => m.actorId === sender.id) ||
        !members.some((m) => m.actorId === recipient.id)) throw new Error("Workspace share membership changed");
      namespaceId = existing.namespaceId;
    } else {
      const [ns] = await tx.insert(namespaces).values({ scope: "private", label: "Shared workspace files" }).returning({ id: namespaces.id });
      if (!ns) throw new Error("Workspace share namespace creation failed");
      namespaceId = ns.id;
      const roomId = randomUUID();
      await tx.insert(rooms).values({ id: roomId, ownerId: input.senderUserId, createdBy: sender.id,
        type: "shared", kind: "access", label: "Shared workspace files", graphThreadId: key,
        namespaceId, humanActorIds: [sender.id, recipient.id].sort() });
      await createRoomJournalStateInTx(tx, roomId);
      await tx.insert(roomMembers).values([
        { roomId, actorId: sender.id, roomRole: "admin" },
        { roomId, actorId: recipient.id, roomRole: "member" },
      ]);
      await reconcileRoomJournalMembershipInTx(tx, [roomId]);
    }
    const inserted = await tx.insert(artifactNamespaces).values({ artifactId: source.id, namespaceId })
      .onConflictDoNothing().returning({ artifactId: artifactNamespaces.artifactId });
    return { namespaceId, alreadyShared: inserted.length === 0 };
  });
}

/** Recipient-only projection, independent of the currently open conversation.
 * Include the access Room id so opening uses the existing exact-Room HTTP guard.
 * Sender provenance comes from the directed container, never artifact ownership.
 */
export async function listWorkspaceSharesForHuman(actorId: string, conn: Database = db) {
  return conn.select({ id: artifacts.id, artifactId: artifacts.artifactId, path: artifacts.path,
    mimeType: artifacts.mimeType, size: artifacts.size, revision: artifacts.revision,
    updatedAt: artifacts.updatedAt, sharedAt: artifactNamespaces.attachedAt,
    roomId: rooms.id, sharedBy: actors.displayName,
  }).from(artifactNamespaces)
    .innerJoin(artifacts, eq(artifacts.id, artifactNamespaces.artifactId))
    .innerJoin(rooms, eq(rooms.namespaceId, artifactNamespaces.namespaceId))
    .innerJoin(roomMembers, and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, actorId)))
    .innerJoin(actors, eq(actors.id, rooms.createdBy))
    .where(and(eq(rooms.kind, "access"),
      eq(rooms.graphThreadId, sql`'workspace-share:' || ${rooms.createdBy}::text || ':' || ${actorId}::text`),
      isNull(artifacts.deletedAt),
      sql`${artifacts.path} is not null and ${artifacts.storageUri} is not null and ${artifacts.mimeType} is not null and ${artifacts.size} is not null`,
      sql`(${rooms.humanActorIds} = ARRAY[${rooms.createdBy}, ${actorId}::uuid]::uuid[] OR ${rooms.humanActorIds} = ARRAY[${actorId}::uuid, ${rooms.createdBy}]::uuid[])`,
    )).orderBy(desc(artifactNamespaces.attachedAt), artifacts.id);
}
