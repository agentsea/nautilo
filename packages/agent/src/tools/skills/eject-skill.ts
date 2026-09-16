/**
 * eject — drop a pulled skill body from engaged context (§2.1).
 *
 * Removes the name from the thread's engaged-set so the next `pre-model`
 * rebuild omits the body. Un-pulled names are a clean no-op.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ViewSkillContext } from "./view-skill";

export function createEjectSkillTool(context?: ViewSkillContext) {
  return new DynamicStructuredTool({
    name: "eject",
    description:
      "Drop a skill body you previously pulled with view_skill when it is no longer relevant " +
      "or the name/description misled. It stays visible for the rest of THIS turn (already in " +
      "context), then on your NEXT turn its full text is removed and only a short " +
      "'[skill \"x\" ejected]' marker remains. Pull it again with view_skill if you need it later.",
    schema: z.object({
      name: z
        .string()
        .describe("Skill slug [a-z0-9-] — the skill to eject from engaged context"),
    }),
    // Synchronous (mutates an in-memory engaged-set), but DynamicStructuredTool
    // requires a Promise<string>-returning func — same shape as discover_tools.
    // eslint-disable-next-line @typescript-eslint/require-await
    func: async ({ name }): Promise<string> => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return "eject failed: no agent or user in context.";
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        return "eject failed: skill name is required.";
      }

      context?.engagedSkills?.eject(trimmedName);
      return `Ejected skill "${trimmedName}".`;
    },
  });
}
