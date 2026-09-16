import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../..");
// Git hooks export repository-local variables; never pass them into a fixture.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const migration = "packages/db/src/migrations/0001_fixture.sql";

for (const scenario of ["top-level SQL", "nested metadata", "unrelated file", "edited applied SQL"] as const) {
  test(`actual Lefthook migration command: ${scenario}`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "nautilo-migration-hook-"));
    const write = (path: string, body: string) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), body);
    };
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8", env: fixtureEnv });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git("init", "-q");
      git("config", "user.name", "Test Maintainer");
      git("config", "user.email", "maintainer@example.test");
      // No hooks are installed in this disposable fixture. Exercise the actual
      // current configuration only after the baseline commit exists.
      write(migration, "SELECT 1;\n");
      git("add", ".");
      git("commit", "-qm", "fixture baseline");
      copyFileSync(join(root, "lefthook.yml"), join(fixture, "lefthook.yml"));
      const guard = "dev/tools/db-migration-safety/guard-staged-migrations.sh";
      write(guard, readFileSync(join(root, guard), "utf8"));
      for (const checker of [
        "dev/tools/db-migration-safety/check-comment-redaction.ts",
        "dev/tools/db-migration-safety/comment-redactions.json",
        "bin/nautilo-dev/src/lib/recorded-main-merge-migration.ts",
      ]) write(checker, readFileSync(join(root, checker), "utf8"));
      // Stub only the package consistency check; run real admission checkers so
      // new exceptions cannot accidentally inherit an always-successful mock.
      write("fake-bin/bun", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_TEST_LOG"\nif [ "$*" = "run --cwd packages/db db:check" ]; then exit 0; fi\nexec "$HOOK_TEST_BUN" "$@"\n');
      chmodSync(join(fixture, "fake-bin/bun"), 0o755);
      const path = scenario === "top-level SQL" ? "packages/db/src/migrations/0002_new.sql"
        : scenario === "nested metadata" ? "packages/db/src/migrations/meta/_journal.json"
          : scenario === "unrelated file" ? "unrelated.txt" : migration;
      write(path, scenario === "nested metadata" ? "{}\n" : "SELECT 2;\n");
      git("add", "--", path);
      const log = join(fixture, "checks.log");
      const result = spawnSync(join(root, "node_modules/.bin/lefthook"), [
        "run", "pre-commit", "--command", "drizzle-migration-guard", "--no-auto-install", "--no-tty",
      ], {
        cwd: fixture, encoding: "utf8",
        env: { ...fixtureEnv, LEFTHOOK: "1", LEFTHOOK_CONFIG: join(fixture, "lefthook.yml"),
          PATH: `${join(fixture, "fake-bin")}:${process.env["PATH"] ?? ""}`, HOOK_TEST_LOG: log, HOOK_TEST_BUN: process.execPath },
      });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(scenario === "edited applied SQL" ? 1 : 0);
      if (scenario === "unrelated file") expect(existsSync(log), output).toBe(false);
      else expect(readFileSync(log, "utf8")).toContain("run --cwd packages/db db:check");
      if (scenario === "edited applied SQL") expect(output).toContain("Applied migrations are immutable");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
}
