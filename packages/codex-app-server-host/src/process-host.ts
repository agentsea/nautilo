import { spawn } from "node:child_process";
import { createNodeAcpProcessTreeAdapter } from "@nautilo/acp-host";
import type { ManagedChildProcess, ProcessHost, SpawnSpec } from "./contracts";

/** Node/Electron adapter. Tests should inject ProcessHost fakes instead. */
export function createNodeProcessHost(): ProcessHost {
  const processTree = createNodeAcpProcessTreeAdapter();
  return {
    async spawn(spec: SpawnSpec): Promise<ManagedChildProcess> {
      const child = spawn(spec.executablePath, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: spec.detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      await spawned(child);
      if (!child.pid) throw new Error("Codex app-server did not provide a pid");
      const pid = child.pid;
      const signalProcessGroup = (signal: "SIGTERM" | "SIGKILL"): Promise<void> =>
        processTree.signalGroup(pid, signal);
      return Promise.resolve({
        pid,
        // The stable contract name predates detached tool processes. This now
        // proves absence of the complete app-server descendant tree, not only
        // the root process group.
        isProcessGroupGone: async () => {
          // The tree adapter hard-contains every captured group at the TERM
          // edge. Let the owned root reach its exit/reap edge before the
          // negative PGID probe; probing in the same tick can still observe a
          // just-killed process and falsely quarantine a contained profile.
          await rootExitOrGrace(exited, 100);
          return processTree.isGroupAbsent(pid);
        },
        stdio: {
          stdin: {
            write: async (chunk) => { if (!child.stdin.write(chunk)) await onceDrain(child.stdin); },
            end: () => { child.stdin.end(); return Promise.resolve(); },
          },
          stdout: child.stdout,
          stderr: child.stderr,
        },
        exited,
        sendInterrupt: () => signalGroupAsync(pid, "SIGINT", child.kill.bind(child)),
        signalProcessGroup,
      });
    },
  };
}

async function rootExitOrGrace(
  exited: Promise<{ readonly code: number | null; readonly signal: string | null }>,
  graceMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited.then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function spawned(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

/** @internal Exported only for focused adapter contract tests; not part of the package entry points. */
export function signalGroupAsync(
  pid: number,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
  kill: (pid: number, signal: NodeJS.Signals) => boolean = (target, requestedSignal) => process.kill(target, requestedSignal),
): Promise<void> {
  return Promise.resolve().then(() => signalGroup(pid, signal, fallback, kill));
}

function signalGroup(
  pid: number,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
  kill: (pid: number, signal: NodeJS.Signals) => boolean,
): void {
  try {
    // A detached POSIX child starts its own group. The negative pid never
    // targets the parent host, avoiding cross-profile collateral damage.
    kill(-pid, signal);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ESRCH") return;
    if (process.platform === "win32") {
      fallback(signal);
      return;
    }
    throw error;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
