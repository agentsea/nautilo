/**
 * M206 — string-matching helpers for local `str_replace` (bookend + classic).
 * Mirrors packages/agent/src/tools/file/matching.ts without importing server code.
 */

export type NormalizeMode = "safe" | "full";

export interface FindFragmentRangeOptions {
  haystack: string;
  startFragment: string;
  endFragment: string;
  /** Where to begin the startFragment search (default 0). */
  startFrom?: number;
  normalize: NormalizeMode;
  /** If true, reject when multiple non-overlapping fragment pairs exist. */
  requireUnique?: boolean;
}

export type FindFragmentRangeResult =
  | {
      ok: true;
      startIndex: number;
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

  const endSearchFrom = startIdx + nStart.length;
  const endIdx = nHLower.indexOf(nEndLower, endSearchFrom);
  if (endIdx === -1) {
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
    const secondStartIdx = nHLower.indexOf(
      nStartLower,
      endIdx + nEnd.length,
    );
    if (secondStartIdx !== -1) {
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

function normalizeForMatch(s: string, mode: NormalizeMode): string {
  let out = s;
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  out = out.replace(/[\u2013\u2014]/g, "-");

  if (mode === "full") {
    // Reserved for future block-level matching.
  }

  return out;
}
