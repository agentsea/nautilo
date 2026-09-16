import { shellQuote } from "./remote-exec.ts";
import {
  buildRemoteComposeExecInvocation,
  type RemoteComposeOverlayFlags,
  type RemoteComposeProfileName,
} from "./remote-compose-command.ts";

export const APP_POSTGRES_SERVICE = "app-postgres" as const;

/** psql flags for postgres-admin repair inside the app-postgres container. */
export const APP_DB_REPAIR_PSQL_FLAGS =
  "-U postgres -d nautilo -v ON_ERROR_STOP=1" as const;

export type AppDbRepairSqlProvider = () => string;

export type AppDbRepairContext =
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

export type RunAppDbRepairDeps = {
  exec: (
    cmd: string,
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  getAppDbRepairSql: AppDbRepairSqlProvider;
  log?: (msg: string) => void;
};

export function buildLocalComposeExecPrefix(
  composeBin: string,
  composeArgs: readonly string[],
  composeProjectArgs: readonly string[],
): string {
  return (
    `${composeBin} ${[...composeArgs, ...composeProjectArgs].join(" ")} ` +
    `exec -T ${APP_POSTGRES_SERVICE} `
  );
}

export function buildAppDbRepairShellPipeline(
  execPrefix: string,
  sql: string,
): string {
  return `printf %s ${shellQuote(sql)} | ${execPrefix}psql ${APP_DB_REPAIR_PSQL_FLAGS}`;
}

export function buildAppDbRepairPipeline(
  ctx: AppDbRepairContext,
  sql: string,
): string {
  const execPrefix = (() => {
    switch (ctx.transport) {
      case "local_compose":
        return buildLocalComposeExecPrefix(
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
          service: APP_POSTGRES_SERVICE,
        });
      case "staged_compose":
        return ctx.execPrefix;
      default: {
        const _exhaustive: never = ctx;
        throw new Error(`unsupported app DB repair transport: ${String(_exhaustive)}`);
      }
    }
  })();
  return buildAppDbRepairShellPipeline(execPrefix, sql);
}

/**
 * Run canonical M212 ownership/grant repair as the postgres superuser inside
 * `app-postgres`. Never logs connection strings or secrets.
 */
export async function runAppDbRepair(
  ctx: AppDbRepairContext,
  deps: RunAppDbRepairDeps,
): Promise<void> {
  const sql = deps.getAppDbRepairSql();
  deps.log?.(
    "app DB repair: applying ownership/grant SQL as postgres inside app-postgres...",
  );
  const pipeline = buildAppDbRepairPipeline(ctx, sql);
  deps.log?.(
    "app DB repair: executing psql inside app-postgres (postgres admin, no credentials logged)",
  );
  const result = await deps.exec("sh", ["-c", pipeline], { stdio: "pipe" });
  if (result.code !== 0) {
    throw new Error(
      `app DB ownership/grant repair failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
}
