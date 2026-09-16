import type { VoiceSentenceEvent } from "@nautilo/types";

const SENTENCE_END_RE = /^(.*?[.!?])\s+(.*)$/s;
const MIN_SENTENCE_LENGTH = 6;
/**
 * D283 — minimum length of the *first* spoken chunk of a turn. The TTS
 * pipeline is sequential and cold at turn start: a too-short opener
 * ("Good idea.") finishes playing before the next chunk is synthesized,
 * leaving an audible gap. We hold the opener and merge following text into
 * it until it clears this length, so the first request is long enough to
 * mask the next chunk's synthesis latency. Set to 0 to disable coalescing.
 */
const DEFAULT_LEAD_MIN_CHARS = 40;

const VOICE_OPEN_TAG_RE = /<voice\s+lang=["']([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)["']\s*>/i;
const VOICE_CLOSE_TAG_RE = /<\/voice\s*>/i;

export interface SentenceDetectorConfig {
  /** Flush partial sentence if no new tokens arrive within this many ms. */
  partialTimeoutMs?: number;
  /** M075 — tag `voice.sentence` for per-user TTS + WS routing. */
  userId?: string;
  /** D261 — speaking agent; carried on each `voice.sentence` event. */
  agentId?: string;
  /** D570 — immutable origin Room for client-local foreground playback. */
  roomId?: string;
  /**
   * D283 — coalesce a short opening chunk forward until it reaches this many
   * characters, so the first TTS request outlasts the next chunk's synthesis
   * latency. Defaults to {@link DEFAULT_LEAD_MIN_CHARS}. Set to 0 to disable.
   */
  leadMinChars?: number;
}

type VoiceSegment = { text: string; lang?: string };

/** Carries an open `<voice lang="…">` across streaming token chunks. */
export type VoiceParseState = { insideLang?: string };

/**
 * Accumulates LLM tokens and emits VoiceSentenceEvent when a sentence
 * boundary (.!?) followed by whitespace is detected, or when a
 * `<voice lang="…">` span opens/closes. Mirrors the TokenBatcher pattern:
 * call addToken(), drain pending events, then complete() at stream end.
 */
export class SentenceDetector {
  private buffer = "";
  private sentenceIndex = 0;
  private pendingEvents: VoiceSentenceEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly partialTimeoutMs: number;
  private readonly voiceUserId: string | undefined;
  private readonly voiceAgentId: string | undefined;
  private readonly voiceRoomId: string | undefined;
  /** Unflushed text after the last parse pass (same lang as {@link trailingLang}). */
  private trailingText = "";
  private trailingLang: string | undefined;
  private readonly voiceParseState: VoiceParseState = {};
  /** D283 — completed opening sentences held for coalescing (index 0 only). */
  private leadBuffer = "";
  private leadLang: string | undefined;
  private readonly leadMinChars: number;

  constructor(config?: SentenceDetectorConfig) {
    this.partialTimeoutMs = config?.partialTimeoutMs ?? 3000;
    this.voiceUserId = config?.userId;
    this.voiceAgentId = config?.agentId;
    this.voiceRoomId = config?.roomId;
    this.leadMinChars = config?.leadMinChars ?? DEFAULT_LEAD_MIN_CHARS;
  }

  private sentencePayload(
    base: Omit<VoiceSentenceEvent, "type" | "userId" | "agentId" | "roomId">,
  ): VoiceSentenceEvent {
    return {
      type: "voice.sentence",
      ...base,
      ...(this.voiceUserId ? { userId: this.voiceUserId } : {}),
      ...(this.voiceAgentId ? { agentId: this.voiceAgentId } : {}),
      ...(this.voiceRoomId ? { roomId: this.voiceRoomId } : {}),
    };
  }

  addToken(token: string): void {
    this.buffer += token;
    this.resetTimer();
    this.extract();
  }

  /** Flush remainder as final sentence (call when LLM stream ends). */
  complete(): void {
    this.clearTimer();
    if (this.buffer) {
      const merged = this.trailingText + this.buffer;
      this.trailingText = "";
      this.trailingLang = undefined;
      this.buffer = "";
      const segments = parseVoiceTaggedText(merged, this.voiceParseState);
      for (const seg of segments) {
        this.flushSegmentText(seg.text, seg.lang, true);
      }
    }
    if (this.trailingText.trim()) {
      this.pushSentence(this.trailingText, this.trailingLang, true);
      this.trailingText = "";
      this.trailingLang = undefined;
    } else if (this.leadBuffer.length > 0) {
      // Held opener with no trailing text (whole turn was shorter than
      // leadMinChars) — emit it as the final chunk; never drop her speech.
      this.emitPayload(this.leadBuffer, this.leadLang, true);
      this.leadBuffer = "";
      this.leadLang = undefined;
    }
    delete this.voiceParseState.insideLang;
  }

  drain(): VoiceSentenceEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  reset(): void {
    this.clearTimer();
    this.buffer = "";
    this.trailingText = "";
    this.trailingLang = undefined;
    this.leadBuffer = "";
    this.leadLang = undefined;
    delete this.voiceParseState.insideLang;
    this.sentenceIndex = 0;
    this.pendingEvents = [];
  }

  private extract(): void {
    const { safe, hold } = splitAtIncompleteVoiceTag(this.buffer);
    this.buffer = hold;

    const segments = parseVoiceTaggedText(safe, this.voiceParseState);
    for (let i = 0; i < segments.length; i++) {
      const atBoundary = i < segments.length - 1;
      this.flushSegmentText(segments[i]!.text, segments[i]!.lang, atBoundary);
    }
  }

  private flushSegmentText(text: string, lang: string | undefined, atBoundary: boolean): void {
    let buf =
      this.trailingText.length > 0 && languagesMatch(this.trailingLang, lang)
        ? this.trailingText + text
        : text;
    if (this.trailingText.length > 0 && !languagesMatch(this.trailingLang, lang)) {
      this.emitTrailingAtBoundary();
      buf = text;
    }

    let match = SENTENCE_END_RE.exec(buf);
    while (match) {
      const sentence = (match[1] ?? "").trim();
      buf = match[2] ?? "";
      this.pushSentence(sentence, lang, false, { minLength: MIN_SENTENCE_LENGTH });
      match = SENTENCE_END_RE.exec(buf);
    }

    const leftover = buf.trim();
    if (atBoundary && leftover.length >= MIN_SENTENCE_LENGTH) {
      this.pushSentence(leftover, lang, false, { minLength: MIN_SENTENCE_LENGTH });
      this.trailingText = "";
      this.trailingLang = undefined;
    } else if (!atBoundary) {
      this.trailingText = buf;
      this.trailingLang = lang;
    } else {
      this.trailingText = leftover;
      this.trailingLang = lang;
    }
  }

  private emitTrailingAtBoundary(): void {
    const leftover = this.trailingText.trim();
    if (leftover.length >= MIN_SENTENCE_LENGTH) {
      this.pushSentence(leftover, this.trailingLang, false, {
        minLength: MIN_SENTENCE_LENGTH,
      });
    }
    this.trailingText = "";
    this.trailingLang = undefined;
  }

  /**
   * Single emit chokepoint. Enforces D283 lead-coalescing: while the turn's
   * first chunk (index 0) is shorter than {@link leadMinChars}, hold it and
   * merge following text in, so the opening TTS request is long enough to
   * mask the next chunk's synthesis latency. A language change or a forced
   * flush (`flushLead`, final) emits whatever is held — we never drop speech
   * and never merge across languages (D261).
   */
  private pushSentence(
    text: string,
    lang: string | undefined,
    final: boolean,
    opts?: { minLength?: number; flushLead?: boolean },
  ): void {
    const clean = text.trim();
    if (!clean) return;

    if (this.leadMinChars > 0 && this.sentenceIndex === 0) {
      const langChange =
        this.leadBuffer.length > 0 && !languagesMatch(this.leadLang, lang);
      if (langChange) {
        this.emitPayload(this.leadBuffer, this.leadLang, false);
        this.leadBuffer = "";
        this.leadLang = undefined;
        // fall through to emit the new-language text as its own chunk
      } else {
        this.leadBuffer = this.leadBuffer ? `${this.leadBuffer} ${clean}` : clean;
        this.leadLang = lang;
        if (!final && !opts?.flushLead && this.leadBuffer.length < this.leadMinChars) {
          return;
        }
        this.emitPayload(this.leadBuffer, this.leadLang, final);
        this.leadBuffer = "";
        this.leadLang = undefined;
        return;
      }
    }

    if (!final && clean.length < (opts?.minLength ?? 0)) return;
    this.emitPayload(clean, lang, final);
  }

  private emitPayload(text: string, lang: string | undefined, final: boolean): void {
    this.pendingEvents.push(
      this.sentencePayload({
        text,
        index: this.sentenceIndex++,
        final,
        ...(lang ? { lang } : {}),
      }),
    );
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.partialTimeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const text = this.trailingText.trim() || this.buffer.trim();
        if (text && text.length >= MIN_SENTENCE_LENGTH) {
          // Stream stalled — force-flush even a held short opener; we can't
          // wait indefinitely for the coalescing target to be reached.
          this.pushSentence(text, this.trailingLang, false, { flushLead: true });
          this.trailingText = "";
          this.trailingLang = undefined;
          this.buffer = "";
        }
      }, this.partialTimeoutMs);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function languagesMatch(a: string | undefined, b: string | undefined): boolean {
  return a === b || (a === undefined && b === undefined);
}

/** Hold back a suffix that may be an incomplete `<voice>` / `</voice>` token. */
export function splitAtIncompleteVoiceTag(text: string): { safe: string; hold: string } {
  const lastLt = text.lastIndexOf("<");
  if (lastLt === -1) {
    return { safe: text, hold: "" };
  }
  const tail = text.slice(lastLt);
  if (couldBeIncompleteVoiceTag(tail)) {
    return { safe: text.slice(0, lastLt), hold: tail };
  }
  return { safe: text, hold: "" };
}

function couldBeIncompleteVoiceTag(fragment: string): boolean {
  if (!fragment.startsWith("<")) return false;
  if (VOICE_OPEN_TAG_RE.exec(fragment) || VOICE_CLOSE_TAG_RE.exec(fragment)) {
    return false;
  }

  // A closing `>` proves this is a complete malformed tag, not a partial
  // valid tag. Release it as literal text instead of buffering forever.
  if (fragment.includes(">")) return false;

  const lower = fragment.toLowerCase();
  return couldBeIncompleteOpenVoiceTag(lower) || couldBeIncompleteCloseVoiceTag(lower);
}

/**
 * Recognize every prefix of `<voice lang="BCP-47">` that can still become a
 * valid opening tag. Model streams may split at any character boundary; in
 * particular `<voice ` and `<voice l` must remain buffered until `lang=...`
 * arrives instead of leaking into ordinary/default-voice text.
 */
function couldBeIncompleteOpenVoiceTag(fragment: string): boolean {
  const tagName = "<voice";
  if (fragment.length <= tagName.length) return tagName.startsWith(fragment);
  if (!fragment.startsWith(tagName)) return false;

  let rest = fragment.slice(tagName.length);
  if (!/^\s/.test(rest)) return false;
  rest = rest.replace(/^\s+/, "");
  if (!rest) return true;

  const attribute = "lang";
  if (rest.length < attribute.length) return attribute.startsWith(rest);
  if (!rest.startsWith(attribute)) return false;
  rest = rest.slice(attribute.length);
  if (!rest) return true;

  if (!rest.startsWith("=")) return false;
  rest = rest.slice(1);
  if (!rest) return true;

  const quote = rest[0];
  if (quote !== '"' && quote !== "'") return false;
  rest = rest.slice(1);

  const closingQuote = rest.indexOf(quote);
  const language = closingQuote === -1 ? rest : rest.slice(0, closingQuote);
  if (!couldBecomeVoiceLanguage(language)) return false;
  if (closingQuote === -1) return true;

  // VOICE_OPEN_TAG_RE permits whitespace between the closing quote and `>`.
  return rest.slice(closingQuote + 1).trim().length === 0;
}

function couldBeIncompleteCloseVoiceTag(fragment: string): boolean {
  const tagName = "</voice";
  if (fragment.length <= tagName.length) return tagName.startsWith(fragment);
  if (!fragment.startsWith(tagName)) return false;
  return fragment.slice(tagName.length).trim().length === 0;
}

function couldBecomeVoiceLanguage(language: string): boolean {
  if (!language) return true;
  // A trailing hyphen is incomplete but can become a valid next subtag.
  return /^[a-z0-9]+(?:-[a-z0-9]*)*$/i.test(language);
}

/**
 * Split `input` into stripped text spans tagged with BCP-47 from `<voice lang="…">`.
 * Nested `<voice>` inside an open span is treated as literal text.
 */
export function parseVoiceTaggedText(
  input: string,
  state: VoiceParseState = {},
): VoiceSegment[] {
  if (!input.includes("<") && state.insideLang) {
    return [{ text: input, lang: state.insideLang }];
  }

  const segments: VoiceSegment[] = [];
  let insideLang = state.insideLang;
  let nestedMarkup = false;
  let acc = "";
  let pos = 0;

  const pushSegment = (): void => {
    if (acc.length > 0) {
      segments.push(
        insideLang !== undefined ? { text: acc, lang: insideLang } : { text: acc },
      );
      acc = "";
    }
  };

  while (pos < input.length) {
    if (input[pos] === "<") {
      const rest = input.slice(pos);
      if (insideLang === undefined) {
        const openMatch = VOICE_OPEN_TAG_RE.exec(rest);
        if (openMatch && openMatch.index === 0) {
          pushSegment();
          insideLang = openMatch[1]!.toLowerCase();
          nestedMarkup = false;
          pos += openMatch[0].length;
          continue;
        }
      } else if (!nestedMarkup) {
        const closeMatch = VOICE_CLOSE_TAG_RE.exec(rest);
        if (closeMatch && closeMatch.index === 0) {
          pushSegment();
          insideLang = undefined;
          nestedMarkup = false;
          pos += closeMatch[0].length;
          continue;
        }
        const nestedOpen = VOICE_OPEN_TAG_RE.exec(rest);
        if (nestedOpen && nestedOpen.index === 0) {
          nestedMarkup = true;
          acc += nestedOpen[0];
          pos += nestedOpen[0].length;
          continue;
        }
      } else {
        const nestedClose = VOICE_CLOSE_TAG_RE.exec(rest);
        if (nestedClose && nestedClose.index === 0) {
          acc += nestedClose[0];
          nestedMarkup = false;
          pos += nestedClose[0].length;
          continue;
        }
        const nestedOpen = VOICE_OPEN_TAG_RE.exec(rest);
        if (nestedOpen && nestedOpen.index === 0) {
          acc += nestedOpen[0];
          pos += nestedOpen[0].length;
          continue;
        }
      }
    }
    acc += input[pos]!;
    pos += 1;
  }

  pushSegment();
  if (insideLang !== undefined) {
    state.insideLang = insideLang;
  } else {
    delete state.insideLang;
  }
  return segments;
}
