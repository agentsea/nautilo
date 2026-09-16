import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

import { runBootstrap as defaultRunBootstrap } from "@nautilo/local/bootstrap-logto";

import {
  ComposeDriver,
  type ComposeDriverDeps,
  type CreateComposeDriverOptions,
  type ExecFn,
} from "./ComposeDriver.ts";
import {
  defaultStagingRoot,
  localInstanceRootDir,
  remoteInstanceRootDir,
  resolveRemoteBaseDir,
} from "./instance-paths.ts";
import { createRemoteExec } from "./remote-exec.ts";
import { createRemoteFs } from "./remote-fs.ts";
import { dockerEnvForProfile, dockerHostFor, wrapWithDockerHost } from "./wrap-docker-host.ts";
import type { ComposeDriverProfile } from "./types.ts";

export function createRemoteComposeDriver(
  profile: ComposeDriverProfile,
  options: CreateComposeDriverOptions,
): ComposeDriver {
  if (profile.transport !== "remote" || profile.ssh === undefined) {
    throw new Error(
      `createRemoteComposeDriver: requires transport="remote" + ssh block (got transport=${profile.transport})`,
    );
  }
  const home = options.operatorHome ?? (process.env["HOME"]?.trim() || homedir());
  const stagingRoot = defaultStagingRoot({ home, instance_id: profile.instance_id });
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  // Pick the remote base dir: explicit `remote_path` wins; else default
  // by SSH user (root → /opt/nautilo, non-root → <remote $HOME>/nautilo).
  const remoteBase =
    profile.remote_path !== undefined && profile.remote_path.trim() !== ""
      ? profile.remote_path
      : resolveRemoteBaseDir(profile.ssh);
  const remoteRoot = remoteInstanceRootDir({
    remote_path: remoteBase,
    instance_id: profile.instance_id,
  });

  const remoteExec = createRemoteExec(profile);
  const remoteFs = createRemoteFs(profile, {
    stagingRoot,
    remoteInstanceRoot: remoteRoot,
  });
  const dockerHost = dockerHostFor(profile);
  const exec: ExecFn = wrapWithDockerHost(
    remoteExec,
    dockerHost,
    undefined,
    (baseEnv) => dockerEnvForProfile(profile, baseEnv).env ?? baseEnv,
  );

  const deps: ComposeDriverDeps = {
    exec,
    fetch: globalThis.fetch.bind(globalThis),
    runBootstrap: defaultRunBootstrap,
    fs: remoteFs,
    now: () => new Date(),
    templateDir: options.templateDir,
    resolveInstanceRootDir: () => remoteRoot,
    resolveLocalInstanceRootDir: (targetProfile) =>
      localInstanceRootDir(home, targetProfile.instance_id),
  };
  if (options.composeBin !== undefined) deps.composeBin = options.composeBin;
  if (options.composeArgs !== undefined) deps.composeArgs = options.composeArgs;
  if (options.firstDeployConsume !== undefined) {
    deps.firstDeployConsume = options.firstDeployConsume;
  }
  if (options.log !== undefined) deps.log = options.log;
  if (options.ensureBootstrapToken !== undefined) {
    deps.ensureBootstrapToken = (targetProfile) =>
      options.ensureBootstrapToken!(targetProfile, home);
  }
  if (options.resolveSourceBuildSha !== undefined) {
    deps.resolveSourceBuildSha = options.resolveSourceBuildSha;
  }
  if (options.doctor !== undefined) {
    deps.doctor = options.doctor;
  }
  deps.enableDependencyRefresh = options.enableDependencyRefresh ?? true;
  return new ComposeDriver(deps);
}
