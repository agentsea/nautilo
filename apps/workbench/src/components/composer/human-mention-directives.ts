import type { Unstable_DirectiveSegment } from "@assistant-ui/core";
import { HANDLE_RE, type RoomMemberDto } from "@nautilo/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_MENTION_DIRECTIVE_RE =
  /@\[human:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,512})\]/gi;
const MAX_HANDLE_LENGTH = 160;
const PLAINTEXT_HUMAN_MENTION_CANDIDATE_RE =
  /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]+)(?![A-Za-z0-9_@-]|\.[A-Za-z0-9])/g;
const MARKDOWN_CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function validHandle(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_HANDLE_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function serializeHumanMentionDirective(
  userId: string,
  handle: string,
): string {
  if (!UUID_RE.test(userId) || !validHandle(handle)) {
    throw new Error("Invalid Human mention directive");
  }
  return `@[human:${userId}:${encodeBase64Url(handle)}]`;
}

export function parseHumanMentionDirective(
  raw: string,
): { userId: string; handle: string } | null {
  const match =
    /^@\[human:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,512})\]$/i.exec(raw);
  if (!match || !UUID_RE.test(match[1])) return null;
  const handle = decodeBase64Url(match[2]);
  return handle && validHandle(handle)
    ? { userId: match[1], handle }
    : null;
}

export function parseHumanMentionDirectiveSegments(
  text: string,
): Unstable_DirectiveSegment[] | null {
  const segments: Unstable_DirectiveSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(HUMAN_MENTION_DIRECTIVE_RE)) {
    const raw = match[0];
    const parsed = parseHumanMentionDirective(raw);
    if (!parsed) continue;
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    segments.push({
      kind: "mention",
      id: parsed.userId,
      label: parsed.handle,
      type: "user",
    });
    cursor = start + raw.length;
  }
  if (segments.length === 0) return null;
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Remove draft-only Human mention machinery from text that is leaving the
 * composer. Clipboard text must never expose the stable Human id embedded in
 * a picker directive.
 */
export function humanMentionDirectivesToPlainText(text: string): string {
  return text.replace(HUMAN_MENTION_DIRECTIVE_RE, (raw) => {
    const parsed = parseHumanMentionDirective(raw);
    return parsed ? `@${parsed.handle}` : raw;
  });
}

function maskMatches(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

function uniqueHumanIdsByHandle(
  members: readonly RoomMemberDto[],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const member of members) {
    if (
      member.kind !== "user" ||
      !member.userId ||
      !member.handle ||
      !HANDLE_RE.test(member.handle)
    ) {
      continue;
    }
    const ids = candidates.get(member.handle) ?? new Set<string>();
    ids.add(member.userId);
    candidates.set(member.handle, ids);
  }

  const unique = new Map<string, string>();
  for (const [handle, ids] of candidates) {
    if (ids.size === 1) unique.set(handle, [...ids][0]);
  }
  return unique;
}

/**
 * Project a draft into room-visible plaintext and a stable, unique recipient
 * list. Picker directives retain their authored Human id. Exact plaintext
 * `@handle` tokens resolve prospectively against the current Room's unique
 * Human roster; persisted messages are never reparsed.
 */
export function projectHumanMentionDirectives(
  text: string,
  members: readonly RoomMemberDto[] = [],
): {
  text: string;
  mentionedHumanUserIds: string[];
} {
  const ids = new Set<string>();
  for (const match of text.matchAll(HUMAN_MENTION_DIRECTIVE_RE)) {
    const parsed = parseHumanMentionDirective(match[0]);
    if (parsed) ids.add(parsed.userId);
  }
  const projected = humanMentionDirectivesToPlainText(text);

  const rosterIdsByHandle = uniqueHumanIdsByHandle(members);
  const plaintextOnly = maskMatches(
    maskMatches(text, HUMAN_MENTION_DIRECTIVE_RE),
    MARKDOWN_CODE_RE,
  );
  for (const match of plaintextOnly.matchAll(
    PLAINTEXT_HUMAN_MENTION_CANDIDATE_RE,
  )) {
    const handle = match[2];
    if (!HANDLE_RE.test(handle)) continue;
    const userId = rosterIdsByHandle.get(handle);
    if (userId) ids.add(userId);
  }

  return { text: projected, mentionedHumanUserIds: [...ids] };
}
