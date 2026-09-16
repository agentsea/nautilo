// Mirror of the desktop render-time filter
// (apps/workbench/src/lib/strip-assistant-artifacts.ts): strips narrator
// emotion tags ([laughs], [excited], …), tool-call scratchpad XML, and
// teaching-mode <voice> markup from assistant-authored text. These leak from
// voice/TTS-tuned models and shouldn't render in a text bubble.
//
// NOTE: kept in sync by hand with the desktop canonical (which carries the
// unit tests). If the tag set drifts, update both — a shared @nautilo home is
// a reasonable future consolidation.

const EMOTION_TAG_RE =
  /\[(laughs|sighs|excited|whispers|curious|sarcastic|happy gasp|frustrated sigh|clears throat|cheerful|warm|thoughtful|playful|serious|gentle|confident|amused|emphatic)\]\s?/gi;

const XML_SCAFFOLD_TAG_RE = /<\/?(result|answer|thinking|output)\s*\/?>/gi;

const VOICE_MARKUP_RE = /<voice\s+lang=["'][^"']*["']\s*>|<\/voice\s*>/gi;

/** Strip narrator emotion tags + scratchpad scaffolding. Pure; safe at render. */
export function stripAssistantArtifacts(text: string): string {
  return text
    .replace(EMOTION_TAG_RE, "")
    .replace(XML_SCAFFOLD_TAG_RE, "")
    .replace(VOICE_MARKUP_RE, "");
}
