import type { AvatarRef, RoomMemberDto } from "@nautilo/types";

/** D408 — `userId → displayName` for peer-human message labels. */
export function buildAuthorLabels(
  members: readonly RoomMemberDto[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of members) {
    if (m.kind === "user" && typeof m.userId === "string" && m.userId.length > 0) {
      map.set(m.userId, m.displayName);
    }
  }
  return map;
}

export interface AgentAuthorLabel {
  name: string;
  ownerCue: string | null;
  actorId: string | null;
  avatarPath: string;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}' agent` : `${name}'s agent`;
}

function ownerCueFor(member: RoomMemberDto, viewerUserId: string | null): string | null {
  const ownerUserId = member.agentOwnerUserId ?? null;
  const ownerDisplayName = member.agentOwnerDisplayName?.trim() || "";
  const ownerHandle = member.agentOwnerHandle?.trim() || "";

  if (ownerUserId && viewerUserId && ownerUserId !== viewerUserId) {
    return ownerDisplayName
      ? possessive(ownerDisplayName)
      : ownerHandle
        ? `@${ownerHandle}`
        : null;
  }

  return ownerHandle
    ? `@${ownerHandle}`
    : ownerDisplayName
      ? possessive(ownerDisplayName)
      : null;
}

export function resolveAgentAuthorLabel(args: {
  authorAgentId: string | undefined;
  members: readonly RoomMemberDto[];
  viewerUserId: string | null;
  fallbackName: string;
  roomId?: string | null;
}): AgentAuthorLabel {
  const author = args.members.find(
    (m) => m.kind === "agent" && m.agentId === args.authorAgentId,
  );
  if (!author) {
    return {
      name: args.fallbackName,
      ownerCue: null,
      actorId: null,
      avatarPath: "",
    };
  }

  const duplicateNameCount = args.members.filter(
    (m) => m.kind === "agent" && m.displayName === author.displayName,
  ).length;
  const ownerUserId = author.agentOwnerUserId ?? null;
  const showOwnerCue =
    duplicateNameCount > 1 ||
    Boolean(ownerUserId && args.viewerUserId && ownerUserId !== args.viewerUserId);

  return {
    name: author.displayName,
    ownerCue: showOwnerCue ? ownerCueFor(author, args.viewerUserId) : null,
    actorId: author.actorId,
    avatarPath: buildAgentAvatarPath({
      roomId: args.roomId,
      agentId: author.agentId,
      avatar: author.agentAvatar,
    }),
  };
}

function avatarVersion(avatar: AvatarRef | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.kind === "preset") return avatar.id;
  return avatar.blobId;
}

/** Relative API path for a room-scoped agent avatar byte route. */
export function buildAgentAvatarPath(args: {
  roomId: string | null | undefined;
  agentId: string | undefined;
  avatar?: AvatarRef | null | undefined;
}): string {
  if (!args.roomId || !args.agentId) return "";
  const params = new URLSearchParams();
  const version = avatarVersion(args.avatar);
  if (version) params.set("v", version);
  const query = params.toString();
  return `/api/rooms/${encodeURIComponent(args.roomId)}/agents/${encodeURIComponent(args.agentId)}/avatar${query ? `?${query}` : ""}`;
}

/** Relative API path for a peer-human avatar byte route. */
export function buildUserAvatarPath(userId: string): string {
  return `/api/users/${encodeURIComponent(userId)}/avatar`;
}

/** Group rooms show sender chrome; 1:1 stays avatar-free. */
export function isGroupRoom(members: readonly RoomMemberDto[]): boolean {
  if (members.length > 2) return true;
  const humans = members.filter((m) => m.kind === "user").length;
  const agents = members.filter((m) => m.kind === "agent").length;
  return humans > 1 || agents > 1;
}
