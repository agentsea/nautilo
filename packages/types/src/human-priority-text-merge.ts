/**
 * Human-priority, browser-safe text rebasing for collaborative document edits.
 *
 * Given the base text B, an unsaved human draft H, and an agent postimage A,
 * this returns H rebased onto A when the changes do not conflict. A conflict
 * deliberately has no synthesized text or conflict markers: callers keep the
 * human draft and require the agent to reread/reapply instead of overwriting it.
 */

import { diff3Merge } from "node-diff3";

import {
  deriveExactAnchoredTextPatch,
} from "./document-patch-helpers";

export type HumanPriorityTextMergeInput = {
  /** Base text observed by both the human and the agent (B). */
  base: string;
  /** Unsaved human draft to preserve (H). */
  humanDraft: string;
  /** Agent-produced authoritative postimage to rebase the human draft onto (A). */
  agentPostimage: string;
};

export type HumanPriorityTextMergeResult =
  | {
      ok: true;
      /** The human draft rebased onto the agent postimage. */
      text: string;
      strategy: "identical" | "human_unchanged" | "agent_unchanged" | "anchored" | "diff3";
    }
  | {
      ok: false;
      /** No text is returned, preventing conflict markers or agent overwrite. */
      reason: "conflict";
    };

/**
 * Rebases an unsaved human draft onto an agent postimage.
 *
 * Fast paths avoid any diff work. For ordinary single-region drafts we reuse
 * the established anchored patch machinery first; line-preserving diff3 is the
 * general fallback for multi-hunk drafts. Identical edits are accepted by
 * diff3 rather than treated as conflicts.
 */
export function mergeTextHumanPriority({
  base,
  humanDraft,
  agentPostimage,
}: HumanPriorityTextMergeInput): HumanPriorityTextMergeResult {
  if (humanDraft === agentPostimage) {
    return { ok: true, text: humanDraft, strategy: "identical" };
  }

  if (humanDraft === base) {
    return { ok: true, text: agentPostimage, strategy: "human_unchanged" };
  }

  if (agentPostimage === base) {
    return { ok: true, text: humanDraft, strategy: "agent_unchanged" };
  }

  const anchoredPatch = deriveExactAnchoredTextPatch(base, humanDraft);
  if (anchoredPatch) {
    const anchoredText = applyExactAnchoredPatch(agentPostimage, anchoredPatch);
    if (anchoredText !== null) {
      return { ok: true, text: anchoredText, strategy: "anchored" };
    }
  }

  const regions = diff3Merge(
    splitLinesPreservingTerminators(humanDraft),
    splitLinesPreservingTerminators(base),
    splitLinesPreservingTerminators(agentPostimage),
    { excludeFalseConflicts: true },
  );

  if (regions.some((region) => "conflict" in region)) {
    return { ok: false, reason: "conflict" };
  }

  return {
    ok: true,
    text: regions.flatMap((region) => region.ok).join(""),
    strategy: "diff3",
  };
}

/**
 * Merge admission must preserve authoritative bytes. The ordinary anchored
 * patch helper intentionally tolerates smart quotes/dashes for human-facing
 * patch application, but that tolerance must never make B/H/A look
 * non-overlapping. The fast path therefore accepts exactly one literal anchor
 * occurrence and otherwise delegates to exact line diff3 below.
 */
function applyExactAnchoredPatch(
  currentText: string,
  patch: ReturnType<typeof deriveExactAnchoredTextPatch>,
): string | null {
  if (patch === null || patch.scope !== undefined || patch.replaceAll === true) return null;
  if (patch.oldString.length === 0) return null;
  const offset = currentText.indexOf(patch.oldString);
  if (offset < 0 || currentText.indexOf(patch.oldString, offset + patch.oldString.length) >= 0) {
    return null;
  }
  return currentText.slice(0, offset) +
    patch.newString +
    currentText.slice(offset + patch.oldString.length);
}

/**
 * Treat every physical line, including its LF/CRLF terminator, as one diff3
 * element. This preserves exact newline shape, including a missing final LF.
 */
function splitLinesPreservingTerminators(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
