/**
 * M053 — `verify-user-link` diagnostic.
 *
 * Reports the Nautilo↔Logto join state for a single user, identified by
 * email. Useful for support after a migration: distinguishes "linked",
 * "linked but suspended", "unlinked, no Logto account" (typical
 * pre-migration), and "unlinked but Logto account still present"
 * (re-run-after-rollback, in which case migrate-to-logto will
 * re-attach for free).
 */
import {
  consoleMigrationLogger,
  type LogtoAdmin,
  type LogtoUser,
  type MigrationDb,
  type MigrationLogger,
  type MigrationUser,
} from "../lib/logto-migration";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";

export type LinkStatus =
  | "linked"
  | "linked-suspended"
  | "unlinked-no-logto"
  | "unlinked-orphan-logto"
  | "linked-but-logto-missing"
  | "user-not-found";

export interface VerifyUserLinkArgs {
  /**
   * M107: primary selector. Lowercased local-Human handle. Lookup uses
   * `findLocalUsersByHandle` (scoped to `server IS NULL`).
   */
  handle?: string | undefined;
  /**
   * @deprecated M107 — pass `--handle` instead. `--email` is accepted
   * for one release as a fallback for legacy operator muscle memory;
   * the helper falls back to `findLocalUserByEmail` and logs a
   * deprecation warning. Removed in M108.
   */
  email?: string | undefined;
  configEnvPath?: string | undefined;
}

export interface VerifyUserLinkDeps {
  db: MigrationDb;
  admin: LogtoAdmin;
  logger: MigrationLogger;
}

export interface VerifyUserLinkReport {
  status: LinkStatus;
  exitCode: number;
  user: MigrationUser | null;
  logto: LogtoUser | null;
}

export async function runVerifyUserLink(
  args: VerifyUserLinkArgs,
  deps: VerifyUserLinkDeps,
): Promise<VerifyUserLinkReport> {
  const log = deps.logger;
  const handle = args.handle?.trim().toLowerCase();
  const email = args.email?.trim();
  if (!handle && !email) {
    log.error("Missing required flag: --handle <name> (or deprecated --email <addr>)");
    return {
      status: "user-not-found",
      exitCode: 2,
      user: null,
      logto: null,
    };
  }

  let user: MigrationUser | null = null;
  if (handle) {
    const matches = await deps.db.findLocalUsersByHandle(handle);
    user = matches[0] ?? null;
    if (!user) {
      log.error(`No local user found with handle "${handle}".`);
      return {
        status: "user-not-found",
        exitCode: 2,
        user: null,
        logto: null,
      };
    }
  } else if (email) {
    log.error(
      "[verify-user-link] deprecation: prefer --handle <name> over --email <addr>",
    );
    user = await deps.db.findLocalUserByEmail(email);
    if (!user) {
      log.error(`No local user found with email "${email}".`);
      return {
        status: "user-not-found",
        exitCode: 2,
        user: null,
        logto: null,
      };
    }
  }
  if (!user) {
    return {
      status: "user-not-found",
      exitCode: 2,
      user: null,
      logto: null,
    };
  }

  let logto: LogtoUser | null = null;
  if (user.externalId) {
    logto = await deps.admin.getUser(user.externalId);
  } else {
    logto = await deps.admin.findUserByEmailOrUsername(
      user.email,
      user.handle,
    );
  }

  const status = classify(user, logto);
  renderReport(log, user, logto, status);
  return {
    status,
    exitCode: status === "linked" ? 0 : 1,
    user,
    logto,
  };
}

function classify(user: MigrationUser, logto: LogtoUser | null): LinkStatus {
  if (user.externalId) {
    if (!logto) return "linked-but-logto-missing";
    if (logto.isSuspended) return "linked-suspended";
    return "linked";
  }
  return logto ? "unlinked-orphan-logto" : "unlinked-no-logto";
}

function renderReport(
  log: MigrationLogger,
  user: MigrationUser,
  logto: LogtoUser | null,
  status: LinkStatus,
): void {
  log.info(
    `  Nautilo user: ${user.id}, handle="${user.handle ?? "(missing)"}", external_id=${
      user.externalId ? `"${user.externalId}"` : "NULL"
    }`,
  );
  if (logto) {
    log.info(
      `  Logto user:   exists, sub="${logto.id}", isSuspended=${logto.isSuspended}, primaryEmail="${logto.primaryEmail ?? ""}"`,
    );
  } else {
    log.info(`  Logto user:   <none found by external_id, email, or username>`);
  }

  switch (status) {
    case "linked":
      log.info(`  Status: ✓ linked`);
      break;
    case "linked-suspended":
      log.info(
        `  Status: ⚠ linked but suspended — un-suspend in Logto admin`,
      );
      break;
    case "linked-but-logto-missing":
      log.info(
        `  Status: ✗ external_id is set but Logto account is missing — ` +
          `run \`migrate-from-logto\` to clear, then \`migrate-to-logto\` to re-link`,
      );
      break;
    case "unlinked-no-logto":
      log.info(
        `  Status: ✗ external_id is NULL — run migrate-to-logto to mint a Logto account`,
      );
      break;
    case "unlinked-orphan-logto":
      log.info(
        `  Status: ✗ external_id is NULL but Logto account still present — ` +
          `re-run migrate-to-logto and it will re-attach this sub via ` +
          `findUserByEmailOrUsername (no new claim URL)`,
      );
      break;
    case "user-not-found":
      // Already reported.
      break;
  }
}

// ---------------------------------------------------------------------------
// Production entry point.
// ---------------------------------------------------------------------------

export async function verifyUserLink(
  args: VerifyUserLinkArgs,
): Promise<number> {
  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "verify-user-link");

  const { createMigrationDb } = await import("../lib/migration-db");
  const { getLogtoAdminClient } = await import("@nautilo/trust");

  const db = createMigrationDb();
  const logger = consoleMigrationLogger();

  let admin: LogtoAdmin;
  try {
    admin = getLogtoAdminClient();
  } catch (err) {
    logger.error(
      `Logto admin client init failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await db.end();
    return 1;
  }

  try {
    const result = await runVerifyUserLink(args, { db, admin, logger });
    return result.exitCode;
  } finally {
    await db.end();
  }
}
