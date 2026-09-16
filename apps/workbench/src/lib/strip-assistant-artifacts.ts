/**
 * D087 UX pass — render-time filter that strips two families of stray
 * tokens from assistant-authored text:
 *
 *   1. Narrator-style emotion tags: `[laughs]`, `[sighs]`, `[whispers]`, …
 *      These leak out of models that were fine-tuned on voice / TTS
 *      corpora and aren't useful in a text chat.
 *
 *   2. Tool-call scratchpad scaffolding: `<result>` / `</result>`,
 *      `<answer>` / `</answer>`, `<thinking>` / `</thinking>`,
 *      `<output>` / `</output>`. Claude Sonnet 4.6 (and peers) have
 *      been trained with internal scratchpad XML around agentic
 *      tool-call intent. Even when the system prompt forbids
 *      XML-style wrapping, the habit leaks as near-empty
 *      `<result> </result>` blocks around synthetic tool-invocation
 *      prompts (notably the workbench's Accept/Reject button
 *      dispatcher at tool-invoke-ref.ts).
 *
 * Extracted from `components/conversation.tsx` into its own module
 * for unit testability — the same pattern `newMessageId` followed
 * when its gray-screen regression had to be locked with anti-bug
 * tests (see `apps/workbench/src/lib/message-id.ts`).
 *
 * Behavioral guarantees (locked in `strip-assistant-artifacts.test.ts`):
 *   - Tag markers are removed; INTERIOR content is preserved.
 *   - Self-closing forms (`<result/>`) are handled.
 *   - Word-boundary is enforced by the `\s*\/?>` anchor: the regex
 *     stops consuming after `result` only when the very next char is
 *     whitespace, `/`, or `>`. This prevents `<resultSet>`-style
 *     collateral damage.
 *   - Only the enumerated emotion tags strip; unknown bracketed tokens
 *     (`[todo]`, `[cite:42]`, …) are preserved.
 *   - Pure function: no I/O, no side effects, no state.
 */

/**
 * The closed set of narrator emotion tags we recognize. Keep this
 * list conservative — any new entry should be justified by an observed
 * leak from a specific model. Open-ending the regex to `[a-z]+`-style
 * would catch legitimate `[cite:foo]` / `[todo]` / `[doc:link]`
 * scaffolding that other systems use for real content.
 */
const EMOTION_TAG_RE =
  /\[(laughs|sighs|excited|whispers|curious|sarcastic|happy gasp|frustrated sigh|clears throat|cheerful|warm|thoughtful|playful|serious|gentle|confident|amused|emphatic)\]\s?/gi;

/**
 * Opening + closing + self-closing forms of the four scratchpad tags.
 * The trailing `\s*\/?>` means:
 *   - `\s*` tolerates `<result  >` (whitespace before >).
 *   - `\/?` covers the self-closing form `<result/>`.
 *   - `>` anchors the close — this is what gives us word-boundary
 *     protection against `<resultSet>` et al (the char after `result`
 *     in `<resultSet>` is `S`, which matches neither `\s`, `\/`, nor
 *     `>`, so the overall regex refuses the match).
 */
const XML_SCAFFOLD_TAG_RE =
  /<\/?(result|answer|thinking|output)\s*\/?>/gi;

/** D261 — teaching-mode `<voice lang="…">` spans (markers only; interior preserved). */
const VOICE_MARKUP_RE =
  /<voice\s+lang=["'][^"']*["']\s*>|<\/voice\s*>/gi;

/**
 * Strip narrator emotion tags + tool-call scratchpad scaffolding from
 * assistant-authored text. Pure; safe to call from render.
 *
 * Use `isEmptyAfterStrip(text)` (below) to decide whether a message
 * bubble should render at all — if the strip produced a whitespace-only
 * result, the bubble would otherwise show a ghost "Genie:" label
 * with no content.
 */
export function stripAssistantArtifacts(text: string): string {
  return text
    .replace(EMOTION_TAG_RE, "")
    .replace(XML_SCAFFOLD_TAG_RE, "")
    .replace(VOICE_MARKUP_RE, "");
}

/**
 * True when the stripped-and-trimmed text is empty. Lets the render
 * layer skip empty-after-strip assistant bubbles entirely.
 */
export function isEmptyAfterStrip(text: string): boolean {
  return stripAssistantArtifacts(text).trim().length === 0;
}
