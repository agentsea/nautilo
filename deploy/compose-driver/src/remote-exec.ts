import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { ExecFn, ExecResult } from "./ComposeDriver.ts";
import type { ComposeDriverProfile, SshProfile } from "./types.ts";

export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9._:/=@%+-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

/**
 * Return host-key verification flags for SSH-backed transports. Profiles
 * without a dedicated known_hosts file retain their historical SSH behavior.
 */
export function buildSshHostKeyArgs(ssh: SshProfile): string[] {
  if (ssh.known_hosts_file === undefined) return [];
  return [
    "-o",
    `UserKnownHostsFile=${expandTilde(ssh.known_hosts_file)}`,
    "-o",
    "StrictHostKeyChecking=yes",
  ];
}

export function buildSshArgs(
  ssh: SshProfile,
  cmd: string,
  args: string[],
): string[] {
  const port = ssh.port ?? 22;
  const identity =
    ssh.identity_file !== undefined ? expandTilde(ssh.identity_file) : undefined;
  const remoteCmd = [cmd, ...args].map(shellQuote).join(" ");
  const sshArgs: string[] = [
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
  ];
  sshArgs.push(...buildSshHostKeyArgs(ssh));
  if (identity !== undefined) sshArgs.push("-i", identity);
  sshArgs.push(`${ssh.user}@${ssh.host}`, "--", remoteCmd);
  return sshArgs;
}

export function createRemoteExec(profile: ComposeDriverProfile): ExecFn {
  if (profile.transport !== "remote" || profile.ssh === undefined) {
    throw new Error(
      `createRemoteExec requires transport="remote" with an ssh block (profile=${profile.name})`,
    );
  }
  const ssh = profile.ssh;

  return async (cmd, args, opts) => {
    const dockerHost = opts.env?.["DOCKER_HOST"];
    if (typeof dockerHost === "string" && dockerHost.startsWith("ssh://")) {
      return runLocal(cmd, args, opts);
    }

    return runLocal("ssh", buildSshArgs(ssh, cmd, args), opts);
  };
}

export function runLocal(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "pipe";
    stdin?: string;
  },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdin !== undefined
        ? ["pipe", "pipe", "pipe"]
        : opts.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let inputFailed = false;
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => resolve(inputFailed
      ? { code: 1, stdout: "", stderr: "Process input could not be delivered" }
      : { code: code ?? 1, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: stderr + String(err) }),
    );
    if (opts.stdin !== undefined) {
      // A consumer can exit before reading all input. Handle EPIPE and fail
      // closed instead of an unhandled stream error or silent partial write.
      child.stdin?.on("error", () => { inputFailed = true; });
      child.stdin?.end(opts.stdin);
    }
  });
}
