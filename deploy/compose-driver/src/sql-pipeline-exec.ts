import type { ExecFn } from "./ComposeDriver.ts";
import type { ComposeDriverProfile } from "./types.ts";
import { dockerEnvForProfile as dockerTransportEnvForProfile } from "./wrap-docker-host.ts";

/** Remote transport with operator-side compose inputs (`from_source !== false`). */
export function usesRemoteSourceMode(profile: ComposeDriverProfile): boolean {
  return profile.transport === "remote" && profile.from_source !== false;
}

function dockerEnvForProfile(
  profile: ComposeDriverProfile,
): { env?: NodeJS.ProcessEnv } {
  return dockerTransportEnvForProfile(profile);
}

/**
 * ExecFn for `sh -c` SQL pipelines that embed `docker compose exec`.
 *
 * - **remote-source** — local shell + `DOCKER_HOST` (same as `runCompose` /
 *   source restore `runPipeline`); compose `-f` / `--env-file` paths stay
 *   operator-local.
 * - **local** — `localExec` without `DOCKER_HOST` (matches restore
 *   `runPipeline`).
 * - **remote registry** — caller uses `remote_ssh` transport with `exec`
 *   (SSH-native); this returns `exec` for any non-source-remote edge cases.
 */
export function sqlPipelineExecForProfile(
  profile: ComposeDriverProfile,
  deps: { exec: ExecFn; localExec: ExecFn },
): ExecFn {
  if (usesRemoteSourceMode(profile)) {
    const dockerEnv = dockerEnvForProfile(profile);
    return (cmd, args, opts) =>
      deps.localExec(cmd, args, {
        ...opts,
        env: { ...(opts.env ?? process.env), ...dockerEnv.env },
      });
  }
  if (profile.transport === "local") {
    return deps.localExec;
  }
  return deps.exec;
}
