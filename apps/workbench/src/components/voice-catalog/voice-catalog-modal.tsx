import type { CatalogVoice } from "@nautilo/types";
import { DEFAULT_VOICE_KEY, GENIE_VOICE_SAMPLE_PHRASES, genieVoiceSampleTextForLanguage } from "@nautilo/types";
import {
  SharedVoiceCatalogModal,
  type VoiceCatalogAssignRole,
} from "@nautilo/voice-catalog-ui";
import { apiClient } from "../../lib/api";

const ENGLISH_SAMPLE_FALLBACK_COPY =
  "No translated Genie sample yet; using English.";

export function genieSampleTextForLanguage(lang: string): string {
  return genieVoiceSampleTextForLanguage(lang);
}

function samplePhrase(voice: CatalogVoice): { text: string; fallbackToEnglish: boolean } {
  const base = voice.language?.trim().toLowerCase().split("-")[0] ?? "";
  const translated = GENIE_VOICE_SAMPLE_PHRASES[base];
  return translated ?
      { text: translated, fallbackToEnglish: false }
    : { text: genieVoiceSampleTextForLanguage("en"), fallbackToEnglish: true };
}

export type VoiceCatalogModalProps = {
  open: boolean;
  onClose: () => void;
  onAssigned: () => void | Promise<void>;
  /** D261 — language-first assign with Primary vs language role. */
  roleAtAssign?: boolean;
  initialLanguage?: string | null;
  defaultAssignRole?: VoiceCatalogAssignRole;
  title?: string;
};

export function VoiceCatalogModal({
  open,
  onClose,
  onAssigned,
  roleAtAssign = false,
  initialLanguage = null,
  defaultAssignRole,
  title = "Browse voices and languages",
}: VoiceCatalogModalProps) {
  return (
    <SharedVoiceCatalogModal
      open={open}
      title={title}
      roleAtAssign={roleAtAssign}
      initialLanguage={initialLanguage}
      defaultAssignRole={defaultAssignRole}
      onClose={onClose}
      loadCatalog={(query) => apiClient.listVoiceCatalog(query)}
      previewVoice={async (voice, source) => {
        const phrase = samplePhrase(voice);
        void source;
        const blob = await apiClient.previewVoice(voice.voiceId, { text: phrase.text });
        return URL.createObjectURL(blob);
      }}
      generatedSampleLabel={(voice) => {
        const phrase = samplePhrase(voice);
        return phrase.fallbackToEnglish ?
            { label: "Generate English sample", title: ENGLISH_SAMPLE_FALLBACK_COPY }
          : { label: "Generate Genie sample" };
      }}
      assignVoice={async (voice, role) => {
        const langKey = role === DEFAULT_VOICE_KEY ? DEFAULT_VOICE_KEY : role;
        await apiClient.upsertVoiceAssignment(langKey, {
          voiceId: voice.voiceId,
          voiceName: voice.name,
        });
        await onAssigned();
      }}
    />
  );
}
