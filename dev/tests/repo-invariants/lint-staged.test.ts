import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repositoryRoot = join(import.meta.dir, "../../..");
const dispatcher = join(repositoryRoot, "dev/scripts/lint-staged.sh");

function write(relativePath: string, contents: string): void {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

let fixtureRoot = "";

describe("lint-staged dispatcher", () => {
  test("groups explicit root, package, and Mobile paths without splitting spaces", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "nautilo lint staged "));
    try {
      const bin = join(fixtureRoot, "bin");
      const log = join(fixtureRoot, "invocations.log");
      mkdirSync(bin);
      write("packages/example/package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
      write("apps/mobile/package.json", JSON.stringify({ scripts: { lint: "expo lint" } }));
      write("root fixture.ts", "export {};\n");
      write("packages/example/src/file with spaces.test.ts", "export {};\n");
      write("packages/example/src/second file.test.ts", "export {};\n");
      write("apps/mobile/src/screen with spaces.test.tsx", "export {};\n");
      const bunx = join(bin, "bunx");
      writeFileSync(bunx, "#!/bin/sh\nprintf '[%s]' \"$PWD\" >> \"$LINT_STAGED_LOG\"\nprintf '<%s>' \"$@\" >> \"$LINT_STAGED_LOG\"\nprintf '\\n' >> \"$LINT_STAGED_LOG\"\n");
      chmodSync(bunx, 0o755);

      const result = spawnSync(
        "bash",
        [
          dispatcher,
          "root fixture.ts",
          "packages/example/src/file with spaces.test.ts",
          "packages/example/src/second file.test.ts",
          "apps/mobile/src/screen with spaces.test.tsx",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            LINT_STAGED_REPO_ROOT: fixtureRoot,
            LINT_STAGED_LOG: log,
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        `[${fixtureRoot}]<eslint><--fix><--><root fixture.ts>`,
        `[${join(fixtureRoot, "packages/example")}]<eslint><--fix><--><src/file with spaces.test.ts><src/second file.test.ts>`,
        `[${join(fixtureRoot, "apps/mobile")}]<expo><lint><--fix><src/screen with spaces.test.tsx>`,
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("rejects a path outside the repository before launching a linter", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "nautilo lint staged "));
    try {
      const bin = join(fixtureRoot, "bin");
      const log = join(fixtureRoot, "invocations.log");
      mkdirSync(bin);
      const bunx = join(bin, "bunx");
      writeFileSync(bunx, "#!/bin/sh\nprintf called >> \"$LINT_STAGED_LOG\"\n");
      chmodSync(bunx, 0o755);

      const result = spawnSync("bash", [dispatcher, "../outside.ts"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          LINT_STAGED_REPO_ROOT: fixtureRoot,
          LINT_STAGED_LOG: log,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refusing non-repository path");
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
