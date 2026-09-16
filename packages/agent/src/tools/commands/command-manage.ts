/**
 * D379 (Stack 145) — `command_manage` mirrors `skill_manage` one-to-one,
 * minus `requiresTools` (commands carry no tool-gating). Create/update/
 * enable/disable/delete a slash-command via the `@nautilo/db` command
 * queries, gated by the same `manage_agents` two-gate (self-edit-or-cap)
 * as skill authoring.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getCommandByName,
  setCommandEnabled,
  softDeleteCommand,
  upsertCommand,
} from "@nautilo/db";
import { findPersonalAgentsForUser, getUserCapabilities } from "@nautilo/trust";

/** R10 — agentskills.io-compatible field constraints (internal to validation). */
const COMMAND_NAME_PATTERN = /^[a-z0-9-]+$/;
const COMMAND_NAME_MAX_LEN = 64;
const COMMAND_DESCRIPTION_MAX_LEN = 1024;

export interface CommandFieldInput {
  name: string;
  description: string;
  body: string;
}

export type CommandFieldValidationResult =
  | {
      ok: true;
      value: {
        name: string;
        description: string;
        body: string;
      };
    }
  | {
      ok: false;
      error: string;
    };

function validateCommandFields(
  input: CommandFieldInput,
): CommandFieldValidationResult {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();

  if (!name) {
    return { ok: false, error: "name is required" };
  }
  if (name.length > COMMAND_NAME_MAX_LEN) {
    return { ok: false, error: `name must be at most ${COMMAND_NAME_MAX_LEN} characters` };
  }
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return { ok: false, error: "name must match [a-z0-9-]" };
  }
  if (!description) {
    return { ok: false, error: "description is required" };
  }
  if (description.length > COMMAND_DESCRIPTION_MAX_LEN) {
    return {
      ok: false,
      error: `description must be at most ${COMMAND_DESCRIPTION_MAX_LEN} characters`,
    };
  }
  if (!body) {
    return { ok: false, error: "body markdown is required" };
  }

  return {
    ok: true,
    value: { name, description, body },
  };
}

/** Actor-mirror check: `actors.owner_id = userId` for this `agentId`. */
async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
  const owned = await findPersonalAgentsForUser(userId);
  return owned.some((row) => row.agentId === agentId);
}

/** permission-model.md §7 item 9 — self-edit-or-cap gate for command authoring. */
async function canManageCommandsForAgent(
  userId: string,
  agentId: string,
): Promise<boolean> {
  if (await ownsAgent(userId, agentId)) return true;
  const caps = await getUserCapabilities(userId);
  return caps.includes("manage_agents");
}

interface CommandManageContext {
  ownerId?: string;
  agentId?: string;
}

export function createCommandManageTool(context?: CommandManageContext) {
  return new DynamicStructuredTool({
    name: "command_manage",
    description: `Create, update, delete, or enable/disable your on-demand slash-commands.

Commands are prompt-injection modules invoked by name (/name) when enabled.
Use create/update with name, description, and body (markdown).
Use enable/disable to toggle without deleting. Use delete to soft-remove a command.`,

    schema: z.object({
      action: z
        .enum(["create", "update", "delete", "enable", "disable"])
        .describe("create/update upsert; delete soft-removes; enable/disable toggle"),
      name: z.string().describe("Command slug [a-z0-9-], max 64 chars"),
      description: z
        .string()
        .optional()
        .describe("Catalog line (required for create/update), max 1024 chars"),
      body: z
        .string()
        .optional()
        .describe("Command markdown body (required for create/update)"),
      enabled: z
        .boolean()
        .optional()
        .describe("Initial enabled state for create/update (default true)"),
    }),

    func: async ({ action, name, description, body, enabled }) => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return "command_manage failed: no agent or user in context.";
      }

      try {
        if (!(await canManageCommandsForAgent(userId, agentId))) {
          return "command_manage denied: you may only manage commands on agents you own, unless you hold manage_agents.";
        }

        const trimmedName = name.trim();

        if (action === "delete") {
          const deleted = await softDeleteCommand(agentId, userId, trimmedName);
          return deleted
            ? `Command "${trimmedName}" deleted.`
            : `Command "${trimmedName}" not found.`;
        }

        if (action === "enable" || action === "disable") {
          const row = await setCommandEnabled(
            agentId,
            userId,
            trimmedName,
            action === "enable",
          );
          if (!row) {
            return `Command "${trimmedName}" not found.`;
          }
          return `Command "${trimmedName}" is now ${row.enabled ? "enabled" : "disabled"}.`;
        }

        if (description === undefined || body === undefined) {
          return "command_manage failed: description and body are required for create/update.";
        }

        const validated = validateCommandFields({
          name: trimmedName,
          description,
          body,
        });
        if (!validated.ok) {
          return `command_manage failed: ${validated.error}`;
        }

        if (action === "create") {
          const existing = await getCommandByName(agentId, userId, validated.value.name);
          if (existing) {
            return `command_manage failed: command "${validated.value.name}" already exists (use update).`;
          }
        }

        if (action === "update") {
          const existing = await getCommandByName(agentId, userId, validated.value.name);
          if (!existing) {
            return `command_manage failed: command "${validated.value.name}" not found (use create).`;
          }
        }

        const row = await upsertCommand({
          agentId,
          userId,
          name: validated.value.name,
          description: validated.value.description,
          body: validated.value.body,
          enabled: enabled ?? true,
          source: "agent",
        });

        return `Command "${row.name}" ${action === "create" ? "created" : "updated"} (${row.enabled ? "enabled" : "disabled"}).`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `command_manage failed: ${msg}`;
      }
    },
  });
}
