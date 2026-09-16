/**
 * D104 Phase 3 — `nautilo-dev reset-logto-user-password`.
 *
 * Local shell break-glass only (never HTTP / MCP): rotate a Logto-linked
 * local user's password via the default-tenant Management API, write the
 * temporary password to a chmod-600 file under `~/.nautilo/password-resets/`,
 * and mark `logto_account_security` with reason `operator_reset` so the
 * workbench forces an immediate rotation.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";
import {
  consoleMigrationLogger,
  type LogtoAdmin,
  type MigrationDb,
  type MigrationLogger,
  type MigrationUser,
} from "../lib/logto-migration";

/** Matches `ACCOUNT_SECURITY_AUDIT.PASSWORD_RESET_OPERATOR` on the server. */
export const ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT =
  "account_password_reset_operator";

export interface ResetLogtoUserPasswordArgs {
  email?: string | undefined;
  handle?: string | undefined;
  userId?: string | undefined;
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
  /** When combined with --yes: also echo plaintext password to stderr (unsafe). */
  print?: boolean | undefined;
  /** Override default `~/.nautilo/password-resets`. */
  outputDir?: string | undefined;
  configEnvPath?: string | undefined;
}

export interface ResetLogtoUserPasswordDeps {
  db: MigrationDb;
  admin: LogtoAdmin;
  logger: MigrationLogger;
  generatePassword?: () => string;
  writeSecretFile?: (path: string, contents: string) => void;
  isoStamp?: () => string;
}

export function formatPasswordResetFile(input: {
  nautiloUserId: string;
  logtoSub: string;
  email: string | null;
  handle: string | null;
  temporaryPassword: string;
  isoStamp: string;
}): string {
  return [
    "# Nautilo operator Logto password reset (D104)",
    `# Created: ${input.isoStamp}`,
    `# Nautilo user id: ${input.nautiloUserId}`,
    `# Logto sub: ${input.logtoSub}`,
    `# Email: ${input.email ?? "(none)"}`,
    `# Handle: ${input.handle ?? "(none)"}`,
    "",
    "Hand this file to the human once via a private channel, then delete it.",
    "They must sign in with the temporary password and choose a new one",
    "under Settings → Security (Workbench / Electron).",
    "",
    "temporary_password:",
    input.temporaryPassword,
    "",
  ].join("\n");
}

async function resolveTargetUser(
  args: Pick<ResetLogtoUserPasswordArgs, "email" | "handle" | "userId">,
  db: MigrationDb,
  log: MigrationLogger,
): Promise<MigrationUser | null> {
  const email = args.email?.trim();
  const handle = args.handle?.trim();
  const userId = args.userId?.trim();
  if (!email && !handle && !userId) {
    log.error(
      "Provide at least one selector: --email <addr>, --handle <name>, and/or --user-id <uuid>.",
    );
    return null;
  }

  const buckets: MigrationUser[][] = [];

  if (email) {
    const list = await db.findLocalUsersByEmail(email);
    if (list.length === 0) {
      log.error(`No local user (server IS NULL) with email "${email}".`);
      return null;
    }
    if (list.length > 1) {
      log.error(
        `Ambiguous email "${email}": ${list.length} local users match. Use --user-id or a unique handle.`,
      );
      return null;
    }
    buckets.push(list);
  }

  if (handle) {
    const list = await db.findLocalUsersByHandle(handle);
    if (list.length === 0) {
      log.error(`No local user (server IS NULL) with handle "${handle}".`);
      return null;
    }
    if (list.length > 1) {
      log.error(
        `Ambiguous handle "${handle}": ${list.length} local users match. Use --user-id or a unique email.`,
      );
      return null;
    }
    buckets.push(list);
  }

  if (userId) {
    const u = await db.findLocalUserById(userId);
    if (!u) {
      log.error(`No local user (server IS NULL) with user id "${userId}".`);
      return null;
    }
    buckets.push([u]);
  }

  let narrowed = buckets[0]!;
  for (let i = 1; i < buckets.length; i++) {
    const next = buckets[i]!;
    const ids = new Set(next.map((u) => u.id));
    narrowed = narrowed.filter((u) => ids.has(u.id));
  }

  if (narrowed.length === 0) {
    log.error("Selectors do not resolve to the same local user.");
    return null;
  }
  return narrowed[0]!;
}

function defaultWriteSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function runResetLogtoUserPassword(
  args: ResetLogtoUserPasswordArgs,
  deps: ResetLogtoUserPasswordDeps,
): Promise<number> {
  const log = deps.logger;
  const apply = Boolean(args.yes) && !args.dryRun;

  if (!args.dryRun && !args.yes) {
    log.error(
      "Pass --dry-run to preview the lookup, or --yes to rotate the password and write the secret file.",
    );
    log.error(
      "(This command never applies mutations without an explicit --yes.)",
    );
    return 2;
  }

  const user = await resolveTargetUser(args, deps.db, log);
  if (!user) return 1;

  if (!user.externalId) {
    log.error(
      `User ${user.id} has no external_id — not linked to Logto. Run migrate-to-logto first.`,
    );
    return 1;
  }

  const logtoUser = await deps.admin.getUser(user.externalId);
  if (!logtoUser) {
    log.error(
      `Linked Logto user ${user.externalId} is missing from Logto (orphan link). Fix with migrate-from-logto then migrate-to-logto.`,
    );
    return 1;
  }
  if (logtoUser.isSuspended) {
    log.error(
      `Logto user ${logtoUser.id} is suspended — unsuspend in the admin console before rotating the password.`,
    );
    return 1;
  }

  const hasSecTable = await deps.db.hasLogtoAccountSecurityTable();
  if (!hasSecTable) {
    log.error(
      "Table logto_account_security is missing — run DB migrations before using this command.",
    );
    return 1;
  }

  const stamp = (deps.isoStamp ?? (() => new Date().toISOString()))();
  const outputDir =
    args.outputDir?.trim() ||
    join(homedir(), ".nautilo", "password-resets");

  log.info(
    `  Target: Nautilo user ${user.id}, email=${user.email ?? "?"}, @${user.handle ?? "?"}, logto_sub=${user.externalId}`,
  );

  if (!apply) {
    log.info(
      `  Dry-run OK — would rotate Logto password, write chmod-600 file under ${outputDir}/, and flag operator_reset.`,
    );
    log.info(
      `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=dry_run`,
    );
    return 0;
  }

  const generatePassword =
    deps.generatePassword ?? (() => randomBytes(32).toString("hex"));
  const tempPassword = generatePassword();
  const writeSecretFile = deps.writeSecretFile ?? defaultWriteSecretFile;

  log.info(
    `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=applying`,
  );

  try {
    await deps.admin.setUserPassword(user.externalId, tempPassword);
  } catch (e) {
    log.error(
      `Logto setUserPassword failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    log.error(
      `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=logto_failed`,
    );
    return 1;
  }

  try {
    await deps.db.markOperatorPasswordResetRequired(user.id);
  } catch (e) {
    log.error(
      `Metadata mark failed after Logto password was rotated — the human MUST use the password printed below; DB error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    log.error(
      `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=metadata_failed`,
    );
    log.error(
      `TEMPORARY PASSWORD (write down NOW — metadata inconsistent): ${tempPassword}`,
    );
    return 1;
  }

  const contents = formatPasswordResetFile({
    nautiloUserId: user.id,
    logtoSub: user.externalId,
    email: user.email,
    handle: user.handle,
    temporaryPassword: tempPassword,
    isoStamp: stamp,
  });

  const safeStamp = stamp.replaceAll(":", "-");
  const outPath = join(
    outputDir,
    `logto-password-reset-${user.id}-${safeStamp}.txt`,
  );

  try {
    writeSecretFile(outPath, contents);
  } catch (e) {
    log.error(
      `File write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    log.error(
      `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=file_failed`,
    );
    log.error(
      `TEMPORARY PASSWORD (write down NOW — file write failed): ${tempPassword}`,
    );
    return 1;
  }

  log.info("");
  log.info(`OK — temporary password written to ${outPath} (chmod 600)`);
  log.info(
    `[${ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT}] userId=${user.id} outcome=success path=${outPath}`,
  );
  if (args.print) {
    log.warn(
      "--print: plaintext password echoed to stderr (sanitize scrollback).",
    );
    log.warn(`TEMPORARY PASSWORD: ${tempPassword}`);
  }
  return 0;
}

export async function resetLogtoUserPassword(
  args: ResetLogtoUserPasswordArgs,
): Promise<number> {
  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "reset-logto-user-password");

  const { createMigrationDb } = await import("../lib/migration-db");
  const { getLogtoAdminClient } = await import("@nautilo/trust");

  const db = createMigrationDb();
  const logger = consoleMigrationLogger();

  let admin: LogtoAdmin;
  try {
    admin = getLogtoAdminClient() as LogtoAdmin;
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
    return await runResetLogtoUserPassword(args, { db, admin, logger });
  } finally {
    await db.end();
  }
}
