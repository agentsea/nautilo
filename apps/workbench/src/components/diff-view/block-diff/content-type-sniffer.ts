/**
 * Picks word- vs character-level diff for within-block HTML snapshots.
 * `<script>` / `<style>` / `<pre>` / `<code>` → character diff; prose-like
 * tags → word diff with whitespace preserved.
 */

export type BlockDiffAlgo = "wordsWithSpace" | "chars";

const CHARS_TAGS = new Set(["script", "style", "pre", "code"]);

export function pickDiffAlgo(tag: string): BlockDiffAlgo {
  const t = tag.trim().toLowerCase();
  return CHARS_TAGS.has(t) ? "chars" : "wordsWithSpace";
}
