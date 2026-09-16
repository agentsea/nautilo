import { existsSync } from "node:fs";
import { copyFile, lstat, readFile, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveInstance } from "@nautilo/config";
import {
  resolveSnapshotDir,
  resolveNautiloHome,
  resolveDotenvPath,
  resolveEnvBackupPath,
} from "../lib/paths";
import { restoreFromGzip } from "../lib/docker-db";
import {
  isLogtoContainerRunning,
  restoreLogtoFromGzip,
} from "../lib/logto-db";
import { save } from "./save";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";
import {
  runLocalCredentialReconciliation,
  runLocalRuntimeAcceptanceExitCode,
} from "../lib/verify";
import { ensureInfraCryptoDbPasswordForInstance } from "../lib/compose-infra";
import { serverStart } from "./server-start";
import { prepareFullDevRestore } from "../lib/full-dev-restore";

interface RestoreOptions {
  /**
   * Skip the automatic pre-restore snapshot. Default is to save a
   * fresh `auto-pre-restore-<ISO>` snapshot so a bad restore can be
   * rolled back immediately.
   */
  noAutosave?: boolean;
  /**
   * Require this restore to include and apply the Logto database dump.
   * This prevents partial rollback during auth cutover rehearsals.
   */
  requireLogto?: boolean;
  /** D202: explicit opt-in to restore the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean;
}

export interface RestoreRuntimeAcceptanceDeps {
  /** Ensure the local Nautilo server is running before acceptance. */
  startServer: () => Promise<number>;
  /** Run the authoritative D427 runtime-acceptance gate. */
  accept: () => Promise<number>;
  log?: (message: string) => void;
}

/** Clear restorable home state while preserving local recovery/protection authority. */
export async function clearHomeForRestore(
  nautiloHome: string,
  remove: typeof rm = rm,
): Promise<void> {
  const marker = join(nautiloHome, ".protected-instance");
  if (existsSync(marker)) {
    const metadata = await lstat(marker);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Refusing restore with a non-regular protected-instance marker");
    }
  }
  for (const entry of await readdir(nautiloHome)) {
    if (entry === "dev-snapshots" || entry === ".protected-instance" || entry === "profiles") continue;
    await remove(join(nautiloHome, entry), { recursive: true, force: true });
  }
}

export function extractHomeArchivePreservingProtection(tarPath: string, nautiloHome: string): void {
  execFileSync("tar", ["--exclude=.protected-instance", "--exclude=profiles", "-xzf", tarPath, "-C", nautiloHome], { stdio: "pipe" });
}

/**
 * Compose restore starts the restored runtime before running acceptance. Keep
 * local restore semantically identical: ensure the local server is started,
 * then run the authoritative gate. A failed start is fail-closed and MUST
 * prevent acceptance (and a success report) because acceptance against an
 * unstarted server would predictably time out.
 *
 * Exported with injectable dependencies for focused sequencing tests.
 */
export async function startServerThenRunRuntimeAcceptance(
  deps: RestoreRuntimeAcceptanceDeps,
): Promise<number> {
  const log = deps.log ?? (() => {});
  log("  Starting local Nautilo server before runtime acceptance...");
  const startCode = await deps.startServer();
  if (startCode !== 0) {
    log(`[acceptance] local Nautilo server failed to start (exit ${startCode}); acceptance not run.`);
    return startCode;
  }
  return deps.accept();
}

export async function restore(name: string, options: RestoreOptions = {}): Promise<void> {
  if (!name) {
    console.error("Usage: nautilo-dev restore <name> [--no-autosave]");
    process.exit(1);
  }

  // Validate before touching anything. `name` is interpolated into
  // paths (via resolveSnapshotDir) AND into a `tar` shell command
  // (the home-dir restore step uses execSync). A path-traversal
  // name like `../foo` or an injection like `foo; rm -rf ~` must
  // NOT reach the filesystem or the shell.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error(
      `Snapshot name "${name}" is invalid. ` +
        `Names must be alphanumeric with hyphens/underscores only ` +
        `(no spaces, no path separators, no shell metacharacters).`,
    );
    process.exit(1);
  }

  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:restore",
    cwd: process.cwd(),
    isDryRunOrReadOnly: false,
    ...(options.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    process.exit(2);
  }

  const dir = resolveSnapshotDir(name);
  if (!existsSync(dir)) {
    console.error(`Snapshot "${name}" not found at ${dir}`);
    process.exit(1);
  }

  const dbPath = join(dir, "database.sql.gz");
  const logtoDbPath = join(dir, "logto_nautilo.sql.gz");
  const dotEnvSrc = join(dir, "dot-env");
  const tarPath = join(dir, "nautilo-home.tar.gz");
  const metaPath = join(dir, "meta.json");

  const fullBackup = await prepareFullDevRestore(dir);
  if (fullBackup) options = { ...options, requireLogto: true };

  if (options.requireLogto) {
    if (!existsSync(logtoDbPath)) {
      console.error(
        `Snapshot "${name}" has no logto_nautilo.sql.gz, but --require-logto was set.`,
      );
      console.error("Refusing to restore a Nautilo-only snapshot as a Logto rollback point.");
      process.exit(1);
    }
    if (!isLogtoContainerRunning()) {
      console.error(
        "Snapshot includes logto_nautilo.sql.gz, but the Logto Postgres container is not running.",
      );
      console.error("Run `bun run infra:start` first, then re-run restore.");
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // 0. Auto-save — take a snapshot of the CURRENT state before we clobber
  //    it. Opt-out via --no-autosave for automation / tests.
  // -------------------------------------------------------------------------
  if (!options.noAutosave) {
    const autoName = `auto-pre-restore-${isoStamp()}`;
    console.log(`Auto-saving current state as "${autoName}" before restore...`);
    try {
      await save(autoName, options.requireLogto ? { requireLogto: true } : {});
      const restoreHint = options.requireLogto
        ? `bun run dev:restore ${autoName} -- --require-logto`
        : `bun run dev:restore ${autoName}`;
      console.log(`  Roll back with: ${restoreHint}\n`);
    } catch (err) {
      // A failed auto-save is a hard stop — we will NOT silently
      // proceed to a destructive action without the safety net.
      console.error(
        `  Auto-save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `  Refusing to restore. Pass --no-autosave to override (you lose the undo path).`,
      );
      process.exit(1);
    }
  }

  console.log(`Restoring snapshot "${name}"...`);

  // -------------------------------------------------------------------------
  // 1. Database
  // -------------------------------------------------------------------------
  if (existsSync(dbPath)) {
    console.log("  Restoring database (clean schema + data import)...");
    await restoreFromGzip(dbPath, console.log, fullBackup ? {
      fullArchive: { expectedMigrationLineage: fullBackup.manifest.drizzle.entries },
    } : {});
    console.log("  Database restored.");
  } else {
    console.log("  No database dump in snapshot — skipping.");
  }

  // -------------------------------------------------------------------------
  // 1b. Logto DB (M059) — only restore if BOTH the snapshot has a
  //     logto_nautilo dump AND the compose stack is running. Older
  //     snapshots (pre-M059) have no logto_nautilo.sql.gz; warn and
  //     continue with Nautilo-only restore.
  // -------------------------------------------------------------------------
  if (existsSync(logtoDbPath)) {
    if (isLogtoContainerRunning()) {
      console.log("  Restoring logto_nautilo (clean schema + data import)...");
      restoreLogtoFromGzip(logtoDbPath, undefined, console.log);
    } else if (options.requireLogto) {
      console.error(
        "  ERROR: Logto Postgres container stopped before restore; refusing partial rollback.",
      );
      process.exit(1);
    } else {
      console.log(
        "  WARNING: logto_nautilo dump present in snapshot but compose container is not running.",
      );
      console.log(
        "           Run `bun run infra:start` first if you want the Logto DB restored.",
      );
    }
  } else if (options.requireLogto) {
    console.error(
      "  ERROR: logto_nautilo.sql.gz disappeared before restore; refusing partial rollback.",
    );
    process.exit(1);
  } else {
    console.log(
      "  No logto_nautilo dump in snapshot (pre-M059 or local-only install) — skipping Logto DB restore.",
    );
  }

  // -------------------------------------------------------------------------
  // 2. ~/.nautilo/ home dir — runs BEFORE the .env section so that the
  //    wipe-except-dev-snapshots pattern doesn't delete config.env that
  //    we're about to write in step 3.
  //
  //    This ordering is load-bearing. Previously the .env section ran
  //    first, wrote config.env, and THEN the home section removed
  //    everything-except-dev-snapshots — destroying the file we just
  //    wrote. The restored state shipped with no config.env, and the
  //    user discovered it only when the server refused to boot.
  // -------------------------------------------------------------------------
  const nautiloHome = resolveNautiloHome();
  if (existsSync(tarPath)) {
    console.log("  Restoring ~/.nautilo...");
    const snapshotsDir = join(nautiloHome, "dev-snapshots");
    const instanceJsonPath = join(nautiloHome, "instance.json");
    // A snapshot may originate from another instance (usually `(default)`).
    // Keep the target's allocated ports and compose identity; restoring the
    // source instance.json makes a named target invalid on its next start.
    const targetInstanceJson = existsSync(instanceJsonPath)
      ? await readFile(instanceJsonPath, "utf-8")
      : null;

    // Clear everything in ~/.nautilo/ except the dev-snapshots dir —
    // we rely on that dir surviving so previous snapshots + the
    // auto-save we just took stay available for rollback.
    if (existsSync(nautiloHome)) {
      await clearHomeForRestore(nautiloHome);
    }

    await mkdir(nautiloHome, { recursive: true });
    extractHomeArchivePreservingProtection(tarPath, nautiloHome);
    if (targetInstanceJson !== null) {
      await writeFile(instanceJsonPath, targetInstanceJson);
    }

    // Defensive — tar could in principle have wiped dev-snapshots if
    // the archive was created wrong. Recreate so future saves work.
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true });
    }
    console.log("  ~/.nautilo restored.");
  } else {
    console.log("  No home archive in snapshot — skipping.");
  }

  // -------------------------------------------------------------------------
  // 3. .env — written LAST so it survives the home-dir wipe in step 2.
  //    Safety-copies the CURRENT (pre-restore) config.env to
  //    _env-safety-backup in case the operator wants to recover post-
  //    restore edits (e.g. new API keys added after the snapshot).
  // -------------------------------------------------------------------------
  const envPath = resolveDotenvPath();
  if (existsSync(dotEnvSrc)) {
    if (existsSync(envPath)) {
      const bakPath = resolveEnvBackupPath();
      await mkdir(join(bakPath, ".."), { recursive: true });
      await copyFile(envPath, bakPath);
      console.log(`  Current .env safety-copied to ${bakPath}`);
    }
    await copyFile(dotEnvSrc, envPath);
    console.log("  .env restored.");
  } else {
    console.log("  No .env in snapshot — skipping.");
  }

  // -------------------------------------------------------------------------
  // 3b. D427 (Wave 4 task 4.1.1) — credential reconciliation.
  //     Runs AFTER the restored `instance.env` is on disk so the app-role
  //     passwords are readable. Re-pins the `nautilo` / `nautilo_agent`
  //     cluster role passwords to the restored env and resyncs the Logto
  //     per-tenant role passwords to the restored `tenants` table. Logto
  //     reconciliation is conditional on the Logto container + DB being
  //     available (a Nautilo-only snapshot or a stack with Logto stopped
  //     skips the Logto pipeline cleanly). Fail-closed: a reconcile failure
  //     aborts the restore — we never report success on a desynced target.
  //     Shared with the Compose restore path via the @nautilo/db planner.
  // -------------------------------------------------------------------------
  try {
    await ensureInfraCryptoDbPasswordForInstance(resolveInstance());
    await runLocalCredentialReconciliation({ log: (m) => console.log(`  ${m}`) });
  } catch (err) {
    console.error(
      `  ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("  Refusing to report restore success; the restored grants and live cluster roles are out of sync.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  if (existsSync(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, "utf-8")) as {
      createdAt?: string;
      envKeyCount?: number;
      dbSizeBytes?: number;
    };
    const date = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : "unknown";
    console.log(
      `\nRestored "${name}" (saved ${date}, ${meta.envKeyCount ?? "?"} keys, DB dump ${
        meta.dbSizeBytes ? (meta.dbSizeBytes / 1024 / 1024).toFixed(1) + " MB" : "?"
      })`,
    );
  } else {
    console.log(`\nRestored "${name}".`);
  }

  // -------------------------------------------------------------------------
  // 3c. D427 (Wave 4 task 4.1.1 / 4.1.2) — authoritative runtime acceptance.
  //     The local restore now shares the Compose path's fail-closed contract:
  //     it does NOT report success until the runtime-role, parameterized Neon
  //     HTTP, OIDC, instance identity, and SPA checks pass (plus /health).
  //     Like Compose restore, local restore starts (or confirms) the local
  //     Nautilo server before acceptance. A failed start is fail-closed and
  //     prevents acceptance, so restore never predictably times out or
  //     reports success against an unstarted server.
  //     Use `bun run dev:verify -- --smoke` for the pre-start, nonfatal
  //     diagnostic that does NOT claim acceptance.
  // -------------------------------------------------------------------------
  const acceptanceCode = await startServerThenRunRuntimeAcceptance({
    startServer: () => serverStart(),
    accept: () => runLocalRuntimeAcceptanceExitCode((m) => console.log(m)),
    log: (m) => console.log(m),
  });
  if (acceptanceCode !== 0) {
    console.error(
      "\nRefusing to report restore success: local server start or runtime acceptance failed. Run `bun run dev:verify` for the full report.",
    );
    process.exit(1);
  }

  console.log("\nRestore verified: runtime acceptance passed.");
}

function isoStamp(): string {
  // Colons + dots are portable-filename-hostile; strip them.
  return new Date().toISOString().replace(/[:.]/g, "-");
}
