import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppsRoot } from "@nautilo/config";
import {
  collectLocalFileDependencySources,
  computeAppSourceHash,
  nodeModulesPackagePath,
} from "./app-registry";
import { invalidateInstalledAppRegistry } from "./installed-app-registry";

const SEED_MARKER_FILE = ".nautilo-seed.json";

interface FirstPartyAppEntry {
  /** Directory name under `packages/first-party-apps/` that holds the source. */
  sourceDir: string;
  /** Destination app id under `appsRoot`. May differ from `sourceDir`. */
  appId: string;
  initialVersion: string;
  compiledEngine?: boolean;
  requiredEngineFiles?: readonly string[];
  prepareCommand?: string;
}

// Compiled Office apps are present only in prepared builds. Fresh seeds use the
// normal enabled default; refreshes leave persisted app enablement untouched.
const FIRST_PARTY_APPS: readonly FirstPartyAppEntry[] = [
  {
    sourceDir: "board", appId: "nautilo-board", initialVersion: "0.1.0", compiledEngine: true,
    requiredEngineFiles: ["main.js", "agent-tools.js", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    prepareCommand: "bun run board:prepare",
  },
  { sourceDir: "writer", appId: "nautilo-writer", initialVersion: "0.1.0" },
  { sourceDir: "design", appId: "nautilo-design", initialVersion: "0.1.0" },
  { sourceDir: "spreadsheet", appId: "nautilo-spreadsheet", initialVersion: "0.1.0", compiledEngine: true },
  { sourceDir: "video", appId: "nautilo-video", initialVersion: "0.1.0" },
  {
    sourceDir: "presentation",
    appId: "nautilo-presentation",
    initialVersion: "0.1.0",
    compiledEngine: true,
    requiredEngineFiles: [
      "browser.js",
      "node.js",
      "index.d.ts",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "dictionaries/DICTIONARY-LICENSE.txt",
      "dictionaries/en_US.aff",
      "dictionaries/en_US.dic",
      "node_modules/@nautilo/office-core/dist/geometry/index.d.ts",
      "node_modules/@nautilo/office-docs/dist/index.d.ts",
    ],
    prepareCommand: "bun run slides:prepare",
  },
];

export interface SeedFirstPartyAppsOptions {
  appsRoot?: string;
  /** Base directory that contains the per-app source directories. */
  sourceRoot?: string;
  /** Test seam for simulating filesystem copy failures. */
  copyDirectory?: typeof cp;
  /**
   * Restrict seeding to specific first-party app ids. The production startup
   * path leaves this unset and seeds the complete first-party catalog.
   */
  appIds?: readonly string[];
}

const MAX_STAGING_COPY_ATTEMPTS = 2;

export function resolveDefaultFirstPartyAppsRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // packages/server/src/apps/seed-first-party-apps.ts → repo root
  const repoRoot = join(dirname(thisFile), "..", "..", "..", "..");
  return join(repoRoot, "packages", "first-party-apps");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function createTemporarySibling(appsRoot: string, appId: string, purpose: string): Promise<string> {
  const path = await mkdtemp(join(appsRoot, `.${appId}.${purpose}-`));
  // `mkdtemp` creates the directory, while `cp(..., { errorOnExist: true })`
  // requires its destination to not exist.
  await rm(path, { recursive: true, force: true });
  return path;
}

async function stageSeed(
  sourceDir: string,
  appsRoot: string,
  appId: string,
  copyDirectory: typeof cp,
): Promise<{ stagingRoot: string; sourceHash: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_STAGING_COPY_ATTEMPTS; attempt += 1) {
    const stagingRoot = await createTemporarySibling(appsRoot, appId, "seed");
    try {
      // Re-read the source identity for each whole-tree attempt. An ENOENT can
      // occur while a package manager is transiently replacing a nested file.
      const sourceHash = await computeAppSourceHash(sourceDir);
      // Dereference local dependency links before moving the app outside the
      // monorepo. The seeded app must retain its owned engine, compiled assets
      // and transitive dependencies at self-contained paths.
      await copyDirectory(sourceDir, stagingRoot, {
        recursive: true,
        errorOnExist: true,
        dereference: true,
      });
      // A first-party app's app-local `file:` install is only a package-manager
      // cache. Overlay the declared sources so a stale physical node_modules
      // copy cannot omit newly added files. This mirrors the server-image
      // Docker overlays while keeping the installed seed self-contained.
      const localDependencies = await collectLocalFileDependencySources(sourceDir);
      for (const dependency of localDependencies) {
        const destination = nodeModulesPackagePath(stagingRoot, dependency.name);
        await rm(destination, { recursive: true, force: true });
        await mkdir(dirname(destination), { recursive: true });
        await cp(dependency.root, destination, {
          recursive: true,
          errorOnExist: true,
          dereference: true,
        });
      }
      // `cp` resolves only once its recursive work has completed. Re-stat the
      // staged root and source identity before swapping. Do not hash the staged
      // tree itself: its dereferenced `file:` dependencies deliberately no
      // longer resolve relative to the original monorepo layout.
      await stat(stagingRoot);
      const currentSourceHash = await computeAppSourceHash(sourceDir);
      if (currentSourceHash !== sourceHash) {
        throw new Error(`source changed while staging ${appId}`);
      }
      return { stagingRoot, sourceHash };
    } catch (err) {
      lastError = err;
      await rm(stagingRoot, { recursive: true, force: true });
      if (!isEnoent(err) || attempt === MAX_STAGING_COPY_ATTEMPTS) {
        break;
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Failed to stage first-party app "${appId}" after ${MAX_STAGING_COPY_ATTEMPTS} attempts; existing seed was preserved: ${detail}`,
    { cause: lastError },
  );
}

async function installStagedSeed(
  stagingRoot: string,
  destRoot: string,
  appsRoot: string,
  appId: string,
): Promise<void> {
  const backupRoot = await createTemporarySibling(appsRoot, appId, "previous");
  const hadExistingSeed = await pathExists(destRoot);
  let movedExistingSeed = false;

  try {
    if (hadExistingSeed) {
      try {
        await rename(destRoot, backupRoot);
        movedExistingSeed = true;
      } catch (err) {
        // A concurrent failed/retried bootstrap may remove the stale seed
        // after pathExists() but before this swap. The staged seed is still
        // valid; only preserve/restore a backup that was actually moved.
        if (!isEnoent(err)) throw err;
      }
    }
    try {
      await rename(stagingRoot, destRoot);
    } catch (err) {
      if (movedExistingSeed) {
        await rename(backupRoot, destRoot);
      }
      throw err;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  await rm(backupRoot, { recursive: true, force: true });
}

export async function seedFirstPartyApps(
  options?: SeedFirstPartyAppsOptions,
): Promise<{ seeded: string[] }> {
  const appsRoot = options?.appsRoot ?? getAppsRoot();
  const sourceRoot = options?.sourceRoot ?? resolveDefaultFirstPartyAppsRoot();
  const copyDirectory = options?.copyDirectory ?? cp;
  const appIds = options?.appIds;

  await mkdir(appsRoot, { recursive: true });

  const seeded: string[] = [];
  for (const entry of FIRST_PARTY_APPS) {
    if (appIds && !appIds.includes(entry.appId)) continue;
    const sourceDir = join(sourceRoot, entry.sourceDir);
    if (!(await pathExists(sourceDir))) {
      continue;
    }
    if (entry.compiledEngine) {
      if (!(await pathExists(join(sourceDir, "engine", "provenance.json")))) continue;
      // A partial generated directory must never replace a working seed.
      const provenance = JSON.parse(await readFile(join(sourceDir, "engine", "provenance.json"), "utf8")) as { files?: Record<string, string> };
      const requiredEngineFiles = entry.requiredEngineFiles ?? ["browser.js", "node.js", "index.js", "LICENSE"];
      if (!provenance.files || requiredEngineFiles.some(path => !provenance.files?.[path])) {
        throw new Error(`Incomplete compiled engine for ${entry.appId}; run ${entry.prepareCommand ?? "bun run sheets:prepare"}`);
      }
      for (const [relative, digest] of Object.entries(provenance.files)) {
        if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(digest)) {
          throw new Error(`Invalid compiled engine provenance for ${entry.appId}`);
        }
        if (!(await pathExists(join(sourceDir, "engine", relative)))) throw new Error(`Incomplete compiled engine for ${entry.appId}: ${relative}`);
        const actual = createHash("sha256").update(await readFile(join(sourceDir, "engine", relative))).digest("hex");
        if (actual !== digest) throw new Error(`Compiled engine integrity mismatch for ${entry.appId}: ${relative}`);
      }
    }
    const destRoot = join(appsRoot, entry.appId);
    const cacheRoot = join(appsRoot, ".cache", entry.appId);
    const sourceHash = await computeAppSourceHash(sourceDir);

    let shouldCopy = false;
    try {
      await stat(destRoot);
      const installedHash = await computeAppSourceHash(destRoot);
      shouldCopy = installedHash !== sourceHash;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      shouldCopy = true;
    }

    if (!shouldCopy) continue;

    const { stagingRoot, sourceHash: stagedSourceHash } = await stageSeed(
      sourceDir,
      appsRoot,
      entry.appId,
      copyDirectory,
    );
    try {
      await writeFile(
        join(stagingRoot, SEED_MARKER_FILE),
        `${JSON.stringify(
          {
            seededFrom: "first-party",
            appId: entry.appId,
            initialVersion: entry.initialVersion,
            sourceHash: stagedSourceHash,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await installStagedSeed(stagingRoot, destRoot, appsRoot, entry.appId);
    } catch (err) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw err;
    }
    await rm(cacheRoot, { recursive: true, force: true });
    seeded.push(entry.appId);
  }
  if (seeded.length > 0) {
    invalidateInstalledAppRegistry();
  }
  return { seeded };
}
