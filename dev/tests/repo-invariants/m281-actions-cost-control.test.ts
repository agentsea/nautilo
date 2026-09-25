import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const workflowsRoot = join(repositoryRoot, ".github/workflows");

type Workflow = {
  env?: Record<string, string>;
  on: Record<string, unknown>;
  jobs: Record<string, {
    "runs-on"?: string;
    env?: Record<string, string>;
    needs?: string | string[];
    steps?: Array<{
      "continue-on-error"?: boolean;
      env?: Record<string, string>;
      id?: string;
      if?: string;
      name?: string;
      run?: string;
      uses?: string;
      with?: Record<string, unknown>;
    }>;
    strategy?: Record<string, unknown>;
  }>;
};

async function source(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(await source(`.github/workflows/${name}`)) as Workflow;
}

function eventConfig(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function eventPaths(value: unknown): string[] {
  return (eventConfig(value).paths ?? []) as string[];
}

const gitLocalEnvironmentNames = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function withoutGitLocalEnvironment(
  command: string,
  args: string[],
): string[] {
  return [
    ...gitLocalEnvironmentNames.flatMap((name) => ["-u", name]),
    command,
    ...args,
  ];
}

async function spawnText(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const captureRoot = mkdtempSync(join(tmpdir(), "m281-subprocess-"));
  const stdoutPath = join(captureRoot, "stdout.txt");
  const stderrPath = join(captureRoot, "stderr.txt");
  try {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const status = await child.exited;
    return {
      status,
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
    };
  } finally {
    await rm(captureRoot, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnText("env", withoutGitLocalEnvironment("git", args), { cwd });
  expect(
    result.status,
    `git ${args.join(" ")} failed:\n${result.stderr}`,
  ).toBe(0);
  return result.stdout.trim();
}

function writeFixture(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function turboDryHash(root: string, taskId: string): Promise<string> {
  const result = await spawnText(
    join(repositoryRoot, "node_modules/.bin/turbo"),
    [
      "run",
      "test:unit",
      "--filter=@fixture/downstream",
      "--dry=json",
      "--cwd",
      root,
      "--dangerously-disable-package-manager-check",
    ],
  );
  if (result.status !== 0) {
    throw new Error(
      `Turbo dry-run failed (status ${String(result.status)}):\n${result.stderr}`,
    );
  }
  const dryRun = JSON.parse(result.stdout) as {
    tasks: Array<{ taskId: string; hash: string }>;
  };
  const task = dryRun.tasks.find((candidate) => candidate.taskId === taskId);
  expect(task, `${taskId} must be present in the fixture graph`).toBeDefined();
  return task?.hash ?? "";
}

async function workspacePathsFor(rootName: string): Promise<string[]> {
  const rootPackage = JSON.parse(await source("package.json")) as {
    workspaces: string[];
  };
  const manifests = new Map<string, {
    path: string;
    dependencies: string[];
  }>();

  for (const workspacePattern of rootPackage.workspaces) {
    const glob = new Bun.Glob(`${workspacePattern}/package.json`);
    for await (const manifestPath of glob.scan({ cwd: repositoryRoot })) {
      const manifest = JSON.parse(await source(manifestPath)) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      if (!manifest.name) continue;
      manifests.set(manifest.name, {
        path: dirname(manifestPath),
        dependencies: [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
          ...Object.keys(manifest.optionalDependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ],
      });
    }
  }

  const pending = [rootName];
  const visited = new Set<string>();
  const paths = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const manifest = manifests.get(name);
    expect(manifest, `workspace ${name} must exist`).toBeDefined();
    if (!manifest) continue;
    paths.add(manifest.path);
    for (const dependency of manifest.dependencies) {
      if (manifests.has(dependency)) pending.push(dependency);
    }
  }
  return [...paths].sort();
}

async function firstPartyRuntimeWorkspacePaths(): Promise<string[]> {
  const paths = new Set<string>();
  const glob = new Bun.Glob("packages/first-party-apps/*/package.json");
  for await (const manifestPath of glob.scan({ cwd: repositoryRoot })) {
    const manifest = JSON.parse(await source(manifestPath)) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const specifier of Object.values({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (!specifier.startsWith("file:")) continue;
      paths.add(
        relative(
          repositoryRoot,
          resolve(repositoryRoot, dirname(manifestPath), specifier.slice(5)),
        ),
      );
    }
  }
  return [...paths].sort();
}

function expectPathsCover(paths: string[], requiredPaths: string[]): void {
  for (const requiredPath of requiredPaths) {
    expect(
      paths,
      `workflow paths must cover ${requiredPath}`,
    ).toContain(`${requiredPath}/**`);
  }
}

describe("M281 GitHub Actions cost controls", () => {
  test("ordinary CI is PR-only, preserves CI aggregation, and uses exact bounded history", async () => {
    const ci = await workflow("ci.yml");
    const ciText = await source(".github/workflows/ci.yml");

    expect(Object.keys(ci.on)).toEqual(["pull_request"]);
    expect(ci.on.pull_request).toEqual({ branches: ["main"] });
    expect(ci.jobs.ci?.needs).toEqual(["lint", "typecheck", "test", "db-migration-integration"]);
    expect(ciText.match(/name: CI/g)?.length).toBe(2);
    for (const job of ["prepare-bun-cache", "lint", "typecheck", "test"]) {
      expect(ci.jobs[job]?.["runs-on"]).toBe("${{ github.event.pull_request.head.repo.id == github.event.repository.id && github.actor != 'dependabot[bot]' && vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}");
    }
    expect(ciText.match(/fetch-depth: 2/g)?.length).toBe(3);
    expect(ciText.match(/TURBO_SCM_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/g)?.length).toBe(3);
    expect(ciText.match(/bash dev\/scripts\/ensure-ci-base\.sh/g)?.length).toBe(3);
    expect(ciText).not.toContain("fetch-depth: 0");
    expect(ciText).not.toContain("Restore Turbo cache");
    expect(ciText).not.toContain("Save Turbo cache");
  });

  test("gives Knip enough heap without broadening every lint subprocess", async () => {
    const ci = await workflow("ci.yml");
    const rootPackage = JSON.parse(await source("package.json")) as { scripts: Record<string, string> };
    const lintSteps = ci.jobs.lint?.steps ?? [];
    const knip = lintSteps.find((step) => step.name === "Unused exports (knip)");

    expect(knip?.run).toBe("bash dev/scripts/ci-gates.sh lint-unused");
    expect(knip?.env).toEqual({
      NODE_OPTIONS: "--max-old-space-size=6144",
    });
    expect(rootPackage.scripts["lint:unused"]).toContain(`NODE_OPTIONS=${knip?.env?.NODE_OPTIONS}`);
    expect(ci.jobs.lint?.env?.NODE_OPTIONS).toBeUndefined();
  });

  test("bounds typecheck heap with optional larger-runner concurrency", async () => {
    const ci = await workflow("ci.yml");
    const rootPackage = JSON.parse(await source("package.json")) as { scripts: Record<string, string> };
    const localGates = await source("dev/scripts/ci-gates.sh");
    const typecheckJob = ci.jobs.typecheck;
    const typecheck = typecheckJob?.steps?.find((step) => step.name === "Typecheck");

    expect(typecheckJob?.env?.TURBO_CONCURRENCY).toBe("${{ github.event.pull_request.head.repo.id == github.event.repository.id && github.actor != 'dependabot[bot]' && vars.CI_LINUX_RUNNER && vars.CI_TYPECHECK_CONCURRENCY || '1' }}");
    expect(typecheckJob?.env?.NODE_OPTIONS).toBeUndefined();
    expect(typecheck?.run).toBe("bash dev/scripts/ci-gates.sh typecheck");
    expect(typecheck?.env).toEqual({
      NODE_OPTIONS: "--max-old-space-size=5120",
    });
    expect(rootPackage.scripts.typecheck).toContain(`NODE_OPTIONS=${typecheck?.env?.NODE_OPTIONS}`);
    expect(rootPackage.scripts.typecheck).toContain("TURBO_CONCURRENCY=${TURBO_CONCURRENCY:-1}");
    expect(localGates).toContain(`export NODE_OPTIONS=${typecheck?.env?.NODE_OPTIONS}`);
    expect(localGates).toContain('export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-1}"');
  });

  test("Desktop smoke uses bounded history and the exact PR base without breaking manual dispatch", async () => {
    const desktop = await workflow("desktop-smoke.yml");
    const desktopText = await source(".github/workflows/desktop-smoke.yml");
    const job = desktop.jobs["desktop-smoke"];

    expect(job?.env?.TURBO_SCM_BASE).toBe(
      "${{ github.event.pull_request.base.sha || github.sha }}",
    );
    expect(desktopText).toContain("fetch-depth: 2");
    expect(desktopText).not.toContain("fetch-depth: 0");
    expect(desktopText).toContain("if: github.event_name == 'pull_request'");
    expect(desktopText).toContain(
      "BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    );
    expect(desktopText).toContain(
      'run: bash dev/scripts/ensure-ci-base.sh "$BASE_SHA"',
    );
    expect(desktopText).not.toContain("TURBO_SCM_BASE: HEAD^");
  });

  test("nightly indicators and monthly mutation assurance are independently dispatchable", async () => {
    const nightly = await workflow("encryption-assurance.yml");
    const mutation = await workflow("lattice-mutation-assurance.yml");
    const mutationText = await source(
      ".github/workflows/lattice-mutation-assurance.yml",
    );

    expect(nightly.on).toEqual({
      schedule: [{ cron: "0 1 * * *" }],
      workflow_dispatch: null,
    });
    expect(Object.keys(nightly.jobs).sort()).toEqual([
      "encryption-assurance",
      "lattice-browser-integration",
      "lattice-storage-integration",
    ]);
    expect(mutation.on).toEqual({
      schedule: [{ cron: "0 3 1 * *" }],
      workflow_dispatch: null,
    });
    expect(mutation.jobs["encryption-mutation"]).toBeDefined();
    expect(mutation.jobs["lattice-mutation-scope"]?.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 4,
    });
    expect(mutation.jobs["lattice-mutation-aggregate"]?.needs).toEqual([
      "lattice-mutation-plan",
      "lattice-mutation-scope",
    ]);
    expect(mutationText).not.toContain("nightly-lattice-mutation");
  });

  test("specialist workflows route by dependency ownership and keep escape hatches", async () => {
    const desktop = await workflow("desktop-smoke.yml");
    const lattice = await workflow("lattice-crypto.yml");
    const latticePr = await workflow("lattice-crypto-pr.yml");
    const supply = await workflow("supply-chain.yml");

    expect(Object.keys(desktop.on).sort()).toEqual([
      "pull_request",
      "workflow_dispatch",
    ]);
    const desktopPaths = eventPaths(desktop.on.pull_request);
    expectPathsCover(
      desktopPaths,
      await workspacePathsFor("@nautilo/desktop"),
    );
    expectPathsCover(desktopPaths, await firstPartyRuntimeWorkspacePaths());
    expect(desktopPaths).toContain("packages/workbench-components/**");
    expect(desktopPaths).toContain("packages/first-party-apps/**");
    expect(desktopPaths).toContain("packages/writer-proposal-core/**");
    expect(desktopPaths).toContain("dev/scripts/install-first-party-apps.ts");

    expect(Object.keys(lattice.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(eventConfig(lattice.on.push).branches).toEqual(["main"]);
    expectPathsCover(
      eventPaths(lattice.on.push),
      await workspacePathsFor("@nautilo/lattice-crypto"),
    );
    expect(Object.keys(lattice.jobs).sort()).toEqual([
      "property-and-fuzz",
      "soak",
      "wasm-reproducibility",
    ]);

    expect(Object.keys(latticePr.on).sort()).toEqual([
      "pull_request",
      "workflow_dispatch",
    ]);
    expect(eventConfig(latticePr.on.pull_request).branches).toEqual(["main"]);
    expectPathsCover(
      eventPaths(latticePr.on.pull_request),
      await workspacePathsFor("@nautilo/lattice-crypto"),
    );
    expect(Object.keys(latticePr.jobs)).toEqual(["integration"]);
    expect(latticePr.jobs.integration?.name).toBe(
      "Lattice integration and scenarios",
    );

    expect(Object.keys(supply.on).sort()).toEqual([
      "pull_request",
      "schedule",
      "workflow_dispatch",
    ]);
    const supplyPaths = eventPaths(supply.on.pull_request);
    for (const required of [
      "**/package.json",
      "bun.lock",
      "patches/**",
      "dev/scripts/install-first-party-apps.ts",
      ".github/scripts/run_socket_scan.py",
      ".github/scripts/test_run_socket_scan.py",
      ".github/workflows/supply-chain.yml",
    ]) {
      expect(supplyPaths).toContain(required);
    }
    expect(supply.on.schedule).toEqual([{ cron: "0 4 * * 1" }]);
  });

  test("every Actions Bun cache is versioned and architecture-safe", async () => {
    const workflowNames = (await readdir(workflowsRoot))
      .filter((name) => name.endsWith(".yml"));
    for (const name of workflowNames) {
      const text = await source(`.github/workflows/${name}`);
      if (!text.includes("~/.bun/install/cache")) continue;
      const parsed = await workflow(name);
      expect(parsed.env?.BUN_VERSION, `${name} must own its Bun version`).toBe(
        "1.3.11",
      );
      for (const line of text.split("\n")) {
        if (line.includes("key:") && line.includes("-bun-")) {
          expect(line).toContain(
            "${{ runner.os }}-${{ runner.arch }}-bun-${{ env.BUN_VERSION }}-",
          );
        }
        if (line.includes("${{ runner.os }}") && line.includes("-bun-") && !line.includes("key:")) {
          expect(line).toContain(
            "${{ runner.os }}-${{ runner.arch }}-bun-${{ env.BUN_VERSION }}-",
          );
        }
      }
    }
  });

  test("main primes one shared Bun cache and PR jobs have one non-blocking writer", async () => {
    const ci = await workflow("ci.yml");
    const ciText = await source(".github/workflows/ci.yml");
    const primer = await workflow("bun-cache-primer.yml");
    const primerText = await source(".github/workflows/bun-cache-primer.yml");
    const prepare = ci.jobs["prepare-bun-cache"];

    expect(primer.on).toEqual({
      push: {
        branches: ["main"],
        paths: [
          ".github/workflows/bun-cache-primer.yml",
          ".github/workflows/ci.yml",
          "package.json",
          "bun.lock",
          "**/bun.lock",
        ],
      },
      workflow_dispatch: null,
    });
    expect(primerText.match(/actions\/cache\/save@/g)).toHaveLength(1);
    expect(primerText).toContain("bun install --frozen-lockfile --ignore-scripts");

    expect(prepare?.steps?.find((step) => step.id === "bun-cache-lookup")?.with)
      .toMatchObject({ "lookup-only": true });
    expect(prepare?.steps?.find((step) => step.id === "warm-bun-cache")?.run)
      .toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(prepare?.steps?.find((step) => step.id === "warm-bun-cache")?.if)
      .toContain("steps.setup-bun-for-cache.outcome == 'success'");
    expect(ciText.match(/actions\/cache\/save@/g)).toHaveLength(1);
    for (const name of ["lint", "typecheck", "test"]) {
      expect(ci.jobs[name]?.needs).toBe("prepare-bun-cache");
      const steps = ci.jobs[name]?.steps ?? [];
      const restore = steps.find((step) =>
        step.uses?.startsWith("actions/cache/restore@")
      );
      expect(restore).toBeDefined();
      expect(restore?.["continue-on-error"]).toBe(true);
      expect(restore?.with?.["restore-keys"]).toBeUndefined();
      expect(steps.some((step) => step.uses?.startsWith("actions/cache/save@")))
        .toBe(false);
      expect(steps.some((step) =>
        step.run === "bun install --frozen-lockfile --ignore-scripts"
      )).toBe(true);
    }
  });

  test("unit tests are non-recursive and transitively cache-correct", async () => {
    const gates = await source("dev/scripts/ci-gates.sh");
    const turbo = JSON.parse(await source("turbo.json")) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    const unitLine = gates
      .split("\n")
      .find((line) => line.includes("turbo run test:unit"));

    expect(unitLine).toContain("--affected");
    expect(unitLine).toContain("--filter='!//'");
    expect(unitLine).not.toContain("--force");
    expect(unitLine).not.toContain("bun run test:unit");
    expect(turbo.tasks["test:unit"]?.dependsOn).toContain("transit");
    for (const [task, config] of Object.entries(turbo.tasks)) {
      if (task.endsWith("#test:unit")) {
        expect(config.dependsOn, `${task} must retain transitive hashing`).toContain(
          "transit",
        );
      }
    }
  });

  test("an upstream source change invalidates a downstream unit-test hash", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "m281-transit-hash-"));
    try {
      writeFixture(
        fixtureRoot,
        "package.json",
        `${JSON.stringify({
          name: "m281-transit-fixture",
          private: true,
          packageManager: "bun@1.3.11",
          workspaces: ["packages/*"],
        })}\n`,
      );
      writeFixture(
        fixtureRoot,
        "turbo.json",
        `${JSON.stringify({
          tasks: {
            transit: { dependsOn: ["^transit"] },
            "test:unit": { dependsOn: ["transit"], outputs: [] },
          },
        })}\n`,
      );
      writeFixture(
        fixtureRoot,
        "packages/upstream/package.json",
        `${JSON.stringify({ name: "@fixture/upstream", version: "1.0.0" })}\n`,
      );
      writeFixture(fixtureRoot, "packages/upstream/src.ts", "export const value = 1;\n");
      writeFixture(
        fixtureRoot,
        "packages/downstream/package.json",
        `${JSON.stringify({
          name: "@fixture/downstream",
          version: "1.0.0",
          scripts: { "test:unit": "true" },
          dependencies: { "@fixture/upstream": "workspace:*" },
        })}\n`,
      );
      writeFixture(
        fixtureRoot,
        "packages/downstream/test.ts",
        'import { value } from "@fixture/upstream"; void value;\n',
      );

      const before = await turboDryHash(
        fixtureRoot,
        "@fixture/downstream#test:unit",
      );
      writeFixture(fixtureRoot, "packages/upstream/src.ts", "export const value = 2;\n");
      const after = await turboDryHash(
        fixtureRoot,
        "@fixture/downstream#test:unit",
      );
      expect(after).not.toBe(before);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("exact-base helper fetches only the requested SHA and fails closed", async () => {
    const helper = await source("dev/scripts/ensure-ci-base.sh");
    expect(helper).toContain('git cat-file -e "${base_sha}^{commit}"');
    expect(helper).toContain(
      'git fetch --no-tags --depth=1 origin "${base_sha}"',
    );
    expect(helper).not.toContain("fetch-depth: 0");
    expect(helper).not.toContain("HEAD^");
    expect(helper).not.toContain("origin/main");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "m281-exact-base-"));
    try {
      const remote = join(fixtureRoot, "remote.git");
      const seed = join(fixtureRoot, "seed");
      const shallow = join(fixtureRoot, "shallow");
      await git(fixtureRoot, "init", "--bare", remote);
      await git(fixtureRoot, "init", seed);
      await git(seed, "config", "user.email", "m281@example.invalid");
      await git(seed, "config", "user.name", "M281 fixture");
      writeFileSync(join(seed, "fixture.txt"), "base\n");
      await git(seed, "add", "fixture.txt");
      await git(seed, "commit", "-m", "base");
      const baseSha = await git(seed, "rev-parse", "HEAD");
      writeFileSync(join(seed, "fixture.txt"), "head\n");
      await git(seed, "commit", "-am", "head");
      await git(seed, "remote", "add", "origin", `file://${remote}`);
      await git(seed, "push", "origin", "HEAD:main");
      await git(fixtureRoot, "clone", "--depth=1", "--branch", "main", `file://${remote}`, shallow);

      expect(
        (await spawnText(
          "env",
          withoutGitLocalEnvironment("git", [
            "cat-file",
            "-e",
            `${baseSha}^{commit}`,
          ]),
          { cwd: shallow },
        )).status,
      ).not.toBe(0);
      const fetchResult = await spawnText(
        "env",
        withoutGitLocalEnvironment("bash", [
          join(repositoryRoot, "dev/scripts/ensure-ci-base.sh"),
          baseSha,
        ]),
        { cwd: shallow },
      );
      if (fetchResult.status !== 0) {
        throw new Error(
          `Exact-base fetch failed (status ${String(fetchResult.status)}):\n${fetchResult.stderr}`,
        );
      }
      expect(
        (await spawnText(
          "env",
          withoutGitLocalEnvironment("git", [
            "cat-file",
            "-e",
            `${baseSha}^{commit}`,
          ]),
          { cwd: shallow },
        )).status,
      ).toBe(0);

      const missingResult = await spawnText(
        "env",
        withoutGitLocalEnvironment("bash", [
          join(repositoryRoot, "dev/scripts/ensure-ci-base.sh"),
          "0".repeat(40),
        ]),
        { cwd: shallow },
      );
      expect(missingResult.status).not.toBe(0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
