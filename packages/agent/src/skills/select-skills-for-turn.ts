/**
 * D263 P1 — per-turn skill selection seam. Pure function: no DB I/O.
 * Selection preserves the turn's tool exposure boundary; skills cannot grant tools.
 */

import { TOOL_EXPOSURE_MANIFEST, type ToolFamilyName } from "../tools/exposure/manifest";

/** Matches `SkillBody` from `@nautilo/db` queries — kept local so unit tests need no DB. */
export interface SkillBody {
  id: string;
  name: string;
  description: string;
  body: string;
  requiresTools: string[];
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Compact guidance for activating authorized, deferred dependencies. */
  activationHint?: string;
}

export interface SelectSkillsForTurnInput {
  skills: readonly SkillBody[];
  /** Tool names bound for this turn. */
  availableToolNames: readonly string[];
  /** Authorized runtime-eligible names, including deferred tools. */
  eligibleToolNames?: readonly string[];
  /** Char budget for the Level-0 catalog lines (`name — description`). */
  catalogBudgetChars?: number;
}

export interface SelectSkillsForTurnResult {
  catalog: SkillCatalogEntry[];
}

/** Default catalog metadata budget (R3). Internal — selector default only. */
const DEFAULT_SKILLS_CATALOG_BUDGET_CHARS = 2_048;

export function requiresToolsMet(skill: SkillBody, available: ReadonlySet<string>): boolean {
  if (skill.requiresTools.length === 0) return true;
  return skill.requiresTools.every((t) => available.has(t));
}

const TOOL_FAMILY_BY_NAME = new Map<string, ToolFamilyName>(
  Object.entries(TOOL_EXPOSURE_MANIFEST.families).flatMap(([family, names]) =>
    names.map((name) => [name, family as ToolFamilyName] as const),
  ),
);

function activationHint(inactiveToolNames: readonly string[]): string | undefined {
  if (inactiveToolNames.length === 0) return undefined;

  const families = new Map<string, string[]>();
  for (const name of inactiveToolNames) {
    const family = TOOL_FAMILY_BY_NAME.get(name) ?? "tool";
    families.set(family, [...(families.get(family) ?? []), name]);
  }
  return [...families]
    .map(([family, names]) => `activate ${family}: ${names.join(", ")}`)
    .join("; ");
}

function catalogLineChars(name: string, description: string, hint?: string): number {
  // `- {name} — {description} ({activation hint})\n`
  return 2 + name.length + 3 + description.length + (hint ? hint.length + 3 : 0) + 1;
}

/**
 * Catalog-only (no auto body injection). Lists skills whose dependencies are
 * eligible, including deferred tools. Bodies remain gated on actually bound
 * tools and load via `view_skill` pull + engaged-set re-injection.
 */
export function selectSkillsForTurn(input: SelectSkillsForTurnInput): SelectSkillsForTurnResult {
  const available = new Set(input.availableToolNames);
  const eligibleToolNames = new Set(input.eligibleToolNames ?? input.availableToolNames);
  const catalogBudget = input.catalogBudgetChars ?? DEFAULT_SKILLS_CATALOG_BUDGET_CHARS;

  const eligible = input.skills.filter((s) => requiresToolsMet(s, eligibleToolNames));

  const catalog: SkillCatalogEntry[] = [];
  let catalogUsed = 0;
  for (const skill of eligible) {
    const hint = activationHint(skill.requiresTools.filter((name) => !available.has(name)));
    const cost = catalogLineChars(skill.name, skill.description, hint);
    if (catalog.length > 0 && catalogUsed + cost > catalogBudget) break;
    catalog.push({
      name: skill.name,
      description: hint ? `${skill.description} (${hint})` : skill.description,
      ...(hint ? { activationHint: hint } : {}),
    });
    catalogUsed += cost;
  }

  return { catalog };
}
