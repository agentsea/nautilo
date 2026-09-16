/**
 * view_skill — pull one enabled skill body into context (R5 / §2.1).
 *
 * Sibling of `discover_tools`: read-only, guest-tier. Returns the body of
 * ONE of the current speaker's enabled skills by name. Miss, disabled, or
 * cross-user → a clean "not found" message (never another user's skill).
 *
 * On success: marks the skill engaged (via context handle) and returns the
 * body headered so `collectSkillNamesAlreadyInContext` dedups same-turn
 * re-injection in `pre-model`.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { buildSkillBodyBlock } from "../../prompts/templates";
import { resolveByName } from "../../skills/resolve-skills";

/** Mutable engaged-set handle — wired by tool-factory sites from graph state. */
export interface EngagedSkillsHandle {
  engage(name: string): void;
  eject(name: string): void;
  toArray(): string[];
}

export function createEngagedSkillsHandle(initial: readonly string[] = []): EngagedSkillsHandle {
  const set = new Set(initial);
  return {
    engage(name: string) {
      const trimmed = name.trim();
      if (trimmed) set.add(trimmed);
    },
    eject(name: string) {
      set.delete(name.trim());
    },
    toArray() {
      return [...set];
    },
  };
}

export interface ViewSkillContext {
  ownerId?: string;
  agentId?: string;
  actorRole?: string;
  engagedSkills?: EngagedSkillsHandle;
}

export function createViewSkillTool(context?: ViewSkillContext) {
  return new DynamicStructuredTool({
    name: "view_skill",
    description:
      "Read the full markdown body of one of your enabled on-demand skills by name. " +
      "Use this when the catalog or discover_skills results suggest a skill is relevant. " +
      "Returns only skills you own for this agent.",
    schema: z.object({
      name: z
        .string()
        .describe("Skill slug [a-z0-9-] — must be one of your enabled skills"),
    }),
    func: async ({ name }) => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (!userId || !agentId) {
        return "view_skill failed: no agent or user in context.";
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        return 'Skill "" not found.';
      }

      try {
        const skill = await resolveByName(agentId, userId, trimmedName, {
          isGuest: context?.actorRole === "guest",
        });
        if (!skill) {
          return `Skill "${trimmedName}" not found.`;
        }
        context?.engagedSkills?.engage(trimmedName);
        return buildSkillBodyBlock({ name: trimmedName, body: skill.body });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `view_skill failed: ${msg}`;
      }
    },
  });
}
