import type { FileToolRawArgs } from "./schema";

const READ_ONLY_CURRENT_COMMANDS = new Set<FileToolRawArgs["command"]>([
  "read",
  "list",
  "stat",
  "glob",
  "grep",
]);

const CURRENT_ROOT_COMMANDS = new Set<FileToolRawArgs["command"]>([
  "list",
  "glob",
  "grep",
]);

/**
 * Recover a read-only unified-file call that omitted its routing fields even
 * though this turn has an explicit Human-selected Current Folder.
 *
 * The default is deliberately narrower than the full file schema:
 * - it never changes an explicit zone or path;
 * - it never applies to a mutating/history command;
 * - read/stat still require a concrete path rather than guessing a target;
 * - list/glob/grep may use `.` because those commands have an unambiguous
 *   selected-folder root operation.
 *
 * This adds no filesystem authority. `zone="current"` continues through the
 * ordinary Desktop relay and its existing contained read policy.
 */
export function applySelectedCurrentFolderReadDefaults(
  raw: FileToolRawArgs,
  currentFolder: string | null,
): FileToolRawArgs {
  const compatible = raw.command === "grep" &&
      (typeof raw.query !== "string" || raw.query.trim().length === 0) &&
      typeof raw.pattern === "string" && raw.pattern.trim().length > 0
    ? { ...raw, query: raw.pattern }
    : raw;

  if (
    !currentFolder ||
    !READ_ONLY_CURRENT_COMMANDS.has(compatible.command) ||
    (compatible.zone !== undefined && compatible.zone !== "current")
  ) {
    return compatible;
  }

  const path = typeof compatible.path === "string" && compatible.path.length > 0
    ? compatible.path
    : CURRENT_ROOT_COMMANDS.has(compatible.command)
      ? "."
      : undefined;
  if (path === undefined) return compatible;

  return {
    ...compatible,
    path,
    zone: compatible.zone ?? "current",
  };
}

/** Precise corrective guidance for semantic fields the runtime cannot infer. */
export function selectedCurrentFolderReadInputError(
  raw: FileToolRawArgs,
  currentFolder: string | null,
): string | null {
  if (!currentFolder || (raw.zone !== undefined && raw.zone !== "current")) return null;
  if (
    (raw.command === "read" || raw.command === "stat") &&
    (typeof raw.path !== "string" || raw.path.trim().length === 0)
  ) {
    return `Error: ${raw.command} requires an exact path. No current file is implicit; choose a relativePath from a prior current-tree result and retry once with path and zone current.`;
  }
  if (raw.command === "grep" && (typeof raw.query !== "string" || raw.query.trim().length === 0)) {
    return "Error: grep requires a non-empty query. Do not repeat this field-only call; choose a concrete regular expression and retry once.";
  }
  if (raw.command === "glob" && (typeof raw.pattern !== "string" || raw.pattern.trim().length === 0)) {
    return "Error: glob requires a non-empty pattern. Do not repeat this field-only call; choose a concrete glob expression and retry once.";
  }
  return null;
}
