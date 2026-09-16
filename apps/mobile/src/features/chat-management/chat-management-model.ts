import type { RoomSummaryDto } from "@nautilo/types";

export const CHAT_LABEL_MAX_LENGTH = 80;

export type ChatManagementAction = "rename" | "archive" | "unarchive" | "leave";

export type ChatManagementCapabilities = {
  canManage: boolean;
  /** Product-category eligibility; direct person/Genie chats are not leaveable. */
  canLeave: boolean;
  isArchived: boolean;
  viewerActorId: string | null;
};

/**
 * The list catalogue already proves membership via its server-side query. It
 * deliberately does not expose room ownership, so management eligibility is
 * supplied by the bounded manageable-room catalogue rather than guessed from
 * roster shape. Rename keeps the existing Workbench's private-room rule; the
 * canonical endpoint remains the final authorization authority.
 */
export function chatManagementActions(
  room: Pick<RoomSummaryDto, "type" | "kind" | "roster">,
  capabilities: ChatManagementCapabilities,
): readonly ChatManagementAction[] {
  const actions: ChatManagementAction[] = [];
  if (capabilities.canManage && room.type === "private") actions.push("rename");
  if (capabilities.canManage) actions.push(capabilities.isArchived ? "unarchive" : "archive");

  const viewerIsMember = capabilities.viewerActorId !== null &&
    (room.roster?.some((member) => member.actorId === capabilities.viewerActorId) ?? false);
  // Child thread membership is inherited from the parent and must not be
  // independently left. Non-conversation containers never reach this list.
  if (capabilities.canLeave && viewerIsMember && room.kind !== "subthread" && room.kind !== "task" && room.kind !== "access") {
    actions.push("leave");
  }
  return actions;
}

export function validateChatLabel(
  value: string,
): { ok: true; label: string } | { ok: false; error: string } {
  const label = value.trim();
  if (!label) return { ok: false, error: "Enter a chat name." };
  if (label.length > CHAT_LABEL_MAX_LENGTH) {
    return { ok: false, error: "Chat names must be at most 80 characters." };
  }
  return { ok: true, label };
}
