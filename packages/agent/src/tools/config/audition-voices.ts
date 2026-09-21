import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { AuditionVoicesToolResult, VoiceDiscoveryCandidate } from "@nautilo/types";
import { discoverVoices, type DiscoverVoicesInput } from "./find-voice";

/**
 * A suggested slate starts small so a Human can compare it comfortably. This
 * is a default for discovery, not a restriction on an explicit Human/model
 * selection or on the discovery contract itself.
 */
const DEFAULT_SUGGESTED_SLATE_SIZE = 3;

const verifiedLanguageSchema = z.object({
  language: z.string(),
  modelId: z.string(),
  accent: z.string().nullable(),
  locale: z.string().nullable(),
  previewUrl: z.string().nullable(),
});

const discoveryCandidateSchema = z.object({
  voiceId: z.string(),
  name: z.string(),
  language: z.string(),
  languageLabel: z.string(),
  accent: z.string(),
  gender: z.string(),
  age: z.string(),
  badge: z.enum(["curated", "provider_v3", "provider_verified", "unverified"]),
  previewUrl: z.string().nullable().optional(),
  verifiedLanguages: z.array(verifiedLanguageSchema),
  matchReason: z.string(),
  honestyWarning: z.string().optional(),
});

export function createAuditionVoicesTool() {
  return new DynamicStructuredTool({
    name: "audition_voices",
    description: `Preview slate ("hear") for voice picking — read-only structured JSON, no audio bytes.

Correct explicit slate: pass selected candidates copied from find_voice. Do NOT pass voiceIds only.
Why: shared-catalog IDs are not always resolvable by ID; candidate objects preserve the metadata and preview URL already found.
Convenience: language/query/accent/limit can produce a suggested slate directly when the user just wants a quick comparison; its default is 3.
The tool-card loads a preview only when the Human requests it; lock in with manage_voices add when the user chooses.`,

    schema: z.object({
      candidates: z
        .array(discoveryCandidateSchema)
        .optional()
        .describe("Explicit slate: selected candidate objects returned by find_voice. Every supplied candidate remains selectable. Do not pass voiceIds-only slates."),
      role: z
        .string()
        .optional()
        .describe('Lock-in role hint for the card: "default" or BCP-47 (e.g. "es")'),
      sampleText: z
        .string()
        .max(500)
        .optional()
        .describe("Optional sample phrase for all preview rows; use the target language when appropriate"),
      language: z.string().optional().describe("Convenience: BCP-47 filter for suggested slate"),
      query: z.string().optional().describe("Convenience: keyword search for suggested slate"),
      accent: z.string().optional().describe("Convenience: accent filter for suggested slate"),
      limit: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT_SUGGESTED_SLATE_SIZE)
        .describe("Suggested slate size when using convenience mode (defaults to 3; discovery owns its actual supported range)"),
    }),

    func: async ({ candidates, role, sampleText, language, query, accent, limit }) => {
      try {
        const discoveryInput: DiscoverVoicesInput = {};
        if (language !== undefined) discoveryInput.language = language;
        if (query !== undefined) discoveryInput.query = query;
        if (accent !== undefined) discoveryInput.accent = accent;
        if (limit !== undefined) discoveryInput.limit = limit;

        if (candidates && candidates.length > 0) {
          const result: AuditionVoicesToolResult = {
            slate: candidates as VoiceDiscoveryCandidate[],
            consideredCount: candidates.length,
          };
          if (role !== undefined) result.role = role;
          if (sampleText !== undefined && sampleText.trim().length > 0) {
            result.sampleText = sampleText.trim();
          }
          return JSON.stringify(result);
        }

        const convenienceInput = { ...discoveryInput, limit: limit ?? DEFAULT_SUGGESTED_SLATE_SIZE };
        const discovered = await discoverVoices(convenienceInput);
        const result: AuditionVoicesToolResult = {
          slate: discovered.candidates,
          suggestedSlate: true,
          consideredCount: discovered.consideredCount,
        };
        if (role !== undefined) result.role = role;
        if (sampleText !== undefined && sampleText.trim().length > 0) {
          result.sampleText = sampleText.trim();
        }
        if (discovered.warnings !== undefined) result.warnings = discovered.warnings;
        if (result.slate.length === 0) {
          return JSON.stringify({
            ...result,
            error: "No voices matched for audition. Try find_voice with broader filters.",
          });
        }
        return JSON.stringify(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({
          slate: [],
          consideredCount: 0,
          error: `audition_voices failed: ${msg}`,
        } satisfies AuditionVoicesToolResult);
      }
    },
  });
}
