/**
 * D153 Phase 3.B — one-shot dev stack orchestrator: infra (optional) +
 * workbench production build (optional) + server-start + optional Electron,
 * with port-collision guardrails and signal-safe child teardown.
 */
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  effectiveServerScheme,
  resolveEffectiveServerUrl,
  resolveInstance,
  resolveNautiloRootDir,
} from "@nautilo/config";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import { listLocalInstances } from "@nautilo/instance-discovery/node";
import { infraStart, type InfraStartOptions } from "./infra-start";
import { NAUTILO_REPO_ROOT } from "../lib/compose-infra";
import { ensureDesktopOfficeCliProvisioned } from "../lib/desktop-officecli-preflight";
import { ensureDesktopOpenHueProvisioned } from "../lib/desktop-openhue-preflight";
import { persistWorkbenchDistToInstanceJson } from "../lib/instance-config";
import { probeInstanceProcessState, probeManyInstanceProcessStates } from "../lib/process-state";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";
import {
  classifyWorktreeCheckout,
  evaluateDefaultInstanceMutationGuard,
} from "../lib/default-instance-guard";
import { resolveDevInstanceId } from "../lib/instance-id";
import { runLocalRuntimeAcceptanceExitCode } from "../lib/verify";
import { selectCloneMaterialization } from "../lib/clone-source-selection";
import { materializeClone } from "./clone";
import { canonicalDefaultCloneSeedReport, cleanupCanonicalDefaultSeedCapture, createCanonicalDefaultSeedCapture, createCanonicalDefaultSourceEvidence, formatCanonicalDefaultCloneSeedReport, prepareCanonicalDefaultCloneSeed } from "../lib/default-clone-seed";
import { defaultCloneSeedRoot } from "../lib/clone-seed-store";
import { readCheckoutMigrationLineage } from "../lib/migration-lineage";
import { assertCloneTargetAbsent, inspectCloneTargetState } from "../lib/clone-preflight";
import { inspectSheetsReadiness, type SheetsReadiness } from "../lib/sheets-readiness";

const DEV_STACK_HELP: HelpSpec = {
  name: "dev-stack",
  summary:
    "Compose infra + Sheets preparation + workbench build + server + (optional) Electron into one Ctrl-C-aware orchestrator.",
  usage: "bun run dev-stack [--instance <name>] [--clone-default] [--refresh-clone-seed] [--electron] [--mobile-web] [--no-build] [--no-infra] [--json]",
  flags: [
    {
      flag: "--instance <name>",
      description:
        "Target instance id. Default: NAUTILO_INSTANCE_ID env, then worktree-derived basename, then (default). Pass `default` (or `(default)`) to attach this worktree's code to the shared default instance from any non-canonical worktree.",
    },
    { flag: "--clone-default", description: "Provision an absent named target from canonical default, then run dev-stack once." },
    { flag: "--refresh-clone-seed", description: "With --clone-default, capture a fresh verified seed." },
    {
      flag: "--electron",
      description:
        "Spawn the Electron desktop app once the server is ready (auto-provisions desktop OfficeCLI and OpenHue first).",
    },
    {
      flag: "--no-build",
      description:
        "Do not prepare Sheets or build Workbench/requested Mobile Web; fail if required generated outputs are absent or stale.",
    },
    {
      flag: "--mobile-web",
      description: "Build and mount the canonical Mobile Web export for this dev stack only.",
    },
    {
      flag: "--no-infra",
      description:
        "Skip infra:start for a warm fast-loop only (assumes Postgres + Logto are already healthy; do not use to recover bootstrap failures).",
    },
    {
      flag: "--office",
      description:
        "Also bring up the LibreOffice engine (nwuno + collabora, D362) in the same compose project. Off by default; replaces the standalone `office:up`.",
    },
    {
      flag: "--json",
      description: "Emit a single JSON summary instead of human-readable output.",
    },
    { flag: "--help, -h", description: "Show this help and exit." },
  ],
  examples: [
    {
      cmd: "bun run dev-stack",
      desc: "Bring up everything for the current worktree's auto-derived instance.",
    },
    {
      cmd: "bun run dev-stack --instance smoke-stack19 --electron",
      desc: "Target a named instance and launch the desktop app.",
    },
    {
      cmd: "bun run dev-stack --instance default --i-know-what-i-am-doing --electron",
      desc: "Smoke this worktree's code against the shared claimed (default) instance.",
    },
    {
      cmd: "bun run dev-stack --no-infra --no-build --instance dev",
      desc: "Fast inner-loop: assume infra is up, skip rebuild, just start the server.",
    },
  ],
  notes: [
    "Port collisions (another worktree's server already on our port) print a recommendation table + exit 1; no auto-kill.",
    "Ctrl-C / SIGTERM tears down only this stack's spawned children; other instances + infra are untouched.",
    "See README.md and apps/desktop/README.md for named-instance development commands.",
  ],
};

const NAUTILO_DEV_ENTRY = join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts");
const MOBILE_WEB_DIST = join(NAUTILO_REPO_ROOT, "apps/mobile/dist");
const MOBILE_WEB_DIST_INDEX = join(MOBILE_WEB_DIST, "index.html");
const DESKTOP_DIR = join(NAUTILO_REPO_ROOT, "apps/desktop");

/**
 * Resolve the installed `electron` package dir. bun may hoist it to the repo
 * root OR nest it under apps/desktop (the workspace that declares it). Prefer
 * the desktop-workspace resolution; fall back to the repo-root path so the
 * error message still points somewhere sensible if nothing is installed.
 */
export function resolveElectronPackageDir(): string {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("electron/package.json", { paths: [DESKTOP_DIR] }));
  } catch {
    return join(NAUTILO_REPO_ROOT, "node_modules/electron");
  }
}

const HEALTH_POLL_MS = 250;
const HEALTH_WAIT_MS = 60_000;
const DIST_FRESH_MS = 5 * 60 * 1000;

export interface DevStackOptions {
  instance?: string;
  electron?: boolean;
  noBuild?: boolean;
  /** Explicitly build and mount Mobile Web; off for ordinary server-only dev. */
  mobileWeb?: boolean;
  noInfra?: boolean;
  /** D362 — also bring up the office engine (nwuno + collabora) profile. */
  office?: boolean;
  asJson?: boolean;
  cloneDefault?: boolean;
  refreshCloneSeed?: boolean;
  /** Test-only: Bun.spawn substitute */
  spawn?: typeof Bun.spawn;
  /** Test-only: global fetch substitute */
  fetch?: typeof fetch;
  /** Test-only: override cwd for worktree derivation + collision compare */
  cwd?: string;
  /** Test-only: HOME for listLocalInstances */
  homeDir?: string;
  /** Test-only: isolate generated Workbench fixtures from the repository dist. */
  workbenchDist?: string;
  /** Test-only: isolate the generated Sheets engine readiness decision. */
  sheetsReadiness?: () => Promise<SheetsReadiness>;
  /** Test-only: env snapshot (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** Test-only: shorten /health wait */
  healthTimeoutMs?: number;
  /** Test-only: infra-start substitute */
  infraStart?: (options?: InfraStartOptions) => Promise<number>;
  /** D202: explicit opt-in when a feature worktree targets (default). */
  iKnowWhatIAmDoing?: boolean;
  /** Test-only: override root node_modules/electron package dir. */
  electronPackageDir?: string;
  /** Test-only: substitute desktop OfficeCLI preflight (M206). */
  desktopOfficeCliPreflight?: (repoRoot: string) => boolean;
  /** Test-only: substitute desktop OpenHue preflight (Stack 173). */
  desktopOpenHuePreflight?: (repoRoot: string) => boolean;
  /** Test seam for the fail-closed D427 gate run before ready/Electron. */
  runtimeAcceptance?: (log: (message: string) => void) => Promise<number>;
  /** D508 internal-only: do not mint a plaintext bootstrap claim file. */
  suppressBootstrapClaimInvite?: boolean;
  /** D508 internal-only: return after ready while preserving the named daemon for browser qualification. */
  returnWhenReady?: boolean;
  cloneDefaultProvision?: (targetId: string, options: { readonly office: boolean; readonly asJson: boolean }) => Promise<number | CloneDefaultProvisionResult>;
  /** Test seam for the no-write target preflight before seed capture. */
  cloneDefaultPreflight?: (targetId: string) => Promise<number>;
}

type CloneDefaultSeedReport = ReturnType<typeof canonicalDefaultCloneSeedReport>;
interface CloneDefaultProvisionResult {
  readonly code: number;
  readonly seed: CloneDefaultSeedReport;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function normalizeFsPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Instance id for `NAUTILO_INSTANCE_ID` / `resolveInstance` (empty string = default instance).
 * Precedence: explicit opts.instance → `--instance` in argv → env.NAUTILO_INSTANCE_ID →
 * worktree basename (strip `nautilo-`; bare `nautilo` → default) → default.
 */
/**
 * Sentinel for the shared default instance (id = empty string).
 *
 * Without this alias, the basename rule auto-isolates every `nautilo-*`
 * worktree to its own instance, with no escape hatch: empty `--instance ""`
 * and empty `NAUTILO_INSTANCE_ID=` both fall through to the basename
 * branch, never to the default. Operators (and agents) who want to smoke
 * a feature branch against the canonical `(default)` instance's claimed
 * user + provider keys would otherwise have to physically `cd` to the
 * `nautilo/` worktree, which forces a branch-checkout dance.
 *
 * Accepting "default" (case-insensitive) at every override layer normalizes
 * to "" so the same recipe works from any worktree.
 */
export function resolveInstanceIdForDevStack(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: Pick<DevStackOptions, "instance">,
): string {
  return resolveDevInstanceId(argv, env, cwd, opts);
}

function isWorkbenchDistFresh(indexPath: string): boolean {
  if (!existsSync(indexPath)) return false;
  try {
    const st = statSync(indexPath);
    return Date.now() - st.mtimeMs <= DIST_FRESH_MS;
  } catch {
    return false;
  }
}

function healthStatusAccepts(status: string | undefined): boolean {
  return status === "ready" || status === "starting" || status === "ok";
}

/**
 * The server picks HTTPS (self-signed cert) for any LAN-mode host
 * (anything that isn't `127.0.0.1` / `localhost`); see
 * `effectiveServerScheme` in `@nautilo/config`. A default instance with
 * `host: "0.0.0.0"` therefore boots HTTPS, and the dev-stack health
 * probe must match — earlier hardcoded `http://` resulted in 90s timeouts
 * + SIGTERM against an otherwise-healthy server.
 *
 * The probe loops back via `127.0.0.1` so the loopback trust boundary is
 * the operator's machine. Self-signed cert verification is intentionally
 * disabled here — that's the same contract Electron + browser workbench
 * use against the same cert in dev. Bun's fetch accepts `tls` directly.
 */
function buildHealthProbeUrl(host: string, port: number): string {
  const scheme = effectiveServerScheme(host);
  return `${scheme}://127.0.0.1:${port}/health`;
}

async function waitForServerHealth(
  host: string,
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number = HEALTH_WAIT_MS,
): Promise<boolean> {
  const url = buildHealthProbeUrl(host, port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(2000),
        // Bun-specific: skip self-signed cert verify on loopback probe.
        // Cast to `RequestInit` because the standard DOM fetch types
        // don't include `tls`, but Bun's runtime accepts it.
        ...({ tls: { rejectUnauthorized: false } } as Partial<RequestInit>),
      });
      if (res.status !== 200) {
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
        continue;
      }
      const text = await res.text();
      let status: string | undefined;
      try {
        status = (JSON.parse(text) as { status?: string }).status;
      } catch {
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
        continue;
      }
      if (healthStatusAccepts(status)) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function parsePidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * `server-start` is deliberately idempotent: it may adopt an already-running
 * daemon, including one that was started outside dev-stack.  Consequently the
 * mutable instance `server.pid` file is *not* an ownership record.  In
 * particular, rereading it during teardown used to let an older dev-stack
 * kill a daemon that a later stack had adopted or replaced.
 *
 * A dev-stack that observed no listener/PID before it invoked server-start may
 * take this short-lived, per-instance lease.  It records the exact daemon PID
 * it observed after startup; cleanup signals that PID only when both the lease
 * and the current PID file still agree.  A competing/adopting dev-stack never
 * obtains a lease and therefore never signals the daemon.
 */
const DEV_STACK_SERVER_OWNERSHIP_FILE = "dev-stack-server-owner.json";

interface DevStackServerOwnershipLease {
  path: string;
  token: string;
  instanceId: string;
  ownerPid: number;
  daemonPid: number | null;
}

interface DevStackServerOwnershipRecord {
  token: string;
  instanceId: string;
  ownerPid: number;
  daemonPid: number | null;
}

function readServerOwnershipRecord(path: string): DevStackServerOwnershipRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Partial<DevStackServerOwnershipRecord>;
    if (typeof record.token !== "string" || typeof record.instanceId !== "string") return null;
    if (typeof record.ownerPid !== "number" || record.ownerPid <= 0) return null;
    if (record.daemonPid !== null && (typeof record.daemonPid !== "number" || record.daemonPid <= 0)) {
      return null;
    }
    return {
      token: record.token,
      instanceId: record.instanceId,
      ownerPid: record.ownerPid,
      daemonPid: record.daemonPid ?? null,
    };
  } catch {
    return null;
  }
}

function sameServerOwnershipValues(
  record: DevStackServerOwnershipRecord | null,
  expected: DevStackServerOwnershipRecord,
): boolean {
  return (
    record?.token === expected.token &&
    record.instanceId === expected.instanceId &&
    record.ownerPid === expected.ownerPid &&
    record.daemonPid === expected.daemonPid
  );
}

function sameServerOwnershipRecord(
  record: DevStackServerOwnershipRecord | null,
  lease: DevStackServerOwnershipLease,
): boolean {
  return sameServerOwnershipValues(record, lease);
}

/**
 * A hard-killed dev-stack cannot execute its normal release path.  A stranded
 * lease is reclaimable only after independently proving that it cannot still
 * describe a live server: the owning dev-stack process is gone, its recorded
 * daemon is absent/gone, and the instance probe found no listener.  Anything
 * ambiguous remains an adoption-only path.
 */
function recoverStaleServerOwnership(
  instanceRoot: string,
  instanceId: string,
  hasLiveServer: boolean,
): void {
  if (hasLiveServer) return;
  const path = join(instanceRoot, DEV_STACK_SERVER_OWNERSHIP_FILE);
  const record = readServerOwnershipRecord(path);
  if (record === null || record.instanceId !== instanceId) return;
  if (isPidAlive(record.ownerPid)) return;
  if (record.daemonPid !== null && isPidAlive(record.daemonPid)) return;
  // Verify the same record immediately before unlinking so we do not remove a
  // lease another dev-stack acquired after our initial read.
  if (!sameServerOwnershipValues(readServerOwnershipRecord(path), record)) return;
  try {
    unlinkSync(path);
  } catch {
    /* best effort; inability to reclaim means fail closed as an adopter */
  }
}

function tryAcquireServerOwnership(instanceRoot: string, instanceId: string): DevStackServerOwnershipLease | null {
  const path = join(instanceRoot, DEV_STACK_SERVER_OWNERSHIP_FILE);
  const lease: DevStackServerOwnershipLease = {
    path,
    token: randomUUID(),
    instanceId,
    ownerPid: process.pid,
    daemonPid: null,
  };
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return null;
  }
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({ token: lease.token, instanceId, ownerPid: lease.ownerPid, daemonPid: null })}\n`,
      "utf8",
    );
    return lease;
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* best effort */
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function recordOwnedServerPid(lease: DevStackServerOwnershipLease, daemonPid: number): boolean {
  if (lease.daemonPid !== null) return false;
  if (!sameServerOwnershipRecord(readServerOwnershipRecord(lease.path), lease)) return false;
  lease.daemonPid = daemonPid;
  try {
    writeFileSync(
      lease.path,
      `${JSON.stringify({ token: lease.token, instanceId: lease.instanceId, ownerPid: lease.ownerPid, daemonPid })}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    lease.daemonPid = null;
    return false;
  }
}

function ownedServerPidForCleanup(
  lease: DevStackServerOwnershipLease | null,
  serverPidPath: string,
): number | null {
  if (lease?.daemonPid === null || lease === null) return null;
  if (!sameServerOwnershipRecord(readServerOwnershipRecord(lease.path), lease)) return null;
  // A replacement PID file belongs to whoever replaced the daemon.  Never
  // infer ownership from a later mutable file read.
  return parsePidFile(serverPidPath) === lease.daemonPid ? lease.daemonPid : null;
}

function releaseServerOwnership(lease: DevStackServerOwnershipLease | null): void {
  if (lease === null) return;
  if (!sameServerOwnershipRecord(readServerOwnershipRecord(lease.path), lease)) return;
  try {
    unlinkSync(lease.path);
  } catch {
    /* best effort */
  }
}

async function drainStreamWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  logStream: NodeJS.WritableStream | undefined,
  echoToStdout: boolean,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        const out = `${prefix}${line}\n`;
        logStream?.write(out);
        if (echoToStdout) process.stdout.write(out);
      }
    }
    if (carry.length > 0) {
      const out = `${prefix}${carry}\n`;
      logStream?.write(out);
      if (echoToStdout) process.stdout.write(out);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface PortCollisionConflict {
  /** Display label for the row that triggered the conflict */
  label: string;
  conflictingCwd: string;
}

export async function detectDevStackPortCollisions(
  myInstanceRoot: string,
  myServerPort: number,
  myCwd: string,
  homeDir: string,
  selfInstanceId: string,
  probeOpts?: Parameters<typeof probeManyInstanceProcessStates>[1],
): Promise<PortCollisionConflict[]> {
  const myRootN = normalizeFsPath(myInstanceRoot);
  const myCwdN = normalizeFsPath(myCwd);
  const rows = await listLocalInstances(homeDir, {
    probeHealth: () => Promise.resolve(false),
  });
  const others = rows.filter((r) => normalizeFsPath(r.root) !== myRootN);
  const states = await probeManyInstanceProcessStates(
    others.map((r) => ({ instanceId: r.instanceId, instanceRoot: r.root })),
    probeOpts,
  );
  const conflicts: PortCollisionConflict[] = [];
  for (let i = 0; i < others.length; i++) {
    const row = others[i]!;
    const st = states[i]!;
    if (!st.isRunning || st.cwd === null || st.serverPid === null) continue;
    if (row.serverPort !== myServerPort) continue;
    if (normalizeFsPath(st.cwd) !== myCwdN) {
      conflicts.push({ label: row.displayId, conflictingCwd: st.cwd });
    }
  }
  const selfState = await probeInstanceProcessState(selfInstanceId, myInstanceRoot, probeOpts);
  if (
    selfState.isRunning &&
    selfState.cwd !== null &&
    normalizeFsPath(selfState.cwd) !== myCwdN
  ) {
    conflicts.push({
      label: rows.find((r) => normalizeFsPath(r.root) === myRootN)?.displayId ?? "(this instance)",
      conflictingCwd: selfState.cwd,
    });
  }
  return conflicts;
}

function printCollisionTable(conflicts: PortCollisionConflict[], myPort: number): void {
  console.error(`[dev-stack] Port ${myPort} is already in use by another worktree:\n`);
  console.error(
    `${"instance / label".padEnd(28)} ${"cwd".padEnd(60)}`,
  );
  console.error(`${"-".repeat(28)} ${"-".repeat(60)}`);
  for (const c of conflicts) {
    console.error(`${c.label.padEnd(28)} ${c.conflictingCwd.padEnd(60)}`);
  }
  console.error("\nSuggested actions:");
  console.error("  • bun run dev:cleanup-instances (report), then dev:delete-instance <exact-id> --yes");
  console.error("  • bun run dev:delete-instance <conflicting-instance> -- --yes");
  console.error("  • Use a different --instance for this worktree\n");
}

type DevStackResolvedInstance = ReturnType<typeof resolveInstance>;

function displayInstanceId(id: string): string {
  return id === "" ? "(default)" : id;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export function resolveElectronServerUrl(inst: DevStackResolvedInstance): string {
  const explicitServerUrl = trimTrailingSlash(inst.server.url);
  try {
    const explicitHost = new URL(explicitServerUrl).hostname;
    const bindIsLocal = isLoopbackHostname(inst.server.host) ||
      inst.server.host === "0.0.0.0" || inst.server.host === "::";
    // The descriptor URL is the instance's canonical public identity. Keep a
    // local descriptor's exact loopback spelling so Desktop does not turn
    // localhost into 127.0.0.1 and accidentally select another trusted slot.
    if (bindIsLocal && isLoopbackHostname(explicitHost)) return explicitServerUrl;
  } catch {
    // Malformed/stale descriptors retain the effective live-URL fallback.
  }
  return resolveEffectiveServerUrl(inst);
}

function printResolvedPlan(
  resolvedId: string,
  inst: DevStackResolvedInstance,
  instanceRoot: string,
  cwd: string,
  merged: DevStackOptions,
): void {
  if (merged.asJson) return;
  const serverUrl = trimTrailingSlash(inst.server.url);
  console.log(
    `[dev-stack] plan — instance=${displayInstanceId(resolvedId)} root=${instanceRoot} cwd=${cwd}`,
  );
  console.log(
    `[dev-stack] plan — server=${serverUrl} host=${inst.server.host}:${inst.server.port} workbench=${inst.workbench.url}`,
  );
  if (merged.electron === true) {
    console.log(`[dev-stack] plan — electron connect URL=${resolveElectronServerUrl(inst)}`);
  }
  if (merged.noInfra === true) {
    console.log(
      "[dev-stack] plan — --no-infra: assuming Postgres and Logto are already healthy.",
    );
  }
}

function mergeArgvOptions(args: string[], base: DevStackOptions): DevStackOptions {
  return {
    ...base,
    electron: base.electron ?? hasFlag(args, "--electron"),
    mobileWeb: base.mobileWeb ?? hasFlag(args, "--mobile-web"),
    noBuild: base.noBuild ?? hasFlag(args, "--no-build"),
    noInfra: base.noInfra ?? hasFlag(args, "--no-infra"),
    office: base.office ?? hasFlag(args, "--office"),
    asJson: base.asJson ?? hasFlag(args, "--json"),
    cloneDefault: base.cloneDefault ?? hasFlag(args, "--clone-default"),
    refreshCloneSeed: base.refreshCloneSeed ?? hasFlag(args, "--refresh-clone-seed"),
    iKnowWhatIAmDoing: base.iKnowWhatIAmDoing ?? hasFlag(args, "--i-know-what-i-am-doing"),
  };
}

async function provisionCanonicalDefaultTarget(
  targetId: string,
  home: string,
  refresh: boolean,
  office: boolean,
  asJson: boolean,
): Promise<CloneDefaultProvisionResult> {
  const request = selectCloneMaterialization({ userHome: home, source: { kind: "canonical-default" }, targetId });
  const lineage = await readCheckoutMigrationLineage(join(NAUTILO_REPO_ROOT, "packages/db/src/migrations"));
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: NAUTILO_REPO_ROOT, encoding: "utf8" });
  if (rev.status !== 0 || !/^[a-f0-9]{40}$/.test(rev.stdout.trim())) throw new Error("Cannot determine checkout commit for clone seed provenance");
  const seedRoot = defaultCloneSeedRoot(home);
  const prepared = await prepareCanonicalDefaultCloneSeed({
    source: request.source, root: seedRoot, forceRefresh: refresh,
    provenance: { checkoutCommitSha: rev.stdout.trim(), lineage: {
      appliedMigrationCount: lineage.length, lastAppliedIndex: lineage.at(-1)?.index ?? -1,
      sha256: createHash("sha256").update(JSON.stringify(lineage)).digest("hex"),
    } },
    capture: createCanonicalDefaultSeedCapture(seedRoot),
    cleanupCapture: () => cleanupCanonicalDefaultSeedCapture(seedRoot),
    sourceEvidence: createCanonicalDefaultSourceEvidence(request.source),
  });
  if (!asJson) console.log(formatCanonicalDefaultCloneSeedReport(prepared));
  const code = await materializeClone(
    request,
    { seed: prepared.seed, freshness: prepared.freshness },
    { mode: "provision", office, quiet: asJson },
  );
  return { code, seed: canonicalDefaultCloneSeedReport(prepared) };
}

/** All target-presence guards run before canonical-default seed capture. */
export function preflightCanonicalDefaultTarget(input: {
  readonly targetId: string;
  readonly home: string;
}, deps: {
  readonly inspectTargetState?: typeof inspectCloneTargetState;
} = {}): number {
  const request = selectCloneMaterialization({
    userHome: input.home,
    source: { kind: "canonical-default" },
    targetId: input.targetId,
  });
  try {
    assertCloneTargetAbsent((deps.inspectTargetState ?? inspectCloneTargetState)({
      root: request.target.root,
      projectName: request.target.projectName,
      volumeNames: [
        `${request.target.projectName}_nautilo_pgdata`,
        `${request.target.projectName}_pgdata`,
      ],
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Clone target is not wholly absent";
    throw new Error(
      `${detail}. Reuse it with bun run dev-stack --instance ${input.targetId}, ` +
      `or remove it explicitly with bun run dev:delete-instance ${input.targetId} -- --yes.`,
    );
  }
  // Do not call resolveInstance here: resolving an absent named target writes
  // instance.json. The materializer performs the canonical collision-aware
  // port allocation as its first target write; dev-stack rechecks collisions
  // before starting the server.
  return 0;
}

/**
 * D202 — dev-stack may target (default) from the canonical `nautilo` checkout
 * for dogfood; feature worktrees need explicit opt-in when resolving to default.
 */
export function evaluateDevStackDefaultTargetGuard(
  resolvedInstanceId: string,
  cwd: string,
  opts: { iKnowWhatIAmDoing?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const worktreeCheckout = classifyWorktreeCheckout(cwd);
  return evaluateDefaultInstanceMutationGuard({
    commandName: "dev-stack",
    instanceId: resolvedInstanceId,
    cwd,
    isDryRunOrReadOnly: worktreeCheckout === "canonical",
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
}

function streamFromSpawnOut(
  out: number | ReadableStream<Uint8Array> | undefined,
): ReadableStream<Uint8Array> | null {
  if (out instanceof ReadableStream) return out;
  return null;
}

type BunSpawn = typeof Bun.spawn;

/**
 * Detect only already-settled child exits. This is intentionally not a full
 * Electron readiness probe; it prevents an immediate nonzero launch failure
 * from being reported as ready without introducing an arbitrary sleep.
 */
async function immediateChildExitCode(child: ReturnType<BunSpawn>): Promise<number | null> {
  // Bun exposes this synchronously once the child has exited. Keep the
  // microtask fallback for the lightweight subprocess fixtures used here.
  if (typeof child.exitCode === "number") return child.exitCode;
  return Promise.race([child.exited, Promise.resolve(null)]);
}

interface ElectronInstallState {
  ok: boolean;
  pathFile: string;
  binaryPath: string | null;
  reason: string;
}

const ELECTRON_UNZIP_REPAIR_SCRIPT = `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { downloadArtifact } = require("@electron/get");

const electronPackageDir = process.env.ELECTRON_PACKAGE_DIR;
if (!electronPackageDir) {
  console.error("ELECTRON_PACKAGE_DIR is required");
  process.exit(1);
}

function getPlatformPath(platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error("Electron builds are not available on platform: " + platform);
  }
}

(async () => {
  const { version } = require(path.join(electronPackageDir, "package.json"));
  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  if (platform === "darwin" && process.platform === "darwin" && arch === "x64" && process.env.npm_config_arch === undefined) {
    try {
      if (childProcess.execSync("sysctl -in sysctl.proc_translated").toString().trim() === "1") arch = "arm64";
    } catch {
      // Ignore Rosetta probe failures; Electron's installer does the same.
    }
  }
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    force: true,
    cacheRoot: process.env.electron_config_cache,
    checksums: require(path.join(electronPackageDir, "checksums.json")),
    platform,
    arch,
  });
  const distPath = path.join(electronPackageDir, "dist");
  fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });
  childProcess.execFileSync("unzip", ["-q", zipPath, "-d", distPath], { stdio: "inherit" });
  fs.writeFileSync(path.join(electronPackageDir, "path.txt"), getPlatformPath(platform));
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

function inspectElectronInstall(electronPackageDir: string): ElectronInstallState {
  const pathFile = join(electronPackageDir, "path.txt");
  if (!existsSync(pathFile)) {
    return { ok: false, pathFile, binaryPath: null, reason: "missing path.txt" };
  }
  const relPath = readFileSync(pathFile, "utf8").trim();
  if (relPath.length === 0) {
    return { ok: false, pathFile, binaryPath: null, reason: "empty path.txt" };
  }
  const binaryPath = join(electronPackageDir, "dist", relPath);
  if (!existsSync(binaryPath)) {
    return { ok: false, pathFile, binaryPath, reason: "missing Electron binary" };
  }
  return { ok: true, pathFile, binaryPath, reason: "ok" };
}

async function ensureElectronInstallReady(
  electronPackageDir: string,
  spawnFn: BunSpawn,
  logStream: NodeJS.WritableStream,
  echo: boolean,
): Promise<boolean> {
  const before = inspectElectronInstall(electronPackageDir);
  if (before.ok) return true;

  const installScript = join(electronPackageDir, "install.js");
  if (!existsSync(installScript)) {
    console.error(`[dev-stack] Electron install is incomplete (${before.reason}) and ${installScript} is missing.`);
    return false;
  }

  rmSync(join(electronPackageDir, "dist"), { recursive: true, force: true });
  rmSync(before.pathFile, { force: true });

  console.log(`[dev-stack] Electron install is incomplete (${before.reason}); running Electron installer once...`);
  const installProc = spawnFn(["node", installScript], {
    cwd: electronPackageDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  await Promise.all([
    drainStreamWithPrefix(streamFromSpawnOut(installProc.stdout), "[electron-install] ", logStream, echo),
    drainStreamWithPrefix(streamFromSpawnOut(installProc.stderr), "[electron-install] ", logStream, echo),
  ]);
  const installExit = await installProc.exited;
  if (installExit !== 0) {
    console.error(`[dev-stack] Electron installer failed (exit ${installExit}).`);
  }

  const afterInstaller = inspectElectronInstall(electronPackageDir);
  if (afterInstaller.ok) return true;

  console.log(
    `[dev-stack] Electron installer did not produce a runnable binary (${afterInstaller.reason}); falling back to system unzip repair...`,
  );
  const repairProc = spawnFn(["node", "-e", ELECTRON_UNZIP_REPAIR_SCRIPT], {
    cwd: electronPackageDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ELECTRON_PACKAGE_DIR: electronPackageDir,
    },
  });
  await Promise.all([
    drainStreamWithPrefix(streamFromSpawnOut(repairProc.stdout), "[electron-repair] ", logStream, echo),
    drainStreamWithPrefix(streamFromSpawnOut(repairProc.stderr), "[electron-repair] ", logStream, echo),
  ]);
  const repairExit = await repairProc.exited;
  if (repairExit !== 0) {
    console.error(`[dev-stack] Electron unzip repair failed (exit ${repairExit}).`);
    return false;
  }

  const after = inspectElectronInstall(electronPackageDir);
  if (after.ok) return true;

  console.error(`[dev-stack] Electron install is still incomplete after repair (${after.reason}).`);
  console.error(`[dev-stack] path.txt: ${after.pathFile}`);
  if (after.binaryPath !== null) console.error(`[dev-stack] expected binary: ${after.binaryPath}`);
  console.error("[dev-stack] Try `node node_modules/electron/install.js` from the repo root, then rerun dev-stack.");
  return false;
}

/**
 * Orchestrated dev stack. Returns a process exit code (0 = clean shutdown / success path).
 */
export async function devStackCmd(args: string[], opts: DevStackOptions = {}): Promise<number> {
  if (hasHelpFlag(args)) {
    console.log(formatHelp(DEV_STACK_HELP));
    return 0;
  }
  const spawnFn: BunSpawn = opts.spawn ?? Bun.spawn;
  const fetchImpl = opts.fetch ?? fetch;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const workbenchDist = opts.workbenchDist ?? join(NAUTILO_REPO_ROOT, "apps/workbench/dist");
  const workbenchDistIndex = join(workbenchDist, "index.html");

  const merged = mergeArgvOptions(args, opts);
  const savedInstance = process.env["NAUTILO_INSTANCE_ID"];
  const savedMobileWebDist = process.env["NAUTILO_MOBILE_WEB_DIST"];
  const resolvedId = resolveInstanceIdForDevStack(
    args,
    env,
    cwd,
    merged.instance !== undefined ? { instance: merged.instance } : undefined,
  );
  process.env["NAUTILO_INSTANCE_ID"] = resolvedId;

  const restoreInstanceEnv = (): void => {
    if (savedInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    if (savedMobileWebDist === undefined) delete process.env["NAUTILO_MOBILE_WEB_DIST"];
    else process.env["NAUTILO_MOBILE_WEB_DIST"] = savedMobileWebDist;
  };

  const defaultGuard = evaluateDevStackDefaultTargetGuard(resolvedId, cwd, {
    env,
    ...(merged.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!defaultGuard.allowed) {
    console.error(defaultGuard.message);
    restoreInstanceEnv();
    return 2;
  }
  if (merged.refreshCloneSeed && !merged.cloneDefault) {
    console.error("[dev-stack] --refresh-clone-seed requires --clone-default");
    restoreInstanceEnv();
    return 2;
  }
  if (merged.cloneDefault && (resolvedId === "" || merged.noInfra || merged.noBuild)) {
    console.error("[dev-stack] --clone-default requires an absent named target and does not support --no-infra or --no-build.");
    restoreInstanceEnv();
    return 2;
  }
  let infraAlreadyReady = false;
  let cloneDefaultSeed: CloneDefaultSeedReport | null = null;

  let serverStartProc: ReturnType<BunSpawn> | null = null;
  let electronProc: ReturnType<BunSpawn> | null = null;
  let shuttingDown = false;
  let ownedServerLease: DevStackServerOwnershipLease | null = null;
  let ownedServerPidPath: string | null = null;

  const cleanupSpawnedChildren = (): void => {
    if (serverStartProc !== null) {
      try {
        const pid = serverStartProc.pid;
        if (typeof pid === "number" && pid > 0) killPidBestEffort(pid);
      } catch {
        /* ignore */
      }
    }
    if (ownedServerPidPath !== null) {
      const ownedServerPid = ownedServerPidForCleanup(ownedServerLease, ownedServerPidPath);
      if (ownedServerPid !== null) killPidBestEffort(ownedServerPid);
    }
    releaseServerOwnership(ownedServerLease);
    ownedServerLease = null;
    ownedServerPidPath = null;
    if (electronProc !== null) {
      try {
        const pid = electronProc.pid;
        if (typeof pid === "number" && pid > 0) killPidBestEffort(pid);
      } catch {
        /* ignore */
      }
    }
  };

  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupSpawnedChildren();
    restoreInstanceEnv();
    process.exit(130);
  };

  try {
    // Readiness must run before clone provisioning, port checks, or infra start:
    // --no-build promises to leave no partial stack behind when generated
    // Sheets artifacts are unusable.
    const readSheetsReadiness = opts.sheetsReadiness
      ?? (() => inspectSheetsReadiness({ repoRoot: NAUTILO_REPO_ROOT }));
    let sheetsReadiness: SheetsReadiness;
    try {
      sheetsReadiness = await readSheetsReadiness();
    } catch (error) {
      console.error(
        `[dev-stack] could not validate the generated Sheets engine: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("[dev-stack] Run `bun run sheets:prepare`, then retry `bun run dev-stack`.");
      return 1;
    }
    if (!sheetsReadiness.ready) {
      if (merged.noBuild) {
        console.error(
          `[dev-stack] --no-build requires a current generated Sheets engine (${sheetsReadiness.reason}: ${sheetsReadiness.detail}).`,
        );
        console.error("[dev-stack] Run `bun run sheets:prepare`, then retry the original dev-stack command.");
        return 1;
      }
      if (!merged.asJson) {
        console.log(
          `[dev-stack] generated Sheets engine needs preparation (${sheetsReadiness.reason}); running sheets:prepare…`,
        );
      }
      const sheetsPrepareProc = spawnFn(["bun", "run", "sheets:prepare"], {
        cwd: NAUTILO_REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      await Promise.all([
        drainStreamWithPrefix(streamFromSpawnOut(sheetsPrepareProc.stdout), "[sheets-prepare] ", undefined, !merged.asJson),
        drainStreamWithPrefix(streamFromSpawnOut(sheetsPrepareProc.stderr), "[sheets-prepare] ", undefined, !merged.asJson),
      ]);
      const sheetsPrepareExit = await sheetsPrepareProc.exited;
      if (sheetsPrepareExit !== 0) {
        console.error(`[dev-stack] Sheets preparation failed (exit ${sheetsPrepareExit}).`);
        console.error("[dev-stack] Run `bun run sheets:prepare` directly to inspect the failure, then retry dev-stack.");
        return sheetsPrepareExit;
      }
      try {
        sheetsReadiness = await readSheetsReadiness();
      } catch (error) {
        console.error(
          `[dev-stack] could not revalidate the generated Sheets engine after preparation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
      if (!sheetsReadiness.ready) {
        console.error(
          `[dev-stack] Sheets preparation completed but the generated engine is still invalid (${sheetsReadiness.reason}: ${sheetsReadiness.detail}).`,
        );
        console.error("[dev-stack] Run `bun run sheets:prepare` directly and inspect packages/first-party-apps/spreadsheet/engine/provenance.json.");
        return 1;
      }
    } else if (!merged.asJson) {
      console.log("[dev-stack] reusing current generated Sheets engine.");
    }

    if (merged.cloneDefault) {
      const preflight = opts.cloneDefaultPreflight ?? ((target: string) => Promise.resolve(preflightCanonicalDefaultTarget({
        targetId: target,
        home: homeDir,
      })));
      const preflightCode = await preflight(resolvedId);
      if (preflightCode !== 0) return preflightCode;
      const provision = opts.cloneDefaultProvision ?? ((target: string, provisionOptions: { readonly office: boolean; readonly asJson: boolean }) =>
        provisionCanonicalDefaultTarget(target, homeDir, merged.refreshCloneSeed === true, provisionOptions.office, provisionOptions.asJson));
      const provisioned = await provision(resolvedId, { office: merged.office === true, asJson: merged.asJson === true });
      const code = typeof provisioned === "number" ? provisioned : provisioned.code;
      if (typeof provisioned !== "number") cloneDefaultSeed = provisioned.seed;
      if (code !== 0) return code;
      infraAlreadyReady = true;
    }
    const instEarly = resolveInstance();
    const myRoot = resolveNautiloRootDir();
    const myPort = instEarly.server.port;
    const myCwd = cwd;
    printResolvedPlan(resolvedId, instEarly, myRoot, myCwd, merged);

    const collisions = await detectDevStackPortCollisions(
      myRoot,
      myPort,
      myCwd,
      homeDir,
      instEarly.instanceId,
      undefined,
    );
    if (collisions.length > 0) {
      printCollisionTable(collisions, myPort);
      return 1;
    }

    if (!merged.noInfra && !infraAlreadyReady) {
      const runInfraStart = merged.infraStart ?? infraStart;
      const infraCode = await runInfraStart({
        ...(merged.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
        ...(merged.office === true ? { office: true } : {}),
        ...(merged.suppressBootstrapClaimInvite === true ? { suppressBootstrapClaimInvite: true } : {}),
      });
      if (infraCode !== 0) return infraCode;
    }

    const inst = resolveInstance();
    const instanceRoot = resolveNautiloRootDir();
    mkdirSync(join(instanceRoot, "logs"), { recursive: true });
    const devStackLogPath = join(instanceRoot, "logs", "dev-stack.log");
    const logStream = createWriteStream(devStackLogPath, { flags: "a" });
    let logStreamClosed = false;
    const closeLogStream = async (): Promise<void> => {
      if (logStreamClosed) return;
      logStreamClosed = true;
      await new Promise<void>((resolve) => {
        // `end()` flushes any pending writes then closes. Wrapping it in
        // an awaited Promise prevents the stream from racing with test
        // teardown (`rmSync` on the tmp instanceRoot) which previously
        // surfaced as ENOENT "Unhandled error between tests" on CI.
        logStream.end(() => resolve());
      });
    };
    // Silence "Unhandled error" warnings from late stream errors; the
    // close-await above handles the legitimate flush path.
    logStream.on("error", () => {
      /* swallow — stream-error during teardown is benign here */
    });
    const echo = !merged.asJson;

    const needsBuild =
      !merged.noBuild && (merged.electron === true || !isWorkbenchDistFresh(workbenchDistIndex));
    if (needsBuild) {
      if (!merged.asJson) {
        console.log("[dev-stack] running workbench production build (with workspace deps)…");
      }
      const buildProc = spawnFn(["bunx", "turbo", "run", "build", "--filter=@nautilo/workbench"], {
        cwd: NAUTILO_REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      await Promise.all([
        drainStreamWithPrefix(streamFromSpawnOut(buildProc.stdout), "[build] ", logStream, echo),
        drainStreamWithPrefix(streamFromSpawnOut(buildProc.stderr), "[build] ", logStream, echo),
      ]);
      const buildExit = await buildProc.exited;
      if (buildExit !== 0) {
        console.error(`[dev-stack] workbench build failed (exit ${buildExit})`);
        await closeLogStream();
        return buildExit;
      }
      const workbenchDistDir = workbenchDist;
      const indexHtmlPath = workbenchDistIndex;
      if (!existsSync(indexHtmlPath)) {
        const distDirPresent = existsSync(workbenchDistDir);
        console.error(
          "[dev-stack] apps/workbench/dist/index.html not found after workbench build reported success.",
        );
        console.error(`[dev-stack] Expected path: ${indexHtmlPath}`);
        console.error(
          `[dev-stack] Parent directory (apps/workbench/dist) exists: ${distDirPresent ? "yes" : "no"}`,
        );
        console.error(`[dev-stack] Workbench build exit code: ${buildExit} (dist still missing).`);
        console.error(
          "[dev-stack] Remediation: run `bunx turbo run build --filter=@nautilo/workbench` manually to surface the real error (workspace dependency build, Vite cache miss, out-of-disk, permissions, partial writes, turbo cache, or misconfigured outDir).",
        );
        return 1;
      }
    }

    if (merged.mobileWeb === true) {
      if (merged.noBuild) {
        if (!existsSync(MOBILE_WEB_DIST_INDEX)) {
          console.error(
            `[dev-stack] --mobile-web with --no-build requires ${MOBILE_WEB_DIST_INDEX}. Run \`bun run mobile:web:export\` first.`,
          );
          await closeLogStream();
          return 1;
        }
      } else {
        if (!merged.asJson) {
          console.log("[dev-stack] running canonical Mobile Web export…");
        }
        const mobileWebExportProc = spawnFn(["bun", "run", "mobile:web:export"], {
          cwd: NAUTILO_REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        await Promise.all([
          drainStreamWithPrefix(streamFromSpawnOut(mobileWebExportProc.stdout), "[mobile-web] ", logStream, echo),
          drainStreamWithPrefix(streamFromSpawnOut(mobileWebExportProc.stderr), "[mobile-web] ", logStream, echo),
        ]);
        const mobileWebExportExit = await mobileWebExportProc.exited;
        if (mobileWebExportExit !== 0) {
          console.error(`[dev-stack] Mobile Web export failed (exit ${mobileWebExportExit})`);
          await closeLogStream();
          return mobileWebExportExit;
        }
        if (!existsSync(MOBILE_WEB_DIST_INDEX)) {
          console.error(
            `[dev-stack] ${MOBILE_WEB_DIST_INDEX} not found after Mobile Web export reported success. Run \`bun run mobile:web:export\` to surface the export error.`,
          );
          await closeLogStream();
          return 1;
        }
      }
      // The server reads this once at boot. Never infer or persist a Mobile
      // path: the explicit flag mounts only the canonical verified export.
      process.env["NAUTILO_MOBILE_WEB_DIST"] = MOBILE_WEB_DIST;
    }

    // D153 Phase 3.B post-smoke fix (2026-05-16) — NAUTILO_WORKBENCH_DIST
    // and NAUTILO_HOST MUST be set in process.env BEFORE we spawn
    // server-start, because the server reads them once at boot.
    // `fastify-static` mounts `/` only when NAUTILO_WORKBENCH_DIST is
    // defined; without it the server returns the JSON 404 for `GET /`
    // and Phase 2.2's cold-boot bootstrap dutifully redirects the
    // renderer to that 404. Setting these AFTER the spawn (which the
    // pre-fix code did) was a no-op for the server child but worked
    // for the Electron child via process.env inheritance — which is
    // why every unit test passed and the bug only surfaced in live smoke.
    process.env["NAUTILO_HOST"] = process.env["NAUTILO_HOST"] ?? "127.0.0.1";
    process.env["NAUTILO_WORKBENCH_DIST"] = workbenchDist;
    process.env["NAUTILO_OFFICE_ENABLED"] = merged.office === true ? "true" : "false";

    persistWorkbenchDistToInstanceJson(instanceRoot, workbenchDist);
    if (!merged.asJson) {
      console.log(`[dev-stack] persisted workbenchDist to instance.json (${workbenchDist})`);
    }

    // D448 — prepare Desktop's FFmpeg, host apply-patch, ripgrep, and
    // Electron bundle once before server-start. `dev:launch` below only runs
    // Electron, so this cannot be duplicated behind the ready boundary.
    if (merged.electron === true) {
      const desktopPrepareProc = spawnFn(["bun", "run", "dev:prepare"], {
        cwd: DESKTOP_DIR,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NAUTILO_INSTANCE_ID: resolvedId,
          NAUTILO_HOST: process.env["NAUTILO_HOST"] ?? "127.0.0.1",
          NAUTILO_PROFILE: process.env["NAUTILO_PROFILE"] ?? "",
        },
      });
      await Promise.all([
        drainStreamWithPrefix(streamFromSpawnOut(desktopPrepareProc.stdout), "[desktop-prepare] ", logStream, echo),
        drainStreamWithPrefix(streamFromSpawnOut(desktopPrepareProc.stderr), "[desktop-prepare] ", logStream, echo),
      ]);
      const desktopPrepareExit = await desktopPrepareProc.exited;
      if (desktopPrepareExit !== 0) {
        console.error(`[dev-stack] Desktop preparation failed (exit ${desktopPrepareExit}).`);
        console.error(
          "[dev-stack] Remediation: fix the reported dev:prepare failure, then rerun `bun run dev:prepare` from apps/desktop. If build:apply-patch reports Cargo is missing, install the Rust toolchain and Cargo (https://rustup.rs).",
        );
        await closeLogStream();
        return desktopPrepareExit;
      }
    }

    const serverPidPath = join(instanceRoot, "server.pid");
    // Snapshot before server-start.  It may succeed by adopting a pre-existing
    // server; such a stack must never own (or later terminate) that daemon.
    // The process-state probe also catches a foreign server that has no PID
    // file yet but is already listening on the instance port.
    const serverBeforeStart = await probeInstanceProcessState(resolvedId, instanceRoot);
    const pidBeforeStart = parsePidFile(serverPidPath);
    if (
      !serverBeforeStart.isRunning &&
      (pidBeforeStart === null || !isPidAlive(pidBeforeStart))
    ) {
      recoverStaleServerOwnership(instanceRoot, resolvedId, serverBeforeStart.isRunning);
      ownedServerLease = tryAcquireServerOwnership(instanceRoot, resolvedId);
      ownedServerPidPath = ownedServerLease === null ? null : serverPidPath;
    }

    const serverArgs = ["bun", NAUTILO_DEV_ENTRY, "server-start", "--require-workbench-dist"];
    if (resolvedId !== "") {
      serverArgs.push("--instance", resolvedId);
    }
    serverStartProc = spawnFn(serverArgs, {
      cwd: NAUTILO_REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NAUTILO_INSTANCE_ID: resolvedId,
      },
    });
    await Promise.all([
      drainStreamWithPrefix(streamFromSpawnOut(serverStartProc.stdout), "[server] ", logStream, echo),
      drainStreamWithPrefix(streamFromSpawnOut(serverStartProc.stderr), "[server] ", logStream, echo),
    ]);
    const startExit = await serverStartProc.exited;
    serverStartProc = null;
    if (startExit !== 0) {
      releaseServerOwnership(ownedServerLease);
      ownedServerLease = null;
      ownedServerPidPath = null;
      console.error(`[dev-stack] server-start failed (exit ${startExit})`);
      await closeLogStream();
      return startExit;
    }

    const serverDaemonPidAfterStart = parsePidFile(serverPidPath);
    if (
      ownedServerLease !== null &&
      (serverDaemonPidAfterStart === null || !recordOwnedServerPid(ownedServerLease, serverDaemonPidAfterStart))
    ) {
      // We cannot prove which daemon started when no exact post-start PID was
      // published.  Fail closed: keep the server available but treat this
      // dev-stack as an adopter for teardown purposes.
      releaseServerOwnership(ownedServerLease);
      ownedServerLease = null;
      ownedServerPidPath = null;
    }

    const healthy = await waitForServerHealth(
      inst.server.host,
      inst.server.port,
      fetchImpl,
      merged.healthTimeoutMs ?? HEALTH_WAIT_MS,
    );
    if (!healthy) {
      const waitedMs = merged.healthTimeoutMs ?? HEALTH_WAIT_MS;
      const probeUrl = buildHealthProbeUrl(inst.server.host, inst.server.port);
      console.error(
        `[dev-stack] timed out after ${waitedMs}ms waiting for ${probeUrl}`,
      );
      cleanupSpawnedChildren();
      await closeLogStream();
      return 1;
    }

    // The server reads its static mount once at boot. One bounded probe after
    // the ordinary ready check catches both a stale newly started --no-build
    // export and an adopted/raced daemon that could not inherit this process's
    // just-built Mobile environment. Cleanup remains ownership-scoped below.
    if (merged.mobileWeb === true) {
      const mobileWebUrl = buildHealthProbeUrl(inst.server.host, inst.server.port)
        .replace(/\/health$/, "/mobile/");
      try {
        const mobileWebResponse = await fetchImpl(mobileWebUrl, {
          signal: AbortSignal.timeout(2_000),
          ...({ tls: { rejectUnauthorized: false } } as Partial<RequestInit>),
        });
        if (mobileWebResponse.status !== 200) {
          console.error(
            `[dev-stack] server returned ${mobileWebResponse.status} for /mobile/. Fix or rebuild Mobile Web, restart this server, then rerun with --mobile-web.`,
          );
          cleanupSpawnedChildren();
          await closeLogStream();
          return 1;
        }
      } catch {
        console.error(
          "[dev-stack] could not verify /mobile/. Fix or rebuild Mobile Web, restart this server, then rerun with --mobile-web.",
        );
        cleanupSpawnedChildren();
        await closeLogStream();
        return 1;
      }
    }

    const runRuntimeAcceptance =
      opts.runtimeAcceptance ??
      // Unit tests inject a fake process spawner and can opt into this seam
      // explicitly. Production always runs the real shared D427 gate.
      (opts.spawn === undefined
        ? runLocalRuntimeAcceptanceExitCode
        : () => Promise.resolve(0));
    const acceptanceExit = await runRuntimeAcceptance((message) => {
      if (!merged.asJson) console.log(`[dev-stack] ${message}`);
    });
    if (acceptanceExit !== 0) {
      console.error(
        `[dev-stack] authoritative runtime acceptance failed (exit ${acceptanceExit}); refusing ready state`,
      );
      cleanupSpawnedChildren();
      await closeLogStream();
      return acceptanceExit;
    }

    const serverUrl = inst.server.url.replace(/\/$/, "");
    // NAUTILO_HOST + NAUTILO_WORKBENCH_DIST already set above (before
    // the server-start spawn) — see the D153 Phase 3.B post-smoke fix
    // comment. They're inherited by the Electron child via process.env
    // spread.

    if (merged.electron === true) {
      const runDesktopOfficeCliPreflight =
        opts.desktopOfficeCliPreflight ??
        ((repoRoot: string) => ensureDesktopOfficeCliProvisioned(repoRoot));
      if (!runDesktopOfficeCliPreflight(NAUTILO_REPO_ROOT)) {
        cleanupSpawnedChildren();
        await closeLogStream();
        return 1;
      }
      const runDesktopOpenHuePreflight =
        opts.desktopOpenHuePreflight ??
        ((repoRoot: string) => ensureDesktopOpenHueProvisioned(repoRoot));
      if (!runDesktopOpenHuePreflight(NAUTILO_REPO_ROOT)) {
        cleanupSpawnedChildren();
        await closeLogStream();
        return 1;
      }
      const electronReady = await ensureElectronInstallReady(
        merged.electronPackageDir ?? resolveElectronPackageDir(),
        spawnFn,
        logStream,
        echo,
      );
      if (!electronReady) {
        cleanupSpawnedChildren();
        await closeLogStream();
        return 1;
      }
      const serverWsUrl = resolveElectronServerUrl(inst);
      electronProc = spawnFn(["bun", "run", "dev:launch"], {
        cwd: DESKTOP_DIR,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NAUTILO_INSTANCE_ID: resolvedId,
          NAUTILO_HOST: process.env["NAUTILO_HOST"] ?? "127.0.0.1",
          NAUTILO_PROFILE: process.env["NAUTILO_PROFILE"] ?? "",
          NAUTILO_CONNECT_SERVER_URL: serverWsUrl,
        },
      });
      const immediateExit = await immediateChildExitCode(electronProc);
      if (immediateExit !== null && immediateExit !== 0) {
        console.error(`[dev-stack] Electron exited before it became ready (exit ${immediateExit}).`);
        cleanupSpawnedChildren();
        await closeLogStream();
        return immediateExit;
      }
    }

    const serverDaemonPid = parsePidFile(serverPidPath);

    let electronDrain: Promise<void> = Promise.resolve();
    if (electronProc !== null) {
      electronDrain = Promise.all([
        drainStreamWithPrefix(streamFromSpawnOut(electronProc.stdout), "[electron] ", logStream, echo),
        drainStreamWithPrefix(streamFromSpawnOut(electronProc.stderr), "[electron] ", logStream, echo),
      ]).then(() => {
        return undefined;
      });
    }

    const summary = {
      instance: resolvedId === "" ? "(default)" : resolvedId,
      serverPort: inst.server.port,
      workbenchPort: inst.workbench.port,
      serverUrl,
      workbenchDist,
      serverPid: serverDaemonPid,
      electronPid: typeof electronProc?.pid === "number" ? electronProc.pid : null,
      logPath: devStackLogPath,
      ...(cloneDefaultSeed === null ? {} : { cloneDefault: cloneDefaultSeed }),
    };

    if (merged.asJson) {
      console.log(JSON.stringify(summary));
    } else {
      console.log(`[dev-stack] ready — server ${serverUrl} (pid=${serverDaemonPid ?? "?"})`);
      if (merged.electron) {
        console.log(`[dev-stack] electron pid=${electronProc?.pid ?? "?"}`);
      }
      console.log(`[dev-stack] logs also appended to ${devStackLogPath}`);
      console.log("[dev-stack] Ctrl-C stops spawned children only (server + electron); infra untouched.");
    }

    if (merged.returnWhenReady === true) {
      await closeLogStream();
      return 0;
    }

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    if (merged.electron && electronProc !== null) {
      const electronExit = await electronProc.exited;
      await electronDrain;
      shuttingDown = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      cleanupSpawnedChildren();
      await closeLogStream();
      return electronExit;
    }

    return await new Promise<number>(() => {
      /* server-only: never resolves until SIGINT/SIGTERM (onSignal exits the process). */
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    cleanupSpawnedChildren();
    return 1;
  } finally {
    restoreInstanceEnv();
  }
}
