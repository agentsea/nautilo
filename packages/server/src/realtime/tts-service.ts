import { randomUUID } from "node:crypto";
import type { ServerEvent, VoiceSentenceEvent } from "@nautilo/types";
import { DEFAULT_VOICE_KEY } from "@nautilo/types";
import { eventBus } from "@nautilo/runtime";
import { getProfile, getVoices } from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";
import { isCloudManagedDeployment } from "@nautilo/config-guard";
import { broadcast } from "./ws-publisher";
import {
  estimateElevenLabsV3TtsUsd,
  safelyRecordProviderCost,
} from "../costs/provider-cost-recorder";

const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
const VOICE_MARKUP_RE =
  /<voice\s+lang=["'][^"']*["']\s*>|<\/voice\s*>/gi;

/** D261 — sole hard default when no profile voices map entry resolves. */
const HARDCODED_DEFAULT_VOICE_ID = "JSWO6cw2AyFE324d5kEr";
const MODEL_ID = "eleven_v3";
const VOICE_CACHE_TTL_MS = 45_000;
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1.0,
};

type VoiceResolutionSource = "profile" | "default";

interface CachedVoiceResolution {
  voiceId: string;
  source: VoiceResolutionSource;
  expiresAt: number;
}

interface QueuedSentence {
  text: string;
  index: number;
  final: boolean;
  roomId?: string;
  userId?: string;
  agentId?: string;
  lang?: string;
}

function isValidElevenLabsVoiceId(id: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(id) && id.length >= 4 && id.length <= 64;
}

function voiceCacheKey(agentId: string | undefined, userId: string | undefined, lang: string): string {
  const scope = agentId ?? userId ?? "";
  return `${scope}:${lang}`;
}

function resolveVoiceIdFromMap(
  voices: Record<string, { voiceId: string; voiceName: string }>,
  lang: string | undefined,
): string | null {
  const ref =
    lang !== undefined && lang !== DEFAULT_VOICE_KEY
      ? (voices[lang] ?? voices[DEFAULT_VOICE_KEY])
      : voices[DEFAULT_VOICE_KEY];
  if (ref?.voiceId && isValidElevenLabsVoiceId(ref.voiceId)) {
    return ref.voiceId;
  }
  return null;
}

function hasLanguageAssignment(
  voices: Record<string, { voiceId: string; voiceName: string }>,
  lang: string,
): boolean {
  const ref = voices[lang];
  return !!ref?.voiceId && isValidElevenLabsVoiceId(ref.voiceId);
}

function stripVoiceMarkup(text: string): string {
  return text.replace(VOICE_MARKUP_RE, "");
}

/**
 * Server-side TTS service (D021 Phase 2).
 *
 * Listens for voice.sentence events on the event bus, queues them,
 * calls ElevenLabs streaming API sequentially, and broadcasts
 * requester-private voice.audio events tagged with their origin Room.
 */
export class TtsService {
  private queue: QueuedSentence[] = [];
  private processing = false;
  private abortController: AbortController | null = null;
  private stopped = false;
  private busListener: ((event: ServerEvent) => void) | null = null;
  private voiceCache = new Map<string, CachedVoiceResolution>();
  /** D261 — at most one `voice.suggestion` per (agent|user, language) per service lifetime until profile refresh. */
  private suggestionEmitted = new Set<string>();

  start(): void {
    if (this.busListener) {
      log("[tts] Server-side TTS service already started — skipping duplicate bus subscription");
      return;
    }
    this.busListener = (event: ServerEvent) => {
      if (event.type === "voice.sentence") {
        this.enqueue(event);
      } else if (event.type === "profile.updated") {
        this.invalidateVoiceCache(event.userId);
      }
    };
    eventBus.on(this.busListener);
    log("[tts] Server-side TTS service started");
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    log("[tts] TTS pipeline stopped by client");
  }

  private invalidateVoiceCache(_userId?: string): void {
    // Cache keys are agent-scoped (`agentId:lang`); profile.updated carries
    // userId only — clear the full cache (45s TTL, rare writes).
    this.voiceCache.clear();
    this.suggestionEmitted.clear();
  }

  private suggestionKey(agentId?: string, userId?: string, lang?: string): string {
    return `${agentId ?? userId ?? ""}:${lang ?? ""}`;
  }

  private maybeEmitVoiceSuggestion(
    sentence: QueuedSentence,
    voices: Record<string, { voiceId: string; voiceName: string }>,
  ): void {
    const lang = sentence.lang;
    if (!lang || lang === DEFAULT_VOICE_KEY) return;
    if (hasLanguageAssignment(voices, lang)) return;

    const key = this.suggestionKey(sentence.agentId, sentence.userId, lang);
    if (this.suggestionEmitted.has(key)) return;
    this.suggestionEmitted.add(key);

    const suggestion = {
      type: "voice.suggestion" as const,
      language: lang,
      ...(sentence.userId ? { userId: sentence.userId } : {}),
      ...(sentence.agentId ? { agentId: sentence.agentId } : {}),
    };
    if (sentence.userId) {
      broadcast(suggestion, { kind: "user", userId: sentence.userId });
    } else {
      broadcast(suggestion);
    }
  }

  private enqueue(sentence: VoiceSentenceEvent): void {
    this.stopped = false;
    this.queue.push({
      text: sentence.text,
      index: sentence.index,
      final: sentence.final,
      ...(sentence.roomId ? { roomId: sentence.roomId } : {}),
      ...(sentence.userId ? { userId: sentence.userId } : {}),
      ...(sentence.agentId ? { agentId: sentence.agentId } : {}),
      ...(sentence.lang ? { lang: sentence.lang } : {}),
    });
    if (!this.processing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const sentence = this.queue.shift()!;
      await this.synthesize(sentence);
    }

    this.processing = false;
  }

  private hardDefault(): { voiceId: string; source: VoiceResolutionSource } {
    return { voiceId: HARDCODED_DEFAULT_VOICE_ID, source: "default" };
  }

  private async resolveVoiceId(
    agentId?: string,
    userId?: string,
    lang?: string,
  ): Promise<{ voiceId: string; source: VoiceResolutionSource }> {
    const langKey = lang ?? DEFAULT_VOICE_KEY;
    const cacheKey = voiceCacheKey(agentId, userId, langKey);
    const now = Date.now();
    const cached = this.voiceCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { voiceId: cached.voiceId, source: cached.source };
    }

    let fromProfile: string | null = null;

    if (agentId) {
      const voices = await getVoices(agentId).catch(() => ({}));
      fromProfile = resolveVoiceIdFromMap(voices, lang);
    } else if (userId) {
      const profile = await getProfile(userId).catch(() => null);
      if (profile) {
        fromProfile = resolveVoiceIdFromMap(profile.voices, lang);
      }
    }

    const resolved = fromProfile
      ? { voiceId: fromProfile, source: "profile" as const }
      : this.hardDefault();

    this.voiceCache.set(cacheKey, {
      voiceId: resolved.voiceId,
      source: resolved.source,
      expiresAt: now + VOICE_CACHE_TTL_MS,
    });

    return resolved;
  }

  private async loadVoicesMap(
    agentId?: string,
    userId?: string,
  ): Promise<Record<string, { voiceId: string; voiceName: string }>> {
    if (agentId) {
      return getVoices(agentId).catch(() => ({}));
    }
    if (userId) {
      const profile = await getProfile(userId).catch(() => null);
      return profile?.voices ?? {};
    }
    return {};
  }

  private async synthesize(sentence: QueuedSentence): Promise<void> {
    const apiKey = process.env["ELEVENLABS_API_KEY"]?.trim();
    if (!apiKey) {
      warn(isCloudManagedDeployment()
        ? "[tts] managed voice service unavailable, skipping TTS"
        : "[tts] ELEVENLABS_API_KEY not set, skipping TTS");
      return;
    }

    const strippedText = stripVoiceMarkup(sentence.text);
    const cleaned = strippedText
      .replace(/\[.*?\]/g, "")
      .replace(EMOJI_RE, "")
      .trim();
    if (!cleaned) return;

    const ttsText = strippedText.replace(EMOJI_RE, "").trim();
    const voices = await this.loadVoicesMap(sentence.agentId, sentence.userId);
    this.maybeEmitVoiceSuggestion(sentence, voices);

    const { voiceId, source } = await this.resolveVoiceId(
      sentence.agentId,
      sentence.userId,
      sentence.lang,
    );
    log(
      `[tts] agentId=${sentence.agentId ?? "none"} userId=${sentence.userId ?? "none"} lang=${sentence.lang ?? DEFAULT_VOICE_KEY} voiceId=${voiceId} source=${source}`,
    );
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`;

    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: MODEL_ID,
          voice_settings: VOICE_SETTINGS,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        warn(`[tts] ElevenLabs API error ${response.status}: ${body.slice(0, 200)}`);
        return;
      }

      if (!response.body) {
        warn("[tts] ElevenLabs response has no body");
        return;
      }

      let chunkIndex = 0;
      const reader = response.body.getReader();

      try {
        while (!this.stopped) {
          const result = await reader.read();
          if (result.done) break;

          const base64 = bufferToBase64(result.value as Uint8Array);
          broadcast({
            type: "voice.audio",
            data: base64,
            chunkIndex: chunkIndex++,
            sentenceIndex: sentence.index,
            final: false,
            ...(sentence.roomId ? { roomId: sentence.roomId } : {}),
            ...(sentence.userId ? { userId: sentence.userId } : {}),
          });
        }
      } finally {
        reader.releaseLock();
      }

      if (!this.stopped) {
        broadcast({
          type: "voice.audio",
          data: "",
          chunkIndex,
          sentenceIndex: sentence.index,
          final: true,
          ...(sentence.roomId ? { roomId: sentence.roomId } : {}),
          ...(sentence.userId ? { userId: sentence.userId } : {}),
        });
        await safelyRecordProviderCost({
          identity: `elevenlabs:tts:${randomUUID()}`,
          userId: sentence.userId ?? null,
          agentId: sentence.agentId ?? null,
          provider: "elevenlabs",
          operation: "text_to_speech",
          estimatedCostUsd: estimateElevenLabsV3TtsUsd(ttsText),
          evidenceState: "estimated",
        });
      }

      log(`[tts] Sentence ${sentence.index} complete (${chunkIndex} chunks)`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        log("[tts] ElevenLabs request aborted");
        return;
      }
      warn(`[tts] ElevenLabs TTS failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.abortController = null;
    }
  }
}

function bufferToBase64(uint8: Uint8Array): string {
  return Buffer.from(uint8).toString("base64");
}

let ttsServiceInstance: TtsService | null = null;

export function getTtsService(): TtsService {
  if (!ttsServiceInstance) {
    ttsServiceInstance = new TtsService();
  }
  return ttsServiceInstance;
}
