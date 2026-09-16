import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Turbo cross-package cache-correctness guard
// ---------------------------------------------------------------------------
//
// Type-aware ESLint and `tsc --noEmit` read the SOURCE of upstream workspace
// packages (we import via `main: ./src/index.ts`, not built `dist`). So a
// change in an upstream package can change a downstream package's lint /
// typecheck result.
//
// Turbo, by default, hashes only a package's OWN files for a task. With no
// `dependsOn`, a downstream `typecheck`/`lint` task therefore CACHE-HITS a
// stale "pass" when only an upstream package changed — masking real type
// errors. (Reproduced: break an exported type in `@nautilo/types`, re-run
// `turbo run typecheck --filter=@nautilo/runtime` with NO `--force` → stale
// cache hit, exit 0, error invisible.)
//
// Historically this was papered over by running every gate with `--force`,
// which throws the cache away on every run — correct, but it re-runs the
// whole affected graph from scratch on every push/merge/rebase forever.
//
// The fix (Vercel's documented "Transit Node" pattern) adds a no-op `transit`
// task that carries the dependency graph, and makes `lint`/`typecheck` depend
// on it. That folds upstream source into the downstream task hash, so the
// cache invalidates correctly — and `--force` becomes unnecessary.
//
// This test locks in the SAFETY CONTRACT so the masking can never silently
// return:
//
//   For every cacheable, cross-package task (lint, typecheck), the CI gate
//   MUST do exactly one of:
//     (a) keep `--force` (cache disabled → always correct), OR
//     (b) make the turbo task `dependsOn: ["transit"]` (cache made correct).
//
//   It must never do NEITHER (that is the stale-cache hole), and the
//   `transit` task itself must be wired `dependsOn: ["^transit"]`.
//
// References (see PR description for the full write-up):
//   - typescript-eslint FAQ — ESLint `--cache` is unsafe with typed linting:
//     https://typescript-eslint.io/troubleshooting/faqs/eslint/#can-i-use-eslints---cache-with-typescript-eslint
//   - Turborepo "Transit Nodes" (parallel + correct cache invalidation):
//     https://turborepo.dev/docs/crafting-your-repository/configuring-tasks
//   - `$TURBO_ROOT$` (root-relative inputs, Turbo >= 2.5):
//     https://turborepo.dev/blog/turbo-2-5

const repoRoot = join(import.meta.dir, "../../..");

type TurboTask = {
  readonly dependsOn?: string[];
  readonly inputs?: string[];
  readonly outputs?: string[];
};
type TurboConfig = { readonly tasks: Record<string, TurboTask> };

const CROSS_PACKAGE_CACHEABLE_TASKS = ["lint", "typecheck", "test:unit"] as const;

function readTurbo(): TurboConfig {
  return JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as TurboConfig;
}

function readCiGates(): string {
  return readFileSync(join(repoRoot, "dev/scripts/ci-gates.sh"), "utf8");
}

function readCiWorkflow(): string {
  return readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
}

/** Does the CI gate for `task` pass `--force` to turbo? */
function gateUsesForce(ciGates: string, task: string): boolean {
  // Matches e.g. `bun run typecheck -- --affected --force`. The gate name in
  // ci-gates.sh is the script name (`lint`, `typecheck`); the eslint gate is
  // `lint-eslint` but invokes `bun run lint`.
  const line = ciGates
    .split("\n")
    .find((l) => l.includes(`bun run ${task} `) && l.includes("--affected"));
  return line?.includes("--force") ?? false;
}

describe("turbo cross-package cache-correctness guard", () => {
  test("transit node is wired to carry the dependency graph", () => {
    const turbo = readTurbo();
    const transit = turbo.tasks.transit;
    expect(transit, "turbo.json must define a `transit` task").toBeDefined();
    expect(transit.dependsOn).toEqual(["^transit"]);
  });

  for (const task of CROSS_PACKAGE_CACHEABLE_TASKS) {
    test(`${task} is either --force'd or depends on transit (never a stale-cache hole)`, () => {
      const turbo = readTurbo();
      const ciGates = readCiGates();

      const dependsOnTransit = turbo.tasks[task]?.dependsOn?.includes("transit") ?? false;
      const forced = gateUsesForce(ciGates, task);

      // The contract: exactly one of the two safety mechanisms must hold.
      // NEITHER = the masking hole this test exists to prevent.
      expect(
        dependsOnTransit || forced,
        `Task "${task}" is cacheable and cross-package but neither depends on ` +
          `"transit" (correct cache) nor runs with --force (no cache). This ` +
          `reintroduces stale-cache masking of upstream type changes. Add ` +
          `"dependsOn": ["transit"] to the ${task} task in turbo.json, OR ` +
          `restore --force in dev/scripts/ci-gates.sh.`,
      ).toBe(true);
    });
  }

  test("lint task hashes the root configs that change its result", () => {
    const turbo = readTurbo();
    const inputs = turbo.tasks.lint?.inputs ?? [];
    // Without these, editing a root rule/config would not invalidate the cache.
    for (const required of [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/eslint.config.mjs",
      "$TURBO_ROOT$/tsconfig.base.json",
    ]) {
      expect(inputs, `lint inputs must include ${required}`).toContain(required);
    }
  });

  test("typecheck task hashes the shared tsconfig base", () => {
    const turbo = readTurbo();
    const inputs = turbo.tasks.typecheck?.inputs ?? [];
    for (const required of ["$TURBO_DEFAULT$", "$TURBO_ROOT$/tsconfig.base.json"]) {
      expect(inputs, `typecheck inputs must include ${required}`).toContain(required);
    }
  });

  test("affected unit tests invoke Turbo directly and exclude the orchestration root", () => {
    const ciGates = readCiGates();
    const unitGate = ciGates
      .split("\n")
      .find((line) => line.includes("turbo run test:unit "));

    expect(unitGate).toContain("bunx turbo run test:unit --affected");
    expect(unitGate).toContain("--filter='!//'");
    expect(unitGate).not.toContain("--force");
    expect(unitGate).not.toContain("bun run test:unit");
  });

  test("CI keeps hosted defaults and scopes optional parallelism to trusted PRs", () => {
    const workflow = Bun.YAML.parse(readCiWorkflow()) as {
      jobs: Record<string, { "runs-on": string; env?: Record<string, string> }>;
    };
    for (const job of ["prepare-bun-cache", "lint", "typecheck", "test"]) {
      expect(workflow.jobs[job]?.["runs-on"]).toBe("${{ github.event.pull_request.head.repo.id == github.event.repository.id && github.actor != 'dependabot[bot]' && vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}");
    }
    expect(workflow.jobs.typecheck?.env?.TURBO_CONCURRENCY).toBe("${{ github.event.pull_request.head.repo.id == github.event.repository.id && github.actor != 'dependabot[bot]' && vars.CI_LINUX_RUNNER && vars.CI_TYPECHECK_CONCURRENCY || '1' }}");
  });
});
