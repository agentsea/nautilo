import type { CommandListItem } from "../../lib/commands-api";

/**
 * Friendly display title derived from the slug name: split on `-`/`_`,
 * Title-Case each word. e.g. "interactive-artifact-authoring" →
 * "Interactive Artifact Authoring". The slug stays the identity used by
 * the command APIs, so callers should still surface the raw slug
 * somewhere; this is presentation only.
 */
export function formatCommandTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type CommandRowKind = "yours" | "official-untouched" | "official-customized";

export function rowKind(command: Pick<CommandListItem, "official" | "forked">): CommandRowKind {
  if (!command.official) return "yours";
  if (command.forked) return "official-customized";
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

export function rowAffordances(kind: CommandRowKind): RowAffordances {
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

export function partitionCommands(commands: CommandListItem[]): {
  official: CommandListItem[];
  yours: CommandListItem[];
} {
  const official: CommandListItem[] = [];
  const yours: CommandListItem[] = [];
  for (const command of commands) {
    if (command.official) {
      official.push(command);
    } else {
      yours.push(command);
    }
  }
  return { official, yours };
}
