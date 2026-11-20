import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Repository-relative paths of the files that belong to this checkout: tracked
 * files plus untracked files Git does not ignore, so a new file fails an
 * invariant before it is staged. Ignored content such as node_modules, build
 * output, and nested Git worktrees under .claude/worktrees is excluded, and
 * tracked files deleted from the working tree are skipped.
 */
export function checkoutFiles(root: string, pathspecs: readonly string[] = []): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success) {
    throw new Error(`git ls-files failed in ${root}: ${result.stderr.toString().trim()}`);
  }
  return [...new Set(result.stdout.toString().split("\0").filter(Boolean))]
    .filter((path) => existsSync(join(root, path)))
    .sort();
}
