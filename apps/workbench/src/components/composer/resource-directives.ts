import type { Unstable_DirectiveSegment } from "@assistant-ui/core";

const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LABEL_LENGTH = 160;
const RESOURCE_DIRECTIVE_RE = /@\[resource:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,512})\]/g;
const SERIALIZED_DIRECTIVE_CANDIDATE_RE = /@\[[^\]\r\n]+\]/g;

export type ResourceDirective = { entryId: string; label: string };

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    // eslint-disable-next-line no-control-regex -- reject controls from directive labels
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/[\\/]/.test(value)
  );
}

export function serializeResourceDirective(entryId: string, label: string): string {
  if (!ENTRY_ID_RE.test(entryId) || !validLabel(label)) {
    throw new Error("Invalid resource directive");
  }
  return `@[resource:${entryId}:${encodeBase64Url(label)}]`;
}

export function parseResourceDirective(text: string): ResourceDirective | null {
  const match = /^@\[resource:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,512})\]$/.exec(text);
  if (!match || !ENTRY_ID_RE.test(match[1])) return null;
  const label = decodeBase64Url(match[2]);
  return label && validLabel(label) ? { entryId: match[1], label } : null;
}

/** Parses known resource directives before plain @mention parsing. */
export function parseResourceDirectiveSegments(
  text: string,
  isKnownEntry: (entryId: string) => boolean,
): Unstable_DirectiveSegment[] | null {
  const segments: Unstable_DirectiveSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(RESOURCE_DIRECTIVE_RE)) {
    const raw = match[0];
    const parsed = parseResourceDirective(raw);
    if (!parsed || !isKnownEntry(parsed.entryId)) continue;
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({
      kind: "mention",
      id: parsed.entryId,
      label: parsed.label,
      type: "resource",
    });
    cursor = start + raw.length;
  }
  if (segments.length === 0) return null;
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** Clean room-visible text; directives never reach the persisted message. */
export function projectResourceDirectives(text: string): string {
  return text.replace(RESOURCE_DIRECTIVE_RE, (raw) => parseResourceDirective(raw)?.label ?? raw);
}

/**
 * Converts an offset measured in Lexical's projected display text back to a
 * serialized composer offset. Valid directives are atomic chips: ordinary
 * text stays one-to-one, while a position inside a chip snaps to its nearest
 * serialized boundary so insertion can never split its opaque token.
 */
export function projectedOffsetToSerializedOffset(
  text: string,
  projectedOffset: number,
  projectDirective: (raw: string) => string | null = (raw) =>
    parseResourceDirective(raw)?.label ?? null,
): number {
  const target = Math.max(0, projectedOffset);
  let serializedCursor = 0;
  let projectedCursor = 0;

  for (const match of text.matchAll(SERIALIZED_DIRECTIVE_CANDIDATE_RE)) {
    const raw = match[0];
    const projected = projectDirective(raw);
    if (projected === null) continue;
    const start = match.index ?? 0;
    const plainLength = start - serializedCursor;
    if (target <= projectedCursor + plainLength) {
      return serializedCursor + Math.min(target - projectedCursor, plainLength);
    }
    projectedCursor += plainLength;

    const labelLength = projected.length;
    const chipEnd = projectedCursor + labelLength;
    if (target <= chipEnd) {
      const withinChip = target - projectedCursor;
      if (withinChip <= 0) return start;
      if (withinChip >= labelLength) return start + raw.length;
      return withinChip * 2 < labelLength ? start : start + raw.length;
    }

    serializedCursor = start + raw.length;
    projectedCursor = chipEnd;
  }

  return Math.min(text.length, serializedCursor + (target - projectedCursor));
}

/** Demotes directives whose store entry was explicitly removed to plain text. */
export function demoteUnknownResourceDirectives(
  text: string,
  isKnownEntry: (entryId: string) => boolean,
): string {
  return text.replace(RESOURCE_DIRECTIVE_RE, (raw) => {
    const parsed = parseResourceDirective(raw);
    return parsed && !isKnownEntry(parsed.entryId) ? parsed.label : raw;
  });
}

export function resourceEntryIdsInText(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(RESOURCE_DIRECTIVE_RE)) {
    const parsed = parseResourceDirective(match[0]);
    if (parsed) ids.add(parsed.entryId);
  }
  return ids;
}

export function insertResourceDirective(
  text: string,
  offset: number,
  directive: string,
): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const left = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const right = after.length > 0 && !/^\s/.test(after) ? " " : "";
  return `${before}${left}${directive}${right}${after}`;
}
