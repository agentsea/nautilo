import {
  findActorByHandle,
  findActorById,
  findActorByOwnerId,
  findShareTargetRoom,
  findUserDisplayInfo,
} from "@nautilo/trust";

/** Single source for share_memory / share_artifact approval snippet width. */
const SHARE_APPROVAL_SNIPPET_MAX_CHARS = 140;

/**
 * Normalizes `target_handle` for roster lookup and preview display.
 * Strips a leading `@` after trim — identical for memory and artifact share.
 */
export function normalizeShareTargetHandle(handle: string): string {
  const h = handle.trim();
  return h.startsWith("@") ? h.slice(1) : h;
}

/**
 * Collapses whitespace and ellipsizes for approval-card snippets (path or memory body).
 */
export function collapseWhitespaceShareApprovalSnippet(
  text: string,
  max = SHARE_APPROVAL_SNIPPET_MAX_CHARS,
): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface ShareApprovalRosterRow {
  userId: string;
  displayName: string | null;
}

/**
 * M173 — resolve a share/grant target handle to a LOCAL user.
 *
 * Hive-mind: any Human seated on this Server can receive a share — there is no
 * per-Agent roster and **no Group-membership requirement** (a real local user
 * with no Server Role is still a valid target). This replaces the legacy
 * `findAgentUserByNormalizedHandle` Group-roster gate on the share/grant paths.
 *
 * Returns `null` when the handle is not a local user-kind actor: unknown
 * handle, an Agent handle, or a federated/remote user (`findActorByHandle`
 * already filters to local `users.server IS NULL`). The single source of truth
 * so `share_memory`, `share_artifact`, and the M173 grant route never drift.
 */
export async function resolveLocalShareTargetByHandle(
  rawHandle: string,
): Promise<{ userId: string; actorId: string; displayName: string } | null> {
  const handle = normalizeShareTargetHandle(rawHandle);
  if (!handle) return null;
  const hit = await findActorByHandle(handle);
  if (!hit || hit.kind !== "user") return null;
  const actorRow = await findActorById(hit.actorId);
  if (!actorRow?.ownerId) return null;
  return { userId: actorRow.ownerId, actorId: hit.actorId, displayName: hit.displayName };
}

/**
 * Resolves display name + shared-room label + whether a new room would be created.
 * Used by both share_memory and share_artifact approval previews so roster / room
 * policy cannot drift between the two tools (M078 / M088A).
 */
export async function resolveShareApprovalTargetRoomPreview(input: {
  agentId: string;
  requesterUserId: string;
  handle: string;
  rosterRow: ShareApprovalRosterRow | null;
}): Promise<{
  targetDisplayName: string;
  roomLabel: string | null;
  wouldCreate: boolean;
}> {
  const { agentId, requesterUserId, handle, rosterRow } = input;
  if (!rosterRow) {
    return {
      targetDisplayName: handle,
      roomLabel: null,
      wouldCreate: false,
    };
  }

  const targetDisplayName = rosterRow.displayName || handle;
  const requesterActor = await findActorByOwnerId(requesterUserId);
  const targetActor = await findActorByOwnerId(rosterRow.userId);
  let roomLabel: string | null = null;
  let wouldCreate = true;
  if (requesterActor && targetActor) {
    const room = await findShareTargetRoom({
      requesterActorId: requesterActor.id,
      targetActorId: targetActor.id,
      agentId,
    });
    if (room) {
      wouldCreate = false;
      roomLabel = room.label;
    } else {
      const reqUser = await findUserDisplayInfo(requesterUserId);
      const tgtUser = await findUserDisplayInfo(rosterRow.userId);
      roomLabel = `${reqUser?.name ?? "You"} & ${tgtUser?.name ?? handle}`;
    }
  }

  return { targetDisplayName, roomLabel, wouldCreate };
}
