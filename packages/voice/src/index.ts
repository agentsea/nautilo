import { SayAdapter } from "./adapters/say";
import { ElevenLabsAdapter } from "./adapters/elevenlabs";
import { fromRuntimeConfig } from "@nautilo/config";
import { warn } from "@nautilo/logger";
import type { TTSAdapter, VoiceConfig } from "./types";

export type { TTSAdapter, SpeakOptions, VoiceConfig } from "./types";
export type { PTTStatus, PTTPermission, PTTCallbacks } from "./ptt/types";
export { NativePTTManager, isPTTAvailable } from "./ptt/native-ptt";

let cachedAdapter: TTSAdapter | null = null;

export function createTTSAdapter(config?: Partial<VoiceConfig>): TTSAdapter {
  if (cachedAdapter) return cachedAdapter;

  const runtimeConfig = fromRuntimeConfig();
  const provider = config?.provider ?? runtimeConfig.nautilo_voice_provider;
  const voiceName = config?.voiceName ?? runtimeConfig.nautilo_voice_name ?? null;
  const voiceIdOverride = config?.voiceId ?? null;

  if (provider === "elevenlabs") {
    const apiKey = process.env["ELEVENLABS_API_KEY"];
    if (!apiKey) {
      warn("[voice] ELEVENLABS_API_KEY not set, falling back to macOS say");
      cachedAdapter = new SayAdapter();
      return cachedAdapter;
    }
    cachedAdapter = new ElevenLabsAdapter(apiKey, voiceName, voiceIdOverride);
    return cachedAdapter;
  }

  if (provider === "say") {
    cachedAdapter = new SayAdapter();
    return cachedAdapter;
  }

  // auto: try ElevenLabs if key present, else say
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (apiKey) {
    cachedAdapter = new ElevenLabsAdapter(apiKey, voiceName, voiceIdOverride);
  } else {
    cachedAdapter = new SayAdapter();
  }
  return cachedAdapter;
}

export function stopTTS(): void {
  cachedAdapter?.stop();
}

export function isSpeaking(): boolean {
  return cachedAdapter?.isSpeaking() ?? false;
}

export function resetTTSAdapter(): void {
  cachedAdapter?.stop();
  cachedAdapter = null;
}

import { ELEVENLABS_CURATED_VOICE_IDS } from "./adapters/elevenlabs";

/** Slugs accepted by `/voice set` and similar (mirrors curated registry). */
export const AVAILABLE_VOICES = Object.freeze(
  Object.keys(ELEVENLABS_CURATED_VOICE_IDS),
);

export {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayName,
  curatedVoiceDisplayNameForId,
} from "./adapters/elevenlabs";
export type { VoiceCatalogEntry } from "./catalog";
export { fetchElevenLabsCatalog, normalizeElevenLabsLabels } from "./catalog";
export {
  VOICE_PREVIEW_SCRIPT_VERSION,
  voicePreviewPath,
  voicePreviewPathForCustomText,
} from "./preview-path";
