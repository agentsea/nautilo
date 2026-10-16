import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const COMMIT_SHA = /^[0-9a-f]{40}$/;

const FULL_PATH_PREFIXES = [
  "apps/desktop/",
  "bin/nautilo-relay/",
  "packages/relay/",
  "packages/lattice-crypto/vendor/openmls-wasm/",
  "native/apply-patch/",
  "patches/",
] as const;

const FULL_EXACT_PATHS = new Set([
  ".bun-version",
  ".gitattributes",
  "bunfig.toml",
  "turbo.json",
  ".github/workflows/windows-desktop.yml",
  "dev/scripts/windows-validation-scope.ts",
  "dev/scripts/install-first-party-apps.ts",
  "dev/scripts/fix-node-pty-perms.ts",
]);

export function requiresFullWindowsValidation(
  eventName: string,
  changedPaths: readonly string[],
): boolean {
  if (eventName === "schedule" || eventName === "workflow_dispatch") return true;
  if (eventName !== "pull_request") {
    throw new Error(`Unsupported Windows validation event: ${eventName || "<empty>"}`);
  }

  return changedPaths.some((inputPath) => {
    const path = inputPath.replaceAll("\\", "/");
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    if (fileName === "package.json" || fileName === "bun.lock") return true;
    if (!path.includes("/") && path.startsWith("tsconfig") && path.endsWith(".json")) return true;
    if (FULL_EXACT_PATHS.has(path)) return true;
    return FULL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  });
}

function exactCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new Error(`${label} must be an exact 40-character lowercase commit SHA`);
  }
  return value;
}

function pullRequestCommits(): { base: string; head: string } {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required for pull_request validation");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } };
  };
  return {
    base: exactCommitSha(event.pull_request?.base?.sha, "pull_request.base.sha"),
    head: exactCommitSha(event.pull_request?.head?.sha, "pull_request.head.sha"),
  };
}

function run(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureCommit(sha: string, label: string): void {
  let inspection = run("git", ["cat-file", "-e", `${sha}^{commit}`]);
  if (inspection.status === 0) return;

  const fetch = run("git", ["fetch", "--no-tags", "--depth=1", "origin", sha]);
  if (fetch.error || fetch.status !== 0) {
    throw new Error(
      `Failed to fetch exact pull-request ${label} ${sha}: ${fetch.stderr || fetch.error?.message || "unknown error"}`,
    );
  }
  inspection = run("git", ["cat-file", "-e", `${sha}^{commit}`]);
  if (inspection.error || inspection.status !== 0) {
    throw new Error(`Exact pull-request ${label} commit is unavailable after fetch: ${sha}`);
  }
}

function changedPaths(base: string, head: string): string[] {
  ensureCommit(base, "base");
  ensureCommit(head, "head");
  const diff = run("git", ["diff", "--merge-base", "--name-only", "--no-renames", "-z", base, head]);
  if (diff.error || diff.status !== 0) {
    throw new Error(`Failed to inspect exact pull-request diff: ${diff.stderr || diff.error?.message || "unknown error"}`);
  }
  return diff.stdout.split("\0").filter(Boolean);
}

if (import.meta.main) {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  const paths = eventName === "pull_request"
    ? (() => {
        const { base, head } = pullRequestCommits();
        return changedPaths(base, head);
      })()
    : [];
  const full = requiresFullWindowsValidation(eventName, paths);
  const output = process.env["GITHUB_OUTPUT"];
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(output, `full=${String(full)}\n`, "utf8");
  console.log(`[windows-validation] ${full ? "full" : "source-only"} (${paths.length} changed paths)`);
}
