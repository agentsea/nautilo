import { randomUUID } from "node:crypto";
import { db, type Database } from "../config/database";
import { namespaces } from "../schema/trust";
import { rooms, roomMembers } from "../schema/rooms";
import { artifactNamespaces } from "../schema/artifact-namespaces";

type Db = Database;

/**
 * D442 Phase 4.2 — atomic "Start a new conversation" from a workspace
 * artifact.
 *
 * Mints a fresh conversational Room (`kind='private'`) + its 1:1
 * Namespace + the caller (admin) and the caller's personal agent
 * (member, `agent_response_mode='active'`) memberships, AND attaches
 * the artifact to the new Room's Namespace — all in a single database
 * transaction. The single-tx boundary is the whole point: the room
 * never exists without its artifact attachment and the attachment
 * never exists without its room. A failure on any step rolls back
 * every prior step.
 *
 * Authorization is the caller's responsibility, NOT this helper's.
 * The route resolves the caller's personal agent actor id and verifies
 * the artifact is readable for the viewer's envelope BEFORE invoking
 * this helper. This helper trusts its inputs and performs no envelope
 * or membership checks.
 *
 * Mirrors the room-bundle insert performed by `insertPrivateRoomBundleTx`
 * in `packages/trust/src/queries.ts`, but inlined here so the artifact
 * attachment rides the SAME transaction. The trust helper is not
 * exported and runs its own transaction, so it cannot be reused for
 * an atomic attach. The `humanActorIds` denormalized set is set
 * directly at insert; no post-tx `updateRoomHumanActors` recompute is
 * needed because the only human member is the caller, inserted in this
 * same tx.
 *
 * Returns the safe `{ id, label, kind }` projection — no namespace id
 * is exposed to the caller (the route returns this shape verbatim).
 */
export interface CreateDiscussionRoomForArtifactInput {
  /** Caller's user id (`rooms.owner_id`). */
  ownerUserId: string;
  /** Caller's actor id (human; becomes admin member + `created_by`). */
  ownerActorId: string;
  /** Caller's personal agent actor id (agent; becomes active member). */
  agentActorId: string;
  /** Room label (route validates 1–80 chars). */
  label: string;
  /** Artifact internal row id (`artifacts.id`) to attach to the new namespace. */
  artifactInternalId: string;
}

export type CreatedDiscussionRoom = {
  id: string;
  label: string;
  kind: string;
};

export async function createDiscussionRoomForArtifact(
  input: CreateDiscussionRoomForArtifactInput,
  conn: Db = db,
): Promise<CreatedDiscussionRoom> {
  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;
  const kind = "private" as const;

  return await conn.transaction(async (tx) => {
    const [nsRow] = await tx
      .insert(namespaces)
      .values({ scope: "private", label: input.label })
      .returning({ id: namespaces.id });
    if (!nsRow) {
      throw new Error("createDiscussionRoomForArtifact: namespace insert failed");
    }
    const namespaceId = nsRow.id;

    await tx.insert(rooms).values({
      id: roomId,
      ownerId: input.ownerUserId,
      type: "private",
      label: input.label,
      graphThreadId,
      namespaceId,
      humanActorIds: [input.ownerActorId],
      createdBy: input.ownerActorId,
      kind,
    });

    await tx.insert(roomMembers).values([
      {
        roomId,
        actorId: input.ownerActorId,
        roomRole: "admin",
      },
      {
        roomId,
        actorId: input.agentActorId,
        roomRole: "member",
        agentResponseMode: "active",
      },
    ]);

    // Attach the artifact to the new Room's Namespace inside the SAME
    // transaction. ON CONFLICT DO NOTHING keeps the helper idempotent on
    // the junction edge (mirrors `attachArtifactToNamespace`).
    await tx
      .insert(artifactNamespaces)
      .values({
        artifactId: input.artifactInternalId,
        namespaceId,
      })
      .onConflictDoNothing();

    return { id: roomId, label: input.label, kind };
  });
}
