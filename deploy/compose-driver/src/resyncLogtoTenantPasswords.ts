import { shellQuote } from "./remote-exec.ts";
import {
  buildRemoteComposeExecInvocation,
  type RemoteComposeOverlayFlags,
  type RemoteComposeProfileName,
} from "./remote-compose-command.ts";
import { LOGTO_POSTGRES_SERVICE, LOGTO_PRESEED_PSQL_FLAGS } from "./repairLogtoPreSeed.ts";

export type LogtoTenantPasswordResyncSqlProvider = () => string;

export type LogtoTenantPasswordResyncContext =
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

export type RunLogtoTenantPasswordResyncDeps = {
  exec: (
    cmd: string,
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  getLogtoTenantPasswordResyncSql: LogtoTenantPasswordResyncSqlProvider;
  log?: (msg: string) => void;
};

function buildLocalLogtoPostgresExecPrefix(
  composeBin: string,
  composeArgs: readonly string[],
  composeProjectArgs: readonly string[],
): string {
  return (
    `${composeBin} ${[...composeArgs, ...composeProjectArgs].join(" ")} ` +
    `exec -T ${LOGTO_POSTGRES_SERVICE} `
  );
}

export function buildLogtoTenantPasswordResyncShellPipeline(
  execPrefix: string,
  sql: string,
): string {
  return `printf %s ${shellQuote(sql)} | ${execPrefix}psql ${LOGTO_PRESEED_PSQL_FLAGS}`;
}

export function buildLogtoTenantPasswordResyncPipeline(
  ctx: LogtoTenantPasswordResyncContext,
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
          `unsupported Logto tenant password resync transport: ${String(_exhaustive)}`,
        );
      }
    }
  })();
  return buildLogtoTenantPasswordResyncShellPipeline(execPrefix, sql);
}

/**
 * Idempotent preflight: resync Logto tenant role passwords from
 * `public.tenants` as the postgres superuser inside `logto-postgres`.
 * Never logs SQL or passwords.
 */
export async function runLogtoTenantPasswordResync(
  ctx: LogtoTenantPasswordResyncContext,
  deps: RunLogtoTenantPasswordResyncDeps,
): Promise<void> {
  const sql = deps.getLogtoTenantPasswordResyncSql();
  deps.log?.(
    "Logto tenant password resync: syncing cluster roles from public.tenants inside logto-postgres...",
  );
  const pipeline = buildLogtoTenantPasswordResyncPipeline(ctx, sql);
  deps.log?.(
    "Logto tenant password resync: executing psql inside logto-postgres (postgres admin, no credentials logged)",
  );
  const result = await deps.exec("sh", ["-c", pipeline], { stdio: "pipe" });
  if (result.code !== 0) {
    throw new Error(
      `Logto tenant password resync failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
}
