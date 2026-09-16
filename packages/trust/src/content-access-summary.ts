import { actors, users, rooms, eq, inArray, getSharedDirectDb } from "@nautilo/db";
import { ContentAccessAuthorityError, lockContentAccessAuthorityInTx } from "./content-access-authority";
import type { ContentAccessAdmission, ContentAccessCommand, ContentAccessFailure } from "./content-access-coordinator";

export type ContentAccessSummary = Readonly<{
  object: ContentAccessCommand["object"];
  people: readonly Readonly<{ actorId: string; displayName: string; userHandle: string | null; canRemove: boolean;
    sources: readonly (Readonly<{ kind: "immutable"; boundaryCount: number }>
      | Readonly<{ kind: "room"; roomId: string; label: string; publicRoom: boolean }>)[] }>[];
  rooms: readonly Readonly<{ roomId: string; label: string; publicRoom: boolean; canDetach: boolean }>[];
  /** Opaque preserved attachments outside this invoking context's authority. */
  otherAccessCount: number;
}>;

/** A Human-only projection of the same locked facts used by mutations. No
 * Namespace IDs, inaccessible Room identities, or hidden member lists escape. */
export async function inspectContentAccess(
  admission: ContentAccessAdmission,
  object: ContentAccessCommand["object"],
): Promise<ContentAccessSummary | ContentAccessFailure> {
  try {
  if (admission.principal.kind !== "human" || admission.audienceContract !== "invoking_room") {
    throw new ContentAccessAuthorityError("denied");
  }
  return await getSharedDirectDb().transaction(async (tx) => {
    const snapshot = await lockContentAccessAuthorityInTx(tx, { principal: admission.principal, object });
    const visible = snapshot.attachments.filter((attachment) => attachment.mutable);
    const actorIds = [...new Set(visible.flatMap((attachment) => attachment.humanActorIds))].sort();
    const roomIds = [...new Set(visible.filter((attachment) => attachment.kind === "dynamic")
      .map((attachment) => attachment.roomId))].sort();
    const people = actorIds.length ? await tx.select({ actorId: actors.id, displayName: users.name, userHandle: users.handle })
      .from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(inArray(actors.id, actorIds)).orderBy(users.name, actors.id) : [];
    const destinations = roomIds.length ? await tx.select({ roomId: rooms.id, label: rooms.label, kind: rooms.kind })
      .from(rooms).where(inArray(rooms.id, roomIds)).orderBy(rooms.label, rooms.id) : [];
    return {
      object: { kind: object.kind, id: object.id },
      people: people.map((person) => {
        const sources = visible.filter((attachment) => attachment.humanActorIds.includes(person.actorId));
        const boundaryCount = sources.filter((attachment) => attachment.kind === "access").length;
        const dynamicIds = new Set(sources.filter((attachment) => attachment.kind === "dynamic").map((attachment) => attachment.roomId));
        return { ...person, canRemove: boundaryCount > 0 && person.actorId !== admission.principal.actorId,
          sources: [ ...(boundaryCount > 0 ? [{ kind: "immutable" as const, boundaryCount }] : []),
            ...destinations.filter((room) => dynamicIds.has(room.roomId)).map((room) => ({
              kind: "room" as const, roomId: room.roomId, label: room.label, publicRoom: room.kind === "open",
            })) ] };
      }),
      rooms: destinations.map((room) => ({ roomId: room.roomId, label: room.label,
        publicRoom: room.kind === "open", canDetach: snapshot.attachments.length > 1 })),
      otherAccessCount: snapshot.attachments.length - visible.length,
    };
  });
  } catch (error) {
    return { outcome: error instanceof ContentAccessAuthorityError
      ? error.reason === "wrong_mode" || error.reason === "stale" ? "stale" : "denied" : "failed",
    stateChanged: false, receiptPersisted: false, recovery: "prepare_again" };
  }
}
