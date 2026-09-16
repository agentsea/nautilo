import { DynamicStructuredTool } from "@langchain/core/tools";
import { getToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import {
  getByName,
  setSkillEnabled,
  softDeleteSkill,
  upsertSkill,
} from "../../../../db/src/queries/skills";
import { findPersonalAgentsForUser, getUserCapabilities } from "@nautilo/trust";

/** R10 — agentskills.io-compatible field constraints (internal to validation). */
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
const SKILL_NAME_MAX_LEN = 64;
const SKILL_DESCRIPTION_MAX_LEN = 1024;

export interface SkillFieldInput {
  name: string;
  description: string;
  body: string;
  requiresTools?: string[] | undefined;
}

export type SkillFieldValidationResult =
  | {
      ok: true;
      value: {
        name: string;
        description: string;
        body: string;
        requiresTools: string[];
      };
    }
  | {
      ok: false;
      error: string;
    };

export function validateSkillFields(input: SkillFieldInput): SkillFieldValidationResult {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();

  if (!name) {
    return { ok: false, error: "name is required" };
  }
  if (name.length > SKILL_NAME_MAX_LEN) {
    return { ok: false, error: `name must be at most ${SKILL_NAME_MAX_LEN} characters` };
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, error: "name must match [a-z0-9-]" };
  }
  if (!description) {
    return { ok: false, error: "description is required" };
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LEN) {
    return {
      ok: false,
      error: `description must be at most ${SKILL_DESCRIPTION_MAX_LEN} characters`,
    };
  }
  if (!body) {
    return { ok: false, error: "body markdown is required" };
  }

  const requiresTools = [...new Set((input.requiresTools ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0))];

  return {
    ok: true,
    value: { name, description, body, requiresTools },
  };
}

export function unknownSkillTools(
  requiresTools: readonly string[],
  catalog: { has(name: string): boolean },
): string[] {
  return [...new Set(requiresTools)].filter((name) => !catalog.has(name)).sort();
}

/** Actor-mirror check: `actors.owner_id = userId` for this `agentId`. */
export async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
  const owned = await findPersonalAgentsForUser(userId);
  return owned.some((row) => row.agentId === agentId);
}

/** permission-model.md §7 item 9 — self-edit-or-cap gate for skill authoring. */
export async function canManageSkillsForAgent(
  userId: string,
  agentId: string,
): Promise<boolean> {
  if (await ownsAgent(userId, agentId)) return true;
  const caps = await getUserCapabilities(userId);
  return caps.includes("manage_agents");
}

interface SkillManageContext {
  ownerId?: string;
  agentId?: string;
}

const requiresToolsSchema = z.array(z.string()).optional();

export function createSkillManageTool(context?: SkillManageContext) {
  return new DynamicStructuredTool({
    name: "skill_manage",
    description: `Create, update, delete, or enable/disable your on-demand instruction skills.

Skills are instructions-only modules injected before each turn when enabled and relevant.
Use create/update with name, description, body (markdown), and optional requiresTools. Usually omit requiresTools and use available tools as needed; set it only to known exposed tool names that are essential for the Skill to work.
Use enable/disable to toggle without deleting. Use delete to soft-remove a skill.`,

    schema: z.object({
      action: z
        .enum(["create", "update", "delete", "enable", "disable"])
        .describe("create/update upsert; delete soft-removes; enable/disable toggle"),
      name: z.string().describe("Skill slug [a-z0-9-], max 64 chars"),
      description: z
        .string()
        .optional()
        .describe("Catalog line (required for create/update), max 1024 chars"),
      body: z.string().optional().describe("SKILL.md markdown body (required for create/update)"),
      requiresTools: requiresToolsSchema.describe(
        "Optional tool names; skill is withheld when any are absent from the turn",
      ),
      enabled: z
        .boolean()
        .optional()
        .describe("Initial enabled state for create/update (default true)"),
    }),

    func: async ({ action, name, description, body, requiresTools, enabled }) => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return "skill_manage failed: no agent or user in context.";
      }

      try {
        if (!(await canManageSkillsForAgent(userId, agentId))) {
          return "skill_manage denied: you may only manage skills on agents you own, unless you hold manage_agents.";
        }

        const trimmedName = name.trim();

        if (action === "delete") {
          const deleted = await softDeleteSkill(agentId, userId, trimmedName);
          return deleted
            ? `Skill "${trimmedName}" deleted.`
            : `Skill "${trimmedName}" not found.`;
        }

        if (action === "enable" || action === "disable") {
          const row = await setSkillEnabled(
            agentId,
            userId,
            trimmedName,
            action === "enable",
          );
          if (!row) {
            return `Skill "${trimmedName}" not found.`;
          }
          return `Skill "${trimmedName}" is now ${row.enabled ? "enabled" : "disabled"}.`;
        }

        if (description === undefined || body === undefined) {
          return "skill_manage failed: description and body are required for create/update.";
        }

        const validated = validateSkillFields({
          name: trimmedName,
          description,
          body,
          requiresTools,
        });
        if (!validated.ok) {
          return `skill_manage failed: ${validated.error}`;
        }

        if (validated.value.requiresTools.length > 0) {
          const catalog = getToolCatalog();
          if (!catalog) {
            return "skill_manage failed: tool catalog is unavailable.";
          }
          const unknown = unknownSkillTools(validated.value.requiresTools, catalog);
          if (unknown.length > 0) {
            return `skill_manage failed: unknown required tools: ${unknown.join(", ")}.`;
          }
        }

        if (action === "create") {
          const existing = await getByName(agentId, userId, validated.value.name);
          if (existing) {
            return `skill_manage failed: skill "${validated.value.name}" already exists (use update).`;
          }
        }

        if (action === "update") {
          const existing = await getByName(agentId, userId, validated.value.name);
          if (!existing) {
            return `skill_manage failed: skill "${validated.value.name}" not found (use create).`;
          }
        }

        const row = await upsertSkill({
          agentId,
          userId,
          name: validated.value.name,
          description: validated.value.description,
          body: validated.value.body,
          requiresTools: validated.value.requiresTools,
          enabled: enabled ?? true,
          source: "agent",
        });

        return `Skill "${row.name}" ${action === "create" ? "created" : "updated"} (${row.enabled ? "enabled" : "disabled"}).`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `skill_manage failed: ${msg}`;
      }
    },
  });
}
