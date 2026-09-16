import type { NamespaceMemoryEnvelope, ToolAccess } from "./types";
import {
  findDefaultRoomForActor,
  getRoomWithAccess,
  findReadableNamespacesForSubset,
} from "./queries";

export type WideEnvelopeResult =
  | { ok: true; envelope: NamespaceMemoryEnvelope; privateRoomId: string }
  | { ok: false; reason: "no_private_room" | "no_namespace" };

/**
 * M137 — build the speaker's WIDEST namespace envelope: the subset rule
 * evaluated as if the speaker were alone with this agent (their 1:1
 * private room). Read across the private scope; write into the private
 * namespace and (optionally) the originating Room the excursion will
 * return to.
 *
 * `toolPolicy` is inherited from the parent envelope (server-wide,
 * agent-agnostic — the speaker's capabilities do not change by Room).
 *
 * `returnRoomNamespaceId` (M137 follow-up #2/#3/#6) — the namespace of the
 * Room the excursion was launched from (e.g. a group room). When supplied
 * it becomes the PRIMARY write target (`writableNamespaces[0]`) so the
 * excursion can bring a found artifact/memory back INTO that Room with the
 * normal write tools, which attach to `writableNamespaces[0]`. The private
 * namespace remains writable as a secondary target. Reads/mutations widen
 * to include it too. Omit (or pass the private NS) for a pure-private run.
 */
export async function buildWideEnvelopeForSpeaker(params: {
  speakerActorId: string;
  speakerUserId: string;
  agentId: string;
  toolPolicy: Record<string, ToolAccess>;
  returnRoomNamespaceId?: string;
}): Promise<WideEnvelopeResult> {
  const privateRoom = await findDefaultRoomForActor(
    params.speakerActorId,
    params.agentId,
  );
  if (!privateRoom) return { ok: false, reason: "no_private_room" };

  const room = await getRoomWithAccess(privateRoom.id);
  if (!room) return { ok: false, reason: "no_namespace" };

  const superset = await findReadableNamespacesForSubset(room.humanActorIds);

  const returnNs =
    params.returnRoomNamespaceId && params.returnRoomNamespaceId !== room.namespaceId
      ? params.returnRoomNamespaceId
      : undefined;

  const readableNamespaces = [
    ...new Set([
      ...superset,
      room.namespaceId,
      ...(returnNs ? [returnNs] : []),
    ]),
  ];

  // Write target order: the Room being returned to comes first (default
  // attach target for "bring it here"), then the private namespace.
  const writableNamespaces = returnNs
    ? [returnNs, room.namespaceId]
    : [room.namespaceId];

  return {
    ok: true,
    privateRoomId: privateRoom.id,
    envelope: {
      memoryMode: "namespace",
      ownerId: params.speakerUserId,
      actorId: params.speakerActorId,
      agentId: params.agentId,
      roomId: privateRoom.id,
      readableNamespaces,
      mutableNamespaces: [...readableNamespaces],
      writableNamespaces,
      toolPolicy: params.toolPolicy,
    },
  };
}
