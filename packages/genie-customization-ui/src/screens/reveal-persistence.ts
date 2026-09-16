import type { OnboardingAPI, ProfileWrite, VoiceSelection } from "../types";

export const VOICE_NOT_CHANGED_NOTICE =
  "Your other changes were saved. Voice was not changed and can be added later in Settings.";

export const VOICE_ASSIGNMENT_UNVERIFIED_NOTICE =
  "Your other changes were saved. We could not confirm the voice update. Refresh Nautilo to verify it before using voice, or choose a voice later in Settings.";

export type RevealPersistenceResult =
  | { ok: true; voice: "unchanged"; notice: null; greetingAudioUrl: null }
  | { ok: true; voice: "assigned"; notice: null; greetingAudioUrl: string }
  | { ok: true; voice: "unchanged"; notice: string; greetingAudioUrl: null }
  | { ok: true; voice: "unverified"; notice: string; greetingAudioUrl: null }
  | { ok: false; error: string };

/**
 * Commits the profile before attempting an optional new voice. A successful
 * preview proves the provider can synthesize before the assignment becomes
 * durable; the preview audio is then reused for the greeting.
 */
export async function persistRevealProfile(
  api: OnboardingAPI,
  profile: ProfileWrite,
  replacement: VoiceSelection | null,
): Promise<RevealPersistenceResult> {
  const profileSave = await api.putProfile({
    ...profile,
    voiceId: null,
    voiceName: null,
  });
  if (!profileSave.ok) return profileSave;

  if (!replacement) {
    return { ok: true, voice: "unchanged", notice: null, greetingAudioUrl: null };
  }

  const preview = await api.previewVoice({
    voiceId: replacement.voiceId,
    displayName: profile.name || "Genie",
  });
  if (!preview.ok) {
    return {
      ok: true,
      voice: "unchanged",
      notice: VOICE_NOT_CHANGED_NOTICE,
      greetingAudioUrl: null,
    };
  }

  const assignment = await api.upsertVoiceAssignment("default", {
    voiceId: replacement.voiceId,
    voiceName: replacement.profileVoiceName,
  });
  if (!assignment.ok) {
    return {
      ok: true,
      // A failed response can be a transport failure after the server has
      // committed. Do not assert that the prior assignment survived, and do
      // not play the preview as though the new voice were usable.
      voice: "unverified",
      notice: VOICE_ASSIGNMENT_UNVERIFIED_NOTICE,
      greetingAudioUrl: null,
    };
  }

  return {
    ok: true,
    voice: "assigned",
    notice: null,
    greetingAudioUrl: preview.data.audioUrl,
  };
}
