import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { check } from "@nautilo/config-guard";
import { DEFAULT_VOICE_KEY } from "@nautilo/types";
import { getProfile } from "../../store/profile-store";

interface OnboardingStatusContext {
  ownerId?: string;
}

function keyLine(name: string, k: { status: string; required: boolean }): string {
  const req = k.required ? " (required)" : "";
  return `${name}${req}: ${k.status}`;
}

export function createOnboardingStatusTool(context?: OnboardingStatusContext) {
  return new DynamicStructuredTool({
    name: "onboarding_status",
    description: `Combined onboarding diagnostic: profile state, key health, and concrete next steps.

Use when the user seems new, asks about setup, or you want a structured snapshot before helping with configuration.
Set include_key_health true only if you need live provider verification (slow, uses network).`,

    schema: z.object({
      include_key_health: z
        .boolean()
        .default(false)
        .describe("If true, ping providers to verify keys (slow)"),
    }),

    func: async ({ include_key_health }) => {
      const ownerId = context?.ownerId ?? "00000000-0000-0000-0000-000000000000";

      try {
        const [result, profile] = await Promise.all([
          check({ validate: include_key_health }),
          getProfile(ownerId),
        ]);

        const lines: string[] = ["== Onboarding Status ==", ""];

        lines.push(`Profile exists: ${profile ? "yes" : "no"}`);
        if (profile) {
          lines.push(`Onboarding completed: ${profile.onboardingCompleted}`);
          lines.push(`Welcome message sent: ${profile.welcomeMessageSent}`);
          lines.push(`Soul file: ${profile.soulFile ? "present" : "missing"}`);
          lines.push(`Name: ${profile.name}`);
          const primary = profile.voices[DEFAULT_VOICE_KEY];
          lines.push(
            `Primary voice: ${primary?.voiceName ?? "none"} (${primary?.voiceId ?? "no id"})`,
          );
        }

        lines.push("", "== Key Status ==");
        const byId = new Map(result.keys.map((k) => [k.id, k]));
        const pick = (id: string, label: string) => {
          const k = byId.get(id);
          return k ? keyLine(label, k) : `${label}: unknown`;
        };
        lines.push(pick("anthropic", "Anthropic"));
        lines.push(pick("openai", "OpenAI"));
        lines.push(pick("openrouter", "OpenRouter"));
        lines.push(pick("google", "Google"));
        lines.push(pick("fireworks", "Fireworks"));
        lines.push(pick("elevenlabs", "ElevenLabs"));
        lines.push(pick("tavily", "Tavily"));

        const s = result.summary;
        lines.push("");
        lines.push(
          `Summary: LLM=${s.hasLlm} embeddings=${s.hasEmbeddings} voice=${s.hasVoice} search=${s.hasSearch}`,
        );

        lines.push("", "== Recommendations ==");
        const rec: string[] = [];
        let n = 1;
        if (!s.hasLlm) {
          rec.push(`${n++}. Add at least one supported chat-provider key (for example OpenRouter, Anthropic, OpenAI, Google, Fireworks, or Venice) via the setup wizard or update_config.`);
        }
        if (!s.hasEmbeddings) {
          rec.push(`${n++}. Add OPENROUTER_API_KEY, VENICE_API_KEY, or OPENAI_API_KEY for embeddings and memory features.`);
        }
        if (!profile) {
          rec.push(`${n++}. Create a profile: complete /setup in the browser or use manage_profile update.`);
        } else if (!profile.onboardingCompleted) {
          rec.push(`${n++}. Finish onboarding in the browser (/setup) or set onboardingCompleted via manage_profile when appropriate.`);
        }
        // D112 Phase 19.6 — DO NOT recommend `regenerate_soul` from
        // onboarding_status. Soul regeneration is a user-initiated
        // action only; the model auto-prompting itself to call it
        // (which the previous "Generate a soul file with
        // regenerate_soul …" line caused) blocks chat with an
        // approval modal on the very first turn after randomization.
        // The seeded archetype already populates `profile.soulFile` at
        // setup time, so missing-soul is no longer the expected fresh
        // state. If a user genuinely wants a new soul, they will ask
        // explicitly and the model can call `regenerate_soul` then.
        if (!s.hasVoice) {
          rec.push(`${n++}. Add ELEVENLABS_API_KEY for voice output (optional).`);
        }
        if (rec.length === 0) {
          rec.push("No critical gaps — profile and keys look sufficient for normal operation.");
        }
        lines.push(...rec);

        return lines.join("\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `onboarding_status failed: ${msg}`;
      }
    },
  });
}
