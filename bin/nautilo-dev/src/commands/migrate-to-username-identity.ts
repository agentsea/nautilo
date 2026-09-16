/**
 * M107 Phase 1 — `migrate-to-username-identity`.
 *
 * Flips an existing Logto-mode Nautilo install from email-as-primary
 * identifier to username-as-primary in Logto + Nautilo DB. Dry-run by
 * default; `--apply` mutates; `--rollback` restores the default-tenant
 * sign-in experience to email mode (does not undo handle backfills).
 *
 * Pure runner (`runMigrateToUsernameIdentity`) accepts injected deps so
 * unit tests stay DB-independent.
 */
import postgresImport from "postgres";
import { resolveInstance } from "@nautilo/config";
import { SIGN_IN_EXP_USERNAME_PATCH_BODY } from "@nautilo/local/bootstrap-logto";
import {
  checkLogtoEnv,
  checkLogtoReachable,
  checkM2MCredentials,
  consoleMigrationLogger,
  type LogtoAdmin,
  type LogtoUser,
  type MigrationDb,
  type MigrationLogger,
  type MigrationUser,
  type PreflightResult,
} from "../lib/logto-migration";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

/** Default-tenant SIE body for email-based sign-in / sign-up (rollback). */
export const SIGN_IN_EXP_EMAIL_PATCH_BODY = {
  signIn: {
    methods: [
      {
        identifier: "email",
        password: true,
        verificationCode: false,
        isPasswordPrimary: true,
      },
    ],
  },
  signUp: {
    identifiers: ["email"],
    password: true,
    verify: false,
  },
} as const;

export type UsernameIdentityAction = "ok" | "set-username" | "skip-no-source";

export interface MigrateToUsernameIdentityArgs {
  apply?: boolean | undefined;
  rollback?: boolean | undefined;
  configEnvPath?: string | undefined;
  /** D202: explicit opt-in to mutate the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
}

export interface MigrateToUsernameIdentityDeps {
  db: MigrationDb;
  admin: LogtoAdmin;
  logger: MigrationLogger;
  /** Defaults to `process.env`. Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `globalThis.fetch`. Override for tests. */
  fetchImpl?: typeof fetch;
  /** Logto `logto_nautilo` DB — `DELETE FROM one_time_tokens`. */
  deleteLogtoOneTimeTokens: () => Promise<void>;
  /** `PATCH ${LOGTO_ENDPOINT}/api/sign-in-exp` on the default tenant. */
  patchDefaultTenantSignInExp: (body: unknown) => Promise<void>;
}

interface ScanRowInternal {
  user: MigrationUser;
  logto: LogtoUser;
  action: UsernameIdentityAction;
  proposedUsername: string | null;
  warnFromEmail: boolean;
}

export async function runMigrateToUsernameIdentity(
  args: MigrateToUsernameIdentityArgs,
  deps: MigrateToUsernameIdentityDeps,
): Promise<number> {
  const log = deps.logger;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  if (args.apply && args.rollback) {
    log.error("--apply and --rollback are mutually exclusive.");
    return 2;
  }

  if (args.rollback) {
    const envCheck = checkLogtoEnv(env);
    if (!envCheck.ok) {
      reportPreflight(log, envCheck);
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
    await deps.patchDefaultTenantSignInExp(SIGN_IN_EXP_EMAIL_PATCH_BODY);
    log.info(
      "Default-tenant sign-in experience patched back to email identifiers.",
    );
    log.info(
      "Note: Nautilo `users.handle` values (if any) were left unchanged.",
    );
    return 0;
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
    return 1;
  }
  if (!colCheck.value) {
    log.error(
      "users.external_id column not found — run `bun run db:migrate` first.",
    );
    return 1;
  }

  const envCheck = checkLogtoEnv(env);
  if (!envCheck.ok) {
    reportPreflight(log, envCheck);
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

  const linked = await deps.db.listLocalUsers(false);
  if (linked.length === 0) {
    log.info("No linked local users (`external_id` set, `server IS NULL`).");
    return 0;
  }

  const scan: ScanRowInternal[] = [];
  for (const user of linked) {
    if (!user.externalId) continue;
    const logtoUser = await deps.admin.getUser(user.externalId);
    if (!logtoUser) {
      log.warn(
        `SKIP user ${user.id}: Logto user missing for external_id=${user.externalId}.`,
      );
      continue;
    }
    const r = resolveUsernameProposal(user, logtoUser);
    if (r.action === "skip-no-source") {
      log.warn(
        `SKIP user ${user.id}: no derivable username (no Logto username, no Nautilo handle, no email local-part).`,
      );
    } else if (r.action === "set-username" && r.warnFromEmail) {
      log.warn(
        `User ${user.id}: deriving username "${r.proposedUsername}" from email local-part — prefer setting Nautilo handle explicitly.`,
      );
    } else if (r.action === "ok") {
      log.info(`ok user ${user.id}: Logto username already set.`);
    }
    scan.push({
      user,
      logto: logtoUser,
      action: r.action,
      proposedUsername: r.proposedUsername,
      warnFromEmail: r.warnFromEmail,
    });
  }

  log.table(
    scan.map((row) => ({
      user_id: row.user.id,
      nautilo_handle: row.user.handle?.trim() || "(empty)",
      logto_username: row.logto.username?.trim() || "(empty)",
      proposed_username: row.proposedUsername ?? "(none)",
      action: row.action,
    })),
  );

  if (!args.apply) {
    log.info("Dry-run complete. Re-run with --apply to mutate Logto + DB.");
    return 0;
  }

  const collisions = await deps.db.listUsersInHandleCollisionGroups();
  if (collisions.length > 0) {
    log.error(
      "Pre-flight failed: duplicate Nautilo handles (case-insensitive) among `server IS NULL` rows. Rename one side manually, then retry.",
    );
    log.table(
      collisions.map((u) => ({
        user_id: u.id,
        handle: u.handle ?? "(null)",
        email: u.email ?? "(null)",
        external_id: u.externalId ?? "(null)",
      })),
    );
    return 1;
  }

  for (const row of scan) {
    if (row.action !== "set-username" || !row.proposedUsername) continue;
    if (!row.user.externalId) continue;
    const status = await deps.admin.patchUser(row.user.externalId, {
      username: row.proposedUsername,
    });
    if (status === 409) {
      log.error(
        `Logto username collision (409) while PATCHing user_id=${row.user.id} (Logto id=${row.user.externalId}). Aborting before sign-in experience flip.`,
      );
      return 1;
    }
    if (status < 200 || status >= 300) {
      log.error(
        `PATCH Logto user failed for user_id=${row.user.id}: HTTP ${status}`,
      );
      return 1;
    }
  }

  for (const row of scan) {
    if (row.action === "skip-no-source" || !row.proposedUsername) continue;
    if (row.user.handle != null && row.user.handle.trim() !== "") continue;
    await deps.db.backfillUserHandleIfNull(
      row.user.id,
      row.proposedUsername,
    );
  }

  await deps.deleteLogtoOneTimeTokens();
  log.info(
    "Deleted all rows from Logto `one_time_tokens` — in-flight invite redeems invalidated; tell active users to restart.",
  );

  await deps.patchDefaultTenantSignInExp(SIGN_IN_EXP_USERNAME_PATCH_BODY);
  log.info("Default-tenant sign-in experience patched to username mode.");
  return 0;
}

function resolveUsernameProposal(
  nautilo: MigrationUser,
  logto: LogtoUser,
): {
  action: UsernameIdentityAction;
  proposedUsername: string | null;
  warnFromEmail: boolean;
} {
  const existing = logto.username?.trim();
  if (existing) {
    return {
      action: "ok",
      proposedUsername: existing.toLowerCase(),
      warnFromEmail: false,
    };
  }
  const h = nautilo.handle?.trim();
  if (h) {
    return {
      action: "set-username",
      proposedUsername: h.toLowerCase(),
      warnFromEmail: false,
    };
  }
  const email = logto.primaryEmail?.trim();
  const at = email?.indexOf("@") ?? -1;
  const local =
    email && at > 0 ? email.slice(0, Math.max(0, at)).trim() : "";
  if (local) {
    return {
      action: "set-username",
      proposedUsername: local.toLowerCase(),
      warnFromEmail: true,
    };
  }
  return {
    action: "skip-no-source",
    proposedUsername: null,
    warnFromEmail: false,
  };
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

type SqlClient = {
  unsafe(query: string): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
};

const createSqlClient = postgresImport as unknown as (
  postgresUrl: string,
  options: { max: number; idle_timeout: number },
) => SqlClient;

async function deleteLogtoOneTimeTokensFromCluster(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const inst = resolveInstance();
  const password = env["LOGTO_DB_PASSWORD"] ?? "logto";
  const postgresUrl = `postgres://logto:${encodeURIComponent(password)}@localhost:${inst.logto.dbPort}/logto_nautilo`;
  const sql = createSqlClient(postgresUrl, { max: 1, idle_timeout: 5 });
  try {
    await sql.unsafe("DELETE FROM one_time_tokens");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function patchDefaultTenantSignInExpFromCluster(
  deps: {
    admin: Pick<LogtoAdmin, "getAccessToken">;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    logger: MigrationLogger;
  },
  body: unknown,
): Promise<void> {
  const env = deps.env ?? process.env;
  const endpoint = env["LOGTO_ENDPOINT"]?.replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error("LOGTO_ENDPOINT is not set");
  }
  const token = await deps.admin.getAccessToken("https://default.logto.app/api");
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`${endpoint}/api/sign-in-exp`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    deps.logger.error(`PATCH /api/sign-in-exp failed: ${res.status} ${text}`);
    throw new Error(`PATCH /api/sign-in-exp failed: ${res.status}`);
  }
}

export async function migrateToUsernameIdentity(
  args: MigrateToUsernameIdentityArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:migrate-to-username-identity",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.apply !== true && args.rollback !== true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });

  // No `exitUnlessSetupStateIn` check here. Unlike `migrate-to-logto`
  // / `verify-user-link`, this command intentionally runs with the
  // Nautilo server STOPPED — it mutates Logto (PATCH users + SIE, DELETE
  // one_time_tokens) and the Nautilo DB (handle backfills) while no
  // live traffic should be racing. Logto reachability is gated by the
  // dedicated preflight checks (`checkLogtoEnv`, `checkLogtoReachable`,
  // `checkM2MCredentials`) further down — that's the constraint we
  // actually care about.

  const { createMigrationDb } = await import("../lib/migration-db");
  const { getLogtoAdminClient } = await import("@nautilo/trust");

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
        "LOGTO_M2M_APP_ID, LOGTO_M2M_APP_SECRET.",
    );
    return 1;
  }

  const env = process.env;
  const deleteLogtoOneTimeTokens = () =>
    deleteLogtoOneTimeTokensFromCluster(env);
  const patchDefaultTenantSignInExp = (body: unknown) =>
    patchDefaultTenantSignInExpFromCluster(
      { admin, env, logger, fetchImpl: globalThis.fetch },
      body,
    );

  const db = createMigrationDb();
  try {
    return await runMigrateToUsernameIdentity(args, {
      db,
      admin,
      logger,
      env: process.env,
      deleteLogtoOneTimeTokens,
      patchDefaultTenantSignInExp,
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await db.end();
  }
}
