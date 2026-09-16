/**
 * view_command — pull one command body into context (D379 / Stack 145).
 *
 * Sibling of `view_skill` (minus the engaged-set handle — commands are
 * not per-turn engaged). Read-only, guest-tier. Returns the body of ONE
 * command by name, falling back to the bundled official registry when no
 * DB row exists. Miss, disabled, or cross-user → a clean "not found"
 * message (never another user's command).
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveCommandByName } from "@nautilo/agent";

/** Header prefix for the injected command body block. */
const COMMAND_BODY_HEADER_PREFIX = `\n\n## Command: `;

function buildCommandBodyBlock(cmd: { name: string; body: string }): string {
  return `${COMMAND_BODY_HEADER_PREFIX}${cmd.name}\n\n${cmd.body}`;
}

export interface ViewCommandContext {
  ownerId?: string;
  agentId?: string;
  actorRole?: string;
}

export function createViewCommandTool(context?: ViewCommandContext) {
  return new DynamicStructuredTool({
    name: "view_command",
    description:
      "Read the full markdown body of one of your commands by name. " +
      "Use this when the catalog or discover_commands results suggest a command is relevant. " +
      "Returns commands you own for this agent, or an official bundled command when no DB row exists.",
    schema: z.object({
      name: z
        .string()
        .describe("Command slug [a-z0-9-] — the command to read"),
    }),
    func: async ({ name }) => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return "view_command failed: no agent or user in context.";
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        return 'Command "" not found.';
      }

      try {
        const command = await resolveCommandByName(agentId, userId, trimmedName, {
          isGuest: context?.actorRole === "guest",
        });
        if (!command) {
          return `Command "${trimmedName}" not found.`;
        }
        return buildCommandBodyBlock({ name: trimmedName, body: command.body });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `view_command failed: ${msg}`;
      }
    },
  });
}
