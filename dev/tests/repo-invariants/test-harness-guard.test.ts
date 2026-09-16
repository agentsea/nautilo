import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

type PackageHarness = {
  readonly path: string;
  readonly scripts: Record<string, string>;
  readonly knipEntries: readonly string[];
  readonly isolatedFiles: Readonly<Record<"unit" | "integration", readonly string[]>>;
  readonly runScripts: Readonly<Record<string, string>>;
};

type HarnessViolation = {
  readonly packagePath: string;
  readonly code:
    | "missing_knip_entry"
    | "directory_batch_isolated"
    | "hardcoded_list_omits_file";
  readonly message: string;
};

const repoRoot = join(import.meta.dir, "../../..");
const isolatedKinds = ["unit", "integration"] as const;

describe("test harness invariants (D256)", () => {
  test("bun.lock records the repository-pinned Bun config version", () => {
    const raw = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    const versions = [...raw.matchAll(/^\s*"configVersion":\s*(\d+),?$/gmu)].map((match) =>
      Number(match[1]),
    );

    expect(versions).toEqual([0]);
  });

  test("current repository satisfies isolated-test + Knip visibility invariants", () => {
    const packages = loadWorkspacePackages(repoRoot);
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.some((pkg) => hasShellWrappedTestScript(pkg))).toBe(true);

    const violations = validateHarness(packages);
    expect(violations).toEqual([]);
  });

  test("test modules cannot terminate their shared runner process", () => {
    const offenders = listRepositoryTestFiles(repoRoot)
      .filter((file) => containsExecutableProcessExit(file))
      .map((file) => relative(repoRoot, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });

  test("process-exit detector ignores fixtures but rejects executable calls", () => {
    expect(containsExecutableProcessExit("fixture.ts", "process.exit(0);")).toBe(true);
    expect(containsExecutableProcessExit("fixture.ts", "process?.exit(1);")).toBe(true);
    expect(containsExecutableProcessExit("fixture.ts", 'const value = "process.exit(0)";')).toBe(false);
    expect(containsExecutableProcessExit("fixture.ts", "const value = `process.exit(0)`;")).toBe(false);
  });

  test("fails when a shell-wrapped unit script hides tests from Knip", () => {
    const violations = validateHarness([
      fakePackage({
        scripts: { "test:unit": "bash scripts/run-unit.sh" },
        knipEntries: [],
        isolatedFiles: { unit: ["tests/unit-isolated/a.test.ts"], integration: [] },
        runScripts: {
          "scripts/run-unit.sh":
            "bun test tests/unit/\nfind tests/unit-isolated -name '*.test.ts' -print0",
        },
      }),
    ]);

    expect(violations.map((v) => v.code)).toContain("missing_knip_entry");
  });

  test("does not require a Knip entry for an empty isolated lane", () => {
    const violations = validateHarness([
      fakePackage({
        scripts: { "test:integration": "bash scripts/run-integration.sh" },
        knipEntries: ["tests/integration/**/*.test.ts"],
        isolatedFiles: { unit: [], integration: [] },
      }),
    ]);

    expect(violations).toEqual([]);
  });

  test("allows inline bun test paths because Knip can parse them", () => {
    const violations = validateHarness([
      fakePackage({
        scripts: {
          "test:unit":
            "bun test tests/unit/ && bun test tests/unit-isolated/only.test.ts",
        },
        knipEntries: [],
        isolatedFiles: { unit: ["tests/unit-isolated/only.test.ts"], integration: [] },
      }),
    ]);

    expect(violations).toEqual([]);
  });

  test("fails when multiple isolated files run as one directory batch", () => {
    const violations = validateHarness([
      fakePackage({
        scripts: { "test:unit": "bun test tests/unit/ && bun test tests/unit-isolated/" },
        isolatedFiles: {
          unit: ["tests/unit-isolated/a.test.ts", "tests/unit-isolated/b.test.ts"],
          integration: [],
        },
      }),
    ]);

    expect(violations.map((v) => v.code)).toContain("directory_batch_isolated");
  });

  test("fails when a hardcoded run script omits an isolated file on disk", () => {
    const violations = validateHarness([
      fakePackage({
        scripts: { "test:unit": "bash scripts/run-unit.sh" },
        knipEntries: ["tests/unit/**/*.test.ts", "tests/unit-isolated/**/*.test.ts"],
        isolatedFiles: {
          unit: ["tests/unit-isolated/a.test.ts", "tests/unit-isolated/b.test.ts"],
          integration: [],
        },
        runScripts: {
          "scripts/run-unit.sh": [
            "bun test tests/unit/",
            "bun test tests/unit-isolated/a.test.ts",
          ].join("\n"),
        },
      }),
    ]);

    expect(violations.map((v) => v.code)).toContain("hardcoded_list_omits_file");
  });
});

function validateHarness(packages: readonly PackageHarness[]): HarnessViolation[] {
  return packages.flatMap((pkg) => [
    ...checkShellWrappedKnipEntries(pkg),
    ...checkDirectoryBatchIsolation(pkg),
    ...checkHardcodedRunScripts(pkg),
  ]);
}

function checkShellWrappedKnipEntries(pkg: PackageHarness): HarnessViolation[] {
  const violations: HarnessViolation[] = [];
  for (const kind of isolatedKinds) {
    const scriptName = kind === "unit" ? "test:unit" : "test:integration";
    const script = pkg.scripts[scriptName] ?? "";
    if (!isShellWrapped(script)) continue;

    const required = [`tests/${kind}/**/*.test.ts`];
    if (pkg.isolatedFiles[kind].length > 0) {
      required.push(`tests/${kind}-isolated/**/*.test.ts`);
    }

    for (const pattern of required) {
      if (!entryCovers(pkg.knipEntries, pattern)) {
        violations.push({
          packagePath: pkg.path,
          code: "missing_knip_entry",
          message: `${pkg.path} ${scriptName} uses a shell wrapper but knip entry does not cover ${pattern}`,
        });
      }
    }
  }
  return violations;
}

function checkDirectoryBatchIsolation(pkg: PackageHarness): HarnessViolation[] {
  const violations: HarnessViolation[] = [];
  for (const kind of isolatedKinds) {
    const scriptName = kind === "unit" ? "test:unit" : "test:integration";
    const script = pkg.scripts[scriptName] ?? "";
    const files = pkg.isolatedFiles[kind];
    if (files.length <= 1) continue;

    const dir = `tests/${kind}-isolated/`;
    if (new RegExp(`bun\\s+test\\b[^&|;\\n]*${escapeRegExp(dir)}(?:\\s|$)`).test(script)) {
      violations.push({
        packagePath: pkg.path,
        code: "directory_batch_isolated",
        message: `${pkg.path} ${scriptName} batches ${files.length} files in ${dir}; run them one-file-per-process`,
      });
    }
  }
  return violations;
}

function checkHardcodedRunScripts(pkg: PackageHarness): HarnessViolation[] {
  const violations: HarnessViolation[] = [];
  for (const kind of isolatedKinds) {
    const scriptName = kind === "unit" ? "test:unit" : "test:integration";
    const shellPath = shellScriptPath(pkg.scripts[scriptName] ?? "");
    if (!shellPath) continue;
    const body = pkg.runScripts[shellPath] ?? "";
    const files = pkg.isolatedFiles[kind];
    if (files.length === 0) continue;
    if (body.includes(`find tests/${kind}-isolated`)) continue;

    for (const file of files) {
      if (!body.includes(file)) {
        violations.push({
          packagePath: pkg.path,
          code: "hardcoded_list_omits_file",
          message: `${pkg.path} ${shellPath} does not mention ${file}; prefer a find-loop`,
        });
      }
    }
  }
  return violations;
}

function loadWorkspacePackages(root: string): PackageHarness[] {
  const rootPackageJson = readJson(join(root, "package.json")) as {
    workspaces?: string[];
  };
  const knip = readJson(join(root, "knip.json")) as {
    workspaces?: Record<string, { entry?: string | string[] }>;
  };

  const packagePaths = new Set<string>();
  for (const workspace of rootPackageJson.workspaces ?? []) {
    for (const pkgPath of expandWorkspace(root, workspace)) {
      packagePaths.add(pkgPath);
    }
  }

  return [...packagePaths].sort().flatMap((pkgPath) => {
    const manifestPath = join(root, pkgPath, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = readJson(manifestPath) as { scripts?: Record<string, string> };
    const scripts = manifest.scripts ?? {};
    const knipEntries = normalizeEntries(knip.workspaces?.[pkgPath]?.entry);
    return [{
      path: pkgPath,
      scripts,
      knipEntries,
      isolatedFiles: {
        unit: listRelativeTestFiles(root, pkgPath, "tests/unit-isolated"),
        integration: listRelativeTestFiles(root, pkgPath, "tests/integration-isolated"),
      },
      runScripts: loadRunScripts(root, pkgPath),
    }];
  });
}

function listRepositoryTestFiles(root: string): string[] {
  const packagePaths = loadWorkspacePackages(root).map((pkg) => pkg.path);
  const searchRoots = ["dev", ...packagePaths]
    .map((path) => join(root, path))
    .filter((path) => existsSync(path));

  return searchRoots
    .flatMap((path) => walkTestFiles(path))
    .filter((path) => /(?:^|\.)((?:test)|(?:spec))\.[cm]?tsx?$/u.test(path))
    .sort();
}

function walkTestFiles(dir: string): string[] {
  const ignoredDirectories = new Set([
    ".git",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ]);

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : walkTestFiles(abs);
    }
    return [abs];
  });
}

function containsExecutableProcessExit(path: string, source = readFileSync(path, "utf8")): boolean {
  const scriptKind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "process"
        && expression.name.text === "exit"
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function expandWorkspace(root: string, workspace: string): string[] {
  if (!workspace.endsWith("/*")) return [workspace].filter((p) => existsSync(join(root, p)));
  const parent = workspace.slice(0, -2);
  const parentAbs = join(root, parent);
  if (!existsSync(parentAbs)) return [];
  return readdirSync(parentAbs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

function loadRunScripts(root: string, pkgPath: string): Record<string, string> {
  const scriptsDir = join(root, pkgPath, "scripts");
  if (!existsSync(scriptsDir)) return {};
  const result: Record<string, string> = {};
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("run-") || !entry.name.endsWith(".sh")) {
      continue;
    }
    const rel = `scripts/${entry.name}`;
    result[rel] = readFileSync(join(scriptsDir, entry.name), "utf8");
  }
  return result;
}

function listRelativeTestFiles(
  root: string,
  pkgPath: string,
  testDir: string,
): string[] {
  const abs = join(root, pkgPath, testDir);
  if (!existsSync(abs)) return [];
  return walk(abs)
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => relative(join(root, pkgPath), file).replaceAll("\\", "/"))
    .sort();
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    return entry.isDirectory() ? walk(abs) : [abs];
  });
}

function isShellWrapped(script: string): boolean {
  return /\bbash\s+scripts\/run-[\w.-]+\.sh\b/.test(script);
}

function shellScriptPath(script: string): string | null {
  return script.match(/\bbash\s+(scripts\/run-[\w.-]+\.sh)\b/)?.[1] ?? null;
}

function entryCovers(entries: readonly string[], required: string): boolean {
  return entries.some((entry) => {
    if (entry === required) return true;
    if (entry === "tests/**/*.test.ts" && required.startsWith("tests/")) return true;
    if (entry === "tests/**/*.ts" && required.startsWith("tests/")) return true;
    return false;
  });
}

function normalizeEntries(entry: string | string[] | undefined): string[] {
  return typeof entry === "string" ? [entry] : entry ?? [];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function fakePackage(partial: Partial<PackageHarness>): PackageHarness {
  return {
    path: partial.path ?? "packages/example",
    scripts: partial.scripts ?? {},
    knipEntries: partial.knipEntries ?? [],
    isolatedFiles: partial.isolatedFiles ?? { unit: [], integration: [] },
    runScripts: partial.runScripts ?? {},
  };
}

function hasShellWrappedTestScript(pkg: PackageHarness): boolean {
  return isShellWrapped(pkg.scripts["test:unit"] ?? "") ||
    isShellWrapped(pkg.scripts["test:integration"] ?? "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
