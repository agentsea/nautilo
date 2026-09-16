import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const thisGuard = "packages/server/tests/unit/codex-rejected-path-absence.test.ts";

/**
 * This is deliberately a tracked-source guard rather than a hand-picked list
 * of files. The rejected D453 path must not quietly reappear in a new route,
 * runtime module, or test seam outside the files that originally contained it.
 *
 * `git ls-files` gives a portable, deterministic repository view and avoids
 * walking generated or dependency output. Keep this bounded to executable
 * source roots and extensions: documentation and generated protocol fixtures
 * are not an implementation path.
 */
const sourceRoots = ["apps/", "packages/", "bin/", "dev/"] as const;
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const excludedPathSegment = /(?:^|\/)(?:node_modules|vendor|generated|dist|build|coverage|\.turbo)(?:\/|$)/;

function trackedSourceFiles(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return tracked
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => relativePath !== thisGuard)
    .filter((relativePath) => sourceRoots.some((root) => relativePath.startsWith(root)))
    .filter((relativePath) => sourceExtension.test(relativePath))
    .filter((relativePath) => !excludedPathSegment.test(relativePath))
    .filter((relativePath) => existsSync(resolve(repositoryRoot, relativePath)))
    .sort();
}

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("D453 rejected direct Codex path", () => {
  test("keeps rejected files, symbols, and fallback seams out of every tracked source path", () => {
    const files = trackedSourceFiles();

    for (const rejectedFile of [
      "packages/server/src/codex/job-execution.ts",
      "packages/runtime/src/executors/codex-app-server-executor.ts",
      "packages/runtime/tests/unit/codex-app-server-executor.test.ts",
      "packages/runtime/src/codex/capability-manifest.ts",
      "packages/runtime/src/codex/skill-callbacks.ts",
    ]) {
      expect(files).not.toContain(rejectedFile);
    }

    const rejectedNames = [
      "prepareCodexExecution",
      "getRegisteredChatRoutesDeps",
      "registeredChatRoutesDeps",
      "createCodexAppServerExecutor",
      "CodexExecutionPort",
      "CodexExecutionEvent",
      "buildEmptyCodexCapabilityManifest",
      "nextTurnId",
    ] as const;

    const violations = files.flatMap((relativePath) => {
      const contents = source(relativePath);
      return rejectedNames
        .filter((rejectedName) => contents.includes(rejectedName))
        .map((rejectedName) => `${relativePath}: ${rejectedName}`);
    });

    expect(violations).toEqual([]);
  });

  test("scans a stable, non-empty tracked source set", () => {
    const files = trackedSourceFiles();
    expect(files).toContain("packages/server/src/app.ts");
    expect(files).not.toContain(thisGuard);
    for (const path of files) {
      expect(excludedPathSegment.test(path)).toBe(false);
    }
  });
});
