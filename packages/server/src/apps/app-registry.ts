import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  isSafeMiniAppId,
  parseMiniAppManifestJson,
  type MiniAppManifest,
} from "./app-manifest";
import { getDisabledAppIds } from "./app-state-store";

export type AppStatus = "ready" | "invalid_manifest" | "needs_dependencies";

export interface RegisteredMiniApp {
  id: string;
  root: string;
  manifest: MiniAppManifest | null;
  status: AppStatus;
  sourceHash: string | null;
  /** D344 — ISO timestamp of the app's `app.json` mtime, a proxy for "installed
   *  at" used to sort the Apps page by newest/oldest. Null if stat fails. */
  installedAt: string | null;
  /** D343 — false when the operator has disabled this app via the
   *  `.app-state.json` persisted disabled set. Disabled apps stay installed
   *  (AI reference, file associations) but are excluded from agent-tool
   *  registration and marked `enabled: false` in the public API. */
  enabled: boolean;
  error?: string;
}

const SOURCE_HASH_SKIP_DIRS = new Set([
  "node_modules",
  ".cache",
  ".git",
  "dist",
  "build",
  "out",
  ".turbo",
  "coverage",
]);

const SOURCE_HASH_SKIP_FILES = new Set([".DS_Store", ".nautilo-seed.json"]);

function shouldSkipSourceHashEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return SOURCE_HASH_SKIP_DIRS.has(name);
  }
  return SOURCE_HASH_SKIP_FILES.has(name);
}

async function collectSourceFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipSourceHashEntry(entry.name, entry.isDirectory())) {
      continue;
    }
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(absPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(absPath);
    }
  }
}

async function hashSourceTree(root: string): Promise<string> {
  const files: string[] = [];
  await collectSourceFiles(root, files);
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = relative(root, filePath).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface PackageJsonDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const PACKAGE_JSON_DEP_SECTIONS = [
  "dependencies",
  "optionalDependencies",
] as const satisfies readonly (keyof PackageJsonDeps)[];

function isFileDependencySpec(spec: string): boolean {
  return spec.startsWith("file:");
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isDirectory();
  } catch {
    return false;
  }
}

export function nodeModulesPackagePath(appRoot: string, packageName: string): string {
  if (packageName.startsWith("@")) {
    const slash = packageName.indexOf("/");
    return join(appRoot, "node_modules", packageName.slice(0, slash), packageName.slice(slash + 1));
  }
  return join(appRoot, "node_modules", packageName);
}

async function resolveLocalFileDependencyRoot(
  appRoot: string,
  packageName: string,
  fileSpec: string,
): Promise<string | null> {
  // The declared file: target is the source of truth. Bun may materialize a
  // physical app-local package copy and leave it stale after the source gains
  // files, so preferring node_modules can produce a matching hash for broken
  // bytes and prevent the first-party seeder from repairing the app.
  const linkedPath = resolve(appRoot, fileSpec.slice("file:".length));
  if (await isExistingDirectory(linkedPath)) {
    return linkedPath;
  }

  // Installed standalone apps no longer have the original relative source
  // tree. Fall back to their self-contained dependency copy for registry and
  // runtime hashing.
  const installedPath = nodeModulesPackagePath(appRoot, packageName);
  if (await isExistingDirectory(installedPath)) {
    return installedPath;
  }
  return null;
}

export interface LocalFileDependencySource {
  name: string;
  root: string;
}

export async function collectLocalFileDependencySources(
  appRoot: string,
): Promise<LocalFileDependencySource[]> {
  const packageJsonPath = join(appRoot, "package.json");
  let pkg: PackageJsonDeps;
  try {
    pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonDeps;
  } catch {
    return [];
  }

  const sources = new Map<string, LocalFileDependencySource>();
  for (const section of PACKAGE_JSON_DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!isFileDependencySpec(spec)) continue;
      const depRoot = await resolveLocalFileDependencyRoot(appRoot, name, spec);
      if (!depRoot) continue;
      sources.set(name, { name, root: depRoot });
    }
  }

  return [...sources.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function computeAppSourceHash(appRoot: string): Promise<string> {
  const baseIdentity = await hashSourceTree(appRoot);
  const localDeps = await collectLocalFileDependencySources(appRoot);
  if (localDeps.length === 0) {
    return baseIdentity;
  }

  const hash = createHash("sha256");
  hash.update(baseIdentity);
  hash.update("\0");
  for (const { name, root } of localDeps) {
    hash.update(name);
    hash.update("\0");
    hash.update(await hashSourceTree(root));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function packageDeclaresDependencies(pkg: PackageJsonDeps): boolean {
  for (const key of PACKAGE_JSON_DEP_SECTIONS) {
    const section = pkg[key];
    if (section && Object.keys(section).length > 0) {
      return true;
    }
  }
  return false;
}

async function appNeedsDependencies(appRoot: string): Promise<boolean> {
  const packageJsonPath = join(appRoot, "package.json");
  try {
    const packageStat = await stat(packageJsonPath);
    if (!packageStat.isFile()) return false;
  } catch {
    return false;
  }

  let pkg: PackageJsonDeps;
  try {
    pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonDeps;
  } catch {
    return false;
  }
  if (!packageDeclaresDependencies(pkg)) {
    return false;
  }

  const nodeModulesPath = join(appRoot, "node_modules");
  try {
    const nodeModulesStat = await stat(nodeModulesPath);
    return !nodeModulesStat.isDirectory();
  } catch {
    return true;
  }
}

function resolveEntryId(folderName: string, rawManifest: unknown): string {
  if (rawManifest && typeof rawManifest === "object" && !Array.isArray(rawManifest)) {
    const maybeId = (rawManifest as Record<string, unknown>)["id"];
    if (typeof maybeId === "string" && isSafeMiniAppId(maybeId)) {
      return maybeId;
    }
  }
  if (isSafeMiniAppId(folderName)) {
    return folderName;
  }
  return folderName.replace(/[^a-z0-9-]/g, "-").slice(0, 64) || "invalid-app";
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function statMtimeIso(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}

async function scanAppFolder(appsRoot: string, folderName: string): Promise<RegisteredMiniApp> {
  const appRoot = join(appsRoot, folderName);
  const manifestPath = join(appRoot, "app.json");
  // D344 — "installed at" proxy from the manifest file mtime (for Apps-page
  // newest/oldest sort). Captured up front so every return path carries it.
  const installedAt = await statMtimeIso(manifestPath);

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    return {
      id: resolveEntryId(folderName, null),
      root: appRoot,
      manifest: null,
      status: "invalid_manifest",
      sourceHash: null,
      installedAt,
      enabled: true,
      error: `failed to read app.json: ${safeErrorMessage(err)}`,
    };
  }

  const validated = parseMiniAppManifestJson(rawManifest);
  if (!validated.ok) {
    return {
      id: resolveEntryId(folderName, rawManifest),
      root: appRoot,
      manifest: null,
      status: "invalid_manifest",
      sourceHash: null,
      installedAt,
      enabled: true,
      error: validated.error,
    };
  }

  const manifest = validated.manifest;
  const sourceHash = await computeAppSourceHash(appRoot);
  if (await appNeedsDependencies(appRoot)) {
    return {
      id: manifest.id,
      root: appRoot,
      manifest,
      status: "needs_dependencies",
      sourceHash,
      installedAt,
      enabled: true,
    };
  }

  return {
    id: manifest.id,
    root: appRoot,
    manifest,
    status: "ready",
    sourceHash,
    installedAt,
    enabled: true,
  };
}

export async function scanInstalledApps(appsRoot: string): Promise<RegisteredMiniApp[]> {
  let entries;
  try {
    entries = await readdir(appsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  // D343 — read the disabled set ONCE per scan; `scanAppFolder` defaults
  // `enabled: true` and we override it here so the on-disk state is the single
  // source of truth.
  const disabled = await getDisabledAppIds(appsRoot);

  const apps: RegisteredMiniApp[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip dot-prefixed operational state (.cache, .app-state.json parent dirs,
    // .nautilo-*.seed-*, .nautilo-*.previous-*) — not installable apps.
    if (entry.name.startsWith(".")) continue;
    const manifestPath = join(appsRoot, entry.name, "app.json");
    try {
      const manifestStat = await stat(manifestPath);
      if (!manifestStat.isFile()) continue;
    } catch {
      continue;
    }
    const scanned = await scanAppFolder(appsRoot, entry.name);
    apps.push({ ...scanned, enabled: !disabled.has(scanned.id) });
  }

  apps.sort((a, b) => a.id.localeCompare(b.id));
  return apps;
}
