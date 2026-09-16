/**
 * M100 Phase 3 — thin wrapper around `bin/nautilo-server --daemon` (PID +
 * logs + health wait). Does not fork a third daemon implementation.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  openConnectorHostPort,
  resolveEffectiveServerUrl,
  resolveInstance,
  resolveNautiloRootDir,
} from "@nautilo/config";
import {
  defaultEnsurePushTokenEncryptionKeyDeps,
  defaultEnsureRemotePairingPepperDeps,
  ensurePushTokenEncryptionKey,
  ensureRemotePairingPepper,
} from "@nautilo/operator-secrets";
import {
  NAUTILO_REPO_ROOT,
  DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  assertServiceSecretFallbackIsFresh,
  resolveInstanceServiceSecrets,
} from "../lib/compose-infra";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { readPersistedWorkbenchDist } from "../lib/instance-config";
import { findListenerPid, looksLikeNautiloServer } from "../lib/listener-pid";
import { ensureOfficeCliProvisioned } from "../lib/officecli-preflight";
import { ensureServerAgentBrowserProvisioned } from "../lib/agent-browser-preflight";

const HEALTH_POLL_MS = 250;
const HEALTH_WAIT_MS = 90_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const SERVER_ENTRY = resolve(import.meta.dirname, "../../../nautilo-server/src/index.ts");

export interface ServerStartOptions {
  requireWorkbenchDist?: boolean;
}

export interface EnsureServerCapabilitySecretsDeps {
  ensureRemotePairingPepper: (instanceRootDir: string) => Promise<void>;
  ensurePushTokenEncryptionKey: (instanceRootDir: string) => Promise<void>;
}

export async function ensureServerCapabilitySecrets(
  instanceRootDir: string,
  deps: EnsureServerCapabilitySecretsDeps = {
    ensureRemotePairingPepper: async (rootDir) => {
      await ensureRemotePairingPepper(
        { instanceRootDir: rootDir },
        defaultEnsureRemotePairingPepperDeps(),
      );
    },
    ensurePushTokenEncryptionKey: async (rootDir) => {
      await ensurePushTokenEncryptionKey(
        { instanceRootDir: rootDir },
        defaultEnsurePushTokenEncryptionKeyDeps(),
      );
    },
  },
): Promise<void> {
  await deps.ensureRemotePairingPepper(instanceRootDir);
  await deps.ensurePushTokenEncryptionKey(instanceRootDir);
}

function resolveDaemonFullRuntimeConnectionString(
  inst: ReturnType<typeof resolveInstance>,
  env: NodeJS.ProcessEnv,
  useInstancePort = false,
): string {
  const raw = env["DB_CONNECTION_STRING"]?.trim();
  if (raw && !useInstancePort) return raw;
  const password = env["NAUTILO_DB_PASSWORD"] ?? "nautilo";
  const url = new URL(
    `postgres://nautilo@localhost:${inst.db.postgresHostPort}/nautilo`,
  );
  url.password = password;
  return url.toString();
}

function resolveDaemonAgentRuntimeConnectionString(
  inst: ReturnType<typeof resolveInstance>,
  env: NodeJS.ProcessEnv,
  useInstancePort = false,
): string {
  const raw = env["DB_AGENT_CONNECTION_STRING"]?.trim();
  if (raw && !useInstancePort) return raw;
  const password = env["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent";
  const url = new URL(
    `postgres://nautilo_agent@localhost:${inst.db.postgresHostPort}/nautilo`,
  );
  url.password = password;
  return url.toString();
}

function resolveDaemonAgentDirectConnectionString(
  inst: ReturnType<typeof resolveInstance>,
  env: NodeJS.ProcessEnv,
): string {
  const raw = env["DB_AGENT_DIRECT_CONNECTION"]?.trim();
  if (raw) return raw;
  const password = env["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent";
  const u = new URL(inst.db.directConnection);
  u.username = "nautilo_agent";
  u.password = password;
  return u.toString();
}

function resolveDaemonCryptoRuntimeConnectionString(
  inst: ReturnType<typeof resolveInstance>,
  env: NodeJS.ProcessEnv,
  useInstancePort = false,
): string {
  const raw = env["DB_CRYPTO_CONNECTION_STRING"]?.trim();
  if (raw && !useInstancePort) return raw;
  const password = env["NAUTILO_CRYPTO_DB_PASSWORD"] ?? "nautilo_crypto";
  const url = new URL(
    `postgres://nautilo_crypto@localhost:${inst.db.postgresHostPort}/nautilo`,
  );
  url.password = password;
  return url.toString();
}

export function serverDaemonEnv(
  inst: ReturnType<typeof resolveInstance>,
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const useInstancePort = instanceId !== "";
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(instanceId !== "" ? { NAUTILO_INSTANCE_ID: instanceId } : {}),
    NAUTILO_OPENCONNECTOR_BASE_URL:
      env["NAUTILO_OPENCONNECTOR_BASE_URL"]?.trim()
      || `http://127.0.0.1:${openConnectorHostPort(inst)}`,
    DB_DIRECT_CONNECTION: inst.db.directConnection,
    DB_CONNECTION_STRING: resolveDaemonFullRuntimeConnectionString(inst, env, useInstancePort),
    DB_AGENT_CONNECTION_STRING: resolveDaemonAgentRuntimeConnectionString(inst, env, useInstancePort),
    DB_AGENT_DIRECT_CONNECTION: resolveDaemonAgentDirectConnectionString(inst, env),
    DB_CRYPTO_CONNECTION_STRING: resolveDaemonCryptoRuntimeConnectionString(
      inst,
      env,
      useInstancePort,
    ),
  };
  // The role-only password is an input to URL construction, never a general
  // child environment variable of its own.
  delete childEnv["NAUTILO_CRYPTO_DB_PASSWORD"];
  return childEnv;
}

/**
 * Stack 193 — build the daemon env for the SELECTED instance by cloning
 * the parent env and loading that instance's explicit `<rootDir>/instance.env`
 * into the clone via `loadConfigEnvIntoProcess`. Unrelated parent values keep
 * their established precedence, but selected internal service credentials
 * are canonical and replace ambient passwords/URLs from another instance.
 * The clone is then handed to `serverDaemonEnv`; `process.env` is never
 * mutated and secret values are never logged. A missing instance.env is a
 * no-op for a proven-fresh instance; every startup entry point separately
 * refuses that fallback when persistent volumes already exist.
 *
 * `rootDir` must be the selected instance's root (default or named) so the
 * daemon does not accidentally load an unrelated ambient instance's env.
 */
export function buildServerDaemonEnv(params: {
  rootDir: string;
  inst: ReturnType<typeof resolveInstance>;
  instanceId: string;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parentEnv = params.parentEnv ?? process.env;
  const clone: NodeJS.ProcessEnv = { ...parentEnv };
  const instanceEnvPath = join(params.rootDir, "instance.env");
  loadConfigEnvIntoProcess({ path: instanceEnvPath }, clone);
  const servicePlan = resolveInstanceServiceSecrets(
    { instanceId: params.instanceId, instanceEnvPath },
    clone,
  );
  if (servicePlan.source === "selected-instance") {
    Object.assign(clone, servicePlan.serviceSecrets);
    const cryptoSecretPath = join(
      params.rootDir,
      DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
    );
    let cryptoPassword: string;
    try {
      cryptoPassword = readFileSync(cryptoSecretPath, "utf8").trim();
    } catch {
      throw new Error(
        "[server:start] selected instance crypto database credential is unavailable",
      );
    }
    if (cryptoPassword === "" || /[\r\n]/u.test(cryptoPassword)) {
      throw new Error(
        "[server:start] selected instance crypto database credential is invalid",
      );
    }
    clone["NAUTILO_CRYPTO_DB_PASSWORD"] = cryptoPassword;
    // Runtime URLs are always rebuilt from the same selected credential plan.
    delete clone["DB_CONNECTION_STRING"];
    delete clone["DB_AGENT_CONNECTION_STRING"];
    delete clone["DB_AGENT_DIRECT_CONNECTION"];
    delete clone["DB_CRYPTO_CONNECTION_STRING"];
  }
  return serverDaemonEnv(params.inst, params.instanceId, clone);
}

function parsePidFromFileContent(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function healthStatusAccepts(status: string | undefined): boolean {
  return status === "ready" || status === "starting" || status === "ok";
}

export async function fetchServerHealth(
  healthUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; status?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  try {
    // A per-request deadline is required in addition to runServerStart's
    // overall deadline: an accepted TCP connection that never answers HTTP
    // would otherwise keep fetchHealth pending forever and prevent the outer
    // loop from observing its 90-second deadline.
    const res = await fetchImpl(healthUrl, ({
      signal: AbortSignal.timeout(timeoutMs),
      // Bun-specific: self-signed cert OK on the loopback probe; same
      // contract Electron + browser workbench use against the same cert
      // in dev. See dev-stack.ts buildHealthProbeUrl rationale.
      tls: { rejectUnauthorized: false },
    } as Partial<RequestInit>));
    if (res.status !== 200) return { ok: false };
    const text = await res.text();
    let status: string | undefined;
    try {
      status = (JSON.parse(text) as { status?: string }).status;
    } catch {
      return { ok: false };
    }
    return {
      ok: healthStatusAccepts(status),
      ...(status !== undefined ? { status } : {}),
    };
  } catch {
    return { ok: false };
  }
}

export interface ServerStartDeps {
  readPidFile: () => number | null;
  /** Used to claim a foreign-but-clearly-Nautilo server by writing the PID file. */
  writePidFile: (pid: number) => void;
  removePidFile: () => void;
  isProcessAlive: (pid: number) => boolean;
  spawnDaemon: () => void;
  fetchHealth: () => Promise<{ ok: boolean; status?: string }>;
  /**
   * Returns the PID listening on the configured port, or null. Used to
   * detect servers started outside `server:start` (foreground `bun run
   * server`, `desktop:all` children, etc.) so we can claim or stop them.
   */
  findListenerPid: () => number | null;
  /** Refuses to claim/stop processes whose cmdline doesn't look like nautilo-server. */
  looksLikeNautiloServer: (pid: number) => boolean;
  /** Provision server-owned runtimes immediately before a new daemon spawn. */
  provisionOfficeCli: () => void;
  provisionAgentBrowser: () => Promise<boolean>;
  /** Verify worktree-local first-party build artifacts before a new spawn. */
  checkFirstPartyAppPrerequisites?: () => boolean;
  log: (s: string) => void;
  warn: (s: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  paths: { pidPath: string; logPath: string; serverUrl: string };
}

/**
 * D172 — when `NAUTILO_WORKBENCH_DIST` is unset, resolve from persisted
 * `instance.json` (Strategy B) or repo-root `apps/workbench/dist` (Strategy A),
 * then set `process.env` before the server child is spawned.
 */
export function applyNautiloWorkbenchDistEnvIfUnset(
  resolvedInstanceId: string,
  logLine: (s: string) => void,
): void {
  const cur = process.env["NAUTILO_WORKBENCH_DIST"];
  if (cur !== undefined && cur !== "") {
    return;
  }
  const persisted = readPersistedWorkbenchDist(resolvedInstanceId);
  const resolved = persisted ?? join(NAUTILO_REPO_ROOT, "apps/workbench/dist");
  process.env["NAUTILO_WORKBENCH_DIST"] = resolved;
  logLine(
    `[server-start] resolved NAUTILO_WORKBENCH_DIST = ${resolved} (source: ${persisted ? "instance.json" : "repo-root fallback"})`,
  );
}

export async function runServerStart(deps: ServerStartDeps): Promise<number> {
  const { paths } = deps;
  const healthUrl = `${paths.serverUrl.replace(/\/$/, "")}/health`;

  const pidFromFile = deps.readPidFile();
  if (pidFromFile !== null && deps.isProcessAlive(pidFromFile)) {
    const h = await deps.fetchHealth();
    if (h.ok && healthStatusAccepts(h.status)) {
      deps.log(
        `[server:start] already running (pid=${pidFromFile}) at ${paths.serverUrl}; logs at ${paths.logPath}`,
      );
      return 0;
    }
    deps.warn(
      `[server:start] PID ${pidFromFile} is alive but /health is not ready — leaving process untouched`,
    );
    return 0;
  }

  if (pidFromFile !== null && !deps.isProcessAlive(pidFromFile)) {
    deps.removePidFile();
  }

  const foreignProbe = await deps.fetchHealth();
  if (foreignProbe.ok && healthStatusAccepts(foreignProbe.status)) {
    // Something IS already serving — discover the PID via port lookup
    // and decide whether to claim it (sane: it's our server, started by
    // a different path like `bun run server` or `desktop:all`) or warn
    // and bail (paranoid: an unrelated process is squatting our port).
    const listenerPid = deps.findListenerPid();
    if (listenerPid === null) {
      deps.warn(
        `[server:start] /health passes at ${paths.serverUrl} but no listener was found via port lookup — refusing to manage; investigate with bin/nautilo-dev infra-status`,
      );
      return 0;
    }
    if (!deps.looksLikeNautiloServer(listenerPid)) {
      deps.warn(
        `[server:start] something is listening on ${paths.serverUrl} (pid=${listenerPid}) but its command line does not look like nautilo-server — refusing to claim; investigate with bin/nautilo-dev infra-status`,
      );
      return 0;
    }
    deps.writePidFile(listenerPid);
    deps.log(
      `[server:start] claimed existing server (pid=${listenerPid}) at ${paths.serverUrl}; logs at ${paths.logPath}`,
    );
    return 0;
  }

  // M203 follow-up — every development server entry point, including full
  // populated clones, must provision OfficeCLI before the daemon builds its
  // one-time tool catalogue. Keep this after adoption checks so an idempotent
  // server-start never downloads runtimes for a daemon it does not own.
  if (deps.checkFirstPartyAppPrerequisites?.() === false) return 1;
  deps.provisionOfficeCli();
  if (!await deps.provisionAgentBrowser()) {
    deps.warn("[server:start] server browser provisioning failed; refusing to start an incomplete runtime");
    return 1;
  }
  deps.spawnDaemon();

  const deadline = deps.now() + HEALTH_WAIT_MS;
  while (deps.now() < deadline) {
    const h = await deps.fetchHealth();
    if (h.ok && healthStatusAccepts(h.status)) {
      const written = deps.readPidFile();
      deps.log("[server:start] running");
      deps.log(`  pid : ${written ?? "(unknown — see log)"}`);
      deps.log(`  url : ${paths.serverUrl}`);
      deps.log(`  log : ${paths.logPath}`);
      return 0;
    }
    await deps.sleep(HEALTH_POLL_MS);
  }

  const pidToKill = deps.readPidFile();
  if (pidToKill !== null && deps.isProcessAlive(pidToKill)) {
    try {
      deps.killPid(pidToKill, "SIGTERM");
      await deps.sleep(400);
      if (deps.isProcessAlive(pidToKill)) {
        deps.killPid(pidToKill, "SIGKILL");
      }
    } catch {
      /* best effort */
    }
    deps.removePidFile();
  }

  deps.warn(
    `[server:start] timed out after ${HEALTH_WAIT_MS}ms waiting for ${healthUrl} (see ${paths.logPath})`,
  );
  return 1;
}

export function checkWorkbenchDistForServerStart(options: {
  env?: NodeJS.ProcessEnv;
  requireWorkbenchDist?: boolean;
  warn: (s: string) => void;
}): number {
  const env = options.env ?? process.env;
  const dist = (env["NAUTILO_WORKBENCH_DIST"] ?? "").trim();
  const isMissing = dist === "";
  const indexPath = isMissing ? "" : join(dist, "index.html");
  const isInvalid = !isMissing && !existsSync(indexPath);

  if (!isMissing && !isInvalid) return 0;

  const problem = isMissing
    ? "NAUTILO_WORKBENCH_DIST is not set"
    : `NAUTILO_WORKBENCH_DIST is set to ${dist}, but ${indexPath} does not exist`;
  const consequence = "Fastify will not serve the Workbench SPA at /, so Electron/browser users will see a JSON 404.";
  const fix = "Use `bun run dev-stack --electron`, or restart with `NAUTILO_WORKBENCH_DIST=$(pwd)/apps/workbench/dist` after building the workbench.";

  if (options.requireWorkbenchDist) {
    options.warn(`[server:start] refusing to start: ${problem}. ${consequence} ${fix}`);
    return 1;
  }

  options.warn(`[server:start] warning: ${problem}. ${consequence} ${fix}`);
  return 0;
}

export function checkFirstPartyAppPrerequisitesForServerStart(options: {
  repoRoot?: string;
  pathExists?: (path: string) => boolean;
  warn: (s: string) => void;
}): boolean {
  const repoRoot = options.repoRoot ?? NAUTILO_REPO_ROOT;
  const pathExists = options.pathExists ?? existsSync;
  const sheetsProvenance = join(repoRoot, "packages/first-party-apps/spreadsheet/engine/provenance.json");
  if (pathExists(sheetsProvenance)) return true;

  options.warn(
    "[server:start] refusing to start: Nautilo Sheets is not prepared in this source worktree. " +
      "Run `bun run sheets:prepare`, then retry `bun run server:start`.",
  );
  return false;
}

function defaultReadPidFile(pidPath: string): number | null {
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

function defaultRemovePidFile(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

function defaultWritePidFile(pidPath: string, pid: number): void {
  try {
    writeFileSync(pidPath, String(pid), { mode: 0o644 });
  } catch {
    /* best effort — claiming a foreign server is advisory */
  }
}

export async function serverStart(options: ServerStartOptions = {}): Promise<number> {
  const rootDir = resolveNautiloRootDir();
  const inst = resolveInstance();
  const pidPath = join(rootDir, "server.pid");
  const logPath = join(rootDir, "logs", "nautilo-server.log");
  // D195/D202 follow-up — instance.json's stored `server.url` was minted
  // before the LAN-mode HTTPS predicate landed and may say `http://...`
  // on long-lived (default) installs even though the server now picks
  // HTTPS for any non-loopback bind host. Use the live predicate so the
  // health probe hits the same scheme the server actually serves; the
  // 90s SIGTERM symptom on (default) traces back to this drift.
  const serverUrl = resolveEffectiveServerUrl(inst);
  const healthBase = serverUrl.replace(/\/$/, "");
  const healthUrl = `${healthBase}/health`;
  const instanceId = (process.env["NAUTILO_INSTANCE_ID"] ?? "").trim();
  const port = inst.server.port;
  const instanceEnvPath = join(rootDir, "instance.env");

  try {
    const servicePlan = resolveInstanceServiceSecrets(
      { instanceId, instanceEnvPath },
      process.env,
    );
    assertServiceSecretFallbackIsFresh(inst, servicePlan);
    await ensureServerCapabilitySecrets(rootDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // D172 must run BEFORE checkWorkbenchDistForServerStart: when the env
  // var is unset, D172 resolves it from instance.json (Strategy B) or
  // repo-root (Strategy A); the strict-mode check then validates the
  // resolved value. Wrong order would fail-fast on env-unset before
  // D172 could supply it, defeating the auto-resolution purpose.
  applyNautiloWorkbenchDistEnvIfUnset(instanceId, console.log);

  const workbenchDistCode = checkWorkbenchDistForServerStart({
    ...(options.requireWorkbenchDist !== undefined
      ? { requireWorkbenchDist: options.requireWorkbenchDist }
      : {}),
    warn: (s) => {
      console.warn(s);
    },
  });
  if (workbenchDistCode !== 0) return workbenchDistCode;

  // Stack 193 — clone the parent env and load the selected instance's
  // `<rootDir>/instance.env` into the clone (parent overrides preserved)
  // BEFORE handing it to the daemon. Built after D172 so the clone also
  // captures any NAUTILO_WORKBENCH_DIST D172 just resolved into
  // process.env. process.env itself is never mutated by this step.
  const daemonEnv = buildServerDaemonEnv({ rootDir, inst, instanceId });

  return runServerStart({
    paths: { pidPath, logPath, serverUrl },
    readPidFile: () => defaultReadPidFile(pidPath),
    writePidFile: (pid) => defaultWritePidFile(pidPath, pid),
    removePidFile: () => defaultRemovePidFile(pidPath),
    isProcessAlive,
    findListenerPid: () => findListenerPid(port),
    looksLikeNautiloServer,
    provisionOfficeCli: () => {
      ensureOfficeCliProvisioned(NAUTILO_REPO_ROOT);
    },
    provisionAgentBrowser: () => ensureServerAgentBrowserProvisioned(NAUTILO_REPO_ROOT),
    checkFirstPartyAppPrerequisites: () => checkFirstPartyAppPrerequisitesForServerStart({
      warn: (s) => { console.warn(s); },
    }),
    spawnDaemon: () => {
      const args = [SERVER_ENTRY, "--daemon"];
      if (instanceId !== "") {
        args.push("--instance", instanceId);
      }
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        stdio: "ignore",
        detached: true,
        env: daemonEnv,
      });
      child.unref();
    },
    fetchHealth: () => fetchServerHealth(healthUrl),
    log: (s) => {
      console.log(s);
    },
    warn: (s) => {
      console.warn(s);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* ignore */
      }
    },
  });
}
