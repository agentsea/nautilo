/**
 * repo-docs — salvaged primitives for the Task-backed build (ISSUE-D363).
 *
 * HISTORY / WHY THIS DIRECTORY IS SMALL: the first implementation built a
 * bespoke runtime around these files (own ReAct loop, a `RepoBackend`
 * abstraction with in-process/container backends, a Docker work-container
 * substrate) instead of using Nautilo's existing Task / scope-subagent
 * primitive. That architecture was scrapped 2026-07-02 (see ISSUE-D363
 * decision log). What remains here is the durable IP only:
 *
 *   - prompt.ts      — the ported OpenWiki system/user prompts (MIT,
 *                      langchain-ai/openwiki) — the actual value
 *   - paths.ts       — repo-relative path normalization + traversal guard
 *   - git-context.ts — git evidence block + run metadata for init/update
 *   - this file      — shared constants incl. the read-only git allowlist
 *
 * There is deliberately NO runtime here. The Task-backed subagent (spec'd
 * before implementation) consumes these.
 */

/** Default directory (repo-relative) the wiki is written into. */
export const DEFAULT_WIKI_DIR = "openwiki";

/** Metadata filename (inside the wiki dir) tracking the last successful run. */
export const METADATA_FILENAME = ".openwiki-metadata.json";

export type RepoDocsCommand = "init" | "update";

/**
 * Directories never walked by discovery and never surfaced by listings. Keeps
 * the agent off build output, VCS internals, and generated-wiki noise.
 */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  ".cache",
  "out",
  "target",
  ".venv",
  "__pycache__",
];

/**
 * Read-only git subcommands the agent-facing `run_git` surface is permitted
 * to invoke. Mutation/network verbs (push, commit, clone, fetch, reset,
 * checkout, config, ...) are excluded by construction — orchestration code,
 * never the LLM, owns git mutation.
 */
export const ALLOWED_GIT_SUBCOMMANDS: readonly string[] = [
  "log",
  "show",
  "blame",
  "status",
  "diff",
  "rev-parse",
  "ls-files",
  "shortlog",
  "describe",
  "rev-list",
  "cat-file",
  "remote",
];

/** Branch name for a doc run, e.g. `openwiki/init-20260702-112805`. */
export function docBranchName(command: RepoDocsCommand): string {
  const iso = new Date().toISOString(); // 2026-07-02T11:28:05.123Z
  const ts = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `openwiki/${command}-${ts}`;
}
