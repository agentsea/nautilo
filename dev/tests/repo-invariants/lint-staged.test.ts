import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repositoryRoot = join(import.meta.dir, "../../..");
const dispatcher = join(repositoryRoot, "dev/scripts/lint-staged.sh");
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";

function write(relativePath: string, contents: string): void {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

let fixtureRoot = "";

describe("lint-staged dispatcher", () => {
  test.each([false, true])("groups paths without splitting spaces through a directory alias: %s", (viaAlias) => {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "nautilo lint staged ")));
    fixtureRoot = temporaryRoot;
    try {
      if (viaAlias) {
        const target = join(temporaryRoot, "target");
        mkdirSync(target);
        fixtureRoot = join(temporaryRoot, "alias");
        symlinkSync(target, fixtureRoot, process.platform === "win32" ? "junction" : "dir");
      }
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
      writeFileSync(bunx, "#!/bin/sh\nprintf '[%s]' \"$(node -p 'process.cwd()')\" >> \"$LINT_STAGED_LOG\"\nprintf '<%s>' \"$@\" >> \"$LINT_STAGED_LOG\"\nprintf '\\n' >> \"$LINT_STAGED_LOG\"\n");
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
            [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const canonicalRoot = realpathSync(fixtureRoot);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        `[${canonicalRoot}]<eslint><--fix><--><root fixture.ts>`,
        `[${join(canonicalRoot, "packages/example")}]<eslint><--fix><--><src/file with spaces.test.ts><src/second file.test.ts>`,
        `[${join(canonicalRoot, "apps/mobile")}]<expo><lint><--fix><src/screen with spaces.test.tsx>`,
      ]);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects a path outside the repository before launching a linter", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "nautilo lint staged ")));
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
          [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`,
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

describe("pre-push gate runner", () => {
  test("executes the requested gates with their comparison refs and unit concurrency", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "nautilo push gates ")));
    try {
      const log = join(fixtureRoot, "gates.log");
      write("dev/scripts/ci-gates.sh", `#!/usr/bin/env bash
printf '%s|%s|%s|%s\\n' "$1" "$TURBO_SCM_BASE" "$TURBO_SCM_HEAD" "$TURBO_CONCURRENCY" >> "$PUSH_GATE_LOG"
`);
      write("dev/scripts/windows-unit-gate.ts", 'console.log("Windows unit gate fixture", process.env["TURBO_SCM_BASE"], process.env["TURBO_SCM_HEAD"], process.env["TURBO_CONCURRENCY"]);\n');
      for (const gate of ["lint-eslint", "typecheck", "unit"]) {
        const result = spawnSync("bash", [join(repositoryRoot, "dev/scripts/pre-push-gate.sh"), gate], {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PUSH_GATE_LOG: log,
            TURBO_SCM_BASE: "fixture-base",
            TURBO_SCM_HEAD: "",
            TURBO_CONCURRENCY: "",
          },
        });
        expect(result.status, result.stderr).toBe(0);
        if (gate === "unit" && process.platform === "win32") {
          expect(result.stdout).toContain("Windows unit gate fixture fixture-base HEAD 4");
        }
      }
      const expected = [
        "lint-eslint|fixture-base|HEAD|",
        "typecheck|fixture-base|HEAD|",
      ];
      if (process.platform !== "win32") expected.push("unit|fixture-base|HEAD|4");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(expected);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
