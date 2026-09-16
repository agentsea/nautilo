import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getValueFromEntries, parseEnvFile } from "@nautilo/config-guard";

import {
  buildRemoteRuntimeAcceptanceTransport,
  composeProjectName,
  localInstanceRootDir,
  resolveServerBaseUrl,
  resolveSourceBuildIdentity,
  runLocal,
  type ComposeDriver,
  type ComposeDriverDeps,
  type ComposeDriverProfile,
  type FirstDeployConsumeContext,
  type MaintenanceDrainHandle,
} from "@nautilo/compose-driver";
import {
  buildComposeMaintenanceDrain,
  buildComposeReleaseReadiness,
  createProductionComposeDriver,
} from "@nautilo/compose-lifecycle";
export {
  DEFAULT_MAINTENANCE_HARD_LEASE_MS,
  maintenanceHardLeaseMs,
  MAINTENANCE_POST_DEADLINE_BUFFER_MS,
} from "@nautilo/compose-lifecycle";
import {
  markDeployConfigConsumed,
  readDeployConfigConsumedAt,
  resolveInstance,
} from "@nautilo/config";
import {
  consumeDeployConfigProviders,
  parseDeployConfigFromPath,
  resolveDeployConfig,
  type EnvLookup,
  type ResolvedDeployConfig,
} from "@nautilo/deploy-config";

import { readInstanceServerUrl } from "./api-client.ts";
import {
  cancelMaintenanceDrain,
  cancelMaintenanceWork,
  completeMaintenanceDrain,
  enterMaintenanceDrain,
  readMaintenanceStatus,
  renewMaintenanceLease,
  transitionMaintenanceApplying,
} from "./api-client.ts";
import { readBootstrapToken, writeBootstrapToken } from "./bootstrap-tokens.ts";
import { loadProfile } from "./profile-schema.ts";
import { readActiveProfileName } from "./profile-aware-server.ts";
import {
  buildLocalContainerFetch,
  buildSshLocalFetch,
  resolveRemoteLoopbackBaseUrl,
  type OperatorFetch,
} from "./remote-operator-transport.ts";
import { runRemoteDoctorChecks } from "./remote-doctor.ts";
import { resolveStandaloneAssets } from "./standalone-assets.ts";

export function loadActiveProfileForCompose(
  profileFlag: string | undefined,
  homeOverride?: string,
): ComposeDriverProfile {
  const home = homeOverride ?? process.env["HOME"] ?? "";
  const name = profileFlag?.trim() || readActiveProfileName(home);
  if (!name) {
    throw new Error("No active profile. Run: nautilo profile use <name>");
  }
  const profile = loadProfile(name, home);
  if (profile.lifecycle !== "compose") {
    throw new Error(
      `Profile '${name}' is not a compose-lifecycle profile (got lifecycle=${profile.lifecycle}). ` +
        `The deploy CLI verbs only operate on compose-lifecycle profiles.`,
    );
  }
  return profile;
}

function templateDir(): string {
  return resolveStandaloneAssets().templateDir;
}

export interface FactoryOptions {
  /** Test-only override; production omits. */
  templateDirOverride?: string;
  firstDeployConsume?: (
    ctx: FirstDeployConsumeContext,
  ) => Promise<void>;
  doctor?: ComposeDriverDeps["doctor"];
  /** Exact clean checkout SHA resolved before deploy-side custody mutation. */
  sourceBuildSha?: string;
}

async function preflightComposeSourceBuildSha(): Promise<string> {
  return resolveSourceBuildIdentity({ templateDir: templateDir(), exec: runLocal });
}

async function confirmThreadedSourceBuildSha(expected: string): Promise<string> {
  const current = await preflightComposeSourceBuildSha();
  if (current !== expected) {
    throw new Error(
      "source deploy refused before mutation: the clean checkout revision changed after owner preflight; retry from a stable checkout.",
    );
  }
  return current;
}

export function resolveOperatorServerUrl(profile: ComposeDriverProfile, home: string): string {
  if (profile.transport === "local") {
    const instanceUrl = readInstanceServerUrl(
      localInstanceRootDir(home, profile.instance_id),
    );
    if (instanceUrl) return instanceUrl;
  }
  return resolveServerBaseUrl(profile, resolveInstance());
}

export interface ReleaseReadinessOptions {
  /** Test seams; production uses the operator's process environment. */
  fetchFn?: OperatorFetch;
  resolveServerUrl?: (profile: ComposeDriverProfile) => string;
  home?: string;
  readBootstrapTokenFn?: (profileName: string, home: string) => string | null;
}

/**
 * Upgrade's operator-only work gate. Production Compose drivers inject a
 * container-loopback transport (local Docker or remote SSH), so owner-bound
 * instances never depend on the retired bootstrap bearer for upgrades.
 */
export function buildReleaseActiveWorkReadiness(
  opts: ReleaseReadinessOptions = {},
): NonNullable<ComposeDriverDeps["assertReleaseActiveWorkReady"]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const home = opts.home ?? process.env["HOME"] ?? "";
  const resolveServerUrl =
    opts.resolveServerUrl ??
    ((profile: ComposeDriverProfile) => resolveOperatorServerUrl(profile, home));
  const readBootstrap =
    opts.readBootstrapTokenFn ??
    ((profileName: string, tokenHome: string) =>
      readBootstrapToken(profileName, { home: tokenHome }));
  return buildComposeReleaseReadiness({
    fetch: fetchFn,
    resolveServerUrl,
    home,
    readBootstrapToken: readBootstrap,
  });
}

// ---------------------------------------------------------------------------
// D420 (Wave 2 task 2.2.5) — maintenance drain polling for `nautilo upgrade`.
//
// The drain is a bounded preflight: enter the durable drain lease, poll the
// operator maintenance status every few seconds, and proceed IMMEDIATELY once
// aggregate work reaches zero. It is bounded by `--wait-for` (default 5m).
// At the deadline it cancels + reconciles remaining executable work (R8).
//
// On success the drain RETAINS the owning lease — it does NOT clear
// maintenance as part of successful drain completion. It returns a
// {@link MaintenanceDrainHandle} that the upgrade transaction uses to:
//   1. transition `draining → applying` immediately before stopping
//      `nautilo-server` (fail-closed on transition/network/auth/malformed
//      error, so the server is never stopped and no backup starts against an
//      unsettled lease), and
//   2. best-effort clear/cancel the lease if the post-stop backup fails.
// The successful upgrade path intentionally leaves `applying`; final
// success/rollback completion fencing is owned by Wave 3.1.3.
//
// On timeout or network/auth/malformed failure it leaves state safe: clears
// the lease best-effort and throws a no-mutation error so the upgrade never
// begins stop/backup/deploy against an unsettled server.
// ---------------------------------------------------------------------------

/** The drain verb the ComposeDriver calls before any upgrade mutation. */
export type MaintenanceDrainFn = (
  profile: ComposeDriverProfile,
  waitForMs: number,
) => Promise<MaintenanceDrainHandle>;

export interface MaintenanceDrainOptions {
  /** Test seam; production uses the global fetch. */
  fetchFn?: OperatorFetch;
  /**
   * Test seam over server URL resolution. Production uses
   * `resolveServerBaseUrl(profile, resolveInstance())` — the same resolver
   * the release-readiness gate uses.
   */
  resolveServerUrl?: (profile: ComposeDriverProfile) => string;
  /**
   * Test seam over the bootstrap-token read for local Compose maintenance
   * requests. Production reads `~/.nautilo/bootstrap-tokens/<profile>`.
   */
  readBootstrapTokenFn?: (profileName: string, home: string) => string | null;
  /** Test seam over the poll sleep. Production uses a setTimeout-based wait. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable clock (ms) for deterministic deadline/renew math. */
  now?: () => number;
  /** Poll interval (ms). Default 3s — "poll every few seconds". */
  pollIntervalMs?: number;
  /**
   * Renew the lease when the remaining soft-lease window drops below this
   * (ms). Default 60s so a default soft lease never expires mid-drain and a
   * longer `--wait-for` keeps the lease alive across polls.
   */
  renewBufferMs?: number;
  /**
   * D420 (Wave 2 task 2.2.3) — post-deadline reconcile budget (ms). After the
   * drain deadline the orchestrator invokes the cancel-work action and polls
   * the aggregate counts until zero or this budget elapses. Default 30s.
   */
  reconcileBudgetMs?: number;
  /** Operator home dir; production reads process.env.HOME. */
  home?: string;
  /** Injectable logger (stderr); production writes `[deploy] ...` lines. */
  log?: (msg: string) => void;
}

/**
 * Build the production maintenance drain. The returned function enters the
 * drain lease, polls to zero (or cancels + reconciles at the deadline), and
 * RETAINS the lease on success by returning a {@link MaintenanceDrainHandle}.
 * On timeout or failure it clears the lease best-effort and throws a
 * no-mutation error.
 */
export function buildMaintenanceDrain(
  opts: MaintenanceDrainOptions = {},
): MaintenanceDrainFn {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const home = opts.home ?? process.env["HOME"] ?? "";
  const resolveServerUrl =
    opts.resolveServerUrl ??
    ((profile: ComposeDriverProfile) => resolveOperatorServerUrl(profile, home));
  const readBootstrap =
    opts.readBootstrapTokenFn ??
    ((profileName: string, home: string) => readBootstrapToken(profileName, { home }));
  return buildComposeMaintenanceDrain({
    home,
    resolveServerUrl,
    readBootstrapToken: readBootstrap,
    api: {
      enter: (transport, input) =>
        enterMaintenanceDrain(transport, fetchFn, input),
      status: (transport) => readMaintenanceStatus(transport, fetchFn),
      renew: (transport, operationId) =>
        renewMaintenanceLease(transport, fetchFn, operationId),
      applying: (transport, operationId) =>
        transitionMaintenanceApplying(transport, fetchFn, operationId),
      cancel: (transport, operationId) =>
        cancelMaintenanceDrain(transport, fetchFn, operationId),
      cancelWork: (transport, operationId) =>
        cancelMaintenanceWork(transport, fetchFn, operationId),
      complete: (transport, operationId) =>
        completeMaintenanceDrain(transport, fetchFn, operationId),
    },
    ...(opts.sleepFn === undefined ? {} : { sleep: opts.sleepFn }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
    ...(opts.renewBufferMs === undefined ? {} : { renewBufferMs: opts.renewBufferMs }),
    ...(opts.reconcileBudgetMs === undefined
      ? {}
      : { reconcileBudgetMs: opts.reconcileBudgetMs }),
    log: opts.log ?? ((msg: string) => process.stderr.write(`[deploy] ${msg}\n`)),
  });
}

type DriverFactory = (
  profile: ComposeDriverProfile,
  opts?: FactoryOptions,
) => ComposeDriver;

let driverFactory: DriverFactory = createDriverForCliImpl;

function cliLog(msg: string): void {
  process.stderr.write(`[deploy] ${msg}\n`);
}

export function buildComposeOperatorTransport(
  profile: ComposeDriverProfile,
  spawnFn?: NonNullable<Parameters<typeof buildLocalContainerFetch>[0]["spawnFn"]>,
): ReleaseReadinessOptions {
  // D427 (Wave 3 task 3.1.1) — remote maintenance/readiness calls execute
  // SSH-locally against loopback on the target (no public DNS, no copied
  // bootstrap bearer). Local Compose uses Docker authority to reach the same
  // container loopback boundary after bootstrap bearer retirement.
  // The per-profile seams below are the ONLY transport
  // difference; the drain / readiness logic is unchanged.
  return profile.transport === "remote" && profile.ssh !== undefined
      ? {
          resolveServerUrl: () =>
            resolveRemoteLoopbackBaseUrl(profile.ssh!, resolveInstance()),
          fetchFn: buildSshLocalFetch({
            ssh: profile.ssh,
            composeProjectName: composeProjectName(profile),
            log: cliLog,
            ...(spawnFn ? { spawnFn } : {}),
          }),
        }
      : profile.transport === "local"
        ? {
            resolveServerUrl: () => "http://127.0.0.1:3001",
            fetchFn: buildLocalContainerFetch({
              composeProjectName: composeProjectName(profile),
              log: cliLog,
              ...(spawnFn ? { spawnFn } : {}),
            }),
            readBootstrapTokenFn: () => null,
          }
        : {};

}

function createDriverForCliImpl(
  profile: ComposeDriverProfile,
  opts: FactoryOptions = {},
): ComposeDriver {
  const operatorSeams = buildComposeOperatorTransport(profile);
  const readinessGate = buildReleaseActiveWorkReadiness(operatorSeams);
  const maintenanceDrain = buildMaintenanceDrain(operatorSeams);
  return createProductionComposeDriver({
    profile,
    templateDir: opts.templateDirOverride ?? templateDir(),
    log: cliLog,
    ensureBootstrapToken,
    ...(opts.sourceBuildSha !== undefined
      ? { resolveSourceBuildSha: () => confirmThreadedSourceBuildSha(opts.sourceBuildSha!) }
      : {}),
    ...(opts.doctor !== undefined ? { doctor: opts.doctor } : {}),
    ...(opts.firstDeployConsume !== undefined
      ? { firstDeployConsume: opts.firstDeployConsume }
      : {}),
    releaseActiveWorkReadiness: readinessGate,
    maintenanceDrain,
    ...(profile.transport === "remote" && profile.ssh !== undefined
      ? {
          remoteRuntimeAcceptance: buildRemoteRuntimeAcceptanceTransport({
            ssh: profile.ssh,
            composeProjectName: composeProjectName(profile),
            log: cliLog,
          }),
        }
      : {}),
  });
}

export function buildUpgradeDoctor(): ComposeDriverDeps["doctor"] {
  return (profile) => {
    if (profile.transport !== "remote") return Promise.resolve();
    const home = process.env["HOME"];
    if (!home || home.trim() === "") {
      throw new Error("HOME is not set");
    }
    if (profile.lifecycle !== "compose" || profile.ssh === undefined) {
      throw new Error(
        `upgrade doctor requires a remote+compose profile with ssh config (profile=${profile.name})`,
      );
    }
    const checks = runRemoteDoctorChecks(
      profile as Parameters<typeof runRemoteDoctorChecks>[0],
      { home },
    );
    const failures = checks.filter((c) => c.status === "fail");
    for (const c of checks) {
      if (c.status === "fail" || c.status === "warn") {
        process.stderr.write(`[deploy] doctor ${c.status}: ${c.name}: ${c.message}\n`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `upgrade doctor preflight failed (${failures.length} failure${failures.length === 1 ? "" : "s"}); aborted before backup/deploy.`,
      );
    }
    return Promise.resolve();
  };
}

/** Production + tests: swap via `setComposeDriverFactoryForTests`. */
export function createDriverForCli(
  profile: ComposeDriverProfile,
  opts?: FactoryOptions,
): ComposeDriver {
  return driverFactory(profile, opts);
}

/** Test-only seam — restores real factory when passed `undefined`. */
export function setComposeDriverFactoryForTests(
  fn: DriverFactory | undefined,
): void {
  driverFactory = fn ?? createDriverForCliImpl;
}

function envLookupForInstance(
  instanceRootDir: string,
  secretsEnvPath?: string,
): EnvLookup {
  const instanceEnvPath = resolve(instanceRootDir, "instance.env");
  const fileRaw = existsSync(instanceEnvPath)
    ? readFileSync(instanceEnvPath, "utf8")
    : "";
  const entries = parseEnvFile(fileRaw);
  const secretsRaw =
    secretsEnvPath !== undefined && existsSync(secretsEnvPath)
      ? readFileSync(secretsEnvPath, "utf8")
      : "";
  const secretEntries = parseEnvFile(secretsRaw);
  return (name: string): string | undefined => {
    const fromFile = getValueFromEntries(entries, name)?.trim();
    if (fromFile && fromFile.length > 0) return fromFile;
    const fromProc = process.env[name]?.trim();
    if (fromProc && fromProc.length > 0) return fromProc;
    const fromSecrets = getValueFromEntries(secretEntries, name)?.trim();
    return fromSecrets && fromSecrets.length > 0 ? fromSecrets : undefined;
  };
}

function generateBootstrapToken(): string {
  return randomBytes(36).toString("base64url");
}

export function ensureBootstrapToken(
  profile: ComposeDriverProfile,
  home: string,
): string {
  const existing = readBootstrapToken(profile.name, { home });
  const token = existing !== null && existing.length > 0
    ? existing
    : generateBootstrapToken();
  if (existing === null || existing.length === 0) {
    writeBootstrapToken(profile.name, token, { home });
  }

  const instanceRoot = localInstanceRootDir(home, profile.instance_id);
  const envPath = join(instanceRoot, "instance.env");
  mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  chmodSync(instanceRoot, 0o700);
  const body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = body.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*NAUTILO_BOOTSTRAP_TOKEN\s*=/.test(lines[i] ?? "")) {
      lines[i] = `NAUTILO_BOOTSTRAP_TOKEN=${token}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (body.length > 0 && !body.endsWith("\n")) lines.push("");
    lines.push(`NAUTILO_BOOTSTRAP_TOKEN=${token}`, "");
  }
  writeFileSync(envPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  chmodSync(envPath, 0o600);
  return token;
}

export function resolveDeployConfigForCompose(
  configPath: string,
  instanceRootDir: string,
): ResolvedDeployConfig {
  const deployConfig = parseDeployConfigFromPath(configPath);
  const lookup = envLookupForInstance(
    instanceRootDir,
    join(dirname(configPath), "secrets.env"),
  );
  return resolveDeployConfig(deployConfig, lookup);
}

/** Provider-only first-deploy hook. Owner creation is never performed here. */
export function buildFirstDeployProviderConsumeHook(input: {
  readonly resolved: ResolvedDeployConfig;
}): (ctx: FirstDeployConsumeContext) => Promise<void> {
  return async (ctx) => {
    const consumedAt = readDeployConfigConsumedAt(ctx.instanceRootDir);
    if (consumedAt === null) {
      const dotenvPath = resolve(ctx.instanceRootDir, "instance.env");
      await consumeDeployConfigProviders(input.resolved, { dotenvPath });
      markDeployConfigConsumed(ctx.instanceRootDir);
    }
  };
}
