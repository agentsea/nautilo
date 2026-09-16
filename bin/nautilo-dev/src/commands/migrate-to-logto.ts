/**
 * M053 — `migrate-to-logto` command.
 *
 * For each local PIN-mode `users` row with `external_id IS NULL`, mints
 * (or finds) a Logto account, writes the `sub` back to the DB row, and
 * generates a password-reset URL the operator hands to that user.
 *
 * Idempotent: re-runs skip already-linked users; partial failures are
 * resumable (the partial unique index from M051 catches double-attach;
 * `findUserByEmailOrUsername` re-attaches the existing Logto account
 * after a rollback round-trip).
 *
 * The pure runner (`runMigrateToLogto`) takes a `MigrationDeps` so the
 * unit tests exercise every branch without Postgres or Logto. The
 * `migrateToLogto` entry point wires up the real deps + injects
 * `~/.nautilo/instance.env` first.
 */
import { join } from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  consoleMigrationLogger,
  checkLogtoEnv,
  checkLogtoReachable,
  checkM2MCredentials,
  renderClaimInvitations,
  type ClaimInvitation,
  type LogtoAdmin,
  type MigrationDb,
  type MigrationLogger,
  type MigrationUser,
  type PreflightResult,
} from "../lib/logto-migration";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveNautiloHome } from "../lib/paths";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

export interface MigrateToLogtoArgs {
  dryRun?: boolean | undefined;
  outputPath?: string | undefined;
  configEnvPath?: string | undefined;
  /** D202: explicit opt-in to migrate the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
}

export interface MigrateToLogtoDeps {
  db: MigrationDb;
  admin: LogtoAdmin;
  logger: MigrationLogger;
  /** Writes the claim-invitations file with chmod 600 semantics. */
  writeClaimInvitations: (path: string, contents: string) => Promise<void>;
  /** Defaults to `process.env`. Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `globalThis.fetch`. Override for tests. */
  fetchImpl?: typeof fetch;
  /** Inserted between Logto user creations to be polite to rate-limits. */
  sleepMs?: (ms: number) => Promise<void>;
  /**
   * Generates a one-time-use temporary password for newly minted Logto
   * users. Defaults to 24 random hex bytes; tests inject a deterministic
   * generator so the rendered claim file is stable.
   */
  generateTempPassword?: () => string;
}

const DEFAULT_CLAIM_INVITATIONS_FILENAME = "claim-invitations.txt";

function defaultClaimInvitationsPath(): string {
  return join(resolveNautiloHome(), DEFAULT_CLAIM_INVITATIONS_FILENAME);
}

/**
 * Pure runner. Returns the process exit code so the entry point can
 * `process.exit(code)`.
 *
 * Caller is responsible for `db.end()` — we do NOT close the handle
 * here so a test can inspect post-run state.
 */
export async function runMigrateToLogto(
  args: MigrateToLogtoArgs,
  deps: MigrateToLogtoDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleepMs ?? defaultSleep;
  const generateTempPassword =
    deps.generateTempPassword ?? defaultTempPassword;
  const log = deps.logger;

  const envCheck = checkLogtoEnv(env);
  if (!envCheck.ok) {
    reportPreflight(log, envCheck);
    return 1;
  }

  const colCheck = await safeAwait(deps.db.hasExternalIdColumn());
  if (!colCheck.ok) {
    log.error(
      `Postgres unreachable: ${
        colCheck.err instanceof Error
          ? colCheck.err.message
          : String(colCheck.err)
      }`,
    );
    log.error(
      "Hint: ensure DB_DIRECT_CONNECTION points at the running cluster, " +
        "or `bun run infra:start` to bring it up.",
    );
    return 1;
  }
  if (!colCheck.value) {
    log.error(
      "users.external_id column not found — M051 migration `0021` " +
        "hasn't been applied. Run `bun run db:migrate` first.",
    );
    return 1;
  }

  const endpoint = env["LOGTO_ENDPOINT"]!;
  const reachable = await checkLogtoReachable(endpoint, fetchImpl);
  if (!reachable.ok) {
    reportPreflight(log, reachable);
    return 1;
  }

  const m2m = await checkM2MCredentials(deps.admin);
  if (!m2m.ok) {
    reportPreflight(log, m2m);
    return 1;
  }

  // Pre-flight passed. Load candidates.
  const candidates = await deps.db.listLocalUsers(true);

  if (candidates.length === 0) {
    log.info(
      "No users to migrate. All local users already have external_id set.",
    );
    return 0;
  }

  if (args.dryRun) {
    log.table(
      candidates.map((u) => ({
        id: u.id,
        handle: u.handle ?? "(missing)",
        email: u.email ?? "(missing)",
        plan: planFor(u),
      })),
    );
    log.info(
      `Would migrate ${candidates.length} user(s). Re-run without --dry-run to apply.`,
    );
    return 0;
  }

  const claims: ClaimInvitation[] = [];
  let skipped = 0;

  for (const [index, user] of candidates.entries()) {
    if (!user.email || !user.handle) {
      log.warn(
        `SKIP user ${user.id}: missing ${
          !user.email ? "email" : "handle"
        }. Repair the row and re-run.`,
      );
      skipped++;
      continue;
    }

    if (index > 0) await sleep(100);

    const existing = await deps.admin.findUserByEmailOrUsername(
      user.email,
      user.handle,
    );

    let sub: string;
    let temporaryPassword: string | null;
    if (existing) {
      log.info(
        `Existing Logto user found for ${user.email}; attaching sub=${existing.id} (credentials unchanged)`,
      );
      sub = existing.id;
      temporaryPassword = null;
    } else {
      const password = generateTempPassword();
      const created = await deps.admin.createUser({
        username: user.handle,
        primaryEmail: user.email,
        name: user.name,
        password,
      });
      sub = created.id;
      temporaryPassword = password;
      log.info(`Created Logto user for ${user.email}: sub=${sub}`);
    }

    await deps.db.setExternalId(user.id, sub);

    claims.push({
      nautiloUserId: user.id,
      name: user.name,
      email: user.email,
      handle: user.handle,
      logtoSub: sub,
      temporaryPassword,
    });
  }

  const outputPath = args.outputPath?.trim()
    ? args.outputPath.trim()
    : defaultClaimInvitationsPath();

  if (claims.length > 0) {
    const contents = renderClaimInvitations(claims);
    await deps.writeClaimInvitations(outputPath, contents);
  }

  log.info("");
  log.info(`Migrated ${claims.length} user(s). Skipped ${skipped}.`);
  if (claims.length > 0) {
    log.info(`Claim invitations written to: ${outputPath}`);
    log.info(
      `Next steps: hand out the URLs in ${outputPath} to each user, ` +
        "then restart the server.",
    );
  }
  return 0;
}

function planFor(u: MigrationUser): string {
  if (!u.email || !u.handle) {
    return "SKIP — missing email or handle";
  }
  return `Create or attach Logto user "${u.handle}" <${u.email}>`;
}

function reportPreflight(log: MigrationLogger, r: PreflightResult): void {
  if (r.ok) return;
  log.error(`Pre-flight failed: ${r.reason}`);
  log.error(r.remediation);
}

interface AwaitOk<T> {
  ok: true;
  value: T;
}
interface AwaitErr {
  ok: false;
  err: unknown;
}
async function safeAwait<T>(p: Promise<T>): Promise<AwaitOk<T> | AwaitErr> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, err };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 24 random bytes hex-encoded → 48-char password. Comfortably above
 * Logto's default password-policy floor (8 chars; rejects breached);
 * the random byte source rules out weak / breached candidates so we
 * never trip the policy.
 */
function defaultTempPassword(): string {
  return randomBytes(24).toString("hex");
}

// ---------------------------------------------------------------------------
// Production entry point — wires real deps + handles env loading + cleanup.
// ---------------------------------------------------------------------------

export async function migrateToLogto(
  args: MigrateToLogtoArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:migrate-to-logto",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.dryRun === true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "migrate-to-logto");

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
    logger.error(
      "Hint: ensure ~/.nautilo/instance.env contains LOGTO_ENDPOINT, " +
        "LOGTO_M2M_APP_ID, LOGTO_M2M_APP_SECRET (run `bun run infra:start`).",
    );
    await db.end();
    return 1;
  }

  try {
    return await runMigrateToLogto(args, {
      db,
      admin,
      logger,
      writeClaimInvitations: writeClaimInvitationsAtomic,
    });
  } finally {
    await db.end();
  }
}

async function writeClaimInvitationsAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const dir = path.replace(/[^/]+$/, "");
  if (dir && dir !== path) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, contents, { encoding: "utf-8", mode: 0o600 });
  await chmod(path, 0o600);
}
