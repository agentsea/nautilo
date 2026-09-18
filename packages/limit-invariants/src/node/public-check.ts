import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LimitObservation } from "../model";
import { scanRepository } from "./scanner";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REVIEW_CONTEXT = "limit-policy-reviewed";

export interface PublicCheckOptions {
  readonly sourceRoot: string;
  readonly base: string;
  readonly head: string;
  readonly repository: string;
  readonly token: string;
}

export interface PublicCheckResult {
  readonly baseObservations: number;
  readonly headObservations: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly added: number;
  readonly changed: number;
  readonly reviewedStatusRequired: boolean;
}

interface CommitStatus {
  readonly context?: unknown;
  readonly state?: unknown;
  readonly url?: unknown;
  readonly created_at?: unknown;
  readonly id?: unknown;
}

export interface PublicCheckDependencies {
  readonly fetch?: typeof fetch;
}

async function git(sourceRoot: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", sourceRoot, ...args], {
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch {
    throw new Error(`Git could not verify ${args[0] ?? "repository state"}.`);
  }
}

async function archiveRevision(sourceRoot: string, revision: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const archivePath = `${destination}.tar`;
  try {
    // Keep repository bytes out of the JS stream bridge. Git and tar handle
    // the full archive without a process-output buffer or pipe lifetime race.
    await execFileAsync("git", ["-C", sourceRoot, "archive", "--format=tar", `--output=${archivePath}`, revision]);
    await execFileAsync("tar", ["-xf", archivePath, "-C", destination]);
  } catch {
    throw new Error(`Git could not archive revision ${revision}.`);
  } finally {
    await rm(archivePath, { force: true });
  }
}

function inventoryByLocator(observations: readonly LimitObservation[]): Map<string, LimitObservation> {
  const indexed = new Map<string, LimitObservation>();
  for (const observation of observations) {
    if (indexed.has(observation.locator)) throw new Error("Limit scan returned duplicate locators.");
    indexed.set(observation.locator, observation);
  }
  return indexed;
}

function latestStatus(statuses: readonly CommitStatus[]): CommitStatus | undefined {
  return [...statuses].sort((left, right) => {
    const leftTime = typeof left.created_at === "string" ? Date.parse(left.created_at) : Number.NaN;
    const rightTime = typeof right.created_at === "string" ? Date.parse(right.created_at) : Number.NaN;
    const timeOrder = (Number.isFinite(rightTime) ? rightTime : -1) - (Number.isFinite(leftTime) ? leftTime : -1);
    if (timeOrder !== 0) return timeOrder;
    const leftId = typeof left.id === "number" ? left.id : -1;
    const rightId = typeof right.id === "number" ? right.id : -1;
    return rightId - leftId;
  })[0];
}

function isCommitStatus(value: unknown): value is CommitStatus {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusBelongsToHead(status: CommitStatus, repository: string, head: string): boolean {
  if (typeof status.url !== "string") return false;
  try {
    const url = new URL(status.url);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "api.github.com"
      && url.pathname.toLowerCase() === `/repos/${repository}/statuses/${head}`.toLowerCase();
  } catch {
    return false;
  }
}

async function requireExactHeadReview(
  repository: string,
  head: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const matching: CommitStatus[] = [];
  for (let page = 1; ; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${repository}/commits/${head}/statuses?per_page=100&page=${page}`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } },
      );
    } catch {
      throw new Error(`GitHub status lookup failed for exact HEAD ${head}.`);
    }
    if (!response.ok) {
      throw new Error(`GitHub status lookup failed for exact HEAD ${head} with HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`GitHub status lookup returned invalid JSON for exact HEAD ${head}.`);
    }
    if (!Array.isArray(payload)) throw new Error(`GitHub status lookup returned an invalid status list for exact HEAD ${head}.`);
    if (!payload.every(isCommitStatus)) {
      throw new Error(`GitHub status lookup returned malformed status items for exact HEAD ${head}.`);
    }
    const pageStatuses = payload;
    matching.push(...pageStatuses.filter((status) => status.context === REVIEW_CONTEXT));
    if (pageStatuses.length < 100) break;
  }
  const latest = latestStatus(matching);
  if (!latest) throw new Error(`Missing ${REVIEW_CONTEXT} status on exact HEAD ${head}.`);
  if (!statusBelongsToHead(latest, repository, head)) {
    throw new Error(`${REVIEW_CONTEXT} status does not belong to exact HEAD ${head}.`);
  }
  if (latest.state !== "success") {
    throw new Error(`Latest ${REVIEW_CONTEXT} status on exact HEAD ${head} is ${String(latest.state)}.`);
  }
}

export async function runPublicLimitCheck(
  options: PublicCheckOptions,
  dependencies: PublicCheckDependencies = {},
): Promise<PublicCheckResult> {
  if (!FULL_SHA.test(options.base) || !FULL_SHA.test(options.head)) {
    throw new Error("--base and --head must be explicit lowercase 40-character commit SHAs.");
  }
  if (!REPOSITORY.test(options.repository)) throw new Error("--repository must be an explicit owner/repo.");
  if (!options.token.trim()) throw new Error("GITHUB_TOKEN is required for read-only commit-status lookup.");
  const sourceRoot = resolve(options.sourceRoot);
  const currentHead = await git(sourceRoot, ["rev-parse", "HEAD"]);
  if (currentHead !== options.head) throw new Error(`--head must equal the checked-out HEAD ${currentHead}.`);
  if (await git(sourceRoot, ["status", "--porcelain"])) {
    throw new Error("Source repository is dirty; public CI checks only committed HEAD state.");
  }
  for (const revision of [options.base, options.head]) {
    const resolved = await git(sourceRoot, ["rev-parse", `${revision}^{commit}`]);
    if (resolved !== revision) throw new Error(`Revision ${revision} is not the exact requested commit.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-public-limit-check-"));
  try {
    const baseRoot = join(temporaryRoot, "base");
    const headRoot = join(temporaryRoot, "head");
    await archiveRevision(sourceRoot, options.base, baseRoot);
    await archiveRevision(sourceRoot, options.head, headRoot);
    const [baseObservations, headObservations] = await Promise.all([
      scanRepository(baseRoot, { lanes: ["primary"] }),
      scanRepository(headRoot, { lanes: ["primary"] }),
    ]);
    const base = inventoryByLocator(baseObservations);
    const head = inventoryByLocator(headObservations);
    let unchanged = 0;
    let changed = 0;
    let added = 0;
    for (const [locator, observation] of head) {
      const before = base.get(locator);
      if (!before) added += 1;
      else if (before.fingerprint === observation.fingerprint) unchanged += 1;
      else changed += 1;
    }
    let removed = 0;
    for (const locator of base.keys()) if (!head.has(locator)) removed += 1;
    if (added + changed > 0) {
      try {
        await requireExactHeadReview(
          options.repository,
          options.head,
          options.token,
          dependencies.fetch ?? globalThis.fetch,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub status lookup failed.";
        throw new Error(`${message} Public limit delta: added=${added} changed=${changed} unchanged=${unchanged} removed=${removed}.`);
      }
    }
    return {
      baseObservations: baseObservations.length,
      headObservations: headObservations.length,
      unchanged,
      removed,
      added,
      changed,
      reviewedStatusRequired: added + changed > 0,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(args: readonly string[]): Omit<PublicCheckOptions, "sourceRoot" | "token"> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !["--base", "--head", "--repository"].includes(name)) {
      throw new Error("Usage: public-check --base <full-sha> --head <full-sha> --repository <owner/repo>");
    }
    if (values.has(name)) throw new Error(`Duplicate argument ${name}.`);
    values.set(name, value);
  }
  const base = values.get("--base");
  const head = values.get("--head");
  const repository = values.get("--repository");
  if (!base || !head || !repository || values.size !== 3) {
    throw new Error("Usage: public-check --base <full-sha> --head <full-sha> --repository <owner/repo>");
  }
  return { base, head, repository };
}

if (import.meta.main) {
  try {
    const input = parseArguments(process.argv.slice(2));
    const result = await runPublicLimitCheck({
      ...input,
      sourceRoot: resolve(import.meta.dir, "../../../.."),
      token: process.env["GITHUB_TOKEN"] ?? "",
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Public limit check failed.");
    process.exitCode = 1;
  }
}
