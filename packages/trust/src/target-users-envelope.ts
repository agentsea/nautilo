import type { NamespaceMemoryEnvelope, ToolAccess } from "./types";
import {
  findAgentOwnerPrivateRoom,
  findRoomByExactHumanActorSet,
  findReadableNamespacesForSubset,
  getRoomWithAccess,
  createRoomFromMembers,
} from "./queries";

/** A target user, carried as both its `users.id` and its user-kind `actors.id`.
 *  The actor id drives the subset rule; the user id drives room minting
 *  (`createRoomFromMembers` resolves members by entity id). */
export type TargetUserRef = { userId: string; actorId: string };

export type TargetUsersEnvelopeResult =
  | {
      ok: true;
      envelope: NamespaceMemoryEnvelope;
      /** The room whose Namespace is the shared/write target. */
      namespaceRoomId: string;
      /** True when a new shared-namespace room was minted (§4.2). */
      minted: boolean;
    }
  | { ok: false; reason: "no_target_users" | "no_namespace" };

/**
 * M165 — derive a namespace envelope from the **target-users set** (the design
 * rule in `subagents-concept.md`: when `use_scope` is false, the Task's
 * namespace comes from "who the task is about", not the transcript room).
 *
 * Sibling to `buildWideEnvelopeForSpeaker`. Independent of the result/transcript
 * room (`target_chat`), so a background task (target users `[requester]`) writes
 * into the requester's own namespace, and an `ask_peer` task (target users
 * `[requester, peer]`) writes into the shared namespace of those two humans —
 * even though its transcript lands in the agent↔peer DM.
 *
 * Shared-namespace resolution (the room whose human set is exactly the target
 * set):
 *   - single human (the requester): the canonical agent↔requester 1:1 private
 *     room (`findAgentOwnerPrivateRoom`) — §4.1.
 *   - multiple humans: a room with exactly that human set
 *     (`findRoomByExactHumanActorSet`); if none exists and `allowMint` is true,
 *     mint one (`createRoomFromMembers` over `{agent} ∪ target humans`) — §4.2.
 *
 * `readableNamespaces` = the subset-rule superset over the target humans (every
 * room whose human set ⊇ the target set) ∪ the shared namespace.
 * `writableNamespaces` = `[sharedNamespace]` (the §4.4 primary attach target).
 * `mutableNamespaces` = a copy of `readableNamespaces` (current convention).
 *
 * `toolPolicy` is inherited from the caller's base envelope (server-wide,
 * agent-agnostic — the same pattern `buildWideEnvelopeForSpeaker` uses).
 */
export async function buildEnvelopeForTargetUsers(params: {
  /** The requesting human — always auto-included; owns any minted room. */
  requester: TargetUserRef;
  /** The full target set (requester included; deduped here defensively). */
  targetUsers: TargetUserRef[];
  agentId: string;
  toolPolicy: Record<string, ToolAccess>;
  /** §4.2 — mint a shared namespace when none exists. Default true. */
  allowMint?: boolean;
  /** Label for a minted room. */
  mintLabel?: string;
}): Promise<TargetUsersEnvelopeResult> {
  const allowMint = params.allowMint ?? true;

  // Dedupe by actor id; requester is always part of the set.
  const byActor = new Map<string, TargetUserRef>();
  for (const u of [params.requester, ...params.targetUsers]) {
    if (u.actorId && u.userId) byActor.set(u.actorId, u);
  }
  const targetRefs = [...byActor.values()];
  if (targetRefs.length === 0) return { ok: false, reason: "no_target_users" };

  const humanActorIds = targetRefs.map((r) => r.actorId).sort();

  // 1. Resolve the shared room + namespace of the EXACT human set.
  let sharedRoomId: string | undefined;
  let sharedNamespaceId: string | undefined;

  if (humanActorIds.length === 1) {
    // §4.1 — the requester's own (agent-scoped) private namespace.
    const priv = await findAgentOwnerPrivateRoom(
      params.requester.userId,
      params.agentId,
    );
    if (priv) {
      sharedRoomId = priv.roomId;
      sharedNamespaceId = priv.namespaceId;
    }
  } else {
    const exact = await findRoomByExactHumanActorSet(humanActorIds);
    if (exact) {
      sharedRoomId = exact.roomId;
      sharedNamespaceId = exact.namespaceId;
    }
  }

  // 2. §4.2 — mint a shared-namespace room when none exists. Multi-user only:
  // a single-user (requester) target always resolves to the requester's
  // EXISTING private namespace and never mints (minting a second 1:1 private
  // room would break `findAgentOwnerPrivateRoom` determinism). A missing
  // single-user private room is the fail-safe `no_namespace` outcome below.
  let minted = false;
  if (!sharedNamespaceId && allowMint && humanActorIds.length > 1) {
    const room = await createRoomFromMembers({
      ownerUserId: params.requester.userId,
      ownerActorId: params.requester.actorId,
      label: params.mintLabel ?? "Shared task namespace",
      members: [
        { kind: "agent", id: params.agentId },
        ...targetRefs.map((r) => ({ kind: "user" as const, id: r.userId })),
      ],
    });
    // `RoomDetailPayload` doesn't carry the namespace id; read it back.
    const access = await getRoomWithAccess(room.id);
    if (access) {
      sharedRoomId = room.id;
      sharedNamespaceId = access.namespaceId;
      minted = true;
    }
  }

  if (!sharedRoomId || !sharedNamespaceId) {
    return { ok: false, reason: "no_namespace" };
  }

  // 3. Readable = subset-rule superset over the target humans ∪ shared NS.
  const superset = await findReadableNamespacesForSubset(humanActorIds);
  const readableNamespaces = [...new Set([...superset, sharedNamespaceId])];

  return {
    ok: true,
    minted,
    namespaceRoomId: sharedRoomId,
    envelope: {
      memoryMode: "namespace",
      ownerId: params.requester.userId,
      actorId: params.requester.actorId,
      agentId: params.agentId,
      roomId: sharedRoomId,
      readableNamespaces,
      mutableNamespaces: [...readableNamespaces],
      writableNamespaces: [sharedNamespaceId],
      toolPolicy: params.toolPolicy,
    },
  };
}
