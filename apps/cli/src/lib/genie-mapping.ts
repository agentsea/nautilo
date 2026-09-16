import type { VoiceRef } from "@nautilo/types";
import type { GenieAvatarValue } from "@nautilo/api-client";
import {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayName,
} from "./curated-voices.ts";

export type GenieResolvedIdentity = {
  name: string;
  voice?: string | undefined;
  defaultModel?: string | undefined;
  personality: string;
  /**
   * D112 Phase 19.6 — pre-rendered soul-file markdown from the chosen
   * archetype, with {{NAME}} substituted to `name`. When present, the
   * randomized profile lands with `soulFile` already populated, which
   * (a) gives the agent a real persona on first turn instead of the
   * default Genie fallback, and (b) lets the `onboarding_status` tool
   * stop nudging the model to call `regenerate_soul` automatically —
   * the file is no longer null.
   */
  soulFile?: string | undefined;
  avatar?: GenieAvatarValue | undefined;
};

function mapVoiceToVoiceRef(voice: string): VoiceRef | null {
  const [provider = "", local = ""] = voice.split(":", 2);
  const normalizedProvider = provider.toLowerCase();
  const normalizedLocal = local.toLowerCase();

  if (normalizedProvider !== "elevenlabs") return null;

  const curatedVoiceId = ELEVENLABS_CURATED_VOICE_IDS[normalizedLocal];
  if (curatedVoiceId) {
    return {
      voiceId: curatedVoiceId,
      voiceName: curatedVoiceDisplayName(normalizedLocal),
    };
  }

  // Explicit setup templates may provide a raw ElevenLabs voice id as
  // `elevenlabs:<voice_id>`. Preserve that path, but do not use the
  // provider-prefixed string as the API voice id — ElevenLabs expects the
  // raw UUID-ish id segment.
  if (local) {
    return { voiceId: local, voiceName: local };
  }

  return null;
}

/** D261 — resolve setup-template voice to `voices.default` assignment. */
export function resolveGenieDefaultVoice(
  resolved: Pick<GenieResolvedIdentity, "voice">,
): VoiceRef | null {
  if (!resolved.voice) return null;
  return mapVoiceToVoiceRef(resolved.voice);
}

export function mapGenieToProfileInput(
  resolved: GenieResolvedIdentity,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: resolved.name,
    personalityPrompt: resolved.personality,
    onboardingCompleted: true,
  };
  if (resolved.defaultModel) {
    out["defaultModel"] = resolved.defaultModel;
  }
  if (resolved.soulFile) {
    out["soulFile"] = resolved.soulFile;
  }
  return out;
}
