import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

import { buildSshHostKeyArgs, expandTilde } from "./remote-exec.ts";
import type { SshProfile } from "./types.ts";

export interface PortForward {
  local: number;
  remoteHost: string;
  remote: number;
}

export interface SshTunnelHandle {
  close(): Promise<void>;
}

export interface OpenSshTunnelOptions {
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
  probePort?: (port: number) => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function openSshTunnel(
  ssh: SshProfile,
  forwards: PortForward[],
  options: OpenSshTunnelOptions = {},
): Promise<SshTunnelHandle> {
  const port = ssh.port ?? 22;
  const identity =
    ssh.identity_file !== undefined ? expandTilde(ssh.identity_file) : undefined;
  const spawnFn =
    options.spawnFn ?? ((c, a) => spawn(c, a, { stdio: ["ignore", "pipe", "pipe"] }));
  const probe = options.probePort ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.pollIntervalMs ?? 300;

  const args: string[] = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-p",
    String(port),
  ];
  args.push(...buildSshHostKeyArgs(ssh));
  if (identity !== undefined) args.push("-i", identity);
  for (const f of forwards) {
    args.push("-L", `${f.local}:${f.remoteHost}:${f.remote}`);
  }
  args.push(`${ssh.user}@${ssh.host}`);

  const child = spawnFn("ssh", args);
  let exited = false;
  let exitErr: Error | undefined;
  child.on("exit", (code, signal) => {
    exited = true;
    if (code !== 0 && code !== null) {
      exitErr = new Error(
        `ssh tunnel exited early (code ${code}, signal ${signal ?? "none"})`,
      );
    }
  });
  child.on("error", (err) => {
    exited = true;
    exitErr = err instanceof Error ? err : new Error(String(err));
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw exitErr ?? new Error("ssh tunnel exited before forwards bound");
    }
    const all = await Promise.all(forwards.map((f) => probe(f.local)));
    if (all.every((ok) => ok)) {
      return {
        async close(): Promise<void> {
          if (exited) return;
          child.kill("SIGTERM");
          await new Promise<void>((res) => {
            if (exited) {
              res();
              return;
            }
            child.once("exit", () => res());
            setTimeout(() => res(), 2000);
          });
        },
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  child.kill("SIGTERM");
  throw new Error(`ssh tunnel: ports did not bind within ${timeoutMs}ms`);
}

function defaultProbe(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        // best-effort; the socket may already be torn down
      }
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 250);
  });
}
