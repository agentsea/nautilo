/**
 * D079 Phase 4 / G3 commit 7 — `file` command "str_replace" handler.
 * D087 Phase 1 §1.3 — routes through the staged-patch store instead of
 * writing directly.
 *
 * THREE disambiguator modes (per decision record Prior-art
 * validation rounds 1+2):
 *
 *   Mode A — classic find/replace (OpenCode / Anthropic pattern)
 *     args: { oldString, newString, replaceAll?, lineRange? }
 *     Replace the first occurrence of oldString (or all with
 *     replaceAll). oldString must be unique within the scope
 *     (globally, or within lineRange if provided).
 *
 *   Mode B — range-replace (no find, no oldString)
 *     args: { lineRange, newString }
 *     Replace ALL content in lines from..to with newString.
 *     No uniqueness check; the range IS the target.
 *
 *   Mode C — bookend find (Papyrus pattern)
 *     args: { startFragment, endFragment, newString, lineRange? }
 *     Find everything between startFragment and endFragment
 *     (inclusive of both) and replace with newString. The agent
 *     never has to emit the middle — tokens-and-reliability win
 *     for large-span rewrites.
 *
 * Mode-validation layer: exactly one disambiguator. Zero → clear
 * error ("specify oldString / lineRange / startFragment+endFragment").
 * Multiple → clear error naming the conflict.
 *
 * Normalization: smart-quote / em-dash normalization applies to the
 * SEARCH side only (so the LLM's smart-quote drift doesn't defeat a
 * literal-straight-quote oldString). `newString` is written byte-exact.
 *
 * As of D087 Phase 1, each mode computes the proposed updated string
 * and routes through `stageContentPatch`. The disk file is NOT
 * touched until the user Accepts via the DiffView.
 */

import { applyContentPatch, encodeAppliedResult, type CommandHandler } from "./_shared";
import { findFragmentRange, findOldStringMatches } from "../matching";
import type { AnchoredEdit } from "../staged-patches";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";

type ProposeResult = { ok: true; updated: string; summary: string } | { ok: false; error: string };

export const handleStrReplace: CommandHandler<"str_replace"> = async (args, resolution, ctx) => {
  const { newString, oldString, startFragment, endFragment, replaceAll, lineRange } = args;
  const backend = getFileBackend(ctx);

  // Required-field guard — flat wire schema leaves `newString` optional.
  if (typeof newString !== "string") {
    return fileToolError("Error: str_replace requires 'newString' (string)");
  }

  // --- Mode-validation layer ---
  const hasOldString = typeof oldString === "string" && oldString.length > 0;
  const hasBookend = typeof startFragment === "string" && typeof endFragment === "string";
  const hasOnlyLineRange = lineRange != null && !hasOldString && !hasBookend;
  const hasPartialBookend =
    (typeof startFragment === "string") !== (typeof endFragment === "string");

  if (replaceAll === true && !hasOldString) {
    return fileToolError("Error: replaceAll requires a non-empty oldString");
  }

  if (hasPartialBookend) {
    return fileToolError("Error: Bookend mode requires BOTH startFragment and endFragment (you provided only one)");
  }
  const modes = [hasOldString, hasOnlyLineRange, hasBookend].filter(Boolean).length;
  if (modes === 0) {
    return fileToolError("Error: No disambiguator provided. Specify oldString, lineRange alone, or startFragment+endFragment.");
  }
  if (modes > 1) {
    return fileToolError("Error: Ambiguous — multiple disambiguators provided (pick exactly one of oldString / lineRange-alone / startFragment+endFragment)");
  }

  // --- Read file ---
  let original: string;
  try {
    original = (await backend.readFile(resolution.resolved)).toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return fileToolError(`Error: file not found: ${resolution.resolved}. Use 'write' to create it.`);
    }
    if (msg.includes("EISDIR")) {
      return fileToolError(`Error: ${resolution.resolved} is a directory`);
    }
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied: ${resolution.resolved}`);
    }
    return fileToolError(`Error reading file: ${msg}`);
  }

  // --- Compute scope window from lineRange ---
  let windowStart = 0;
  let windowEnd = original.length;
  if (lineRange) {
    const lines = original.split("\n");
    if (lineRange.from < 1 || lineRange.from > lines.length) {
      return fileToolError(`Error: lineRange.from ${lineRange.from} is outside file bounds (file has ${lines.length} lines)`);
    }
    if (lineRange.to < lineRange.from) {
      return fileToolError(`Error: lineRange.to (${lineRange.to}) must be >= lineRange.from (${lineRange.from})`);
    }
    if (lineRange.to > lines.length) {
      return fileToolError(`Error: lineRange.to ${lineRange.to} is outside file bounds (file has ${lines.length} lines)`);
    }

    windowStart = 0;
    for (let i = 0; i < lineRange.from - 1; i++) {
      windowStart += (lines[i] ?? "").length + 1;
    }
    windowEnd = windowStart;
    for (let i = lineRange.from - 1; i < lineRange.to; i++) {
      windowEnd += (lines[i] ?? "").length + 1;
    }
    windowEnd = Math.min(windowEnd, original.length);
  }

  // --- Dispatch on mode to compute proposed bytes ---
  let proposal: ProposeResult;
  if (hasOldString) {
    proposal = proposeClassicReplace(
      original,
      oldString,
      newString,
      replaceAll === true,
      windowStart,
      windowEnd,
      lineRange != null,
    );
  } else if (hasBookend) {
    proposal = proposeBookendReplace(
      original,
      startFragment,
      endFragment,
      newString,
      windowStart,
      windowEnd,
    );
  } else {
    proposal = proposeRangeReplace(original, windowStart, windowEnd, newString);
  }

  if (!proposal.ok) return fileToolError(`Error: ${proposal.error}`);

  // --- Stage the patch ---
  try {
    const scope = lineRange ? { from: lineRange.from, to: lineRange.to } : undefined;
    const explicitAnchoredEdit: AnchoredEdit | undefined =
      hasOldString && replaceAll === true
        ? {
            oldString,
            newString,
            replaceAll: true,
            ...(scope ? { scope } : {}),
          }
        : undefined;
    const envelope = await applyContentPatch({
      resolution,
      ctx,
      command: "str_replace",
      commandArgs: {
        path: args.path,
        zone: args.zone,
        ...(oldString !== undefined ? { oldString } : {}),
        ...(startFragment !== undefined ? { startFragment } : {}),
        ...(endFragment !== undefined ? { endFragment } : {}),
        ...(replaceAll !== undefined ? { replaceAll } : {}),
        ...(lineRange !== undefined ? { lineRange } : {}),
      },
      newBytes: Buffer.from(proposal.updated, "utf-8"),
      summary: proposal.summary,
      ...(explicitAnchoredEdit
        ? { anchoredEdit: explicitAnchoredEdit }
        : { deriveAnchoredEdit: true, ...(scope ? { anchoredScope: scope } : {}) }),
    });
    if ("errorText" in envelope) return fileToolError(envelope.errorText);
    return encodeAppliedResult(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fileToolError(`Error applying str_replace: ${msg}`);
  }
};

function proposeClassicReplace(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  windowStart: number,
  windowEnd: number,
  scoped: boolean,
): ProposeResult {
  const { count, firstOffset } = findOldStringMatches(original, oldString, windowStart, windowEnd);

  if (count === 0) {
    return { ok: false, error: `oldString not found${scoped ? " within lineRange" : ""}` };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `oldString not unique within scope (found ${count} matches). ` +
        `Widen the context, narrow the lineRange, or set replaceAll=true.`,
    };
  }

  let updated: string;
  if (replaceAll && count > 1) {
    const windowContent = original.slice(windowStart, windowEnd);
    const replaced = windowContent.split(oldString).join(newString);
    updated = original.slice(0, windowStart) + replaced + original.slice(windowEnd);
  } else {
    const offset = firstOffset!;
    updated =
      original.slice(0, offset) + newString + original.slice(offset + oldString.length);
  }

  const occurrences = replaceAll ? count : 1;
  return {
    ok: true,
    updated,
    summary: `Applied str_replace ${occurrences} occurrence(s) — revertable.`,
  };
}

function proposeBookendReplace(
  original: string,
  startFragment: string,
  endFragment: string,
  newString: string,
  windowStart: number,
  windowEnd: number,
): ProposeResult {
  const result = findFragmentRange({
    haystack: original,
    startFragment,
    endFragment,
    startFrom: windowStart,
    normalize: "safe",
    requireUnique: true,
  });

  if (!result.ok) {
    return { ok: false, error: result.reason };
  }
  if (result.endIndex > windowEnd) {
    return {
      ok: false,
      error: `bookend match extends past the specified lineRange. Widen the lineRange or narrow the fragments.`,
    };
  }

  const updated =
    original.slice(0, result.startIndex) + newString + original.slice(result.endIndex);
  const replacedBytes = result.endIndex - result.startIndex;
  return {
    ok: true,
    updated,
    summary: `Applied str_replace bookend mode (replaced ${replacedBytes} bytes between fragments) — revertable.`,
  };
}

function proposeRangeReplace(
  original: string,
  windowStart: number,
  windowEnd: number,
  newString: string,
): ProposeResult {
  const updated = original.slice(0, windowStart) + newString + original.slice(windowEnd);
  const replacedBytes = windowEnd - windowStart;
  return {
    ok: true,
    updated,
    summary: `Applied str_replace lineRange (replaced ${replacedBytes} bytes) — revertable.`,
  };
}
