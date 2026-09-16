/**
 * M053 — `migrate-from-logto` command (rollback).
 *
 * Clears `users.external_id` on every linked local row. Logto users are
 * NOT deleted by default (so re-running `migrate-to-logto` later can
 * re-attach them via `findUserByEmailOrUsername` for free). Pass
 * `--delete-logto-users` to also hard-delete via the M053-new
 * `LogtoAdminClient.deleteUser` (NOT `revokeUser`, which only suspends).
 *
 * Post-M072 note: Logto is the only supported auth mode in current
 * builds. This command remains as the database-side rollback half — the
 * full rollback target requires forking back to a pre-M072 build.
 */
import {
  consoleMigrationLogger,
  type LogtoAdmin,
  type MigrationDb,
  type MigrationLogger,
} from "../lib/logto-migration";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

export interface MigrateFromLogtoArgs {
  dryRun?: boolean | undefined;
  deleteLogtoUsers?: boolean | undefined;
  configEnvPath?: string | undefined;
  /** D202: explicit opt-in to migrate the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
}

export interface MigrateFromLogtoDeps {
  db: MigrationDb;
  /**
   * Lazy: only constructed when `--delete-logto-users` is set. Tests
   * that exercise the dry-run / no-delete paths can pass null here so
   * the assertion "no Logto API calls in dry-run" is trivially true.
   */
  getAdmin: () => LogtoAdmin;
  logger: MigrationLogger;
}

export async function runMigrateFromLogto(
  args: MigrateFromLogtoArgs,
  deps: MigrateFromLogtoDeps,
): Promise<number> {
  const log = deps.logger;

  const linked = await deps.db.listLocalUsers(false);

  if (linked.length === 0) {
    log.info("No linked users to roll back. Nothing to do.");
    return 0;
  }

  if (args.dryRun) {
    log.table(
      linked.map((u) => ({
        id: u.id,
        handle: u.handle ?? "(missing)",
        externalId: u.externalId,
        plan: args.deleteLogtoUsers
          ? "Clear external_id + DELETE Logto user"
          : "Clear external_id (Logto user retained)",
      })),
    );
    log.info(`Would clear external_id on ${linked.length} user(s).`);
    return 0;
  }

  // Important: capture the externalIds BEFORE clearing — clearAllExternalIds
  // mutates the rows and a re-select would return empty `external_id` values.
  const subsToDelete = linked
    .map((u) => u.externalId)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const cleared = await deps.db.clearAllExternalIds();
  log.info(`Cleared external_id on ${cleared} user(s).`);

  if (args.deleteLogtoUsers && subsToDelete.length > 0) {
    const admin = deps.getAdmin();
    let deleted = 0;
    let failed = 0;
    for (const sub of subsToDelete) {
      try {
        await admin.deleteUser(sub);
        log.info(`Deleted Logto user ${sub}`);
        deleted++;
      } catch (err) {
        log.warn(
          `Failed to delete Logto user ${sub}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        failed++;
      }
    }
    log.info(`Hard-deleted ${deleted} Logto user(s); ${failed} failed.`);
  }

  log.info("");
  log.info(
    "Next steps: rollback target requires forking to a pre-M072 build.",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Production entry point.
// ---------------------------------------------------------------------------

export async function migrateFromLogto(
  args: MigrateFromLogtoArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:migrate-from-logto",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.dryRun === true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "migrate-from-logto");

  const { createMigrationDb } = await import("../lib/migration-db");
  const { getLogtoAdminClient } = await import("@nautilo/trust");

  const db = createMigrationDb();
  const logger = consoleMigrationLogger();

  try {
    return await runMigrateFromLogto(args, {
      db,
      getAdmin: () => getLogtoAdminClient(),
      logger,
    });
  } finally {
    await db.end();
  }
}
