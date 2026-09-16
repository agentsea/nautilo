/**
 * Per-instance **server** process probing for `dev:list-instances`.
 *
 * **Idle heuristic (cheapest path):** `idleSeconds` is wall-clock seconds since the
 * most recent mtime among, when present: `logs/nautilo-server.log`, `logs/server.log`,
 * and `instance.json` under the instance root. A single synchronous `stat(2)` loop
 * per candidate avoids tailing logs or scraping sockets. When a live server PID exists,
 * `ageSeconds` comes from `ps` elapsed time; when **no** listener/file-backed server PID
 * is detected, both `ageSeconds` and `idleSeconds` are set to that same filesystem idle
 * value so long-abandoned layout dirs can still satisfy the STALE predicate (uptime ∧ idle).
 *
 * **Subprocess policy:** `ps` / `lsof` probes use `Bun.spawn` with stdout pipes and
 * `AbortSignal.timeout(budget)` — no shell interpolation of user-controlled strings.
 * TCP listener PID discovery uses the same `lsof -nP -t -iTCP:<port> -sTCP:LISTEN`
 * argv sequence as {@link findListenerPid} in `listener-pid.ts`, but **`Bun.spawn`**
 * so `probeManyInstanceProcessStates` can query distinct ports concurrently (sync
 * `execSync` in `findListenerPid` would serialize under parallel `probe` calls).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { InstanceJsonSchema } from "@nautilo/config";
import { looksLikeNautiloServer } from "./listener-pid";

export interface InstanceProcessState {
  instanceId: string;
  serverPid: number | null;
  serverPort: number | null;
  cwd: string | null;
  ageSeconds: number | null;
  idleSeconds: number | null;
  isStale: boolean;
  isRunning: boolean;
}

export interface ProcessStateOptions {
  staleUptimeSeconds?: number;
  staleIdleSeconds?: number;
  budgetMsPerInstance?: number;
  /**
   * Test-only: intercept subprocess stdout for `ps` / `lsof` (production omits).
   */
  spawnStdout?: (
    cmd: readonly string[],
    signal: AbortSignal,
  ) => Promise<string | null>;
  /**
   * Test-only: override port→PID lookup (production omits; uses async `lsof` spawn).
   */
  testPortListenerPid?: (port: number) => number | null;
  /**
   * When set by {@link probeManyInstanceProcessStates}, skips per-row port `lsof`
   * (parallel prefetch).
   */
  listenerPidHintByPort?: ReadonlyMap<number, number | null>;
}

function envHours(name: string, fallbackHours: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackHours;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackHours;
}

export function resolveStaleThresholdSeconds(opts?: ProcessStateOptions): {
  staleUptimeSeconds: number;
  staleIdleSeconds: number;
} {
  const envUptime = envHours("NAUTILO_DEV_STALE_UPTIME_H", 6) * 3600;
  const envIdle = envHours("NAUTILO_DEV_STALE_IDLE_H", 6) * 3600;
  return {
    staleUptimeSeconds: opts?.staleUptimeSeconds ?? envUptime,
    staleIdleSeconds: opts?.staleIdleSeconds ?? envIdle,
  };
}

/** Exported for unit tests — mirrors `isStale` predicate on the row type. */
export function computeIsStale(
  ageSeconds: number | null,
  idleSeconds: number | null,
  staleUptimeSeconds: number,
  staleIdleSeconds: number,
): boolean {
  if (ageSeconds === null || idleSeconds === null) return false;
  return ageSeconds > staleUptimeSeconds && idleSeconds > staleIdleSeconds;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

function readPidFileContent(instanceRoot: string): number | null {
  const path = join(instanceRoot, "server.pid");
  if (!existsSync(path)) return null;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readServerPort(instanceRoot: string): number | null {
  const path = join(instanceRoot, "instance.json");
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = InstanceJsonSchema.safeParse(raw);
    if (!parsed.success) return null;
    const p = parsed.data.server.port;
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Parse macOS/BSD `ps -o etime=` values into seconds. */
export function parsePsEtimeToSeconds(etime: string): number | null {
  const s = etime.trim();
  if (!s) return null;
  const dayFirst = /^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  if (dayFirst) {
    const d = Number(dayFirst[1]);
    const h = Number(dayFirst[2]);
    const m = Number(dayFirst[3]);
    const sec = Number(dayFirst[4]);
    if ([d, h, m, sec].some((x) => !Number.isFinite(x))) return null;
    return d * 86400 + h * 3600 + m * 60 + sec;
  }
  const parts = s.split(":").map((x) => Number.parseInt(x.trim(), 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return null;
}

function idleSecondsFromFilesystem(instanceRoot: string): number | null {
  const candidates = [
    join(instanceRoot, "logs", "nautilo-server.log"),
    join(instanceRoot, "logs", "server.log"),
    join(instanceRoot, "instance.json"),
  ];
  let latestMs = 0;
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
    } catch {
      /* missing */
    }
  }
  if (latestMs === 0) return null;
  return Math.max(0, Math.floor((Date.now() - latestMs) / 1000));
}

async function defaultSpawnStdout(
  cmd: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const proc = Bun.spawn([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal,
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return text.trim();
  } catch {
    return null;
  }
}

/** Same numeric parsing contract as `findListenerPid` in `listener-pid.ts`. */
function parseLsofListenPids(stdout: string): number | null {
  const out = stdout.trim();
  if (out === "") return null;
  const pids = out
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n): n is number => Number.isInteger(n) && n > 0);
  if (pids.length === 0) return null;
  return Math.min(...pids);
}

/** Async `lsof` with the same argv shape as `findListenerPid` (listener-pid.ts). */
async function findListenerPidAsync(
  port: number,
  signal: AbortSignal,
  spawnStdout: (cmd: readonly string[], signal: AbortSignal) => Promise<string | null>,
): Promise<number | null> {
  const out = await spawnStdout(
    ["lsof", "-nP", "-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN"],
    signal,
  );
  if (out === null) return null;
  return parseLsofListenPids(out);
}

async function prefetchListenerPidsForInstances(
  instances: Array<{ instanceRoot: string }>,
  budgetMs: number,
  opts?: ProcessStateOptions,
): Promise<Map<number, number | null>> {
  const ports = new Set<number>();
  for (const r of instances) {
    const p = readServerPort(r.instanceRoot);
    if (p !== null && p > 0) ports.add(p);
  }
  const spawnStdout = opts?.spawnStdout ?? defaultSpawnStdout;
  const map = new Map<number, number | null>();
  await Promise.all(
    [...ports].map(async (port) => {
      const signal = AbortSignal.timeout(budgetMs);
      let pid: number | null;
      if (typeof opts?.testPortListenerPid === "function") {
        pid = opts.testPortListenerPid(port);
      } else {
        pid = await findListenerPidAsync(port, signal, spawnStdout);
      }
      map.set(port, pid);
    }),
  );
  return map;
}

function parseLsofCwdStdout(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) continue;
    if (!/\bcwd\b/.test(trimmed)) continue;
    const m = /(\/\S+)\s*$/.exec(trimmed);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function readProcessCwd(
  pid: number,
  signal: AbortSignal,
  spawnStdout: (cmd: readonly string[], signal: AbortSignal) => Promise<string | null>,
): Promise<string | null> {
  const out = await spawnStdout(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-nP"], signal);
  if (out === null || out === "") return null;
  return parseLsofCwdStdout(out);
}

async function readProcessAgeSeconds(
  pid: number,
  signal: AbortSignal,
  spawnStdout: (cmd: readonly string[], signal: AbortSignal) => Promise<string | null>,
): Promise<number | null> {
  const out = await spawnStdout(["ps", "-p", String(pid), "-o", "etime="], signal);
  if (out === null) return null;
  return parsePsEtimeToSeconds(out);
}

function resolveServerPidFromParts(
  configuredPort: number | null,
  instanceRoot: string,
  fromPort: number | null,
): { pid: number | null; boundPort: number | null } {
  if (configuredPort === null || configuredPort <= 0) {
    return { pid: null, boundPort: null };
  }
  if (fromPort !== null) {
    return { pid: fromPort, boundPort: configuredPort };
  }
  const fromFile = readPidFileContent(instanceRoot);
  if (fromFile !== null && isProcessAlive(fromFile) && looksLikeNautiloServer(fromFile)) {
    return { pid: fromFile, boundPort: null };
  }
  return { pid: null, boundPort: null };
}

export function formatAgeShort(ageSeconds: number | null): string {
  if (ageSeconds === null) return "—";
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const m = Math.floor(ageSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export async function probeInstanceProcessState(
  instanceId: string,
  instanceRoot: string,
  opts?: ProcessStateOptions,
): Promise<InstanceProcessState> {
  const budgetMs = opts?.budgetMsPerInstance ?? 50;
  const signal = AbortSignal.timeout(budgetMs);
  const { staleUptimeSeconds, staleIdleSeconds } = resolveStaleThresholdSeconds(opts);
  const spawnStdout = opts?.spawnStdout ?? defaultSpawnStdout;

  const configuredPort = readServerPort(instanceRoot);
  let fromPort: number | null = null;
  if (configuredPort !== null && configuredPort > 0) {
    if (typeof opts?.testPortListenerPid === "function") {
      fromPort = opts.testPortListenerPid(configuredPort);
    } else if (opts?.listenerPidHintByPort?.has(configuredPort)) {
      fromPort = opts.listenerPidHintByPort.get(configuredPort) ?? null;
    } else {
      fromPort = await findListenerPidAsync(configuredPort, signal, spawnStdout);
    }
  }
  const { pid: serverPid, boundPort } = resolveServerPidFromParts(
    configuredPort,
    instanceRoot,
    fromPort,
  );
  const fsIdle = idleSecondsFromFilesystem(instanceRoot);

  let cwd: string | null = null;
  let ageSeconds: number | null = null;
  let idleSeconds: number | null = fsIdle;

  const running = serverPid !== null && isProcessAlive(serverPid);
  if (running && serverPid !== null) {
    const [cwdR, ageR] = await Promise.all([
      readProcessCwd(serverPid, signal, spawnStdout),
      readProcessAgeSeconds(serverPid, signal, spawnStdout),
    ]);
    cwd = cwdR;
    ageSeconds = ageR;
    if (idleSeconds === null) {
      idleSeconds = ageSeconds;
    }
  } else {
    if (fsIdle !== null) {
      ageSeconds = fsIdle;
      idleSeconds = fsIdle;
    } else {
      ageSeconds = null;
      idleSeconds = null;
    }
  }

  const isStale = computeIsStale(ageSeconds, idleSeconds, staleUptimeSeconds, staleIdleSeconds);

  return {
    instanceId,
    serverPid: running ? serverPid : null,
    serverPort: boundPort,
    cwd,
    ageSeconds,
    idleSeconds,
    isStale,
    isRunning: running,
  };
}

export async function probeManyInstanceProcessStates(
  instances: Array<{ instanceId: string; instanceRoot: string }>,
  opts?: ProcessStateOptions,
): Promise<InstanceProcessState[]> {
  const budgetMs = opts?.budgetMsPerInstance ?? 50;
  const hintMap = await prefetchListenerPidsForInstances(instances, budgetMs, opts);
  const mergedOpts: ProcessStateOptions = { ...opts, listenerPidHintByPort: hintMap };
  return Promise.all(
    instances.map((row) => probeInstanceProcessState(row.instanceId, row.instanceRoot, mergedOpts)),
  );
}
