/**
 * D363 — repo-docs Task wrapper (orchestrator-owned; the LLM never mutates git).
 *
 * A thin pre/post wrapper around the standard `runScopeSubagentUntilPause`
 * runner for `preset === "repo_docs"` tasks:
 *   - PRE  (`prepareRepoDocsWorkspace`): resolve the target repo (local path or
 *     git URL), create an isolated `openwiki/<mode>-<ts>` worktree/branch, and
 *     compose the run brief = ported OpenWiki prompt + PRE-INJECTED git evidence.
 *     The executor points the subagent's `currentFolder` at the worktree and
 *     hands it this brief; the agent writes docs via the `file` tool only.
 *   - POST (`commitAndPublish`): commit the generated documentation directory
 *     pointer as a bot author, publish per `metadata.publish`, and record run
 *     metadata. `cleanup` tears the worktree down on abort/failure.
 *
 * Everything git-mutating lives here, not in the agent loop.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile, stat } from "node:fs/promises";
import {
  buildGitContext,
  createSystemPrompt,
  createUserPrompt,
  docBranchName,
  DEFAULT_WIKI_DIR,
  readLastUpdate,
  writeLastUpdateMetadata,
  type RepoDocsCommand,
  type RepoGitSurface,
} from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";

const execFileAsync = promisify(execFile);

const BOT_AUTHOR = { name: "Nautilo OpenWiki", email: "openwiki@nautilo" } as const;
const CLONE_CACHE_SUBDIR = ".nautilo/repo-docs/clones";

type PublishLevel = "branch" | "push" | "pr";

export interface RepoDocsWorkspace {
  workDir: string;
  branch: string;
  mode: RepoDocsCommand;
  brief: string;
  /** Commit the generated docs on the branch + publish per level; returns a summary. */
  commitAndPublish(): Promise<string>;
  /** Remove the worktree (local) on abort/failure. Idempotent, never throws. */
  cleanup(): Promise<void>;
}

interface RepoDocsMeta {
  target: string;
  mode: "init" | "update" | "auto";
  publish: PublishLevel;
  instructions?: string | undefined;
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 4_000_000,
      timeout: timeoutMs,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? e),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function isGitUrl(t: string): boolean {
  return /^https?:\/\//i.test(t) || /^git@/i.test(t) || /^ssh:\/\//i.test(t) || /^git:\/\//i.test(t) || t.endsWith(".git");
}

function parseMeta(input: Record<string, unknown>): RepoDocsMeta {
  const md = (input["metadata"] ?? {}) as Record<string, unknown>;
  const target = typeof md["target"] === "string" ? md["target"].trim() : "";
  if (!target) throw new Error("repo_docs task metadata.target is missing");
  const rawMode = md["mode"];
  const mode = rawMode === "init" || rawMode === "update" || rawMode === "auto" ? rawMode : "auto";
  const rawPub = md["publish"];
  const publish: PublishLevel = rawPub === "push" || rawPub === "pr" ? rawPub : "branch";
  const instructions = typeof md["instructions"] === "string" ? md["instructions"] : undefined;
  return { target, mode, publish, instructions };
}

/** Build the RepoGitSurface the salvaged git-context helpers consume. */
function gitSurfaceFor(workDir: string): RepoGitSurface {
  return {
    readFile: (p: string) => fsReadFile(path.join(workDir, p), "utf8"),
    writeFile: async (p: string, content: string) => {
      const abs = path.join(workDir, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, "utf8");
    },
    git: (args: string[]) => git(workDir, args),
  };
}

/**
 * Resolve the target + create the isolated worktree/branch, then compose the
 * run brief. The caller points the subagent's currentFolder at `workDir`.
 */
export async function prepareRepoDocsWorkspace(
  input: Record<string, unknown>,
  modelId: string,
): Promise<RepoDocsWorkspace> {
  const meta = parseMeta(input);
  const wikiDir = DEFAULT_WIKI_DIR;

  // 1. Resolve target → an on-disk git repo we can add a worktree to.
  let repoRoot: string;
  let rootLabel: string;
  if (isGitUrl(meta.target)) {
    const digest = createHash("sha256").update(meta.target).digest("hex").slice(0, 32);
    repoRoot = path.join(homedir(), CLONE_CACHE_SUBDIR, digest);
    rootLabel = meta.target;
    const cloned = await stat(path.join(repoRoot, ".git")).then(() => true).catch(() => false);
    if (!cloned) {
      await mkdir(path.dirname(repoRoot), { recursive: true });
      const res = await git(process.cwd(), ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "50", "--no-tags", meta.target, repoRoot], 300_000);
      if (res.exitCode !== 0) throw new Error(`git clone failed for ${meta.target}: ${res.stderr.slice(0, 400)}`);
    } else {
      await git(repoRoot, ["fetch", "--depth", "50", "--no-tags", "origin"], 180_000);
    }
  } else {
    repoRoot = path.resolve(meta.target);
    rootLabel = "the target repository";
    const st = await stat(repoRoot).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`repo_docs target is not a directory: ${repoRoot}`);
    const inside = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new Error(`repo_docs target is not a git repository: ${repoRoot}`);
    }
  }

  // 2. Decide init vs update from the committed state.
  let mode: RepoDocsCommand;
  if (meta.mode === "init" || meta.mode === "update") {
    mode = meta.mode;
  } else {
    const quickstart = await stat(path.join(repoRoot, wikiDir, "quickstart.md")).then(() => true).catch(() => false);
    mode = quickstart ? "update" : "init";
  }

  // 3. Isolated worktree on a fresh branch (never touches the live checkout).
  const branch = docBranchName(mode);
  const workDir = `${repoRoot.replace(/\/+$/, "")}-openwiki-${Date.now().toString(36)}`;
  const wt = await git(repoRoot, ["worktree", "add", "-b", branch, workDir, "HEAD"]);
  if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr.slice(0, 300)}`);

  // 4. Compose the brief: ported OpenWiki prompt + PRE-INJECTED git evidence.
  const surface = gitSurfaceFor(workDir);
  const lastUpdate = await readLastUpdate(surface, wikiDir);
  const gitSummary = await buildGitContext(surface, mode, lastUpdate);
  const brief = `${createSystemPrompt(mode, wikiDir, rootLabel)}\n\n${createUserPrompt(mode, gitSummary, lastUpdate, wikiDir, meta.instructions ?? null)}`;

  log(`[repo-docs] prepared ${mode} run: branch=${branch} workDir=${workDir}`);

  return {
    workDir,
    branch,
    mode,
    brief,
    async commitAndPublish(): Promise<string> {
      await writeLastUpdateMetadata(surface, wikiDir, {
        command: mode,
        // Record the source revision the docs were generated from (the worktree
        // HEAD before the docs commit), not the docs commit itself.
        gitHead: (await git(workDir, ["rev-parse", "HEAD"])).stdout.trim(),
        workhorseModel: modelId,
        finalizeModel: modelId,
      }).catch((e) => warn(`[repo-docs] metadata write failed: ${e instanceof Error ? e.message : String(e)}`));
      const add = await git(workDir, ["add", "-A"]);
      if (add.exitCode !== 0) return `docs run finished but \`git add\` failed: ${add.stderr.slice(0, 200)}`;
      const staged = await git(workDir, ["diff", "--cached", "--quiet"]);
      if (staged.exitCode === 0) {
        return `The ${wikiDir}/ wiki is already current for ${rootLabel} — no documentation changes were needed (branch ${branch} left empty).`;
      }
      const nFiles = (await git(workDir, ["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean).length;
      const commit = await git(workDir, [
        "-c", `user.name=${BOT_AUTHOR.name}`,
        "-c", `user.email=${BOT_AUTHOR.email}`,
        "commit", "-m", `docs(openwiki): ${mode} documentation`,
      ]);
      if (commit.exitCode !== 0) return `docs generated but \`git commit\` failed: ${commit.stderr.slice(0, 300)}`;
      const sha = (await git(workDir, ["rev-parse", "--short", "HEAD"])).stdout.trim();

      let publishNote = `committed ${sha} on branch ${branch} (worktree ${workDir})`;
      if (meta.publish === "push" || meta.publish === "pr") {
        const push = await git(workDir, ["push", "-u", "origin", branch], 120_000);
        publishNote = push.exitCode === 0
          ? `committed ${sha} and pushed branch ${branch} to origin`
          : `committed ${sha} on ${branch}; push failed (${push.stderr.slice(0, 150)})`;
        if (meta.publish === "pr" && push.exitCode === 0) {
          publishNote += " — open a PR for the branch (automatic PR creation not enabled in v1)";
        }
      }
      return `Documentation ${mode === "init" ? "generated" : "updated"} for ${rootLabel}: ${nFiles} file(s) in ${wikiDir}/, ${publishNote}.`;
    },
    async cleanup(): Promise<void> {
      const res = await git(repoRoot, ["worktree", "remove", "--force", workDir]);
      if (res.exitCode !== 0) warn(`[repo-docs] worktree cleanup failed for ${workDir}: ${res.stderr.slice(0, 150)}`);
    },
  };
}
