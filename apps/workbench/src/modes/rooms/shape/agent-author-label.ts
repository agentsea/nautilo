import type { AvatarRef, RoomMemberDto } from "@nautilo/types";
import { harnessPresentation } from "../subagents/harness-presentation";

/**
 * D352 — build the `userId → displayName` label map used for multi-author
 * (peer-human) message rendering. Extracted here so the center path
 * (`SlackShapeRoom` via `RoomAuthorScope`) and the reader-rail self-source
 * fallback build it identically — single source, no second split-brain.
 * Only humans need labels; agent messages render via the assistant branch.
 */
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
  avatarSrc: string;
}

export function resolveRoomAgentChromeLabel(args: {
  members: readonly RoomMemberDto[];
  focusedBotActorIds: readonly string[];
  fallbackName: string;
}): string {
  const agents = args.members.filter((m) => m.kind === "agent");
  if (agents.length === 0) return args.fallbackName;
  if (args.focusedBotActorIds.length === 1) {
    return (
      agents.find((m) => m.actorId === args.focusedBotActorIds[0])?.displayName ??
      args.fallbackName
    );
  }
  if (agents.length === 1) return agents[0]?.displayName ?? args.fallbackName;
  return "Agents";
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}' agent` : `${name}'s agent`;
}

function ownerCueFor(member: RoomMemberDto, viewerUserId: string | null): string | null {
  const ownerUserId = member.agentOwnerUserId ?? null;
  const ownerDisplayName = member.agentOwnerDisplayName?.trim() || "";
  const ownerHandle = member.agentOwnerHandle?.trim() || "";

  if (ownerUserId && viewerUserId && ownerUserId !== viewerUserId) {
    return ownerDisplayName ? possessive(ownerDisplayName) : ownerHandle ? `@${ownerHandle}` : null;
  }

  return ownerHandle ? `@${ownerHandle}` : ownerDisplayName ? possessive(ownerDisplayName) : null;
}

export function resolveAgentAuthorLabel(args: {
  authorAgentId: string | undefined;
  members: readonly RoomMemberDto[];
  viewerUserId: string | null;
  fallbackName: string;
  fallbackAvatarSrc: string;
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
      avatarSrc: args.fallbackAvatarSrc,
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
    avatarSrc: agentAvatarUrl({
      roomId: args.roomId,
      agentId: author.agentId,
      avatar: author.agentAvatar,
      fallbackAvatarSrc: args.fallbackAvatarSrc,
    }),
  };
}

/**
 * External harness results are authored by the harness, while the canonical
 * Room session still belongs to the delegating Nautilo agent. Preserve both
 * identities without manufacturing a durable Room member for a task-scoped
 * worker.
 */
export function resolveAssistantAuthorLabel(args: {
  authorAgentId: string | undefined;
  authorHarnessId: string | undefined;
  members: readonly RoomMemberDto[];
  viewerUserId: string | null;
  fallbackName: string;
  fallbackAvatarSrc: string;
  roomId?: string | null;
}): AgentAuthorLabel {
  const delegator = resolveAgentAuthorLabel(args);
  if (!args.authorHarnessId) return delegator;
  const presentation = harnessPresentation(args.authorHarnessId);
  return {
    name: presentation?.displayName ?? args.authorHarnessId,
    ownerCue: `via ${delegator.name}`,
    actorId: null,
    avatarSrc: "",
  };
}

function avatarVersion(avatar: AvatarRef | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.kind === "preset") return avatar.id;
  return avatar.blobId;
}

function agentAvatarUrl(args: {
  roomId: string | null | undefined;
  agentId: string | undefined;
  avatar: AvatarRef | null | undefined;
  fallbackAvatarSrc: string;
}): string {
  if (!args.roomId || !args.agentId) return args.fallbackAvatarSrc;
  const params = new URLSearchParams();
  const version = avatarVersion(args.avatar);
  if (version) params.set("v", version);
  const query = params.toString();
  return `/api/rooms/${encodeURIComponent(args.roomId)}/agents/${encodeURIComponent(args.agentId)}/avatar${query ? `?${query}` : ""}`;
}
