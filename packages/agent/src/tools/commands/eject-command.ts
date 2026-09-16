/**
 * eject_command — drop a pulled command body from context (D379 / Stack 145).
 *
 * Structural mirror of `eject` (skills). Commands are NOT per-turn engaged
 * (no `EngagedCommandsHandle` — see view-command.ts), so this tool does
 * not mutate any engaged-set; it is a clean no-op confirmation that keeps
 * the command_* family symmetric with the skill_* family. Future revisions
 * that introduce per-turn command engagement should wire a handle here.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export interface EjectCommandContext {
  ownerId?: string;
  agentId?: string;
}

export function createEjectCommandTool(context?: EjectCommandContext) {
  return new DynamicStructuredTool({
    name: "eject_command",
    description:
      "Drop a command body you previously pulled with view_command when it is no longer relevant " +
      "or the name/description misled. Commands are not held in a per-turn engaged-set, so this " +
      "is a structural no-op: it confirms the ejection and removes nothing from context. Pull it " +
      "again with view_command if you need it later.",
    schema: z.object({
      name: z
        .string()
        .describe("Command slug [a-z0-9-] — the command to eject"),
    }),
    func: ({ name }): Promise<string> => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return Promise.resolve(
          "eject_command failed: no agent or user in context.",
        );
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        return Promise.resolve(
          "eject_command failed: command name is required.",
        );
      }

      return Promise.resolve(`Ejected command "${trimmedName}".`);
    },
  });
}
