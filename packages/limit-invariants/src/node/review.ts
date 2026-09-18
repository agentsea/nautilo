#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runLimitCheck } from "./cli";

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export const LIMIT_POLICY_STATUS_CONTEXT = "limit-policy-reviewed";

export interface LimitPolicyReviewInput {
  readonly repository: string;
  readonly head: string;
  readonly repositoryRoot: string;
}

export interface LimitPolicyReviewDependencies {
  readonly git: (repositoryRoot: string, args: readonly string[]) => Promise<string>;
  readonly check: (repositoryRoot: string) => Promise<number>;
  readonly post: (repository: string, head: string) => Promise<void>;
}

interface SourceState { readonly head: string; readonly remote: string; readonly status: string }

export function normalizedGitHubRepository(remote: string): string | null {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/u);
  return match?.[1] ?? null;
}

async function sourceState(root: string, git: LimitPolicyReviewDependencies["git"]): Promise<SourceState> {
  const [head, remote, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { head: head.trim(), remote: remote.trim(), status: status.trim() };
}

function assertSource(input: LimitPolicyReviewInput, state: SourceState): void {
  if (state.head !== input.head) throw new Error("Limit review source HEAD does not match the exact requested commit");
  if (state.status !== "") throw new Error("Limit review source contains tracked or untracked non-ignored changes");
  if (normalizedGitHubRepository(state.remote) !== input.repository) {
    throw new Error("Limit review source origin does not match the requested GitHub repository");
  }
}

export async function runLimitPolicyReview(input: LimitPolicyReviewInput, dependencies: LimitPolicyReviewDependencies): Promise<void> {
  if (!REPOSITORY.test(input.repository)) throw new Error("--repository must be an explicit owner/name");
  if (!SHA.test(input.head)) throw new Error("--head must be an exact 40-character lowercase commit SHA");
  const root = resolve(input.repositoryRoot);
  assertSource(input, await sourceState(root, dependencies.git));
  if (await dependencies.check(root) !== 0) throw new Error("Strict local limit policy review failed");
  assertSource(input, await sourceState(root, dependencies.git));
  await dependencies.post(input.repository, input.head);
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function usage(): never {
  process.stderr.write("Usage: bun src/node/review.ts --repository owner/name --head <40-hex-sha>\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repository = valueAfter(argv, "--repository");
  const head = valueAfter(argv, "--head");
  if (!repository || !head) usage();
  const repositoryRoot = resolve(import.meta.dir, "../../../..");
  await runLimitPolicyReview({ repository, head, repositoryRoot }, {
    git: async (root, args) => (await execFileAsync("git", [...args], { cwd: root, encoding: "utf8" })).stdout,
    check: runLimitCheck,
    post: async (target, sha) => {
      await execFileAsync("gh", [
        "api", "--method", "POST", `repos/${target}/statuses/${sha}`,
        "-f", "state=success", "-f", `context=${LIMIT_POLICY_STATUS_CONTEXT}`,
        "-f", "description=Limit policy reviewed for this commit",
      ], { encoding: "utf8" });
    },
  });
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`Limit policy review failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
