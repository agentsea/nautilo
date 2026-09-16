/**
 * M210 Phase 6 — `nautilo-dev verify-pool-lifecycle`.
 *
 * Read-only operator helper: before/after pg_stat snapshots, 1,000 sequential
 * then 50 parallel `SELECT 1` through direct postgres.js wire connections,
 * split evenly across the `nautilo` and `nautilo_agent` application pools.
 * Never prints DSNs, passwords, or auth headers.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  resolveAgentDatabaseConnectionString,
  resolveAppDatabaseConnectionString,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  collectMetricsViaReader,
  directPostgresSelect1,
  parseVerifyPoolLifecycleArgs,
  runVerifyPoolLifecycle,
  sanitizePoolLifecycleError,
  SQL_STAT_ACTIVITY_GROUPED,
  SQL_STAT_DATABASE,
  type MetadataReader,
  type VerifyPoolLifecycleDeps,
} from "../lib/pool-lifecycle-verify";

const METADATA_APP_NAME = "nautilo.pool-lifecycle-verify";

const VERIFY_POOL_HELP: HelpSpec = {
  name: "dev:verify-pool-lifecycle",
  summary:
    "M210 read-only pool lifecycle QA — pg_stat before/after + direct postgres.js SELECT 1 load.",
  usage: "verify-pool-lifecycle --instance <non-default-name>",
  flags: [
    {
      flag: "--instance <non-default-name>",
      description:
        "Required: explicit non-default local instance id.",
    },
  ],
  examples: [
    {
      cmd: "bun run dev:verify-pool-lifecycle --instance pool-qa",
      desc: "Local isolated instance pool lifecycle verification.",
    },
  ],
  notes: [
    "Issues only SELECT queries. Never prints connection strings or auth headers.",
    "Sequential load: 1,000 parameterized SELECT 1 (500 per application role); burst: 50 parallel SELECT 1 (25 per role).",
    "Refuses missing, empty, or default/(default) instance targets.",
    "Remote --profile QA is a manual SSH-host workflow; this command rejects --profile.",
  ],
};

function appendApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function createMetadataReader(connectionString: string): MetadataReader {
  const sql = postgres(
    appendApplicationName(connectionString, METADATA_APP_NAME),
    { max: 1 },
  );

  return {
    async queryRows(query: string): Promise<Record<string, string | number | null>[]> {
      if (query === SQL_STAT_DATABASE) {
        const rows = await sql`
          SELECT datname, sessions, sessions_abandoned
          FROM pg_stat_database WHERE datname = 'nautilo'
        `;
        return rows as Record<string, string | number | null>[];
      }
      if (query === SQL_STAT_ACTIVITY_GROUPED) {
        const rows = await sql`
          SELECT COALESCE(client_addr::text, 'local') AS client_addr,
                 usename, application_name, state, count(*)::int AS n
          FROM pg_stat_activity WHERE datname = 'nautilo'
          GROUP BY 1, 2, 3, 4 ORDER BY n DESC
        `;
        return rows as Record<string, string | number | null>[];
      }
      throw new Error("only SELECT metadata queries are permitted");
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

function createRoleClient(connectionString: string, applicationRole: string) {
  return postgres(
    appendApplicationName(connectionString, `nautilo.pool-lifecycle-verify.${applicationRole}`),
    { max: 1, connect_timeout: 5 },
  );
}

function buildProductionDeps(
  env: NodeJS.ProcessEnv,
  logClose: (msg: string) => void,
): VerifyPoolLifecycleDeps {
  const connectionStrings = {
    nautilo: resolveAppDatabaseConnectionString(env),
    nautilo_agent: resolveAgentDatabaseConnectionString(env),
  };
  const directConn = resolveDirectDatabaseConnectionString(env);

  return {
    log: (msg) => console.log(msg),
    logClose,
    async collectMetrics() {
      const reader = createMetadataReader(directConn);
      try {
        return await collectMetricsViaReader(reader);
      } finally {
        await reader.close();
        logClose("[verify-pool-lifecycle] metadata handle closed");
      }
    },
    async runSequentialSelect1(applicationRole, count) {
      const client = createRoleClient(connectionStrings[applicationRole], applicationRole);
      try {
        for (let i = 0; i < count; i++) {
          await directPostgresSelect1({
            query: (value) => client`SELECT ${value}::int`,
          });
        }
      } finally {
        await client.end({ timeout: 5 });
      }
    },
    async runParallelBurst(applicationRole, count) {
      const results = await Promise.allSettled(
        Array.from({ length: count }, async () => {
          const client = createRoleClient(connectionStrings[applicationRole], applicationRole);
          try {
            await directPostgresSelect1({
            query: (value) => client`SELECT ${value}::int`,
          });
          } finally {
            await client.end({ timeout: 5 });
          }
        }),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      return { requested: count, succeeded, failed: count - succeeded };
    },
  };
}

/**
 * Return the minimal environment needed to locate a named instance without
 * inheriting ambient connection strings or other configuration overrides.
 */
function deriveInstanceVerificationEnv(
  env: NodeJS.ProcessEnv,
  instanceId: string,
): NodeJS.ProcessEnv {
  const derivedEnv: NodeJS.ProcessEnv = {
    NAUTILO_INSTANCE_ID: instanceId,
  };
  for (const key of ["HOME", "USERPROFILE"] as const) {
    const value = env[key]?.trim();
    if (value) {
      derivedEnv[key] = value;
    }
  }
  return derivedEnv;
}

function missingTargetInstanceFilesError(
  instanceId: string,
  missingFiles: string[],
): Error {
  return new Error(
    `instance "${instanceId}" is not initialized for pool verification: missing ${missingFiles.join(" and ")}. Run instance setup first.`,
  );
}

/**
 * Locate and load an existing target instance without allowing resolver
 * fallbacks to initialize files or ambient shell DSNs to win precedence.
 */
export function prepareInstanceVerificationEnv(
  env: NodeJS.ProcessEnv,
  instanceId: string,
): NodeJS.ProcessEnv {
  const targetEnv = deriveInstanceVerificationEnv(env, instanceId);
  const rootDir = resolveNautiloRootDir({ env: targetEnv });
  const instanceJsonPath = join(rootDir, "instance.json");
  const instanceEnvPath = join(rootDir, "instance.env");
  const missingFiles = [
    ...(existsSync(instanceJsonPath) ? [] : ["instance.json"]),
    ...(existsSync(instanceEnvPath) ? [] : ["instance.env"]),
  ];
  if (missingFiles.length > 0) {
    throw missingTargetInstanceFilesError(instanceId, missingFiles);
  }

  const result = loadConfigEnvIntoProcess({ path: instanceEnvPath }, targetEnv);
  if (!result.loaded) {
    throw missingTargetInstanceFilesError(instanceId, ["instance.env"]);
  }
  return targetEnv;
}

export async function verifyPoolLifecycleCmd(
  args: string[],
  opts?: { explicitInstance?: string | undefined },
): Promise<number> {
  if (hasHelpFlag(args)) {
    console.log(formatHelp(VERIFY_POOL_HELP));
    return 0;
  }

  const parsed = parseVerifyPoolLifecycleArgs(args, opts);
  if (!parsed.ok) {
    console.error(parsed.message);
    return parsed.exitCode;
  }

  if (parsed.target.kind === "profile") {
    console.error(
      [
        "Refusing --profile verification in local nautilo-dev.",
        "Run remote deploy profile pool QA on its SSH Docker host.",
        "For local direct postgres.js QA, pass --instance <non-default-name>.",
      ].join("\n"),
    );
    return 2;
  }

  try {
    const instanceEnv = prepareInstanceVerificationEnv(process.env, parsed.target.name);
    return await runVerifyPoolLifecycle(
      { target: parsed.target },
      buildProductionDeps(instanceEnv, (msg) => console.log(msg)),
    );
  } catch (err) {
    console.error(
      `[verify-pool-lifecycle] aborted: ${sanitizePoolLifecycleError(err)}`,
    );
    return 2;
  }
}
