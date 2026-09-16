import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { renameAgentProfileIdentity } from "@nautilo/db";
import {
  getProfile,
  getProfileByAgentId,
  upsertProfile,
  type NautiloProfile,
  type UpsertProfileInput,
} from "../../store/profile-store";
import { emitProfileUpdated } from "./emit-profile-updated";

interface ManageProfileContext {
  ownerId?: string;
  /** M132 — the Agent this profile describes; threaded from the turn's tool context envelope. */
  agentId?: string;
}

const profileFieldsSchema = z
  .object({
    name: z.string().optional(),
    workLifeMode: z.enum(["work", "life", "both"]).nullable().optional(),
    privacySpectrum: z.number().int().min(0).max(100).nullable().optional(),
    language: z.string().optional(),
    onboardingCompleted: z.boolean().optional(),
    welcomeMessageSent: z.boolean().optional(),
  })
  .optional();

function formatProfileSummary(p: Awaited<ReturnType<typeof getProfile>>): string {
  if (!p) {
    return "No profile yet — use update to create one.";
  }
  const lines = [
    `Name: ${p.name}`,
    `Language: ${p.language}`,
    `Primary voice: ${p.voices["default"]?.voiceName ?? "none"} (${p.voices["default"]?.voiceId ?? "no id"})`,
    `Work/life mode: ${p.workLifeMode ?? "unspecified"}`,
    `Privacy spectrum: ${p.privacySpectrum ?? "unspecified"}`,
    `Onboarding completed: ${p.onboardingCompleted}`,
    `Welcome message sent: ${p.welcomeMessageSent}`,
    `Soul file: ${p.soulFile ? "present" : "missing"}`,
  ];
  return lines.join("\n");
}

export function createManageProfileTool(context?: ManageProfileContext) {
  return new DynamicStructuredTool({
    name: "manage_profile",
    description: `Read or update the user's structured profile (identity layer).

Use "read" to summarize name, voice, mode, privacy, language, onboarding flags, and whether a soul file exists.
Use "update" to change those fields. Personal facts and preferences belong in manage_memory, not here.

Voice assignment is not handled here — use manage_voices or PUT /api/profile/voices/:lang.`,

    schema: z.object({
      action: z.enum(["read", "update"]).describe("read = summary, update = merge fields into profile"),
      fields: profileFieldsSchema.describe("Only for update — partial profile fields"),
    }),

    func: async ({ action, fields }) => {
      const ownerId = context?.ownerId ?? "00000000-0000-0000-0000-000000000000";

      try {
        if (action === "read") {
          const p = await getProfile(ownerId);
          return formatProfileSummary(p);
        }

        const agentId = context?.agentId;
        if (!agentId) {
          return "manage_profile failed: no agent in context.";
        }
        const patch = (fields ?? {}) as UpsertProfileInput;
        // M156 — a name change is identity-critical: route it through the
        // transactional helper so `profiles.name`, the agent-actor cache,
        // and the auto-derived handle commit together. Non-name fields use
        // the normal writer.
        let profile: NautiloProfile;
        const nameProvided =
          typeof patch.name === "string" && patch.name.trim().length > 0;
        if (nameProvided) {
          const { name: _name, ...rest } = patch;
          if (Object.keys(rest).length > 0) {
            await upsertProfile(ownerId, agentId, rest);
          }
          await renameAgentProfileIdentity({
            ownerUserId: ownerId,
            agentId,
            name: patch.name as string,
          });
          const refreshed = await getProfileByAgentId(agentId);
          if (!refreshed) {
            return "manage_profile failed: profile not found after rename.";
          }
          profile = refreshed;
        } else {
          profile = await upsertProfile(ownerId, agentId, patch);
        }
        emitProfileUpdated(profile);
        const changed = Object.keys(fields ?? {}).join(", ") || "(defaults applied)";
        return `Profile updated (${changed}). Current name: ${profile.name}.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `manage_profile failed: ${msg}`;
      }
    },
  });
}
