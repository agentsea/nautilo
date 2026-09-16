import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { debug, warn } from "@nautilo/logger";
import { migrateStorageLayout } from "./migrate-storage-layout";
import type { NautiloRuntimePaths } from "./runtime-paths";

/**
 * Every zone/subdirectory that must exist before the server starts.
 *
 * Order is deliberate: zone roots first (`homeRootDir`, `dataDir`),
 * then children. `mkdir -p` semantics handle duplicates cheaply, but
 * ordering keeps the log readable if anything fails.
 *
 * No `inboxDir` — async ingestion is deferred to D068.
 */
function allDirectories(paths: NautiloRuntimePaths): string[] {
  return [
    // certs (TLS)
    paths.certsDir,

    // home zone — permanent user-visible work product
    paths.homeRootDir,
    paths.workspaceDir,
    paths.researchDir,
    paths.notesDir,
    paths.exportsDir,
    paths.logsDir,
    paths.transcriptsDir,

    // scratch zone (sibling of home/)
    paths.scratchDir,

    // data zone + sub-paths
    paths.dataDir,
    paths.dbDataDir,
    paths.embeddingsDir,
    paths.voiceCacheDir,
    paths.audioCacheDir,

    // vault zone (future encrypted credentials)
    paths.vaultDir,
  ];
}

/**
 * Zone roots that should carry a `.gitignore` at creation time so a
 * stray `git init` inside `~/.nautilo/` doesn't accidentally snapshot
 * ephemeral content.
 */
function zonesThatIgnoreAll(paths: NautiloRuntimePaths): string[] {
  return [paths.scratchDir, paths.dataDir];
}

const GITIGNORE_CONTENT = "*\n!.gitignore\n";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create every Nautilo zone directory and its data sub-paths, then run
 * the one-time layout migration from the pre-D049 location.
 *
 * Performance target (D049 P1): < 50ms for a fully-populated tree on a
 * typical SSD. Measured ~5-15ms in the tested cases.
 *
 * Callable from any entry point (`nautilo-server`, future Electron
 * main, test harness). `nautilo-local` does NOT call this directly —
 * it spawns `nautilo-server` as a child process.
 */
export async function ensureDirectoryTree(
  paths: NautiloRuntimePaths,
): Promise<void> {
  const started = performance.now();

  // 1. Create every zone directory. mkdir -p semantics.
  await Promise.all(
    allDirectories(paths).map((dir) =>
      mkdir(dir, { recursive: true }).catch((err: unknown) => {
        warn(
          `[storage] mkdir failed for ${dir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }),
    ),
  );

  // 2. Migrate content from pre-D049 layouts BEFORE seeding .gitignore.
  //    If we seeded first, destinations would be non-empty and block
  //    the rename. Migration is idempotent via marker file.
  await migrateStorageLayout(paths);

  // 3. Drop a .gitignore in ephemeral/internal zones so a stray git
  //    init inside ~/.nautilo/ doesn't snapshot them.
  await Promise.all(
    zonesThatIgnoreAll(paths).map(async (dir) => {
      const marker = join(dir, ".gitignore");
      if (await fileExists(marker)) return;
      try {
        await writeFile(marker, GITIGNORE_CONTENT, { flag: "wx" });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
          warn(
            `[storage] .gitignore seed failed for ${dir}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }),
  );

  const elapsed = Math.round(performance.now() - started);
  debug(`[storage] ensureDirectoryTree complete (${elapsed}ms)`);
}
