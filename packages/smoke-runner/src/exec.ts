/**
 * Child-process exec with timeout + stdout/stderr capture.
 *
 * Used by the VM drivers (LimaDriver, TartDriver) to invoke limactl /
 * tart / ssh commands and by the Runner to call nautilo-smoke's own
 * honeypot.sh inside the guest.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface RunCommandOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly input?: string; // piped to stdin
}

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Run `cmd` with the given args. Captures stdout/stderr. Enforces a
 * wall-clock timeout (default 30s). Never throws; failures surface as
 * non-zero exitCode + timedOut flags.
 */
export async function runCommand(
  cmd: string,
  args: readonly string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  return new Promise<RunCommandResult>((resolve) => {
    const spawnOpts: SpawnOptions = {
      env: opts.env
        ? { ...process.env, ...opts.env }
        : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // detached lets us kill the whole process group on timeout.
      // Critical for `limactl shell` which spawns ssh children that
      // would otherwise orphan and hold stdio open, preventing 'close'.
      detached: true,
    };
    if (opts.cwd !== undefined) {
      spawnOpts.cwd = opts.cwd;
    }

    const child = spawn(cmd, args, spawnOpts);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (result: RunCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const killProcessGroup = (): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // best effort
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
      // Don't wait for 'close' — limactl's orphaned ssh children can hold
      // stdio open for several more seconds after SIGKILL. Settle the
      // promise now with the stdout/stderr we've captured; the kernel
      // will reap the remnants.
      settle({
        stdout,
        stderr,
        exitCode: 124, // GNU timeout convention
        durationMs: Date.now() - startedAt,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : -1),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}
