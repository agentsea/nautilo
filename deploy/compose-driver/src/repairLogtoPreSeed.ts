import { shellQuote } from "./remote-exec.ts";
import {
  buildRemoteComposeExecInvocation,
  type RemoteComposeOverlayFlags,
  type RemoteComposeProfileName,
} from "./remote-compose-command.ts";

export const LOGTO_POSTGRES_SERVICE = "logto-postgres" as const;

/** psql flags for postgres-admin Logto pre-seed recovery inside logto-postgres. */
export const LOGTO_PRESEED_PSQL_FLAGS =
  "-U postgres -d logto_nautilo -v ON_ERROR_STOP=1" as const;

export type LogtoPreSeedRecoverySqlProvider = () => string;

export type LogtoPreSeedRecoveryContext =
  | {
      transport: "local_compose";
      composeBin: string;
      composeArgs: readonly string[];
      /** Compose argv before the verb (`up`, `exec`, …): project name, `-f`, env-file, profiles. */
      composeProjectArgs: readonly string[];
    }
  | {
      transport: "remote_ssh";
      remoteRoot: string;
      projectName: string;
      overlays: RemoteComposeOverlayFlags;
      profiles: readonly RemoteComposeProfileName[];
    }
  | {
      transport: "staged_compose";
      /** Prefix ending with a trailing space (from `dbExecPrefix` or equivalent). */
      execPrefix: string;
    };

export type RunLogtoPreSeedRecoveryDeps = {
  exec: (
    cmd: string,
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  getLogtoPreSeedRecoverySql: LogtoPreSeedRecoverySqlProvider;
  log?: (msg: string) => void;
};

export function buildLocalLogtoPostgresExecPrefix(
  composeBin: string,
  composeArgs: readonly string[],
  composeProjectArgs: readonly string[],
): string {
  return (
    `${composeBin} ${[...composeArgs, ...composeProjectArgs].join(" ")} ` +
    `exec -T ${LOGTO_POSTGRES_SERVICE} `
  );
}

export function buildLogtoPreSeedRecoveryShellPipeline(
  execPrefix: string,
  sql: string,
): string {
  return `printf %s ${shellQuote(sql)} | ${execPrefix}psql ${LOGTO_PRESEED_PSQL_FLAGS}`;
}

export function buildLogtoPreSeedRecoveryPipeline(
  ctx: LogtoPreSeedRecoveryContext,
  sql: string,
): string {
  const execPrefix = (() => {
    switch (ctx.transport) {
      case "local_compose":
        return buildLocalLogtoPostgresExecPrefix(
          ctx.composeBin,
          ctx.composeArgs,
          ctx.composeProjectArgs,
        );
      case "remote_ssh":
        return buildRemoteComposeExecInvocation({
          remoteRoot: ctx.remoteRoot,
          projectName: ctx.projectName,
          overlays: ctx.overlays,
          profiles: ctx.profiles,
          service: LOGTO_POSTGRES_SERVICE,
        });
      case "staged_compose":
        return ctx.execPrefix;
      default: {
        const _exhaustive: never = ctx;
        throw new Error(
          `unsupported Logto pre-seed recovery transport: ${String(_exhaustive)}`,
        );
      }
    }
  })();
  return buildLogtoPreSeedRecoveryShellPipeline(execPrefix, sql);
}

/**
 * Run Logto pre-seed recovery as the postgres superuser inside
 * `logto-postgres`. Never logs connection strings or secrets.
 */
export async function runLogtoPreSeedRecovery(
  ctx: LogtoPreSeedRecoveryContext,
  deps: RunLogtoPreSeedRecoveryDeps,
): Promise<void> {
  const sql = deps.getLogtoPreSeedRecoverySql();
  deps.log?.(
    "Logto pre-seed recovery: checking orphaned tenant roles inside logto-postgres...",
  );
  const pipeline = buildLogtoPreSeedRecoveryPipeline(ctx, sql);
  deps.log?.(
    "Logto pre-seed recovery: executing psql inside logto-postgres (postgres admin, no credentials logged)",
  );
  const result = await deps.exec("sh", ["-c", pipeline], { stdio: "pipe" });
  if (result.code !== 0) {
    throw new Error(
      `Logto pre-seed recovery failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
}
