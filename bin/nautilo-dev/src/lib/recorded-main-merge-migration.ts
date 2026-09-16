import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Accept only an exact, previously approved rewrite arriving from main. */
export function isRecordedMainMergeMigration(path: string, cwd = process.cwd()): boolean {
  if (!/^packages\/db\/src\/migrations\/[^/]+\.sql$/u.test(path)) return false;
  const git = (args: string[]) => execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const mergeHeadPath = git(["rev-parse", "--git-path", "MERGE_HEAD"]).toString("utf8").trim();
    const incoming = readFileSync(resolve(cwd, mergeHeadPath), "utf8").trim();
    // Refuse absent/ambiguous merge parents and merges from feature branches.
    if (!/^[a-f0-9]{40,64}$/u.test(incoming)) return false;
    git(["merge-base", "--is-ancestor", incoming, "refs/remotes/origin/main"]);

    const before = git(["show", `HEAD:${path}`]);
    const staged = git(["show", `:${path}`]);
    if (!staged.equals(git(["show", `${incoming}:${path}`]))) return false;

    // Read approval from the committed incoming parent, never the local index:
    // a local edit to the receipt cannot authorize a new migration rewrite.
    const receipt: unknown = JSON.parse(git([
      "show", `${incoming}:bin/nautilo-dev/src/lib/applied-migration-rewrites.json`,
    ]).toString("utf8"));
    if (!isRecord(receipt) || receipt["schemaVersion"] !== 1 || !Array.isArray(receipt["rewrites"])) return false;
    const beforeHash = createHash("sha256").update(before).digest("hex");
    const afterHash = createHash("sha256").update(staged).digest("hex");
    return receipt["rewrites"].some((entry: unknown) =>
      isRecord(entry)
      && entry["path"] === path
      && entry["beforeSha256"] === beforeHash
      && entry["afterSha256"] === afterHash,
    );
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  process.exitCode = path && isRecordedMainMergeMigration(path) ? 0 : 1;
}
