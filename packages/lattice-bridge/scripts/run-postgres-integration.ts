import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CRYPTO_STORAGE_TABLE_NAMES,
  buildCryptoRoleReconcilePsqlScript,
  buildFullCryptoTablePrivilegeReconcileSql,
} from "@nautilo/db";
import { buildEventFeedReaderRoleSql } from "../../db/src/utils/event-feed-role";
import { waitForFinalPostgres } from "./postgres-integration-readiness";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const INIT_SCRIPT = resolve(REPO_ROOT, "infra/postgres-init.sh");
const CONTAINER_NAME =
  `nautilo-lattice-bridge-test-${process.pid}-${Date.now()}`;
const POSTGRES_IMAGE =
  process.env["LATTICE_BRIDGE_TEST_POSTGRES_IMAGE"]
  ?? "pgvector/pgvector:pg17";
const LATTICE_BACKUP_TABLES = CRYPTO_STORAGE_TABLE_NAMES;
const requestedTestPaths = process.argv.slice(2);

function ephemeralPassword(): string {
  return randomBytes(24).toString("hex");
}

const credentials = Object.freeze({
  postgres: ephemeralPassword(),
  nautilo: ephemeralPassword(),
  logto: ephemeralPassword(),
  agent: ephemeralPassword(),
  crypto: ephemeralPassword(),
});

function run(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    stdio?: "inherit" | "pipe";
  } = {},
): string {
  const result = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `${command} failed with exit ${String(result.status)}`
      + (stderr === "" ? "" : `: ${stderr}`),
    );
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function inspectPostgresStatus(): string | undefined {
  const status = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      CONTAINER_NAME,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  return status.status === 0 ? status.stdout.trim() : undefined;
}

function readPostgresLogs(): string {
  const logs = spawnSync(
    "docker",
    ["logs", CONTAINER_NAME],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (logs.status !== 0) return "";
  return [logs.stdout, logs.stderr].filter(Boolean).join("\n");
}

function canQueryPostgres(): boolean {
  const query = spawnSync(
    "docker",
    [
      "exec",
      CONTAINER_NAME,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      "SELECT 1",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  return query.status === 0 && query.stdout.trim() === "1";
}

async function waitForInitializedPostgres(): Promise<void> {
  await waitForFinalPostgres({
    canQuery: canQueryPostgres,
    inspectStatus: inspectPostgresStatus,
    now: Date.now,
    readLogs: readPostgresLogs,
    sleep: async (milliseconds) => {
      await new Promise((complete) => setTimeout(complete, milliseconds));
    },
  });
}

function psql(
  database: "postgres" | "nautilo",
  script: string,
): void {
  run(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER_NAME,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      database,
    ],
    { input: script },
  );
}

export function provisionPrivilegedMigrationRoles(
  executeAdminSql: typeof psql,
): void {
  executeAdminSql("postgres", buildEventFeedReaderRoleSql());
}

function roleExists(): boolean {
  return run(
    "docker",
    [
      "exec",
      CONTAINER_NAME,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_crypto')",
    ],
  ) === "t";
}

function mappedPostgresPort(): string {
  const mapping = run(
    "docker",
    ["port", CONTAINER_NAME, "5432/tcp"],
  );
  const match = mapping.match(/:(\d+)\s*$/);
  if (!match) throw new Error("could not resolve disposable Postgres port");
  return match[1]!;
}

function databaseUrl(
  role: "postgres" | "nautilo" | "nautilo_agent" | "nautilo_crypto",
  password: string,
  port: string,
  database = "nautilo",
): string {
  const url = new URL(`postgres://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = password;
  return url.toString();
}

function verifyCryptoBackupRestore(): void {
  const userId = "90000000-0000-4000-8000-000000000001";
  const actorId = "90000000-0000-4000-8000-000000000002";
  const deviceId = "device_backup_restore_anchor";
  psql("nautilo", `
    INSERT INTO users (id, name)
    VALUES ('${userId}', 'Crypto backup/restore fixture');
    INSERT INTO actors (
      id, owner_id, display_name, trust_state, kind
    ) VALUES (
      '${actorId}', '${userId}', 'Crypto backup/restore fixture',
      'verified', 'user'
    );
    INSERT INTO human_crypto_custodies (
      human_id, user_id, human_actor_id,
      initial_installation_lineage_digest, state, ever_initialized_at,
      first_device_id, current_recovery_generation,
      current_recovery_public_key_digest, revision,
      last_transition_audit_ref, created_at, updated_at
    ) VALUES (
      '${actorId}', '${userId}', '${actorId}',
      decode(repeat('11', 32), 'hex'), 'active',
      '2026-01-01T00:00:00.000Z', '${deviceId}', 1,
      decode(repeat('22', 32), 'hex'), 1,
      'audit_backup_restore_fixture',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO human_crypto_devices (
      device_id, human_id, user_id, human_actor_id, client_kind,
      installation_lineage_digest, device_generation,
      signing_public_key, encryption_public_key, public_fingerprint,
      state, authorization_kind, approval_generation, recovery_generation,
      authorization_evidence_digest, key_package_generation,
      key_package_count, delivery_sequence_high_watermark,
      delivery_acknowledged_sequence, revision, created_at, activated_at
    ) VALUES (
      '${deviceId}', '${actorId}', '${userId}', '${actorId}', 'browser',
      decode(repeat('33', 32), 'hex'), 1,
      decode(repeat('44', 32), 'hex'), decode(repeat('55', 65), 'hex'),
      decode(repeat('66', 32), 'hex'), 'active', 'first_bootstrap',
      NULL, 1, decode(repeat('77', 32), 'hex'), 0, 0, 5, 5, 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  const tableArguments = LATTICE_BACKUP_TABLES.flatMap((table) => [
    "--table",
    `public.${table}`,
  ]);
  const dump = run(
    "docker",
    [
      "exec",
      CONTAINER_NAME,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "nautilo",
      "--data-only",
      "--column-inserts",
      "--no-owner",
      "--no-privileges",
      ...tableArguments,
    ],
  );
  const retainedClientHighWatermark = 6;
  psql("nautilo", `
    UPDATE human_crypto_devices
       SET delivery_sequence_high_watermark = ${retainedClientHighWatermark},
           delivery_acknowledged_sequence = ${retainedClientHighWatermark}
     WHERE device_id = '${deviceId}';
    TRUNCATE TABLE ${LATTICE_BACKUP_TABLES.join(", ")} CASCADE;
  `);
  psql("nautilo", dump);
  const restored = run(
    "docker",
    [
      "exec",
      CONTAINER_NAME,
      "psql",
      "-U",
      "postgres",
      "-d",
      "nautilo",
      "-t",
      "-A",
      "-c",
      `SELECT delivery_sequence_high_watermark::text
         || '|' || delivery_acknowledged_sequence::text
         || '|' || state
         FROM human_crypto_devices
        WHERE device_id = '${deviceId}'`,
    ],
  );
  if (restored !== "5|5|active") {
    throw new Error(`crypto backup/restore drifted: ${restored}`);
  }
  const restoredHighWatermark = Number(restored.split("|")[0]);
  if (restoredHighWatermark >= retainedClientHighWatermark) {
    throw new Error("crypto rollback fixture did not restore older state");
  }
  psql("nautilo", `
    TRUNCATE TABLE ${LATTICE_BACKUP_TABLES.join(", ")} CASCADE;
    DELETE FROM users WHERE id = '${userId}';
  `);
}

async function main(): Promise<number> {
  const dockerEnv = {
    ...process.env,
    POSTGRES_PASSWORD: credentials.postgres,
    NAUTILO_DB_PASSWORD: credentials.nautilo,
    LOGTO_DB_PASSWORD: credentials.logto,
    NAUTILO_AGENT_DB_PASSWORD: credentials.agent,
    NAUTILO_CRYPTO_DB_PASSWORD: credentials.crypto,
    NAUTILO_POSTGRES_CLUSTER_KIND: "app",
  };
  run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      CONTAINER_NAME,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "NAUTILO_DB_PASSWORD",
      "--env",
      "LOGTO_DB_PASSWORD",
      "--env",
      "NAUTILO_AGENT_DB_PASSWORD",
      "--env",
      "NAUTILO_CRYPTO_DB_PASSWORD",
      "--env",
      "NAUTILO_POSTGRES_CLUSTER_KIND",
      "--volume",
      `${INIT_SCRIPT}:/docker-entrypoint-initdb.d/01-nautilo.sh:ro`,
      "--health-cmd",
      "pg_isready -U postgres -d postgres",
      "--health-interval",
      "1s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "60",
      POSTGRES_IMAGE,
    ],
    { env: dockerEnv },
  );

  try {
    await waitForInitializedPostgres();
    if (!roleExists()) {
      throw new Error(
        "fresh app-cluster bootstrap did not create nautilo_crypto",
      );
    }

    // Reproduce a five-password, pre-M231 app cluster: the ordinary roles and
    // database exist, but the crypto role and all 14 tables do not.
    psql(
      "postgres",
      [
        "REVOKE ALL ON DATABASE nautilo FROM nautilo_crypto;",
        "REVOKE ALL ON DATABASE logto_nautilo FROM nautilo_crypto;",
        "DROP ROLE nautilo_crypto;",
      ].join("\n"),
    );
    psql("postgres", buildCryptoRoleReconcilePsqlScript());
    provisionPrivilegedMigrationRoles(psql);

    const port = mappedPostgresPort();
    const migrationUrl = databaseUrl(
      "nautilo",
      credentials.nautilo,
      port,
    );
    run(
      "bun",
      ["run", "--cwd", "packages/db", "db:migrate"],
      {
        env: {
          ...process.env,
          DB_CONNECTION_STRING: migrationUrl,
        },
        stdio: "inherit",
      },
    );
    psql("nautilo", buildFullCryptoTablePrivilegeReconcileSql());

    // Prove reconciliation repairs a legacy/day-two instance instead of only
    // accepting the pristine role created above.
    psql(
      "nautilo",
      [
        "CREATE ROLE lattice_intruder NOLOGIN;",
        "GRANT lattice_intruder TO nautilo_crypto;",
        "ALTER ROLE nautilo_crypto BYPASSRLS INHERIT;",
        "GRANT SELECT ON users TO nautilo_crypto;",
        "GRANT SELECT ON crypto_domains TO nautilo_agent, lattice_intruder;",
      ].join("\n"),
    );
    psql("postgres", buildCryptoRoleReconcilePsqlScript());
    psql("nautilo", buildFullCryptoTablePrivilegeReconcileSql());

    const testEnv = {
      ...process.env,
      LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL: databaseUrl(
        "postgres",
        credentials.postgres,
        port,
      ),
      LATTICE_BRIDGE_TEST_DATABASE_URL: databaseUrl(
        "nautilo_crypto",
        credentials.crypto,
        port,
      ),
      LATTICE_BRIDGE_TEST_APP_DATABASE_URL: migrationUrl,
      LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL: databaseUrl(
        "nautilo_agent",
        credentials.agent,
        port,
      ),
    };
    const result = spawnSync(
      "bun",
      [
        "test",
        "--timeout",
        "60000",
        "--max-concurrency",
        "1",
        ...(requestedTestPaths.length === 0
          ? ["packages/lattice-bridge/tests/integration/"]
          : requestedTestPaths),
      ],
      {
        cwd: REPO_ROOT,
        env: testEnv,
        stdio: "inherit",
      },
    );
    if (result.status === 0) verifyCryptoBackupRestore();
    return result.status ?? 1;
  } catch (error) {
    try {
      const logs = run("docker", ["logs", CONTAINER_NAME]);
      if (logs !== "") console.error(logs);
    } catch {
      // Preserve the primary failure if Docker itself has already gone away.
    }
    throw error;
  } finally {
    spawnSync("docker", ["stop", "--time", "5", CONTAINER_NAME], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
  }
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
