import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string> }>;
};

type RootPackage = {
  scripts?: Record<string, string>;
};

async function read(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(join(repositoryRoot, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("retired limit inventory", () => {
  test("has no root commands, package, or developer skill", async () => {
    const rootPackage = JSON.parse(await read("package.json")) as RootPackage;
    const rootScripts = rootPackage.scripts ?? {};

    expect(Object.keys(rootScripts).filter((name) => name.startsWith("limits:"))).toEqual([]);
    expect(await exists("packages/limit-invariants/package.json")).toBe(false);
    expect(await exists("dev/tools/limit-preflight/codex/skills/limit-preflight/SKILL.md")).toBe(false);
  });

  test("has no automatic developer or CI gate", async () => {
    const [rootPackage, gates, localCi, hooks, workflow] = await Promise.all([
      read("package.json"),
      read("dev/scripts/ci-gates.sh"),
      read("dev/scripts/ci-local.sh"),
      read("lefthook.yml"),
      read(".github/workflows/ci.yml"),
    ]);
    const rootScripts = (JSON.parse(rootPackage) as RootPackage).scripts;
    expect(Object.keys(rootScripts ?? {}).filter((name) => name.startsWith("limits:"))).toEqual([]);
    expect(localCi).toContain("bash dev/scripts/ci-gates.sh all");
    for (const source of [gates, localCi, hooks, workflow]) {
      expect(source).not.toContain("limit-invariants");
      expect(source).not.toContain("limit-policy-reviewed");
      expect(source).not.toContain("limits:check");
    }
  });
});

describe("ordinary CI token permissions", () => {
  test("grants source read access and no job-level write exceptions", async () => {
    const source = await readFile(
      join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as Workflow;

    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(
        job.permissions,
        `${jobName} must not widen the ordinary CI workflow token`,
      ).toBeUndefined();
    }
  });
});
