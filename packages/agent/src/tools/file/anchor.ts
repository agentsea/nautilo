import {
  applyAnchoredTextPatch as applyAnchoredTextPatchCore,
  deriveAnchoredTextPatch as deriveAnchoredTextPatchCore,
  findAnchorMatches as findAnchorMatchesCore,
} from "@nautilo/types";
import type { AnchoredTextPatch } from "@nautilo/types";
import type { AnchoredEdit } from "./staged-patches";

export type ApplyAnchoredSpliceResult =
  | { ok: true; text: string }
  | { ok: false; kind: "not_found" | "ambiguous" };

function editToPatch(edit: AnchoredEdit): AnchoredTextPatch {
  return {
    kind: "anchored_text",
    oldString: edit.oldString,
    newString: edit.newString,
    ...(edit.replaceAll !== undefined ? { replaceAll: edit.replaceAll } : {}),
    ...(edit.scope ? { scope: edit.scope } : {}),
  };
}

function patchToEdit(patch: AnchoredTextPatch): AnchoredEdit {
  return {
    oldString: patch.oldString,
    newString: patch.newString,
    ...(patch.replaceAll !== undefined ? { replaceAll: patch.replaceAll } : {}),
    ...(patch.scope ? { scope: patch.scope } : {}),
  };
}

export function deriveAnchoredEdit(
  original: string,
  updated: string,
  scope?: AnchoredEdit["scope"],
): AnchoredEdit | null {
  const patch = deriveAnchoredTextPatchCore(original, updated, scope);
  return patch ? patchToEdit(patch) : null;
}

export function applyAnchoredSplice(
  currentText: string,
  edit: AnchoredEdit,
): ApplyAnchoredSpliceResult {
  const result = applyAnchoredTextPatchCore(currentText, editToPatch(edit));
  if (result.ok) return result;
  return {
    ok: false,
    kind: result.reason === "anchor_ambiguous" ? "ambiguous" : "not_found",
  };
}

export function findAnchorMatches(
  haystack: string,
  oldString: string,
  windowStart: number,
  windowEnd: number,
): number[] {
  return findAnchorMatchesCore(haystack, oldString, windowStart, windowEnd);
}
