/**
 * M100 Phase 3 — graceful stop for the headless per-instance server (PID file).
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { findListenerPid, looksLikeNautiloServer } from "../lib/listener-pid";

const POLL_MS = 200;
const SIGTERM_WAIT_MS = 5_000;

function parsePidFromFileContent(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

export interface ServerStopDeps {
  readPidFile: () => number | null;
  removePidFile: () => void;
  isProcessAlive: (pid: number) => boolean;
  /** Find an externally-started server via port lookup (lsof). */
  findListenerPid: () => number | null;
  /** Refuses to kill processes whose cmdline doesn't look like nautilo-server. */
  looksLikeNautiloServer: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  log: (s: string) => void;
  warn: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  paths: { pidPath: string; serverUrl: string };
}

async function killAndWait(
  deps: ServerStopDeps,
  pid: number,
): Promise<void> {
  deps.kill(pid, "SIGTERM");
  const deadline = deps.now() + SIGTERM_WAIT_MS;
  while (deps.now() < deadline && deps.isProcessAlive(pid)) {
    await deps.sleep(POLL_MS);
  }
  if (deps.isProcessAlive(pid)) {
    deps.kill(pid, "SIGKILL");
    while (deps.isProcessAlive(pid)) {
      await deps.sleep(POLL_MS);
    }
  }
}

export async function runServerStop(deps: ServerStopDeps): Promise<number> {
  const fromFile = deps.readPidFile();

  if (fromFile !== null && deps.isProcessAlive(fromFile)) {
    await killAndWait(deps, fromFile);
    deps.removePidFile();
    deps.log(`[server:stop] stopped (pid=${fromFile})`);
    return 0;
  }

  if (fromFile !== null && !deps.isProcessAlive(fromFile)) {
    deps.removePidFile();
    // Don't return yet — a different (foreign-launched) server might be
    // running on the same port and the operator still expects "stop" to
    // stop it.
  }

  const fromPort = deps.findListenerPid();
  if (fromPort === null) {
    deps.log(`[server:stop] nothing listening on ${deps.paths.serverUrl}; already stopped`);
    return 0;
  }
  if (!deps.looksLikeNautiloServer(fromPort)) {
    deps.warn(
      `[server:stop] something is listening on ${deps.paths.serverUrl} (pid=${fromPort}) but its command line does not look like nautilo-server — refusing to kill`,
    );
    return 1;
  }

  deps.log(
    `[server:stop] no PID file but found a Nautilo server listening (pid=${fromPort}); stopping it`,
  );
  await killAndWait(deps, fromPort);
  deps.removePidFile();
  deps.log(`[server:stop] stopped (pid=${fromPort})`);
  return 0;
}

function defaultReadPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const n = parsePidFromFileContent(readFileSync(pidPath, "utf8"));
    if (n === null) {
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
    return n;
  } catch {
    return null;
  }
}

function defaultRemovePid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

export async function serverStop(): Promise<number> {
  const rootDir = resolveNautiloRootDir();
  const inst = resolveInstance();
  const pidPath = join(rootDir, "server.pid");
  return runServerStop({
    paths: { pidPath, serverUrl: inst.server.url },
    readPidFile: () => defaultReadPid(pidPath),
    removePidFile: () => defaultRemovePid(pidPath),
    isProcessAlive: defaultIsProcessAlive,
    findListenerPid: () => findListenerPid(inst.server.port),
    looksLikeNautiloServer,
    kill: (p, sig) => {
      try {
        process.kill(p, sig);
      } catch {
        /* ignore */
      }
    },
    log: (s) => {
      console.log(s);
    },
    warn: (s) => {
      console.warn(s);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
}
