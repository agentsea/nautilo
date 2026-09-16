/**
 * D129 P3 part 2 (Stack 11.5) — operator-side counterpart to
 * `infra/postgres-init.sh`'s agent-role provisioning block.
 *
 * The init script only runs on FIRST boot of a Postgres data volume.
 * Operators upgrading a pre-D129-P3 install have an existing volume
 * where the script never fired with the new agent-role SQL — they're
 * missing the `nautilo_agent` role, the `users_public` view, and the
 * GRANT/REVOKE deltas. M212 extends this command to also repair legacy
 * volumes where `public` objects are owned by `postgres` instead of the
 * runtime `nautilo` app role.
 *
 * Default mode is **dry-run** (probe only, no mutation). `--apply`
 * mutates. The probe + apply paths both go through a `ClusterExec`
 * injection point so unit tests can drive the command without
 * docker.
 *
 * Idempotent: re-runs against an already-correct cluster exit 0 with
 * "OK: app-role ownership + grants and nautilo_agent contract already
 * in place."
 *
 * SQL applied (matches the second + third psql blocks in
 * `infra/postgres-init.sh`, plus M212 app-role ownership repair):
 *
 *   - CREATE ROLE nautilo_agent (if missing)
 *   - GRANT USAGE / CONNECT on database + schema
 *   - ALTER DEFAULT PRIVILEGES so future tables grant the agent role
 *   - GRANT SELECT/INSERT/UPDATE/DELETE on existing tables
 *   - REVOKE on credential-class tables (credentials, recovery_codes,
 *     logto_account_security, channel_identities) — see the
 *     sensitive-tables-matrix.md classification
 *   - CREATE OR REPLACE VIEW users_public + GRANT SELECT on it
 *   - REVOKE ALL on raw `users` table from nautilo_agent
 *   - ALTER OWNER of existing public tables/sequences/views to nautilo
 *   - GRANT nautilo ALL on existing public tables/sequences + defaults
 *
 * The `sessions` table is intentionally NOT in the REVOKE list —
 * it's conversational transcript sessions (not auth tokens), and the
 * agent legitimately reads it for memory recall + "list recent
 * conversations" surfaces. Auth tokens live on disk at
 * `~/.nautilo/sessions.json`, never in this DB. See
 * `packages/db/audits/sensitive-tables-matrix.md` for the canonical
 * per-table classification.
 */
import { execFileSync, execSync } from "node:child_process";
import { resolveInstance } from "@nautilo/config";
import {
  buildFullLegacyRoleRepairSql,
  LANGCHAIN_CHECKPOINT_TABLES,
  NAUTILO_ESSENTIAL_SELECT_TABLE,
  PROBE_NAUTILO_ESSENTIAL_SELECT_SQL,
  PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL,
  SENSITIVE_TABLES,
} from "@nautilo/db";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

const DB_USER_DEFAULT = "postgres";
const TARGET_DB = "nautilo";
const TARGET_ROLE = "nautilo_agent";
const REQUIRED_AGENT_TABLES = ["profiles", "sessions", "session_messages"] as const;

export interface MigrateOptions {
  container?: string | undefined;
  superuser?: string | undefined;
  apply?: boolean | undefined;
  /** D202: explicit opt-in to apply migration against the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
  /**
   * Override for the nautilo_agent role's password. Read from
   * `NAUTILO_AGENT_DB_PASSWORD` env if not provided; defaults to
   * `nautilo_agent` (DEV-ONLY; production deployments MUST set the
   * env var per the operator playbook).
   */
  agentPassword?: string | undefined;
}

export interface ProbeResult {
  status: "ok" | "missing-role" | "missing-grants" | "missing-view" | "needs-fix" | "no-container";
  rolePresent: boolean;
  usersPublicViewPresent: boolean;
  requiredTablesGranted: boolean[];
  sensitiveTablesRevoked: boolean[];
  containerRunning: boolean;
  appRoleOwnershipOk: boolean;
  nautiloEssentialSelectOk: boolean;
  /** Stack 198 — langchain (LangGraph PostgresSaver) schema presence. */
  langchainSchemaPresent: boolean;
  /**
   * Stack 198 — per checkpoint table, whether nautilo_agent has DML.
   * `true` when the table is absent (trivially OK — nothing to grant on);
   * `false` only when the table exists but DML is missing.
   */
  langchainCheckpointTablesGranted: boolean[];
}

export interface ClusterExec {
  query: (
    sql: string,
    opts: { container: string; superuser: string; db?: string },
  ) => string;
  containerRunning: (container: string) => boolean;
}

function defaultClusterExec(): ClusterExec {
  return {
    query: (sql, { container, superuser, db }) => {
      const target = db ?? "postgres";
      return execFileSync(
        "docker",
        ["exec", container, "psql", "-U", superuser, "-t", "-A", "-c", sql.trim(), target],
        { stdio: ["ignore", "pipe", "pipe"] },
      )
        .toString()
        .trim();
    },
    containerRunning: (container) => {
      try {
        const out = execSync(
          `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`,
        )
          .toString()
          .trim();
        return out === "true";
      } catch {
        return false;
      }
    },
  };
}

function resolveDefaultContainer(): string {
  return resolveInstance().compose.containers.legacyPostgres;
}

function probeAppRoleState(
  options: { container: string; superuser: string },
  exec: ClusterExec,
): { appRoleOwnershipOk: boolean; nautiloEssentialSelectOk: boolean } {
  const notOwnedCount = exec.query(PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL, {
    ...options,
    db: TARGET_DB,
  });
  const appRoleOwnershipOk = notOwnedCount === "" || notOwnedCount === "0";

  const essentialSelect = exec.query(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL, {
    ...options,
    db: TARGET_DB,
  });
  const nautiloEssentialSelectOk =
    essentialSelect === "skip" || essentialSelect === "ok";

  return { appRoleOwnershipOk, nautiloEssentialSelectOk };
}

/** Pure probe; no mutation. Used by both dry-run and the `--apply` decision gate. */
export function probeAgentRoleState(
  options: { container: string; superuser: string },
  exec: ClusterExec = defaultClusterExec(),
): ProbeResult {
  if (!exec.containerRunning(options.container)) {
    return {
      status: "no-container",
      rolePresent: false,
      usersPublicViewPresent: false,
      requiredTablesGranted: REQUIRED_AGENT_TABLES.map(() => false),
      sensitiveTablesRevoked: SENSITIVE_TABLES.map(() => false),
      containerRunning: false,
      appRoleOwnershipOk: false,
      nautiloEssentialSelectOk: false,
      langchainSchemaPresent: false,
      langchainCheckpointTablesGranted: LANGCHAIN_CHECKPOINT_TABLES.map(() => false),
    };
  }

  const { appRoleOwnershipOk, nautiloEssentialSelectOk } = probeAppRoleState(
    options,
    exec,
  );

  const rolePresent =
    exec.query(`SELECT 1 FROM pg_roles WHERE rolname = '${TARGET_ROLE}'`, options) ===
    "1";

  const usersPublicViewPresent =
    exec.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'users_public' AND n.nspname = 'public' AND c.relkind = 'v'`,
      { ...options, db: TARGET_DB },
    ) === "1";

  const sensitiveTablesRevoked = SENSITIVE_TABLES.map((tbl) => {
    if (!rolePresent) return false;
    // `has_table_privilege` returns t/f. If the role has ANY of the four
    // basic privileges on the sensitive table, it's NOT revoked.
    const out = exec.query(
      `SELECT has_table_privilege('${TARGET_ROLE}', 'public.${tbl}', 'SELECT, INSERT, UPDATE, DELETE')`,
      { ...options, db: TARGET_DB },
    );
    // Empty output → table doesn't exist → "revoked" trivially holds.
    if (out === "") return true;
    return out === "f";
  });

  const requiredTablesGranted = REQUIRED_AGENT_TABLES.map((tbl) => {
    if (!rolePresent) return false;
    const out = exec.query(
      `SELECT has_table_privilege('${TARGET_ROLE}', 'public.${tbl}', 'SELECT')`,
      { ...options, db: TARGET_DB },
    );
    return out === "t";
  });

  const allRequiredGranted = requiredTablesGranted.every((r) => r);
  const allRevoked = sensitiveTablesRevoked.every((r) => r);

  // Stack 198 — langchain (LangGraph PostgresSaver) checkpoint grants.
  // The schema is created lazily by PostgresSaver.setup(); when absent,
  // there is nothing to grant and the probe skips cleanly. When present,
  // each existing checkpoint table must grant nautilo_agent DML; an
  // absent table is trivially OK (PostgresSaver.setup() will create it
  // later and the apply path's default privileges cover it).
  const langchainSchemaPresent =
    exec.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = 'langchain'`,
      { ...options, db: TARGET_DB },
    ) === "1";

  const langchainCheckpointTablesGranted = LANGCHAIN_CHECKPOINT_TABLES.map((tbl) => {
    // Schema absent → PostgresSaver.setup() hasn't run; nothing to grant,
    // trivially OK. Role absent → can't hold grants; report not-granted
    // (status chain reports missing-role before missing-grants anyway).
    if (!langchainSchemaPresent) return true;
    if (!rolePresent) return false;
    const out = exec.query(
      `SELECT has_table_privilege('${TARGET_ROLE}', 'langchain.${tbl}', 'SELECT, INSERT, UPDATE, DELETE')`,
      { ...options, db: TARGET_DB },
    );
    // Empty output → table doesn't exist yet → trivially OK (default
    // privileges from the apply path cover it once setup() creates it).
    if (out === "") return true;
    return out === "t";
  });

  const langchainGrantsOk = langchainCheckpointTablesGranted.every((r) => r);

  let status: ProbeResult["status"];
  if (!appRoleOwnershipOk || !nautiloEssentialSelectOk) status = "needs-fix";
  else if (!rolePresent) status = "missing-role";
  else if (!usersPublicViewPresent) status = "missing-view";
  else if (!allRequiredGranted || !allRevoked || !langchainGrantsOk) status = "missing-grants";
  else status = "ok";

  return {
    status,
    rolePresent,
    usersPublicViewPresent,
    requiredTablesGranted,
    sensitiveTablesRevoked,
    containerRunning: true,
    appRoleOwnershipOk,
    nautiloEssentialSelectOk,
    langchainSchemaPresent,
    langchainCheckpointTablesGranted,
  };
}

/**
 * Idempotent SQL block that mirrors `infra/postgres-init.sh`'s
 * agent-role provisioning. Safe to re-run.
 */
function buildApplySql(agentPassword: string): { onPostgres: string; onNautilo: string } {
  // Defense against JS-template-literal SQL injection: validate the
  // password BEFORE building the SQL string. We use the password in TWO
  // places — JS string interpolation (built into the DO $$ block below)
  // AND Postgres `format(... %L ...)` (which is SQL-safe). The %L
  // protects against PG-side injection but only if the JS-built string
  // is itself well-formed. A password containing `'` would already break
  // the JS-built SQL string before Postgres saw it.
  //
  // Strategy: refuse passwords containing characters that would break
  // the JS-built SQL or shell out via docker exec. The character set
  // below is permissive enough for any reasonable random password
  // (base64, hex, alphanumeric + common symbols) while excluding the
  // dangerous ones (`'`, `\\`, `\``, `$`).
  if (!/^[A-Za-z0-9!#%&()*+,\-./:;<=>?@[\]^_{|}~]+$/.test(agentPassword)) {
    throw new Error(
      `migrate-add-agent-role: NAUTILO_AGENT_DB_PASSWORD contains characters ` +
        `unsafe for SQL string assembly. Allowed: A-Za-z0-9 plus !#%&()*+,-./:;<=>?@[]^_{|}~. ` +
        `Common safe choices: hex, base64 (with - and _ from base64url), alphanumeric.`,
    );
  }

  // Block 1 — connect to the maintenance `postgres` DB to create the role
  // and grant CONNECT on the `nautilo` DB. The password is validated
  // above to be free of JS/SQL-breaking characters; format() %L then
  // adds Postgres-side literal quoting as belt-and-suspenders.
  //
  // Stack 193 — the ELSE branch now SYNCHRONIZES the existing role's
  // password to `agentPassword` (rotating it) instead of leaving it
  // unchanged. Previously a healthy cluster (grants/view/ownership all
  // ok) caused `--apply` to return early without ever syncing the
  // password, so the recommended repair command was a no-op against a
  // role whose password had drifted from `NAUTILO_AGENT_DB_PASSWORD`.
  // Re-running this block is idempotent: ALTER ROLE PASSWORD just
  // rewrites the stored hash to the same value.
  const onPostgres = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TARGET_ROLE}') THEN
    EXECUTE format('CREATE ROLE ${TARGET_ROLE} LOGIN PASSWORD %L', '${agentPassword}');
    RAISE NOTICE 'D129 P3: created role ${TARGET_ROLE}';
  ELSE
    EXECUTE format('ALTER ROLE ${TARGET_ROLE} PASSWORD %L', '${agentPassword}');
    RAISE NOTICE 'D129 P3: role ${TARGET_ROLE} already exists; password synchronized';
  END IF;
END $$;

REVOKE ALL ON DATABASE ${TARGET_DB} FROM ${TARGET_ROLE};
GRANT CONNECT ON DATABASE ${TARGET_DB} TO ${TARGET_ROLE};
`;

  const onNautilo = buildFullLegacyRoleRepairSql();

  return { onPostgres, onNautilo };
}

export async function migrateAddAgentRole(
  options: MigrateOptions = {},
  exec: ClusterExec = defaultClusterExec(),
): Promise<number> {
  // The command is logically synchronous (docker exec is synchronous);
  // the async signature matches the other migrate-* command shapes for
  // router uniformity. This await satisfies `require-await` without
  // changing behavior.
  await Promise.resolve();

  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:migrate-add-agent-role",
    cwd: process.cwd(),
    isDryRunOrReadOnly: options.apply !== true,
    ...(options.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  const container = options.container ?? resolveDefaultContainer();
  const superuser = options.superuser ?? DB_USER_DEFAULT;
  const apply = options.apply === true;
  const agentPassword =
    options.agentPassword ??
    process.env["NAUTILO_AGENT_DB_PASSWORD"] ??
    "nautilo_agent";

  const probe = probeAgentRoleState({ container, superuser }, exec);

  if (probe.status === "no-container") {
    console.error(
      `migrate-add-agent-role: container "${container}" is not running. ` +
        `Start it with \`nautilo-dev infra-start\` or override with --container.`,
    );
    return 1;
  }

  console.log(`migrate-add-agent-role: probe against container "${container}":`);
  console.log(
    `  public objects owned by nautilo: ${probe.appRoleOwnershipOk ? "yes" : "no"}`,
  );
  console.log(
    `  nautilo SELECT on ${NAUTILO_ESSENTIAL_SELECT_TABLE}: ${
      probe.nautiloEssentialSelectOk ? "yes" : "no"
    }`,
  );
  console.log(`  role nautilo_agent present: ${probe.rolePresent ? "yes" : "no"}`);
  console.log(
    `  users_public view present: ${probe.usersPublicViewPresent ? "yes" : "no"}`,
  );
  for (let i = 0; i < REQUIRED_AGENT_TABLES.length; i++) {
    console.log(
      `  ${REQUIRED_AGENT_TABLES[i]} granted to nautilo_agent: ${
        probe.requiredTablesGranted[i] ? "yes" : "no"
      }`,
    );
  }
  for (let i = 0; i < SENSITIVE_TABLES.length; i++) {
    console.log(
      `  ${SENSITIVE_TABLES[i]} revoked from nautilo_agent: ${
        probe.sensitiveTablesRevoked[i] ? "yes" : "no"
      }`,
    );
  }
  console.log(
    `  langchain schema present: ${probe.langchainSchemaPresent ? "yes" : "no"}`,
  );
  for (let i = 0; i < LANGCHAIN_CHECKPOINT_TABLES.length; i++) {
    console.log(
      `  langchain.${LANGCHAIN_CHECKPOINT_TABLES[i]} DML granted to nautilo_agent: ${
        probe.langchainCheckpointTablesGranted[i] ? "yes" : "no"
      }`,
    );
  }

  if (probe.status === "ok") {
    if (!apply) {
      console.log(
        "migrate-add-agent-role: OK — app-role ownership + grants and nautilo_agent contract already in place. Nothing to apply.",
      );
      return 0;
    }
    // Stack 193 — even when the probe is healthy, `--apply` must still
    // synchronize the existing nautilo_agent password to the configured
    // value. Fall through to the apply path; the idempotent repair SQL
    // is safe to re-run and the onPostgres block now ALTER ROLEs the
    // password in both the missing- and existing-role branches.
    console.log(
      "migrate-add-agent-role: probe healthy; --apply requested — synchronizing nautilo_agent password and re-running idempotent provisioning.",
    );
  } else if (!apply) {
    console.log(
      `\nmigrate-add-agent-role: dry-run. State is "${probe.status}". ` +
        `Re-run with --apply to fix.`,
    );
    return 0;
  } else {
    console.log(
      `\nmigrate-add-agent-role: --apply requested. Applying app-role ownership/grants ` +
        `and nautilo_agent provisioning idempotently...`,
    );
  }

  const sql = buildApplySql(agentPassword);

  exec.query(sql.onPostgres, { container, superuser, db: "postgres" });
  console.log("  applied: role + database-level grants (postgres maintenance DB)");

  exec.query(sql.onNautilo, { container, superuser, db: TARGET_DB });
  console.log(
    "  applied: app-role ownership/grants + nautilo_agent schema grants/revokes/view",
  );

  const post = probeAgentRoleState({ container, superuser }, exec);
  if (post.status === "ok") {
    console.log(
      "\nmigrate-add-agent-role: OK — app-role ownership + grants and nautilo_agent contract complete.",
    );
    return 0;
  }

  console.error(
    `\nmigrate-add-agent-role: post-apply probe still reports "${post.status}". ` +
      `Something went wrong; inspect the cluster manually.`,
  );
  return 1;
}
