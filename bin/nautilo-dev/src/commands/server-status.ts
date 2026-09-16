/**
 * M100 Phase 3 — compact status for the headless per-instance server.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { findListenerPid, looksLikeNautiloServer } from "../lib/listener-pid";

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

export interface ServerStatusDeps {
  readPidFile: () => number | null;
  isProcessAlive: (pid: number) => boolean;
  findListenerPid: () => number | null;
  looksLikeNautiloServer: (pid: number) => boolean;
  fetchHealthLabel: () => Promise<string>;
  fetchSetupState: () => Promise<string>;
  log: (s: string) => void;
  warn: (s: string) => void;
  paths: { pidPath: string; logPath: string; serverUrl: string };
}

export async function runServerStatus(deps: ServerStatusDeps): Promise<number> {
  const { paths } = deps;
  const pidFromFile = deps.readPidFile();
  const managedAlive =
    pidFromFile !== null && deps.isProcessAlive(pidFromFile);

  // Probe /health regardless of PID-file state — that's the source of
  // truth for "is something serving requests right now".
  const health = await deps.fetchHealthLabel();
  const reachable = health !== "(unreachable)";

  if (managedAlive) {
    const setupState = await deps.fetchSetupState();
    deps.log("[server:status] running");
    deps.log(`  pid : ${pidFromFile}`);
    deps.log(`  url : ${paths.serverUrl}`);
    deps.log(`  health : ${health}`);
    deps.log(`  setupState : ${setupState}`);
    deps.log(`  log : ${paths.logPath}`);
    return 0;
  }

  if (pidFromFile !== null && !managedAlive) {
    deps.warn(`[server:status] stale PID file at ${paths.pidPath} (pid=${pidFromFile} not running)`);
  }

  if (!reachable) {
    deps.log("[server:status] not running");
    deps.log(`  url : ${paths.serverUrl}`);
    deps.log("  pid : (none)");
    deps.log(`  log : ${paths.logPath}`);
    return 1;
  }

  // /health is responding but no managed PID — surface the foreign
  // listener so the operator knows where to point their tooling.
  const listenerPid = deps.findListenerPid();
  if (listenerPid !== null && deps.looksLikeNautiloServer(listenerPid)) {
    const setupState = await deps.fetchSetupState();
    deps.log("[server:status] running (foreign — not managed by server:start)");
    deps.log(`  pid : ${listenerPid}`);
    deps.log(`  url : ${paths.serverUrl}`);
    deps.log(`  health : ${health}`);
    deps.log(`  setupState : ${setupState}`);
    deps.log(`  log : ${paths.logPath}`);
    deps.log("  hint : run `bun run server:start` to claim it (writes the PID file)");
    return 0;
  }

  // Reachable but the listener doesn't look like nautilo-server. Be loud.
  deps.warn(
    `[server:status] /health is reachable at ${paths.serverUrl} but the listener (pid=${listenerPid ?? "?"}) does not look like nautilo-server`,
  );
  return 1;
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

export async function serverStatus(): Promise<number> {
  const rootDir = resolveNautiloRootDir();
  const inst = resolveInstance();
  const pidPath = join(rootDir, "server.pid");
  const logPath = join(rootDir, "logs", "nautilo-server.log");
  const serverUrl = inst.server.url;
  const healthUrl = `${serverUrl.replace(/\/$/, "")}/health`;
  const setupUrl = `${serverUrl.replace(/\/$/, "")}/api/setup/status`;

  return runServerStatus({
    paths: { pidPath, logPath, serverUrl },
    readPidFile: () => defaultReadPid(pidPath),
    isProcessAlive: defaultIsProcessAlive,
    findListenerPid: () => findListenerPid(inst.server.port),
    looksLikeNautiloServer,
    fetchHealthLabel: async () => {
      try {
        const res = await fetch(healthUrl);
        if (!res.ok) return `http ${res.status}`;
        const text = await res.text();
        try {
          const j = JSON.parse(text) as { status?: string };
          return j.status ?? "(no status field)";
        } catch {
          return "(non-JSON body)";
        }
      } catch {
        return "(unreachable)";
      }
    },
    fetchSetupState: async () => {
      try {
        const res = await fetch(setupUrl);
        if (!res.ok) return "(unreachable)";
        const j = (await res.json()) as { setupState?: string };
        return typeof j.setupState === "string" ? j.setupState : "(unreachable)";
      } catch {
        return "(unreachable)";
      }
    },
    log: (s) => {
      console.log(s);
    },
    warn: (s) => {
      console.warn(s);
    },
  });
}
