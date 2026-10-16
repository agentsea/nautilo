import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { requiresFullWindowsValidation } from "../../scripts/windows-validation-scope";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
type Step = { name?: string; id?: string; run?: string; if?: string };
type Workflow = {
  on: { pull_request: { paths: string[] }; schedule: { cron: string }[]; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};
const workflow = Bun.YAML.parse(readFileSync(resolve(repositoryRoot, ".github/workflows/windows-desktop.yml"), "utf8")) as Workflow;

function withGitFixture(action: (fixture: {
  write: (path: string, contents: string) => void;
  git: (...args: string[]) => string;
  commit: (parent?: string) => string;
  run: (base: string, head: string) => { status: number | null; output: string };
  root: string;
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "windows-scope-git-"));
  const environment = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "CI fixture",
    GIT_AUTHOR_EMAIL: "ci-fixture@example.invalid",
    GIT_COMMITTER_NAME: "CI fixture",
    GIT_COMMITTER_EMAIL: "ci-fixture@example.invalid",
  };
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: root, env: environment, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = (path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (parent?: string): string => {
    git("add", "-A");
    const tree = git("write-tree");
    // Construct only temporary fixture objects; no product refs or hooks change.
    return git("commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture");
  };
  try {
    git("init", "--quiet");
    const script = "dev/scripts/windows-validation-scope.ts";
    mkdirSync(dirname(join(root, script)), { recursive: true });
    copyFileSync(join(repositoryRoot, script), join(root, script));
    action({
      root, write, git, commit,
      run: (base, head) => {
        const eventPath = join(root, "event.json");
        const outputPath = join(root, "output");
        writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
        writeFileSync(outputPath, "");
        const result = spawnSync(process.execPath, [join(root, script)], {
          cwd: root,
          env: { ...environment, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
          encoding: "utf8",
        });
        return { status: result.status, output: readFileSync(outputPath, "utf8") };
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Windows qualification scope", () => {
  test.each([
    "packages/server/src/routes/rooms.ts",
    "packages/agent/src/tools/catalog.ts",
    "packages/db/src/schema/users.ts",
    "packages/runtime/src/jobs.ts",
    "apps/workbench/src/components/Chat.tsx",
    "bin/nautilo-dev/src/commands/verify.ts",
    "packages/config/src/instance-id.ts",
    "README.md",
  ])("ordinary feature change keeps the PR on source checks: %s", (path) => {
    expect(requiresFullWindowsValidation("pull_request", [path])).toBe(false);
  });

  test.each([
    "apps/desktop/electron-builder.yml",
    "apps/desktop/scripts/build-electron.ts",
    "apps/desktop/electron/main.ts",
    "bin/nautilo-relay/src/desktop-host-main.ts",
    "packages/relay/src/desktop-host-protocol.ts",
    "packages/lattice-crypto/vendor/openmls-wasm/openmls_wasm.js",
    "packages/lattice-crypto/vendor/openmls-wasm/openmls_wasm_bg.wasm",
    "native/apply-patch/Cargo.lock",
    "patches/knip@5.88.1.patch",
    "package.json",
    "packages/config/package.json",
    "bun.lock",
    "packages/first-party-apps/writer/bun.lock",
    ".bun-version",
    ".gitattributes",
    "bunfig.toml",
    "turbo.json",
    "tsconfig.base.json",
    ".github/workflows/windows-desktop.yml",
    "dev/scripts/windows-validation-scope.ts",
    "dev/scripts/install-first-party-apps.ts",
    "dev/scripts/fix-node-pty-perms.ts",
  ])("packaging, native, or dependency changes retain full PR qualification: %s", (path) => {
    expect(requiresFullWindowsValidation("pull_request", [path])).toBe(true);
    expect(workflow.on.pull_request.paths.some((pattern) => new Bun.Glob(pattern).match(path))).toBe(true);
  });

  test("one packaging input keeps a mixed PR on full qualification", () => {
    expect(requiresFullWindowsValidation("pull_request", [
      "packages/server/src/routes/rooms.ts",
      "bun.lock",
    ])).toBe(true);
  });

  test.each(["schedule", "workflow_dispatch"])("%s always exercises full qualification without a PR diff", (eventName) => {
    expect(requiresFullWindowsValidation(eventName, [])).toBe(true);
  });

  test("an unsupported event cannot silently select reduced validation", () => {
    expect(() => requiresFullWindowsValidation("push", [])).toThrow();
  });

  test("the CLI inspects exact local PR commits and writes the source-only decision", () => {
    const root = mkdtempSync(join(tmpdir(), "windows-scope-cli-"));
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
      expect(head.status).toBe(0);
      const sha = head.stdout.trim();
      const eventPath = join(root, "event.json");
      const output = join(root, "output");
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha }, head: { sha } } }));
      const run = spawnSync(process.execPath, [join(repositoryRoot, "dev/scripts/windows-validation-scope.ts")], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("full=false\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid PR metadata fails without emitting a reduced-validation decision", () => {
    const root = mkdtempSync(join(tmpdir(), "windows-scope-invalid-"));
    try {
      const eventPath = join(root, "event.json");
      const output = join(root, "output");
      writeFileSync(output, "");
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: "not-a-commit" }, head: { sha: "also-invalid" } } }));
      const run = spawnSync(process.execPath, [join(repositoryRoot, "dev/scripts/windows-validation-scope.ts")], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("exact 40-character lowercase commit SHA");
      expect(readFileSync(output, "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packaging changes only on main do not promote a feature PR to full qualification", () => {
    withGitFixture(({ write, git, commit, run }) => {
      write("package.json", '{"version":"1"}');
      const common = commit();
      write("packages/server/src/rooms.ts", "export const feature = true;\n");
      const feature = commit(common);
      git("read-tree", common);
      write("package.json", '{"version":"2"}');
      git("add", "package.json");
      const upstream = git("commit-tree", git("write-tree"), "-p", common, "-m", "upstream");
      expect(run(upstream, feature)).toEqual({ status: 0, output: "full=false\n" });
    });
  });

  test("moving a packaging file into an ordinary source directory still selects full qualification", () => {
    withGitFixture(({ root, write, commit, run }) => {
      write("apps/desktop/old.ts", "export const moved = true;\n");
      const base = commit();
      mkdirSync(join(root, "packages/server"), { recursive: true });
      renameSync(join(root, "apps/desktop/old.ts"), join(root, "packages/server/moved.ts"));
      const head = commit(base);
      expect(run(base, head)).toEqual({ status: 0, output: "full=true\n" });
    });
  });

  test("unavailable comparison commits fail without selecting source-only validation", () => {
    withGitFixture(({ commit, run }) => {
      const base = commit();
      // This repository has no remote, so failure cannot contact a live service.
      const result = run(base, "0".repeat(40));
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
    });
  });

  test("full qualification remains available manually and every night", () => {
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
    for (const { cron } of workflow.on.schedule) {
      const [minute, hour, day, month, weekday] = cron.split(" ");
      expect(Number(minute)).toBeGreaterThanOrEqual(0);
      expect(Number(minute)).toBeLessThan(60);
      expect(Number(hour)).toBeGreaterThanOrEqual(0);
      expect(Number(hour)).toBeLessThan(24);
      expect([day, month, weekday]).toEqual(["*", "*", "*"]);
    }
  });

  test("source tests, invariants, and Writer/Video checks still run on every admitted PR", () => {
    const steps = workflow.jobs["windows-x64"]!.steps;
    for (const command of [
      "bun dev/scripts/windows-unit-gate.ts",
      "bun run test:invariants",
      "bun run --cwd packages/first-party-apps/writer typecheck",
      "bun run --cwd packages/first-party-apps/video typecheck",
      "bun run --cwd packages/first-party-apps/writer build",
      "bun run --cwd packages/first-party-apps/video build",
    ]) {
      const step = steps.find((candidate) => candidate.run === command);
      expect(step, `Windows source check must remain: ${command}`).toBeDefined();
      expect(step!.if).toBeUndefined();
    }
  });

  test("all seven expensive checks share the classification output and retain their order", () => {
    const steps = workflow.jobs["windows-x64"]!.steps;
    const expectedNames = [
      "Typecheck Desktop",
      "Typecheck development tools",
      "Typecheck database",
      "Typecheck server",
      "Build Windows Desktop installer",
      "Verify packaged Relay Host launch",
      "Smoke-test packaged Desktop boot",
    ];
    const conditional = steps.filter((step) => step.if !== undefined);
    expect(conditional.map((step) => step.name)).toEqual(expectedNames);
    for (const step of conditional) {
      expect(step.if).toContain("steps.validation-scope.outputs.full == 'true'");
    }
    const scopeIndex = steps.findIndex((step) => step.id === "validation-scope");
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(steps[scopeIndex]!.run).toContain("bun dev/scripts/windows-validation-scope.ts");
    expect(steps[scopeIndex]!.if).toBeUndefined();
    expect(scopeIndex).toBeLessThan(steps.findIndex((step) => step.run === "bun install --frozen-lockfile"));
    expect(workflow.permissions).toEqual({ contents: "read" });
  });
});
