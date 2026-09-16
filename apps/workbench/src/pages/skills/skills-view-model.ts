import type { SkillListItem } from "../../lib/skills-api";

/**
 * Friendly display title derived from the slug name: split on `-`/`_`,
 * Title-Case each word. e.g. "interactive-artifact-authoring" →
 * "Interactive Artifact Authoring". The slug stays the identity used by
 * view_skill / discover_skills / skill_manage, so callers should still
 * surface the raw slug somewhere; this is presentation only.
 */
export function formatSkillTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type SkillRowKind = "yours" | "official-untouched" | "official-customized";

export function rowKind(skill: Pick<SkillListItem, "official" | "forked">): SkillRowKind {
  if (!skill.official) return "yours";
  if (skill.forked) return "official-customized";
  return "official-untouched";
}

export interface RowAffordances {
  badge: string | null;
  canToggle: boolean;
  toggleHint?: string;
  canEdit: boolean;
  canDelete: boolean;
  canCustomize: boolean;
  canReset: boolean;
}

export function rowAffordances(kind: SkillRowKind): RowAffordances {
  switch (kind) {
    case "yours":
      return {
        badge: null,
        canToggle: true,
        canEdit: true,
        canDelete: true,
        canCustomize: false,
        canReset: false,
      };
    case "official-untouched":
      return {
        badge: "★ official",
        canToggle: false,
        toggleHint: "Customize to disable",
        canEdit: false,
        canDelete: false,
        canCustomize: true,
        canReset: false,
      };
    case "official-customized":
      return {
        badge: "★ official · customized",
        canToggle: true,
        canEdit: true,
        canDelete: false,
        canCustomize: false,
        canReset: true,
      };
  }
}

export function partitionSkills(skills: SkillListItem[]): {
  official: SkillListItem[];
  yours: SkillListItem[];
} {
  const official: SkillListItem[] = [];
  const yours: SkillListItem[] = [];
  for (const skill of skills) {
    if (skill.official) {
      official.push(skill);
    } else {
      yours.push(skill);
    }
  }
  return { official, yours };
}
