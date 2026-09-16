import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { genieRecoveryResult } from "../genie-recovery";

/**
 * D513 — persisted semantic recovery; clients only navigate after a Human
 * clicks their local recovery affordance.
 */
interface LaunchCustomizationContext {
  ownerId?: string;
}

export function createLaunchCustomizationTool(
  _context?: LaunchCustomizationContext,
) {
  return new DynamicStructuredTool({
    name: "launch_customization",
    description: `Open the customization wizard for the user so they can shape your personality, voice, avatar, and language.

Call this ONLY after you have offered and the user has clearly said yes ("customize you", "open it", "sure", etc.). Never call it unprompted or on the first turn. It creates a Human-clicked recovery card and never opens UI automatically.`,

    schema: z.object({
      confirmed: z
        .boolean()
        .describe(
          "Must be true — set only after the user has explicitly agreed to open customization.",
        ),
    }),

    func: ({ confirmed }): Promise<string> => {
      if (!confirmed) {
        return Promise.resolve(
          "launch_customization not sent: only call this after the user agrees to open customization. Offer first, then wait for a yes.",
        );
      }
      return Promise.resolve(
        genieRecoveryResult("launch_customization", "Customization is ready when you are. Open Customize Genie to continue."),
      );
    },
  });
}
