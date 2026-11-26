import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFiles } from "./checkout-files";

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "checkout-files-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("checkout file inventory", () => {
  test("lists tracked and new files but not ignored content or nested worktrees", async () => {
    await withTemporaryDirectory(async (root) => {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await writeFile(join(root, ".gitignore"), ".claude/\nnode_modules/\n");
      for (const directory of [
        "packages/a/src",
        "packages/a/node_modules/dep",
        ".claude/worktrees/other/packages/a/src",
        "docs",
      ]) {
        await mkdir(join(root, directory), { recursive: true });
      }
      for (const path of [
        "packages/a/src/tracked.ts",
        "packages/a/src/deleted.ts",
        "packages/a/src/new.ts",
        "packages/a/node_modules/dep/index.ts",
        ".claude/worktrees/other/packages/a/src/tracked.ts",
        "docs/guide.md",
      ]) {
        await writeFile(join(root, path), "");
      }
      execFileSync("git", ["add", "packages/a/src/tracked.ts", "packages/a/src/deleted.ts"], {
        cwd: root,
      });
      await unlink(join(root, "packages/a/src/deleted.ts"));

      expect(checkoutFiles(root, ["packages"])).toEqual([
        "packages/a/src/new.ts",
        "packages/a/src/tracked.ts",
      ]);
      expect(checkoutFiles(root)).toEqual([
        ".gitignore",
        "docs/guide.md",
        "packages/a/src/new.ts",
        "packages/a/src/tracked.ts",
      ]);
    });
  });

  test("fails instead of returning an empty inventory outside a Git checkout", async () => {
    await withTemporaryDirectory(async (root) => {
      expect(() => checkoutFiles(root)).toThrow("git ls-files failed");
    });
  });
});
