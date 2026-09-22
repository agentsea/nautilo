import { HANDLE_RE, type RoomMemberDto } from "@nautilo/types";

import type { ComposerMentionCandidate } from "@/components/composer";

const HUMAN_MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{2,29})(?![A-Za-z0-9_@-]|\.[A-Za-z0-9])/g;
const EVERYONE_MENTION_RE = /(^|[^A-Za-z0-9_@])@everyone(?![A-Za-z0-9_@-]|\.[A-Za-z0-9])/;
const MARKDOWN_CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g;

/**
 * The Room roster is the only source for mobile member @ suggestions. Do not
 * derive handles from display names: the server uses canonical handles for
 * both the agent responder gate and structured Human notification recipients.
 * `everyone` is reserved for the room audience, so Humans and Genies with that
 * handle are omitted instead of presenting a choice that cannot be represented
 * distinctly in Mobile's plaintext composer.
 */
export function mobileMentionCandidates(
  members: readonly RoomMemberDto[],
  viewerActorId: string | null,
): ComposerMentionCandidate[] {
  const people = members
    .filter((member) => {
      const handle = member.handle?.trim().toLowerCase();
      return member.actorId !== viewerActorId
        && handle !== "everyone"
        && Boolean(handle && HANDLE_RE.test(handle));
    })
    .map((member) => ({
      actorId: member.actorId,
      kind: member.kind,
      displayName: member.displayName,
      handle: member.handle!.trim().toLowerCase(),
    }))
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.handle.localeCompare(right.handle),
    );
  return [{
    actorId: "room-audience-everyone",
    kind: "audience",
    displayName: "@everyone — Notify everyone in this room",
    handle: "everyone",
  }, ...people];
}

function withoutCode(text: string): string {
  return text.replace(MARKDOWN_CODE_RE, (match) => " ".repeat(match.length));
}

/**
 * Mirrors desktop's ordinary-text fallback: exact @handle tokens are resolved
 * against the current Room's unique Human roster at send time. Persisted text
 * remains readable; the parallel id list carries notification intent.
 */
export function projectMobileHumanMentions(
  text: string,
  members: readonly RoomMemberDto[],
): { content: string; mentionedHumanUserIds: string[]; mentionEveryone?: boolean } {
  const humanIdsByHandle = new Map<string, Set<string>>();
  for (const member of members) {
    const handle = member.handle?.trim().toLowerCase();
    if (member.kind !== "user" || !member.userId || !handle || !HANDLE_RE.test(handle)) continue;
    const ids = humanIdsByHandle.get(handle) ?? new Set<string>();
    ids.add(member.userId);
    humanIdsByHandle.set(handle, ids);
  }

  const mentionedHumanUserIds = new Set<string>();
  for (const match of withoutCode(text).matchAll(HUMAN_MENTION_RE)) {
    const handle = match[2]?.toLowerCase();
    if (!handle || handle === "everyone") continue;
    const ids = humanIdsByHandle.get(handle);
    if (ids?.size === 1) mentionedHumanUserIds.add([...ids][0]);
  }
  const visibleText = withoutCode(text);
  return {
    content: text,
    mentionedHumanUserIds: [...mentionedHumanUserIds],
    ...(EVERYONE_MENTION_RE.test(visibleText) ? { mentionEveryone: true } : {}),
  };
}
