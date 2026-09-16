/**
 * ISSUE-M193 — browser-safe anchored text patch helpers.
 *
 * Pure string operations for derive/apply used by server routes, api-client
 * tests, workbench, and agent file tools (via thin wrappers in anchor.ts).
 */

import type { AnchoredTextPatch } from "./document-patches";

export type ApplyAnchoredTextPatchResult =
  | { ok: true; text: string }
  | { ok: false; reason: "anchor_not_found" | "anchor_ambiguous" };

/** SHA-256 hex digest for UTF-8 text using Web Crypto (browser + modern Node). */
export async function sha256HexForText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle.digest is unavailable");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function deriveAnchoredTextPatch(
  original: string,
  updated: string,
  scope?: AnchoredTextPatch["scope"],
): AnchoredTextPatch | null {
  if (original.length === 0) return null;

  const prefix = commonPrefixLength(original, updated);
  const suffix = commonSuffixLength(original, updated, prefix);

  let originalStart = snapToLineStart(original, prefix);
  let updatedStart = snapToLineStart(updated, prefix);
  let originalEnd = snapToNextLineStart(original, original.length - suffix);
  let updatedEnd = snapToNextLineStart(updated, updated.length - suffix);

  while (true) {
    const oldString = original.slice(originalStart, originalEnd);
    const matchCount =
      oldString.length === 0
        ? 0
        : findOldStringMatches(original, oldString, 0, original.length).count;

    if (matchCount === 1 || (originalStart === 0 && originalEnd === original.length)) {
      return {
        kind: "anchored_text",
        oldString,
        newString: updated.slice(updatedStart, updatedEnd),
        ...(scope ? { scope } : {}),
      };
    }

    const nextOriginalStart = previousLineStart(original, originalStart);
    const nextUpdatedStart = previousLineStart(updated, updatedStart);
    const nextOriginalEnd = nextLineStart(original, originalEnd);
    const nextUpdatedEnd = nextLineStart(updated, updatedEnd);

    if (
      nextOriginalStart === originalStart &&
      nextUpdatedStart === updatedStart &&
      nextOriginalEnd === originalEnd &&
      nextUpdatedEnd === updatedEnd
    ) {
      return {
        kind: "anchored_text",
        oldString,
        newString: updated.slice(updatedStart, updatedEnd),
        ...(scope ? { scope } : {}),
      };
    }

    originalStart = nextOriginalStart;
    updatedStart = nextUpdatedStart;
    originalEnd = nextOriginalEnd;
    updatedEnd = nextUpdatedEnd;
  }
}

/**
 * Derive an anchored patch that exactly reconstructs `updated` from `original`.
 *
 * The normal line-snapped candidate is kept when it is exact. When that
 * candidate would omit an editor normalization elsewhere in the document, use
 * a whole-document optimistic patch instead. That fallback fails when the
 * original document content changed, rather than clobbering a concurrent edit.
 */
export function deriveExactAnchoredTextPatch(
  original: string,
  updated: string,
): AnchoredTextPatch | null {
  const candidate = deriveAnchoredTextPatch(original, updated);
  if (!candidate) return null;

  const applied = applyAnchoredTextPatch(original, candidate);
  if (applied.ok && applied.text === updated) return candidate;

  return {
    kind: "anchored_text",
    oldString: original,
    newString: updated,
  };
}

export function applyAnchoredTextPatch(
  currentText: string,
  patch: AnchoredTextPatch,
): ApplyAnchoredTextPatchResult {
  const window = lineWindowOffsets(currentText, patch.scope);
  if (!window) return { ok: false, reason: "anchor_not_found" };

  const matches = findAnchorMatches(currentText, patch.oldString, window.start, window.end);

  if (patch.replaceAll === true) {
    if (matches.length < 1) return { ok: false, reason: "anchor_not_found" };
    return { ok: true, text: replaceMatches(currentText, matches, patch) };
  }

  if (matches.length === 0) return { ok: false, reason: "anchor_not_found" };
  if (matches.length > 1) return { ok: false, reason: "anchor_ambiguous" };

  const offset = matches[0]!;
  return {
    ok: true,
    text:
      currentText.slice(0, offset) +
      patch.newString +
      currentText.slice(offset + patch.oldString.length),
  };
}

export function findAnchorMatches(
  haystack: string,
  oldString: string,
  windowStart: number,
  windowEnd: number,
): number[] {
  if (oldString.length === 0) return [];
  const matches: number[] = [];
  let pos = windowStart;
  while (pos <= windowEnd) {
    const result = findOldStringMatches(haystack, oldString, pos, windowEnd);
    if (result.count === 0 || result.firstOffset === null) break;
    matches.push(result.firstOffset);
    pos = result.firstOffset + oldString.length;
  }
  return matches;
}

function findOldStringMatches(
  haystack: string,
  oldString: string,
  windowStart: number,
  windowEnd: number,
): { count: number; firstOffset: number | null } {
  const nH = normalizeForMatch(haystack);
  const nOld = normalizeForMatch(oldString);
  if (!nOld) return { count: 0, firstOffset: null };

  let count = 0;
  let firstOffset: number | null = null;
  let pos = windowStart;
  while (pos < windowEnd && pos < nH.length) {
    const found = nH.indexOf(nOld, pos);
    if (found === -1 || found + nOld.length > windowEnd) break;
    count += 1;
    if (firstOffset === null) firstOffset = found;
    pos = found + nOld.length;
  }
  return { count, firstOffset };
}

function normalizeForMatch(s: string): string {
  let out = s;
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  out = out.replace(/[\u2013\u2014]/g, "-");
  return out;
}

function replaceMatches(currentText: string, matches: number[], patch: AnchoredTextPatch): string {
  let text = currentText;
  for (let i = matches.length - 1; i >= 0; i--) {
    const offset = matches[i]!;
    text =
      text.slice(0, offset) + patch.newString + text.slice(offset + patch.oldString.length);
  }
  return text;
}

function lineWindowOffsets(
  text: string,
  scope: AnchoredTextPatch["scope"] | undefined,
): { start: number; end: number } | null {
  if (!scope) return { start: 0, end: text.length };
  const lines = text.split("\n");
  if (scope.from < 1 || scope.from > lines.length || scope.to < scope.from) {
    return null;
  }
  if (scope.to > lines.length) return null;

  let start = 0;
  for (let i = 0; i < scope.from - 1; i++) {
    start += (lines[i] ?? "").length + 1;
  }

  let end = start;
  for (let i = scope.from - 1; i < scope.to; i++) {
    end += (lines[i] ?? "").length + 1;
  }

  return { start, end: Math.min(end, text.length) };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const max = Math.min(a.length, b.length) - prefixLength;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function snapToLineStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const previousNewline = text.lastIndexOf("\n", index - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

function snapToNextLineStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  if (text[index - 1] === "\n") return index;
  const nextNewline = text.indexOf("\n", index);
  return nextNewline === -1 ? text.length : nextNewline + 1;
}

function previousLineStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const previousNewline = text.lastIndexOf("\n", index - 2);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

function nextLineStart(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const nextNewline = text.indexOf("\n", index);
  return nextNewline === -1 ? text.length : nextNewline + 1;
}
