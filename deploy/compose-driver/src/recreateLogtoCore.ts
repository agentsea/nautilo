import {
  buildRemoteComposeCommand,
  type RemoteComposeCommandRequest,
  type RemoteComposeOverlayFlags,
  type RemoteComposeProfileName,
} from "./remote-compose-command.ts";

/** Logto OSS core service (not logto-postgres). */
export const LOGTO_CORE_SERVICE = "logto" as const;

export type LogtoCoreRecreateContext =
  | {
      transport: "local_compose";
      composeBin: string;
      composeArgs: readonly string[];
      /** Compose argv before the verb (`up`, `exec`, …): project name, `-f`, env-file, profiles. */
      composeProjectArgs: readonly string[];
      /** Registry-mode deploys must not rebuild during recreate. */
      registryMode?: boolean | undefined;
    }
  | {
      transport: "remote_ssh";
      remoteRoot: string;
      projectName: string;
      overlays: RemoteComposeOverlayFlags;
      profiles: readonly RemoteComposeProfileName[];
    };

export type RunLogtoCoreRecreateDeps = {
  exec: (
    cmd: string,
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  log?: (msg: string) => void;
};

/** Remote compose request: recreate only Logto core, never logto-postgres. */
export function buildRemoteLogtoCoreRecreateRequest(): RemoteComposeCommandRequest {
  return {
    verb: "up",
    service: LOGTO_CORE_SERVICE,
    noBuild: true,
    noDeps: true,
    forceRecreate: true,
  };
}

export function buildLocalLogtoCoreRecreateArgs(
  composeArgs: readonly string[],
  composeProjectArgs: readonly string[],
  opts?: { registryMode?: boolean | undefined },
): string[] {
  return [
    ...composeArgs,
    ...composeProjectArgs,
    "up",
    "-d",
    ...(opts?.registryMode === true ? ["--no-build"] : []),
    "--force-recreate",
    "--no-deps",
    LOGTO_CORE_SERVICE,
  ];
}

/**
 * Recreate the Logto core container after auth-profile up so tenant pool
 * config picks up password resync changes. Never touches logto-postgres.
 */
export async function runLogtoCoreRecreate(
  ctx: LogtoCoreRecreateContext,
  deps: RunLogtoCoreRecreateDeps,
): Promise<void> {
  deps.log?.(
    "Logto core recreate: refreshing logto container after tenant password resync (logto-postgres untouched)...",
  );

  switch (ctx.transport) {
    case "local_compose": {
      const args = buildLocalLogtoCoreRecreateArgs(
        ctx.composeArgs,
        ctx.composeProjectArgs,
        { registryMode: ctx.registryMode },
      );
      const result = await deps.exec(ctx.composeBin, args, { stdio: "inherit" });
      if (result.code !== 0) {
        throw new Error(
          `Logto core recreate failed (exit ${result.code}): ${result.stderr.trim()}`,
        );
      }
      return;
    }
    case "remote_ssh": {
      const built = buildRemoteComposeCommand({
        remoteRoot: ctx.remoteRoot,
        projectName: ctx.projectName,
        overlays: ctx.overlays,
        profiles: ctx.profiles,
        request: buildRemoteLogtoCoreRecreateRequest(),
      });
      const result = await deps.exec(built.command, [...built.args], {
        stdio: "inherit",
      });
      if (result.code !== 0) {
        throw new Error(
          `Logto core recreate failed (exit ${result.code}): ${result.stderr.trim()}`,
        );
      }
      return;
    }
    default: {
      const _exhaustive: never = ctx;
      throw new Error(
        `unsupported Logto core recreate transport: ${String(_exhaustive)}`,
      );
    }
  }
}
