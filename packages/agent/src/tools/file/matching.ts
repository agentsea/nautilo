/**
 * D079 Phase 4 / G3 commit 7 — string-matching helpers for the
 * `file` tool's str_replace command (+ future block commands).
 *
 * Port of the useful parts of Papyrus's
 * `agents/overlord/src/utils/snippet-finder.ts` (bookend-fragment
 * range finder + normalization cascade) with Nautilo-appropriate
 * scope: byte-level search against text files, NOT HTML trees.
 *
 * Two normalization modes:
 *   - "safe" (byte-level / source code): smart-quote / em-dash /
 *     ellipsis normalization only. Applied to SEARCH only; writes
 *     pass through byte-exact. Safe for source code because
 *     indentation (whitespace) is preserved exactly.
 *   - "full" (block-level, D081 when it lands): adds whitespace-
 *     collapse + list-marker strip + plain-text-strip with
 *     position remap. Consumed by D081's block commands when the
 *     adapter has parsed markdown/HTML/XML into source fragments.
 *
 * This commit ships only "safe" mode since byte-level str_replace
 * is the immediate consumer. "full" mode lands with D081; the
 * enum value is reserved so the matching.ts public surface stays
 * stable.
 *
 * Decision record anchor:
 *   pr-reviews/DECISION-2026-04-21-file-tool-shape.md §Prior-art
 *   validation round 2 (Papyrus bookend pattern).
 */

export type NormalizeMode = "safe" | "full";

export interface FindFragmentRangeOptions {
  haystack: string;
  startFragment: string;
  endFragment: string;
  /** Where to begin the startFragment search (default 0). */
  startFrom?: number;
  normalize: NormalizeMode;
  /** If true, reject when multiple non-overlapping fragment pairs
   *  exist (uniqueness contract matching oldString's). Default true. */
  requireUnique?: boolean;
}

export type FindFragmentRangeResult =
  | {
      ok: true;
      /** Byte offset of first char of startFragment match. */
      startIndex: number;
      /** Byte offset of first char AFTER endFragment match. */
      endIndex: number;
    }
  | {
      ok: false;
      reason: string;
      errorKind:
        | "start_not_found"
        | "end_not_found_after_start"
        | "multiple_matches";
    };

/**
 * Find the byte range covered by a bookend fragment pair.
 *
 * 1. Normalize haystack + fragments per `normalize`.
 * 2. Find first occurrence of startFragment in haystack (case-insensitive + normalized).
 * 3. Find first occurrence of endFragment AT-OR-AFTER the start match.
 * 4. If `requireUnique`, check there's no second non-overlapping
 *    pair — reject with match count if there is.
 * 5. Map the normalized-text positions back to haystack byte
 *    offsets. (Since "safe" normalization is 1:1 on length — each
 *    normalization swap is single-char-for-single-char — the byte
 *    offsets are already valid. This changes for "full" mode
 *    where whitespace-collapse breaks the 1:1 invariant; "full"
 *    lands with D081 which will add a position-remap.)
 */
export function findFragmentRange(
  opts: FindFragmentRangeOptions,
): FindFragmentRangeResult {
  const {
    haystack,
    startFragment,
    endFragment,
    startFrom = 0,
    normalize,
    requireUnique = true,
  } = opts;

  if (!startFragment || !endFragment) {
    return {
      ok: false,
      reason: "Bookend mode requires both startFragment and endFragment",
      errorKind: "start_not_found",
    };
  }

  const nH = normalizeForMatch(haystack, normalize);
  const nStart = normalizeForMatch(startFragment, normalize);
  const nEnd = normalizeForMatch(endFragment, normalize);

  const nHLower = nH.toLowerCase();
  const nStartLower = nStart.toLowerCase();
  const nEndLower = nEnd.toLowerCase();

  const startIdx = nHLower.indexOf(nStartLower, startFrom);
  if (startIdx === -1) {
    return {
      ok: false,
      reason: `Could not find startFragment "${startFragment.slice(0, 60)}${
        startFragment.length > 60 ? "…" : ""
      }"`,
      errorKind: "start_not_found",
    };
  }

  // End must come at-or-after the start match (the start+end
  // positions cannot overlap the same characters, so end searches
  // from `startIdx + startFragment.length` — end CAN equal the end
  // of start in zero-length pathologies, but that's a caller bug).
  const endSearchFrom = startIdx + nStart.length;
  const endIdx = nHLower.indexOf(nEndLower, endSearchFrom);
  if (endIdx === -1) {
    // Diagnose: did end appear BEFORE start? That's a different
    // error surface than "not found at all" — helpful for LLM
    // retries.
    const endBefore = nHLower.lastIndexOf(nEndLower, startIdx);
    if (endBefore !== -1) {
      return {
        ok: false,
        reason:
          `endFragment "${endFragment.slice(0, 40)}" was found BEFORE startFragment ` +
          `(at offset ${endBefore}); bookend order is reversed. Swap the fragments.`,
        errorKind: "end_not_found_after_start",
      };
    }
    return {
      ok: false,
      reason: `Could not find endFragment "${endFragment.slice(0, 60)}${
        endFragment.length > 60 ? "…" : ""
      }" after startFragment match at offset ${startIdx}`,
      errorKind: "end_not_found_after_start",
    };
  }

  if (requireUnique) {
    // Check for a second non-overlapping pair after the first range.
    const secondStartIdx = nHLower.indexOf(
      nStartLower,
      endIdx + nEnd.length,
    );
    if (secondStartIdx !== -1) {
      // There's another candidate startFragment match after this
      // range. We don't search for its paired end — the existence
      // of a second start is enough to reject for uniqueness.
      // Tests for this: the caller should narrow the fragments or
      // pass `requireUnique: false` for intentional batch ops.
      return {
        ok: false,
        reason:
          `startFragment matches more than once — ambiguous pair. ` +
          `Narrow with more unique text or scope with lineRange.`,
        errorKind: "multiple_matches",
      };
    }
  }

  return {
    ok: true,
    startIndex: startIdx,
    endIndex: endIdx + nEnd.length,
  };
}

/**
 * Normalize a string for matching. Preserves length (1:1 char
 * substitution) in "safe" mode so resolved offsets in the
 * normalized string map back to the same positions in the
 * original haystack — critical for str_replace, which needs to
 * splice the ORIGINAL bytes.
 *
 * Swaps in "safe" mode (all are single-codepoint-for-single-
 * codepoint; length preserved):
 *   - Left/right single smart quotes → '
 *   - Left/right double smart quotes → "
 *   - En dash / em dash → -
 *   - Ellipsis char (U+2026) → kept as-is (length would change if
 *     we expanded to `...`; not worth the position-remap for one
 *     char). Agent can include either form verbatim.
 *
 * "full" mode additions (length-breaking; requires position remap
 * in the caller — not used by byte-level str_replace today):
 *   - Whitespace collapse
 *   - List-marker strip
 *   - HTML tag strip
 *   (Reserved for D081 block commands.)
 */
function normalizeForMatch(s: string, mode: NormalizeMode): string {
  let out = s;
  // Smart quotes: U+2018/2019 → ', U+201A/201B also → '
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  // Double smart quotes: U+201C/201D/201E/201F → "
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  // En / em dash: U+2013 / U+2014 → -
  out = out.replace(/[\u2013\u2014]/g, "-");

  if (mode === "full") {
    // D081 block commands will fill these in when they land. Today
    // they're no-ops so the helper's signature stays stable. When
    // D081 wires in, the caller will also need a position-remap
    // layer because these transformations break the 1:1 length
    // invariant that "safe" mode preserves.
    // - Collapse runs of whitespace to single space
    // - Strip leading list markers ("1.", "a)", "•")
    // - Strip HTML tags
  }

  return out;
}

/**
 * Utility: check if a path-independent `oldString` is unique in a
 * haystack (within an optional line-range window). Returns match
 * count + the first match's byte offset if count is 1, otherwise
 * returns the count alone (caller decides: 0 → not found, >1 →
 * require replaceAll or narrower context).
 *
 * Applied to the classic str_replace Mode A. Normalization is
 * "safe" only (byte-level), and the match is substring-based (not
 * regex) so special chars in `oldString` don't need escaping.
 */
export function findOldStringMatches(
  haystack: string,
  oldString: string,
  windowStart: number,
  windowEnd: number,
): { count: number; firstOffset: number | null } {
  const nH = normalizeForMatch(haystack, "safe");
  const nOld = normalizeForMatch(oldString, "safe");
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
