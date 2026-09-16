export type NautiloScript =
  | "latin"
  | "cjk"
  | "japanese"
  | "arabic"
  | "emoji"
  | "unknown";

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const JAPANESE_RE = /[\u3040-\u30FF]/u;
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const LATINish_RE = /^[\t\n\r -~\u00A0-\u024F\u1E00-\u1EFF]*$/u;

export interface ScriptDetection {
  scripts: Set<NautiloScript>;
  hasUnsupported: boolean;
}

export function detectScripts(text: string): ScriptDetection {
  const scripts = new Set<NautiloScript>();
  if (text.length === 0) scripts.add("latin");
  if (LATINish_RE.test(text)) scripts.add("latin");
  if (CJK_RE.test(text)) scripts.add("cjk");
  if (JAPANESE_RE.test(text)) scripts.add("japanese");
  if (ARABIC_RE.test(text)) scripts.add("arabic");
  if (EMOJI_RE.test(text)) scripts.add("emoji");
  const knownText = text.replace(LATINish_RE, "");
  return {
    scripts,
    hasUnsupported: scripts.size === 0 && knownText.length > 0,
  };
}

export function hasEmoji(text: string): boolean {
  return EMOJI_RE.test(text);
}

export function hasArabic(text: string): boolean {
  return ARABIC_RE.test(text);
}

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text) || JAPANESE_RE.test(text);
}
