import { diffChars, diffWordsWithSpace } from "diff";
import type { BlockDiffAlgo } from "./content-type-sniffer";

export type BlockDiffSegment =
  | { kind: "equal"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string };

/**
 * Build word- or char-level diff segments between `before` and `after`.
 *
 * Adjacent dels and adjacent adds within a contiguous non-equal run
 * are merged into a single strike block followed by a single highlight
 * block. This is purely a render-readability optimization for
 * low-overlap prose rewrites: `diffWordsWithSpace` on "Old intro one"
 * vs "Punchy new intro" emits alternating segments — `Old/Punchy`,
 * `intro/new`, `one/intro` — which the eye has to mentally re-pair.
 * Grouping dels-then-adds renders as `[Old intro one][Punchy new intro]`
 * which reads cleanly without losing any information. For high-overlap
 * edits (typo fixes) the input already lacks alternating runs, so the
 * grouping is a no-op there. (D121-P5 orchestrator viz audit.)
 */
export function buildBlockDiffSegments(
  before: string,
  after: string,
  algo: BlockDiffAlgo,
): BlockDiffSegment[] {
  const parts =
    algo === "chars" ? diffChars(before, after) : diffWordsWithSpace(before, after);
  const raw: BlockDiffSegment[] = [];
  for (const p of parts) {
    if (!p.value) continue;
    if (p.added) raw.push({ kind: "add", text: p.value });
    else if (p.removed) raw.push({ kind: "del", text: p.value });
    else raw.push({ kind: "equal", text: p.value });
  }

  // Coalesce dels-then-adds within each contiguous non-equal run.
  // Small whitespace-only equal segments INSIDE an active run get
  // absorbed into both the del and add accumulators, because
  // `diffWordsWithSpace` reports inter-word single spaces as `equal`
  // even when the surrounding words are pure rewrites — and
  // displaying those spaces as standalone equal nodes between every
  // word-pair fragments the visual run into alternating noise.
  // Larger equal segments (structural markup, full common words)
  // terminate the run as expected.
  const out: BlockDiffSegment[] = [];
  let dels = "";
  let adds = "";
  const flush = (): void => {
    if (dels) out.push({ kind: "del", text: dels });
    if (adds) out.push({ kind: "add", text: adds });
    dels = "";
    adds = "";
  };
  const isTinyWhitespace = (s: string): boolean => s.length <= 2 && /^\s+$/.test(s);
  for (const seg of raw) {
    if (seg.kind === "del") dels += seg.text;
    else if (seg.kind === "add") adds += seg.text;
    else if ((dels || adds) && isTinyWhitespace(seg.text)) {
      dels += seg.text;
      adds += seg.text;
    } else {
      flush();
      out.push(seg);
    }
  }
  flush();
  return out;
}
