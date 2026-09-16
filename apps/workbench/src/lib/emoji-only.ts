/**
 * D212 P4 — emoji-only message detection.
 *
 * When a chat message body is just a small run of emoji (e.g. a human
 * or agent sending "🎉" or "👍👍"), we render it at a large size — the
 * iMessage / Signal "big emoji" feel — instead of body text size.
 *
 * MR2 (D212): the gate is deliberately CONSERVATIVE. Only a body of
 * **≤ MAX_EMOJI_ONLY graphemes, all emoji, plus optional whitespace**
 * qualifies. This avoids surprise giant rendering of a long message
 * that merely happens to start or end with an emoji.
 *
 * Pure function: no I/O, no React, no state. Safe to call from render.
 */
import emojiRegex from "emoji-regex-xs";

/** Max emoji in a body for it to still count as "emoji-only" (MR2). */
export const MAX_EMOJI_ONLY = 3;

/**
 * True when `text`, after trimming, is between 1 and `MAX_EMOJI_ONLY`
 * emoji and contains nothing else but emoji and inter-emoji whitespace.
 *
 * Examples (MAX_EMOJI_ONLY = 3):
 *   "🎉"          → true
 *   " 👍 👍 "      → true
 *   "👀😄🎉"       → true
 *   "👀😄🎉🔥"      → false  (4 emoji, over the cap)
 *   "nice 🎉"      → false  (non-emoji text present)
 *   ""            → false  (empty)
 */
export function isEmojiOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Fresh regex per call: emoji-regex-xs returns a stateful /g regex,
  // and sharing one across calls leaks `lastIndex` between invocations.
  const re = emojiRegex();

  let emojiCount = 0;
  for (const _match of trimmed.matchAll(re)) {
    emojiCount += 1;
    if (emojiCount > MAX_EMOJI_ONLY) return false;
  }

  if (emojiCount === 0) return false;

  // Everything that is not an emoji must be whitespace: strip all emoji
  // (fresh regex — matchAll above advanced the other one's lastIndex)
  // and require the remainder to be whitespace-only.
  const nonEmoji = trimmed.replace(emojiRegex(), "");
  return nonEmoji.trim().length === 0;
}
