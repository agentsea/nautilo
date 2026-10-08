import { spawn } from "node:child_process";
import { spawnTerminalPty } from "./terminal-host";

/** Immutable command prepared by Desktop's existing contained admission. */
export interface PreparedLocalExecution {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exact sandbox environment. Parent inheritance is never supported here. */
  readonly env: Readonly<Record<string, string>>;
  readonly dispose: () => void | Promise<void>;
}

export interface LocalProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly failureCode?: string;
}

export interface LocalExecutionProcess {
  readonly pid: number | null;
  /** Settles only after the adapter has received the final output. */
  readonly exited: Promise<LocalProcessExit>;
  write(chars: string): void;
  terminate(): void;
}

export type LocalExecutionSpawner = (
  prepared: PreparedLocalExecution,
  tty: boolean,
  onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => void,
) => LocalExecutionProcess;

function groupIsAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}

function terminateGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // macOS can reject a signal while an already killed group is disappearing.
    // Only a separate, non-destructive absence check can resolve that ambiguity.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !groupIsAbsent(pid)) throw error;
  }
}

/**
 * Both adapters run the same complete argv under the same prepared environment.
 * The process group is the supported ownership boundary. Deliberately detached
 * descendants or commands that transfer work to another service are unsupported.
 */
export const spawnLocalExecutionProcess: LocalExecutionSpawner = (prepared, tty, onOutput) => {
  if (process.platform === "win32") throw new Error("LOCAL_EXECUTION_PLATFORM_UNSUPPORTED");
  if (prepared.env === null || prepared.env === undefined) {
    throw new Error("LOCAL_EXECUTION_ENV_REQUIRED");
  }
  // Preparation excludes account projection. Keep an independent guard at the
  // last spawn seam against regression to the old GitHub-token injection lane.
  for (const key of Object.keys(prepared.env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key)) {
      throw new Error("LOCAL_EXECUTION_CREDENTIAL_ENV_DENIED");
    }
  }
  if (tty) {
    const pty = spawnTerminalPty(prepared.program, [...prepared.args], {
      cwd: prepared.cwd,
      env: { ...prepared.env },
      name: "xterm-color",
    });
    let finished = false;
    let cleanupFailed = false;
    const outputSubscription = pty.onData((data) => onOutput("stdout", Buffer.from(data, "utf8")));
    const exited = new Promise<LocalProcessExit>((resolve) => {
      const exitSubscription = pty.onExit(({ exitCode, signal }) => {
        // node-pty emits exit after draining its terminal stream. Closing the
        // command also ends any remaining members of this owned process group.
        try { terminateGroup(pty.pid); } catch { cleanupFailed = true; }
        finished = true;
        outputSubscription.dispose();
        exitSubscription.dispose();
        resolve({
          exitCode,
          signal: signal === undefined || signal === 0 ? null : String(signal),
          ...(cleanupFailed ? { failureCode: "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED" } : {}),
        });
      });
    });
    return {
      pid: pty.pid,
      exited,
      write(chars) {
        if (finished) throw new Error("LOCAL_EXECUTION_STDIN_CLOSED");
        pty.write(chars);
      },
      terminate() {
        if (!finished) terminateGroup(pty.pid);
      },
    };
  }

  const child = spawn(prepared.program, [...prepared.args], {
    cwd: prepared.cwd,
    env: { ...prepared.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let finished = false;
  let groupCleanupUnconfirmed = false;
  let failureCode: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => onOutput("stderr", chunk));
  child.stdout.on("error", () => { failureCode = "LOCAL_EXECUTION_OUTPUT_DRAIN_FAILED"; });
  child.stderr.on("error", () => { failureCode = "LOCAL_EXECUTION_OUTPUT_DRAIN_FAILED"; });
  const exited = new Promise<LocalProcessExit>((resolve) => {
    child.once("error", () => { failureCode = "LOCAL_EXECUTION_SPAWN_FAILED"; });
    child.once("exit", () => {
      // A shell may exit while a background child still owns a pipe. End the
      // owned group now, then wait for close to drain every captured stream.
      if (child.pid !== undefined) {
        try { terminateGroup(child.pid); } catch { groupCleanupUnconfirmed = true; }
      }
    });
    child.once("close", (exitCode, signal) => {
      // Exit can precede both output drain and the disappearance of killed
      // descendants. Never signal the group again after reaping its leader;
      // check only for conclusive absence at this existing settlement boundary.
      if (groupCleanupUnconfirmed && child.pid !== undefined && !groupIsAbsent(child.pid)) {
        failureCode = "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED";
      }
      finished = true;
      resolve({ exitCode, signal, ...(failureCode === undefined ? {} : { failureCode }) });
    });
  });
  return {
    pid: child.pid ?? null,
    exited,
    write() { throw new Error("LOCAL_EXECUTION_STDIN_REQUIRES_PTY"); },
    terminate() {
      if (!finished && child.pid !== undefined) terminateGroup(child.pid);
    },
  };
};
