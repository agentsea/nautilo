import type { RoomMemberDto } from "@nautilo/types";

/**
 * The deliberately narrow presentation contract for a direct human
 * conversation. This is intentionally independent of `room.kind`: older
 * rooms can carry group metadata while their live roster is still exactly two
 * people, and that is the interaction that should read like a normal chat.
 */
export interface DirectHumanRoomInput {
  readonly members: readonly RoomMemberDto[];
  readonly viewerActorId: string | null | undefined;
  readonly viewerUserId: string | null | undefined;
}

export interface DirectHumanRoomState {
  readonly isDirectHumanRoom: boolean;
  /** The other human in the conversation, when the exact contract holds. */
  readonly peer: RoomMemberDto | null;
}

const notDirectHumanRoom: DirectHumanRoomState = {
  isDirectHumanRoom: false,
  peer: null,
};

/**
 * Resolve the exact two-human, zero-agent presentation state.
 *
 * Do not widen this to "zero agents" or to room metadata. In particular,
 * three-person human groups keep their existing group/conductor UI. A viewer
 * identity match is required so an incomplete or stale roster can never make
 * a room look like a direct conversation for the wrong person.
 */
export function resolveDirectHumanRoom({
  members,
  viewerActorId,
  viewerUserId,
}: DirectHumanRoomInput): DirectHumanRoomState {
  if (members.length !== 2) return notDirectHumanRoom;

  const humans = members.filter((member) => member.kind === "user");
  if (humans.length !== 2) return notDirectHumanRoom;

  // A duplicate row is not two distinct people. Keep ordinary room chrome
  // until the authoritative roster settles rather than guessing a peer.
  if (new Set(humans.map((member) => member.actorId)).size !== 2) {
    return notDirectHumanRoom;
  }

  const viewer = humans.find(
    (member) =>
      (viewerActorId !== null && viewerActorId !== undefined && member.actorId === viewerActorId) ||
      (viewerUserId !== null && viewerUserId !== undefined && member.userId === viewerUserId),
  );
  if (!viewer) return notDirectHumanRoom;

  const peer = humans.find((member) => member.actorId !== viewer.actorId) ?? null;
  if (!peer) return notDirectHumanRoom;

  return { isDirectHumanRoom: true, peer };
}
