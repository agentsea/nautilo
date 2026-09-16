/**
 * D296 P2 — shared skills resolution seam. Merges official bundled skills
 * with speaker-scoped DB rows (DB shadows official by name — copy-on-write).
 * Used by pre-model ingress, discover_skills, and view_skill so all three
 * read sites see the same catalog.
 */

import { fromRuntimeConfig } from "@nautilo/config";
import { getEnabledBodies, getByName } from "@nautilo/db";
import { OFFICIAL_SKILLS, getBundledSkill, type BundledSkill } from "./bundled";
import type { SkillBody } from "./select-skills-for-turn";

/**
 * Bundled skills that require the office/Collabora tools. When the office
 * feature flag is off, these must be withheld everywhere (discover, per-turn
 * injection, view) — the office tools they require are also not registered.
 */
export const OFFICE_BUNDLED_SKILL_NAMES: ReadonlySet<string> = new Set([
  "office-control",
  "office-calc",
  "office-impress",
]);

/** True when a bundled skill must be hidden because office is disabled. */
export function isOfficeSkillHidden(name: string): boolean {
  return OFFICE_BUNDLED_SKILL_NAMES.has(name) && !fromRuntimeConfig().nautilo_office_enabled;
}

function bundledToSkillBody(skill: BundledSkill): SkillBody {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    requiresTools: skill.requiresTools,
  };
}

/**
 * Pure merge: official base, DB rows shadow by `name`, DB-only rows appended.
 * Returns sorted by `name` ascending with no duplicate names.
 */
export function mergeOfficialWithDbRows(
  official: SkillBody[],
  dbRows: SkillBody[],
): SkillBody[] {
  const byName = new Map<string, SkillBody>();

  for (const skill of official) {
    byName.set(skill.name, skill);
  }

  for (const row of dbRows) {
    byName.set(row.name, row);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveEnabledBodies(
  agentId: string,
  userId: string,
  opts: { isGuest: boolean },
): Promise<SkillBody[]> {
  if (opts.isGuest) return [];

  const dbRows = await getEnabledBodies(agentId, userId);
  const officialAsSkillBody = OFFICIAL_SKILLS
    .filter((skill) => !isOfficeSkillHidden(skill.name))
    .map(bundledToSkillBody);
  return mergeOfficialWithDbRows(officialAsSkillBody, dbRows);
}

export async function resolveByName(
  agentId: string,
  userId: string,
  name: string,
  opts: { isGuest: boolean },
): Promise<SkillBody | null> {
  if (opts.isGuest) return null;

  const row = await getByName(agentId, userId, name);
  if (row) {
    if (!row.enabled) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      body: row.body,
      requiresTools: row.requiresTools,
    };
  }

  if (isOfficeSkillHidden(name)) return null;
  const bundled = getBundledSkill(name);
  return bundled ? bundledToSkillBody(bundled) : null;
}
