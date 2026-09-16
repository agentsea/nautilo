/**
 * MR6 — Length cap of 32 UTF-16 code units. Same metric used by
 * Fastify's JSON-schema `maxLength` and JS `String.prototype.length`.
 */
export const EMOJI_MAX_LENGTH = 32;

export function isValidEmojiString(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (input.length === 0 || input.length > EMOJI_MAX_LENGTH) return false;
  // Reject C0/C1 control characters (loop avoids control-char literals in a
  // regex, which `no-control-regex` forbids).
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  // Reject unpaired surrogate halves only. Supplementary-plane emoji (e.g.
  // 🎉) are valid surrogate PAIRS and must pass — the naive [\uD800-\uDFFF]
  // class wrongly rejects them, so we test for lone (unpaired) surrogates.
  if (
    typeof (input as { isWellFormed?: () => boolean }).isWellFormed ===
    "function"
  ) {
    if (!(input as unknown as { isWellFormed: () => boolean }).isWellFormed()) {
      return false;
    }
  } else if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      input,
    )
  ) {
    return false;
  }
  return true;
}
