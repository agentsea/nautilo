import type { ArtifactDto } from "@nautilo/api-client/browser";
import type { EventFeedItem, RoomDetailResponse } from "@nautilo/types";

export interface EventFeedHumanPresentation {
  userId: string;
  displayName: string;
}

export interface EventFeedPresentation {
  text: string;
  roomId: string | null;
  roomLabel: string | null;
  roomUnavailable: boolean;
  artifactId: string | null;
  artifactLabel: string | null;
  artifactUnavailable: boolean;
  kindLabel: string;
}

function roomIdForEvent(event: EventFeedItem): string | null {
  if (event.type === "room.member_joined" || event.type === "room.member_left") {
    return event.data.roomId;
  }
  if (event.type === "artifact.added") return event.data.roomId;
  if (event.type === "artifact.shared" && event.data.destination.kind === "room") {
    return event.data.destination.roomId;
  }
  return null;
}

function currentActorDisplayName(event: EventFeedItem): string | null {
  return event.type === "unknown" ? null : event.actorDisplayName ?? null;
}

export function presentEventFeedItem(input: {
  event: EventFeedItem;
  humansById: ReadonlyMap<string, EventFeedHumanPresentation>;
  roomsById: ReadonlyMap<string, RoomDetailResponse | null>;
  artifactsById: ReadonlyMap<string, ArtifactDto | null>;
  viewerActorId: string | null;
}): EventFeedPresentation {
  const { event, humansById, roomsById, artifactsById, viewerActorId } = input;
  const roomId = roomIdForEvent(event);
  const room = roomId === null ? null : roomsById.get(roomId) ?? null;
  const roomLabel = room?.label ?? null;
  const roomText = roomLabel ?? "an unavailable Room";

  const roomActor = event.actorId === null
    ? undefined
    : [...roomsById.values()]
      .flatMap((candidate) => candidate?.members ?? [])
      .find((member) => member.actorId === event.actorId);
  const actorName = event.actorId !== null && event.actorId === viewerActorId
    ? "You"
    : currentActorDisplayName(event)
      ?? roomActor?.displayName
      ?? (event.actorKind === "agent" ? "An agent" : "Someone");

  if (event.type === "artifact.added" || event.type === "artifact.shared") {
    const artifactId = event.data.artifactId;
    const artifact = artifactsById.get(artifactId) ?? null;
    const artifactLabel = artifact?.path.split("/").pop() ?? artifact?.path ?? null;
    const artifactText = artifactLabel ?? "an unavailable Artifact";
    const text = event.type === "artifact.added"
      ? `${actorName} added ${artifactText} in ${roomText}`
      : event.data.destination.kind === "person"
        ? `${actorName} shared ${artifactText} with you`
        : `${actorName} shared ${artifactText} with ${roomText}`;
    return {
      text,
      roomId,
      roomLabel,
      roomUnavailable: roomId !== null && room === null,
      artifactId,
      artifactLabel,
      artifactUnavailable: artifact === null,
      kindLabel: "Artifacts",
    };
  }

  if (event.type !== "room.member_joined" && event.type !== "room.member_left") {
    return {
      text: "A workspace event occurred",
      roomId,
      roomLabel,
      roomUnavailable: roomId !== null && room === null,
      artifactId: null,
      artifactLabel: null,
      artifactUnavailable: false,
      kindLabel: "Event",
    };
  }

  const subject = humansById.get(event.data.userId)?.displayName ?? "Someone";
  const actorMember = event.actorId === null
    ? undefined
    : room?.members.find((member) => member.actorId === event.actorId);
  const actorIsSubject = actorMember?.kind === "user" && actorMember.userId === event.data.userId;
  // Membership wording requires canonical actor/subject identity. The
  // read-time display label is intentionally not identity evidence: after a
  // self-leave the actor is no longer in the current Room roster, and names
  // are neither unique nor stable.
  const hasPresentedActor = event.actorId !== null
    && (event.actorId === viewerActorId || actorMember !== undefined);
  const isAdminAction = hasPresentedActor && !actorIsSubject;
  const membershipActorName = event.actorId !== null && event.actorId === viewerActorId
    ? "You"
    : actorMember?.displayName ?? (event.actorKind === "agent" ? "An agent" : "Someone");

  if (event.type === "room.member_joined") {
    return {
      text: !hasPresentedActor
        ? `${subject} became a member of ${roomText}`
        : isAdminAction
        ? `${membershipActorName} added ${subject} to ${roomText}`
        : `${subject} joined ${roomText}`,
      roomId,
      roomLabel,
      roomUnavailable: room === null,
      artifactId: null,
      artifactLabel: null,
      artifactUnavailable: false,
      kindLabel: "Membership",
    };
  }

  return {
    text: !hasPresentedActor
      ? `${subject} is no longer a member of ${roomText}`
      : isAdminAction
      ? `${membershipActorName} removed ${subject} from ${roomText}`
      : `${subject} left ${roomText}`,
    roomId,
    roomLabel,
    roomUnavailable: room === null,
    artifactId: null,
    artifactLabel: null,
    artifactUnavailable: false,
    kindLabel: "Membership",
  };
}
