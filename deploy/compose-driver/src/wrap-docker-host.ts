import { spawnSync } from "node:child_process";

import type { ExecFn } from "./ComposeDriver.ts";
import { expandTilde, runLocal } from "./remote-exec.ts";
import type { ComposeDriverProfile } from "./types.ts";

interface SyncProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DockerSshAgentManagerDeps {
  run: (
    cmd: string,
    args: string[],
    opts: { encoding?: BufferEncoding; env?: NodeJS.ProcessEnv },
  ) => SyncProcessResult;
  registerExit: (handler: () => void) => void;
}

export interface DockerSshAgentManager {
  envForIdentity: (
    identity: string,
    baseEnv: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
  dispose: () => void;
}

export function createDockerSshAgentManager(
  deps: DockerSshAgentManagerDeps = {
    run: (cmd, args, opts) =>
      spawnSync(cmd, args, opts) as unknown as SyncProcessResult,
    registerExit: (handler) => {
      process.once("exit", handler);
    },
  },
): DockerSshAgentManager {
  const agents = new Map<string, NodeJS.ProcessEnv>();
  let exitRegistered = false;

  const dispose = () => {
    for (const agentEnv of agents.values()) {
      deps.run("ssh-agent", ["-k"], {
        env: { ...process.env, ...agentEnv },
      });
    }
    agents.clear();
  };

  return {
    envForIdentity(identity, baseEnv) {
      const key = expandTilde(identity);
      const cached = agents.get(key);
      if (cached !== undefined) return cached;

      const agent = deps.run("ssh-agent", ["-s"], { encoding: "utf8" });
      const socket = agent.stdout.match(/SSH_AUTH_SOCK=([^;]+);/u)?.[1];
      const pid = agent.stdout.match(/SSH_AGENT_PID=([0-9]+);/u)?.[1];
      if (agent.status !== 0 || socket === undefined || pid === undefined) {
        throw new Error(
          `Could not start ssh-agent for Docker SSH transport: ${
            agent.stderr.trim() || "invalid ssh-agent output"
          }`,
        );
      }

      const agentEnv = { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid };
      const added = deps.run("ssh-add", [key], {
        encoding: "utf8",
        env: { ...baseEnv, ...agentEnv },
      });
      if (added.status !== 0) {
        deps.run("ssh-agent", ["-k"], {
          env: { ...baseEnv, ...agentEnv },
        });
        throw new Error(
          `Could not load ssh.identity_file into ssh-agent for Docker: ${
            added.stderr.trim() || "ssh-add failed"
          }`,
        );
      }

      agents.set(key, agentEnv);
      if (!exitRegistered) {
        deps.registerExit(dispose);
        exitRegistered = true;
      }
      return agentEnv;
    },
    dispose,
  };
}

const defaultDockerSshAgentManager = createDockerSshAgentManager();

/**
 * Docker's ssh:// transport invokes ssh itself and has no IdentityFile URL.
 * It does honor SSH_AUTH_SOCK, so load the configured private key into a
 * process-local agent and pass that agent only to Docker invocations.
 */
export function dockerEnvForProfile(
  profile: ComposeDriverProfile,
  baseEnv: NodeJS.ProcessEnv = process.env,
  agentManager: DockerSshAgentManager = defaultDockerSshAgentManager,
): { env?: NodeJS.ProcessEnv } {
  if (profile.transport !== "remote" || profile.ssh === undefined) return {};
  const env = { ...baseEnv, DOCKER_HOST: dockerHostFor(profile) };
  const identity = profile.ssh.identity_file;
  if (identity === undefined) return { env };

  const agentEnv = agentManager.envForIdentity(identity, baseEnv);
  return {
    env: {
      ...env,
      ...agentEnv,
    },
  };
}

/** Build the DOCKER_HOST=ssh://... string for a remote profile. */
export function dockerHostFor(profile: ComposeDriverProfile): string {
  if (profile.transport !== "remote" || profile.ssh === undefined) {
    throw new Error(
      `dockerHostFor: requires transport="remote" with ssh block (got ${profile.transport})`,
    );
  }
  const ssh = profile.ssh;
  const port = ssh.port ?? 22;
  if (port === 22) return `ssh://${ssh.user}@${ssh.host}`;
  return `ssh://${ssh.user}@${ssh.host}:${port}`;
}

/**
 * Wraps an ExecFn so that `docker` commands always run LOCALLY with
 * DOCKER_HOST set (the local docker CLI talks to the remote daemon
 * over SSH). Non-docker commands fall through to the inner exec —
 * which, for a remote driver, is `createRemoteExec(profile)` (ssh-
 * wraps them onto the droplet).
 */
export function wrapWithDockerHost(
  inner: ExecFn,
  dockerHost: string,
  localExec?: ExecFn,
  dockerEnv?: (baseEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): ExecFn {
  const local = localExec ?? runLocal;
  return async (cmd, args, opts) => {
    if (cmd === "docker") {
      const baseEnv = opts.env ?? process.env;
      const env = dockerEnv?.(baseEnv) ?? { ...baseEnv, DOCKER_HOST: dockerHost };
      return local(cmd, args, { ...opts, env });
    }
    return inner(cmd, args, opts);
  };
}
