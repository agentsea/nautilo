/**
 * Git evidence + run-metadata + change detection — port of OpenWiki's
 * `utils.ts`. Written against a minimal fs/git surface so the future
 * Task-backed subagent (or any host) can supply it however it executes.
 */

import { warn } from "@nautilo/logger";
import { DEFAULT_WIKI_DIR, METADATA_FILENAME, type RepoDocsCommand } from "./constants";

/** Minimal fs/git surface this module needs from its host. */
export interface RepoGitSurface {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  git(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface UpdateMetadata {
  updatedAt: string;
  command: RepoDocsCommand;
  gitHead?: string | undefined;
  workhorseModel: string;
  finalizeModel: string;
}

function metadataPath(wikiDir: string): string {
  return `${wikiDir}/${METADATA_FILENAME}`;
}

export async function readLastUpdate(
  backend: RepoGitSurface,
  wikiDir: string = DEFAULT_WIKI_DIR,
): Promise<UpdateMetadata | null> {
  try {
    const raw = await backend.readFile(metadataPath(wikiDir));
    const parsed = JSON.parse(raw) as Partial<UpdateMetadata>;
    if (typeof parsed.updatedAt === "string" && typeof parsed.command === "string") {
      return {
        updatedAt: parsed.updatedAt,
        command: parsed.command === "init" ? "init" : "update",
        gitHead: typeof parsed.gitHead === "string" ? parsed.gitHead : undefined,
        workhorseModel: parsed.workhorseModel ?? "",
        finalizeModel: parsed.finalizeModel ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeLastUpdateMetadata(
  backend: RepoGitSurface,
  wikiDir: string,
  meta: Omit<UpdateMetadata, "updatedAt" | "gitHead"> & { gitHead?: string | undefined },
): Promise<void> {
  const full: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command: meta.command,
    gitHead: meta.gitHead,
    workhorseModel: meta.workhorseModel,
    finalizeModel: meta.finalizeModel,
  };
  await backend.writeFile(metadataPath(wikiDir), `${JSON.stringify(full, null, 2)}\n`);
}

async function gitText(backend: RepoGitSurface, args: string[]): Promise<string> {
  try {
    const res = await backend.git(args);
    return [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (e) {
    warn(`[repo-docs] git ${args.join(" ")} failed: ${(e as Error).message}`);
    return "";
  }
}

function section(cmd: string, output: string): string {
  return [`$ git ${cmd}`, output.length > 0 ? output : "(no output)"].join("\n");
}

export async function getGitHead(backend: RepoGitSurface): Promise<string | undefined> {
  const head = await gitText(backend, ["rev-parse", "HEAD"]);
  return head.length > 0 ? head : undefined;
}

/**
 * Produce the git-evidence block passed to init/update prompts. For updates we
 * diff since the previously recorded gitHead (or timestamp) so the agent can be
 * surgical about what changed.
 */
export async function buildGitContext(
  backend: RepoGitSurface,
  command: RepoDocsCommand,
  lastUpdate: UpdateMetadata | null,
): Promise<string> {
  const sections: string[] = [];
  sections.push(section("status --short", await gitText(backend, ["status", "--short"])));
  const head = await getGitHead(backend);
  sections.push(section("rev-parse HEAD", head ?? "(unknown)"));

  if (command === "update" && lastUpdate?.gitHead) {
    sections.push(
      section(
        `log ${lastUpdate.gitHead}..HEAD --name-status --oneline`,
        await gitText(backend, ["log", `${lastUpdate.gitHead}..HEAD`, "--name-status", "--oneline"]),
      ),
    );
  } else if (command === "update" && lastUpdate?.updatedAt) {
    sections.push(
      section(
        `log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        await gitText(backend, ["log", "--since", lastUpdate.updatedAt, "--name-status", "--oneline"]),
      ),
    );
  } else {
    if (command === "update") sections.push("No prior OpenWiki update timestamp was found.");
    sections.push(
      section(
        "log --max-count=20 --name-status --oneline",
        await gitText(backend, ["log", "--max-count=20", "--name-status", "--oneline"]),
      ),
    );
  }

  sections.push(section("diff --name-status HEAD", await gitText(backend, ["diff", "--name-status", "HEAD"])));
  return sections.join("\n\n");
}

export function formatLastUpdate(lastUpdate: UpdateMetadata | null): string {
  return lastUpdate === null
    ? "No previous OpenWiki update metadata was found."
    : JSON.stringify(lastUpdate, null, 2);
}
