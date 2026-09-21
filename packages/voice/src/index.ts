export type { PTTStatus, PTTPermission, PTTCallbacks } from "./ptt/types";
export { NativePTTManager, isPTTAvailable } from "./ptt/native-ptt";

import { ELEVENLABS_CURATED_VOICE_IDS } from "./curated-voices";

/** Slugs accepted by `/voice set` and similar (mirrors curated registry). */
export const AVAILABLE_VOICES = Object.freeze(
  Object.keys(ELEVENLABS_CURATED_VOICE_IDS),
);

export {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayName,
  curatedVoiceDisplayNameForId,
} from "./curated-voices";
export type { VoiceCatalogEntry } from "./catalog";
export { fetchElevenLabsCatalog, normalizeElevenLabsLabels } from "./catalog";
export {
  VOICE_PREVIEW_SCRIPT_VERSION,
  voicePreviewPath,
  voicePreviewPathForCustomText,
} from "./preview-path";
