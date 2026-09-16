import { z } from "zod";

export const SoulFileInputSchema = z.object({
  name: z.string().trim().min(1).max(100).default("Genie"),
  language: z.string().trim().min(2).max(5).default("en"),
  privacySpectrum: z.number().int().min(0).max(100).nullable().default(null),
  workLifeMode: z.enum(["work", "life", "both"]).nullable().default(null),
  voiceName: z.string().trim().min(1).max(100).nullable().default(null),
  personalityPrompt: z.string().trim().min(1).nullable().default(null),
  motherAnswer: z.string().trim().min(1).nullable().default(null),
});

export type SoulFileInput = z.infer<typeof SoulFileInputSchema>;

export function normalizeSoulFileInput(input: Partial<SoulFileInput>): SoulFileInput {
  return SoulFileInputSchema.parse(input);
}
