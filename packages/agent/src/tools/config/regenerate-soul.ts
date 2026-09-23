import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { generateSoulFile } from "../../soul/generate-soul-file";
import type { SoulFileInput } from "../../soul/types";
import { DEFAULT_VOICE_KEY } from "@nautilo/types";
import { getProfile, upsertProfile, type NautiloProfile } from "../../store/profile-store";
import { emitProfileUpdated } from "./emit-profile-updated";

interface RegenerateSoulContext {
  ownerId?: string;
  /** Exact Human who caused this turn; provider funding follows this subject. */
  causalHumanUserId?: string;
  /** M132 — the Agent this profile describes; threaded from the turn's tool context envelope. */
  agentId?: string;
}

const overridesSchema = z.object({
  name: z.string().optional(),
  workLifeMode: z.enum(["work", "life", "both"]).nullable().optional(),
  privacySpectrum: z.number().int().min(0).max(100).nullable().optional(),
  voiceName: z.string().nullable().optional(),
  motherAnswer: z.string().nullable().optional(),
});

function profileToSoulPartial(profile: NautiloProfile): Partial<SoulFileInput> {
  return {
    name: profile.name,
    language: profile.language,
    privacySpectrum: profile.privacySpectrum,
    workLifeMode: profile.workLifeMode as SoulFileInput["workLifeMode"],
    voiceName: profile.voices?.[DEFAULT_VOICE_KEY]?.voiceName ?? null,
    motherAnswer: profile.motherAnswer,
  };
}

function mergeSoulInput(
  base: Partial<SoulFileInput>,
  overrides: z.infer<typeof overridesSchema> | undefined,
): Partial<SoulFileInput> {
  const o = overrides ?? {};
  const out: Partial<SoulFileInput> = { ...base };
  if (o.name !== undefined) out.name = o.name;
  if (o.workLifeMode !== undefined) out.workLifeMode = o.workLifeMode;
  if (o.privacySpectrum !== undefined) out.privacySpectrum = o.privacySpectrum;
  if (o.voiceName !== undefined) out.voiceName = o.voiceName;
  if (o.motherAnswer !== undefined) out.motherAnswer = o.motherAnswer;
  return out;
}

export function createRegenerateSoulTool(context?: RegenerateSoulContext) {
  return new DynamicStructuredTool({
    name: "regenerate_soul",
    description: `Regenerate the markdown soul file from profile fields plus optional overrides.

Slow (~10–15s) when the LLM path runs. Always use action "preview" first to show a truncated sample; use "apply" only after the user confirms.
Overrides let you experiment without changing stored profile fields until apply.`,

    schema: z.object({
      action: z.enum(["preview", "apply"]).describe("preview = read-only sample, apply = save soulFile to profile"),
      overrides: overridesSchema
        .optional()
        .describe("Merged over current profile when generating"),
    }),

    func: async ({ action, overrides }) => {
      const ownerId = context?.ownerId ?? "00000000-0000-0000-0000-000000000000";

      try {
        const profile = await getProfile(ownerId);
        const base = profile
          ? profileToSoulPartial(profile)
          : {
              name: "Genie" as const,
              language: "en",
              privacySpectrum: null,
              workLifeMode: null,
              voiceName: null,
              motherAnswer: null,
            };
        const merged = mergeSoulInput(base, overrides);

        if (!context?.causalHumanUserId) {
          return "regenerate_soul failed: no Human in context.";
        }
        const soulFile = await generateSoulFile(merged, undefined, {
          humanUserId: context.causalHumanUserId,
        });

        if (action === "preview") {
          const snippet = soulFile.slice(0, 500);
          return `Preview (first 500 chars):\n\n${snippet}\n\nUse action "apply" to save this soul file to the profile.`;
        }

        const agentId = context?.agentId;
        if (!agentId) {
          return "regenerate_soul failed: no agent in context.";
        }
        const updated = await upsertProfile(ownerId, agentId, { soulFile });
        emitProfileUpdated(updated);
        const tail = soulFile.slice(0, 300);
        return `Soul file saved. Opening excerpt (first 300 chars):\n\n${tail}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `regenerate_soul failed: ${msg}`;
      }
    },
  });
}
