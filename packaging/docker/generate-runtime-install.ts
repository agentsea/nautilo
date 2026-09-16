import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const RUNTIME_INSTALL_DIR = join(import.meta.dir, "runtime-install");
const POLICY_PATH = join(import.meta.dir, "runtime-install-policy.json");

type DependencyMap = Record<string, string>;

export type PackageManifest = {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  imports?: unknown;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  overrides?: DependencyMap;
  packageManager?: string;
  workspaces?: string[];
};

export type WorkspaceManifest = {
  path: string;
  manifest: PackageManifest;
};

type RuntimeInstallPolicy = {
  schemaVersion: 1;
  entryWorkspace: string;
  rootOverrides: string[];
  reviewedExceptions: Array<{
    kind: "root-override";
    name: string;
    reason: string;
  }>;
};

type ProjectionSummary = {
  schemaVersion: 1;
  generatedBy: string;
  entryWorkspace: string;
  workspaceCount: number;
  workspaces: Array<{ name: string; path: string }>;
  reviewedExceptions: RuntimeInstallPolicy["reviewedExceptions"];
};

const RUNTIME_MANIFEST_FIELDS = [
  "name",
  "version",
  "private",
  "type",
  "main",
  "module",
  "exports",
  "imports",
  "bin",
  "engines",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const satisfies ReadonlyArray<keyof PackageManifest>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function workspacePaths(rootManifest: PackageManifest): string[] {
  const paths: string[] = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const root = pattern.slice(0, -2);
      const absoluteRoot = join(REPO_ROOT, root);
      for (const child of readdirSync(absoluteRoot).sort()) {
        const path = `${root}/${child}`;
        if (existsSync(join(REPO_ROOT, path, "package.json"))) paths.push(path);
      }
      continue;
    }
    if (!existsSync(join(REPO_ROOT, pattern, "package.json"))) {
      throw new Error(`workspace manifest is missing: ${pattern}/package.json`);
    }
    paths.push(pattern);
  }
  return paths.sort();
}

export function loadWorkspaceManifests(): Map<string, WorkspaceManifest> {
  const rootManifest = readJson<PackageManifest>(join(REPO_ROOT, "package.json"));
  const workspaces = new Map<string, WorkspaceManifest>();
  for (const path of workspacePaths(rootManifest)) {
    const manifest = readJson<PackageManifest>(join(REPO_ROOT, path, "package.json"));
    if (!manifest.name) throw new Error(`workspace has no name: ${path}`);
    if (workspaces.has(manifest.name)) throw new Error(`duplicate workspace name: ${manifest.name}`);
    workspaces.set(manifest.name, { path, manifest });
  }
  return workspaces;
}

export function computeProductionClosure(
  entryWorkspace: string,
  workspaces: ReadonlyMap<string, WorkspaceManifest>,
): Set<string> {
  if (!workspaces.has(entryWorkspace)) throw new Error(`entry workspace is missing: ${entryWorkspace}`);

  const closure = new Set<string>();
  const pending = [entryWorkspace];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (closure.has(name)) continue;
    closure.add(name);

    const workspace = workspaces.get(name)!;
    for (const [dependency, version] of Object.entries(workspace.manifest.dependencies ?? {})) {
      const isLocalFile = version.startsWith("file:");
      const target = workspaces.get(dependency);
      if (!version.startsWith("workspace:") && !isLocalFile && !target) continue;
      if (!workspaces.has(dependency)) {
        throw new Error(`${workspace.path} requires missing production workspace ${dependency}`);
      }
      if (isLocalFile && resolve(REPO_ROOT, workspace.path, version.slice(5)) !==
        resolve(REPO_ROOT, workspaces.get(dependency)!.path)) {
        throw new Error(`${workspace.path} local dependency ${dependency} does not name its registered workspace`);
      }
      if (!version.startsWith("workspace:") && !isLocalFile && version !== target!.manifest.version) {
        throw new Error(`${workspace.path} requires ${dependency}@${version}, not its registered workspace version ${target!.manifest.version}`);
      }
      pending.push(dependency);
    }
  }
  return closure;
}

function projectManifest(manifest: PackageManifest): PackageManifest {
  const projected: PackageManifest = { name: manifest.name };
  for (const field of RUNTIME_MANIFEST_FIELDS) {
    const value = manifest[field];
    if (value !== undefined) (projected as Record<string, unknown>)[field] = value;
  }
  return projected;
}

function writeProjectionTree(outputDir: string): ProjectionSummary {
  const policy = readJson<RuntimeInstallPolicy>(POLICY_PATH);
  const rootManifest = readJson<PackageManifest>(join(REPO_ROOT, "package.json"));
  const workspaces = loadWorkspaceManifests();
  const closure = computeProductionClosure(policy.entryWorkspace, workspaces);
  const selected = [...closure]
    .map((name) => ({ name, ...workspaces.get(name)! }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const exceptionsByName = new Map(policy.reviewedExceptions.map((item) => [item.name, item]));
  const rootOverrides: DependencyMap = {};
  for (const name of [...policy.rootOverrides].sort()) {
    const value = rootManifest.overrides?.[name];
    if (!value) throw new Error(`runtime override is absent from root package.json: ${name}`);
    if (!exceptionsByName.has(name)) throw new Error(`runtime override has no reviewed exception: ${name}`);
    rootOverrides[name] = value;
  }
  for (const exception of policy.reviewedExceptions) {
    if (!policy.rootOverrides.includes(exception.name)) {
      throw new Error(`reviewed exception is not used by the runtime projection: ${exception.name}`);
    }
  }

  mkdirSync(outputDir, { recursive: true });
  const projectedRoot: PackageManifest = {
    name: "@nautilo/runtime-install",
    version: "0.0.0",
    private: true,
    ...(rootManifest.packageManager === undefined ? {} : { packageManager: rootManifest.packageManager }),
    workspaces: selected.map((item) => item.path),
    overrides: rootOverrides,
  };
  writeFileSync(join(outputDir, "package.json"), stableJson(projectedRoot));

  for (const workspace of selected) {
    const outputPath = join(outputDir, workspace.path, "package.json");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, stableJson(projectManifest(workspace.manifest)));
  }

  const summary: ProjectionSummary = {
    schemaVersion: 1,
    generatedBy: "packaging/docker/generate-runtime-install.ts",
    entryWorkspace: policy.entryWorkspace,
    workspaceCount: selected.length,
    workspaces: selected.map(({ name, path }) => ({ name, path })),
    reviewedExceptions: [...policy.reviewedExceptions].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(join(outputDir, "projection.json"), stableJson(summary));
  return summary;
}

function generateFrozenLock(outputDir: string): void {
  cpSync(join(REPO_ROOT, "bun.lock"), join(outputDir, "bun.lock"));
  const environment = { ...process.env };
  delete environment["CI"];
  const result = spawnSync(
    process.execPath,
    [
      "install",
      "--cwd",
      outputDir,
      "--lockfile-only",
      "--ignore-scripts",
      "--linker=hoisted",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: environment },
  );
  if (result.status !== 0) {
    throw new Error(`failed to generate runtime bun.lock:\n${result.stdout}${result.stderr}`);
  }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  }
  visit(root);
  return files;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertTreesEqual(expectedRoot: string, actualRoot: string): void {
  if (!existsSync(actualRoot)) throw new Error(`generated runtime install directory is missing: ${actualRoot}`);
  const expectedFiles = filesUnder(expectedRoot);
  const actualFiles = filesUnder(actualRoot);
  if (stableJson(expectedFiles) !== stableJson(actualFiles)) {
    throw new Error("generated runtime install file list has drifted; run `bun run docker:runtime-install:generate`");
  }
  const changed = expectedFiles.filter((path) => digest(join(expectedRoot, path)) !== digest(join(actualRoot, path)));
  if (changed.length > 0) {
    throw new Error(`generated runtime install files have drifted: ${changed.join(", ")}; run \`bun run docker:runtime-install:generate\``);
  }
}

export function generateRuntimeInstall(options: { check?: boolean } = {}): ProjectionSummary {
  const tempRoot = mkdtempSync(join(tmpdir(), "nautilo-runtime-install-"));
  const generatedRoot = join(tempRoot, basename(RUNTIME_INSTALL_DIR));
  try {
    const summary = writeProjectionTree(generatedRoot);
    generateFrozenLock(generatedRoot);
    if (options.check) {
      assertTreesEqual(generatedRoot, RUNTIME_INSTALL_DIR);
    } else {
      rmSync(RUNTIME_INSTALL_DIR, { recursive: true, force: true });
      cpSync(generatedRoot, RUNTIME_INSTALL_DIR, { recursive: true });
    }
    return summary;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const summary = generateRuntimeInstall({ check: args.has("--check") });
  console.log(
    args.has("--check")
      ? `runtime install projection is current (${summary.workspaceCount} workspaces)`
      : `generated runtime install projection (${summary.workspaceCount} workspaces)`,
  );
}
