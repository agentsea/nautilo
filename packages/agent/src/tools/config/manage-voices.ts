import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { DEFAULT_VOICE_KEY } from "@nautilo/types";
import {
  assertValidVoiceLangKey,
  getProfile,
  getVoices,
  removeVoiceAssignment,
  upsertVoiceAssignment,
} from "../../store/profile-store";
import { emitProfileUpdated } from "./emit-profile-updated";

interface ManageVoicesContext {
  ownerId?: string;
  /** M132 — the Agent this profile describes; required for add/remove/list. */
  agentId?: string;
}

function isValidElevenLabsVoiceId(id: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(id) && id.length >= 4 && id.length <= 64;
}

function formatVoicesList(voices: Awaited<ReturnType<typeof getVoices>>): string {
  const keys = Object.keys(voices).sort((a, b) => {
    if (a === DEFAULT_VOICE_KEY) return -1;
    if (b === DEFAULT_VOICE_KEY) return 1;
    return a.localeCompare(b);
  });
  if (keys.length === 0) {
    return "No voice assignments yet. Use add with language \"default\" for the primary voice, or a BCP-47 code (e.g. \"es\") for a language voice.";
  }
  const lines = keys.map((lang) => {
    const ref = voices[lang]!;
    const role = lang === DEFAULT_VOICE_KEY ? "PRIMARY" : lang.toUpperCase();
    return `${role}: ${ref.voiceName} (${ref.voiceId})`;
  });
  return lines.join("\n");
}

export function createManageVoicesTool(context?: ManageVoicesContext) {
  return new DynamicStructuredTool({
    name: "manage_voices",
    description: `List, add, or remove per-language voice assignments on the agent profile.

Use "list" to see all assigned voices (primary + language slots).
Use "add" to assign a voice for a language key ("default" = primary, or BCP-47 like "es").
Use "remove" to drop a language voice (cannot remove "default" — replace it instead).
After the user chooses a voice from an audition_voices slate, lock it in with add.`,

    schema: z.object({
      action: z.enum(["list", "add", "remove"]).describe("list | add | remove"),
      language: z
        .string()
        .describe('Voice map key: "default" for primary, or BCP-47 (e.g. "es", "fr-CA")'),
      voiceId: z.string().optional().describe("ElevenLabs voice id (required for add)"),
      voiceName: z.string().optional().describe("Display name (required for add)"),
    }),

    func: async ({ action, language, voiceId, voiceName }) => {
      const agentId = context?.agentId;
      const ownerId = context?.ownerId ?? "00000000-0000-0000-0000-000000000000";

      if (!agentId) {
        return "manage_voices failed: no agent in context.";
      }

      try {
        if (action === "list") {
          const voices = await getVoices(agentId);
          return formatVoicesList(voices);
        }

        assertValidVoiceLangKey(language);

        if (action === "add") {
          if (typeof voiceId !== "string" || typeof voiceName !== "string") {
            return "manage_voices add failed: voiceId and voiceName are required strings.";
          }
          if (!isValidElevenLabsVoiceId(voiceId)) {
            return `manage_voices add failed: invalid voiceId "${voiceId}" — use a valid ElevenLabs voice id (alphanumeric, 4–64 chars).`;
          }
          const trimmedName = voiceName.trim();
          if (!trimmedName) {
            return "manage_voices add failed: voiceName must be non-empty.";
          }
          await upsertVoiceAssignment(agentId, language, {
            voiceId,
            voiceName: trimmedName,
          });
          const profile = await getProfile(ownerId);
          if (profile) {
            emitProfileUpdated(profile);
          }
          const voices = await getVoices(agentId);
          const ref = voices[language];
          const slot = language === DEFAULT_VOICE_KEY ? "primary" : language;
          return `Voice assigned for ${slot}: ${ref?.voiceName ?? trimmedName} (${ref?.voiceId ?? voiceId}).`;
        }

        await removeVoiceAssignment(agentId, language);
        const profile = await getProfile(ownerId);
        if (profile) {
          emitProfileUpdated(profile);
        }
        return `Removed voice assignment for ${language}.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `manage_voices failed: ${msg}`;
      }
    },
  });
}
