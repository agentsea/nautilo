import { existsSync } from "node:fs";
import { copyFile, rm, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveNautiloHome, resolveDotenvPath, resolveEnvBackupPath } from "../lib/paths";
import { dropAndCreateDb, isContainerRunning } from "../lib/docker-db";
import {
  dropAndCreateLogtoDb,
  isLogtoContainerRunning,
  logtoDatabaseExists,
} from "../lib/logto-db";
import { save } from "./save";

interface CleanOptions {
  /**
   * Skip the automatic pre-clean snapshot. Default is to save a fresh
   * `auto-pre-clean-<ISO>` so the wipe is always reversible.
   */
  noAutosave?: boolean;
}

export async function clean(options: CleanOptions = {}): Promise<void> {
  if (!options.noAutosave && isContainerRunning()) {
    const autoName = `auto-pre-clean-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    console.log(`Auto-saving current state as "${autoName}" before clean...`);
    try {
      await save(autoName);
      console.log(`  Roll back with: bun run dev:restore ${autoName}\n`);
    } catch (err) {
      console.error(
        `  Auto-save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `  Refusing to clean. Pass --no-autosave to override (you lose the undo path).`,
      );
      process.exit(1);
    }
  }

  console.log("Cleaning local state to factory-fresh...\n");

  // 1. Database (legacy nautilo cluster)
  if (isContainerRunning()) {
    console.log("  Dropping and recreating database...");
    dropAndCreateDb();
    console.log("  Database wiped (migrations will run on next server start).");
  } else {
    console.log("  Docker container not running — skipping database wipe.");
    console.log("  Start with `bun run db:dev` and re-run clean if needed.");
  }

  // 1b. Logto DB (M059) — when the compose stack is up, ALWAYS run
  //     dropAndCreateLogtoDb regardless of whether `logto_nautilo`
  //     currently exists. Skipping based on "DB doesn't exist" is a
  //     trap: a previous half-completed clean may have dropped the
  //     DB without dropping the cluster-level per-tenant roles
  //     (`logto_tenant_logto_nautilo*`). Re-running `dev:clean` then
  //     silently no-ops, and the next `infra:start` fails at
  //     `logto-seed` with "role already exists" (Postgres 42710) and
  //     no recovery path through the existing tooling. The helper is
  //     idempotent on a fresh cluster (DROP DATABASE IF EXISTS +
  //     DROP ROLE IF EXISTS), so running it unconditionally costs
  //     nothing and guarantees a clean re-seed surface.
  //
  //     After this, `bootstrap-logto` re-seeds applications /
  //     resources / roles on the next `bun run infra:start` (or
  //     `--with-logto` boot); admin user creation is gated on the
  //     `sign_in_mode='SignIn'` probe so a fresh DB triggers a fresh
  //     admin password too.
  if (isLogtoContainerRunning()) {
    if (logtoDatabaseExists()) {
      console.log("  Dropping and recreating logto_nautilo (+ purging stale tenant roles)...");
    } else {
      console.log("  Recreating logto_nautilo from scratch (+ purging stale tenant roles)...");
    }
    dropAndCreateLogtoDb();
    console.log(
      "  Logto DB wiped — re-run `bun run infra:start` to re-seed Logto.",
    );
  } else {
    console.log("  Compose postgres container not running — skipping Logto DB wipe.");
  }

  // 2. .env -> safety backup (outside repo)
  const envPath = resolveDotenvPath();
  if (existsSync(envPath)) {
    const bakPath = resolveEnvBackupPath();
    await mkdir(join(bakPath, ".."), { recursive: true });
    await copyFile(envPath, bakPath);
    await rm(envPath);
    console.log(`  .env safety-copied to ${bakPath}`);
  } else {
    console.log("  No .env found — already clean.");
  }

  // 3. ~/.nautilo/ contents (preserve dev-snapshots/)
  const nautiloHome = resolveNautiloHome();
  if (existsSync(nautiloHome)) {
    const entries = await readdir(nautiloHome);
    let removed = 0;
    for (const entry of entries) {
      if (entry === "dev-snapshots") continue;
      await rm(join(nautiloHome, entry), { recursive: true, force: true });
      removed++;
    }
    console.log(`  ~/.nautilo: cleared ${removed} items (dev-snapshots preserved).`);
  } else {
    console.log("  ~/.nautilo: not found — already clean.");
  }

  // Ensure dev-snapshots dir exists for future saves
  await mkdir(join(nautiloHome, "dev-snapshots"), { recursive: true });

  const bakExists = existsSync(resolveEnvBackupPath());
  console.log("\nClean slate. Start the server to run fresh onboarding.");
  if (bakExists) {
    console.log(`Tip: Your previous .env is at ${resolveEnvBackupPath()}`);
  }
}
