import { HANDLE_RE, type RoomMemberDto } from "@nautilo/types";

import type { ComposerMentionCandidate } from "@/components/composer";

const HUMAN_MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{2,29})(?![A-Za-z0-9_@-]|\.[A-Za-z0-9])/g;
const MARKDOWN_CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g;

/**
 * The Room roster is the only source for mobile @ suggestions. Do not derive
 * handles from display names: the server uses canonical handles for both the
 * agent responder gate and structured Human notification recipients.
 */
export function mobileMentionCandidates(
  members: readonly RoomMemberDto[],
  viewerActorId: string | null,
): ComposerMentionCandidate[] {
  return members
    .filter((member) => {
      const handle = member.handle?.trim().toLowerCase();
      return member.actorId !== viewerActorId && Boolean(handle && HANDLE_RE.test(handle));
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
): { content: string; mentionedHumanUserIds: string[] } {
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
    if (!handle) continue;
    const ids = humanIdsByHandle.get(handle);
    if (ids?.size === 1) mentionedHumanUserIds.add([...ids][0]);
  }
  return { content: text, mentionedHumanUserIds: [...mentionedHumanUserIds] };
}
