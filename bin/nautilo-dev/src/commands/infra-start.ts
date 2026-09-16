/**
 * M051: bring up every infrastructure dependency the Nautilo server
 * needs in dev — the legacy nautilo-postgres stack (DATABASE_URL target)
 * AND the new compose stack (postgres + logto + logto-seed). Idempotent:
 * already-running containers are no-ops.
 *
 * Sequencing matters because each step's wait gate guards the next:
 *   1. Legacy postgres via `bun run db:dev`. Wait until `nautilo-postgres`
 *      reports healthy via `pg_isready`.
 *   2. New compose stack. Wait until Logto's OIDC discovery doc returns
 *      200 (logto-seed must complete + logto core must boot).
 *   3. bootstrap-logto. Idempotent at the application layer
 *      (sign_in_mode='SignIn' short-circuit).
 *   4. `bun run db:migrate` — applies Drizzle migrations to the legacy
 *      `nautilo` database (`packages/db` / `DB_DIRECT_CONNECTION`, with
 *      legacy fallback to `DB_CONNECTION_STRING`).
 *   5. `bootstrapClaimInvite` — idempotent mint of `kind='claim'` invite
 *      when `users` is empty (M073).
 *
 * After this command exits 0, every consumer (`bun run server`,
 * `bun run cli`, `bun run dev-stack`, `bun run desktop`) finds
 * a fully provisioned environment to attach to.
 */
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  resolveInstance,
  resolveNautiloStorageRoot,
  type ResolvedInstance,
} from "@nautilo/config";
import { bootstrapDirForInstance } from "@nautilo/operator-secrets";
import {
  bootstrapClaimInvite,
  formatClaimInviteBanner,
} from "../lib/bootstrap-claim-invite";
import { migrateAddAgentRole } from "./migrate-add-agent-role";
import { resyncLogtoTenantRoles } from "../lib/logto-db";
import {
  dockerComposeDbDevPrefixRaw,
  dockerComposeNautiloPrefixArgs,
  ensureInfraCredentialAuthorityForInfraStart,
  ensureOpenConnectorEncryptionKeyForInstance,
  formatInfraInstanceBanner,
  NAUTILO_REPO_ROOT,
  openConnectorContainerName,
} from "../lib/compose-infra";
import {
  reconcileCryptoServiceRole,
  reconcileCryptoStoragePrivileges,
  reconcileServiceRoles,
} from "../lib/service-role-reconcile";
import { deriveCloneOperationNextStage } from "../lib/clone-operation";
import {
  assertExactMigrationPrefix,
  mapDatabaseLedgerToCheckout,
  parseDatabaseMigrationLedger,
  readCheckoutMigrationLineage,
  type MigrationLineageEntry,
} from "../lib/migration-lineage";
import { queryPostgresContainer } from "../lib/postgres-archive";

const REPO_ROOT = NAUTILO_REPO_ROOT;
const BOOTSTRAP_SCRIPT = resolve(
  REPO_ROOT,
  "bin/nautilo-local/src/bootstrap-logto.ts",
);
const DB_PACKAGE_DIR = resolve(REPO_ROOT, "packages/db");
const PG_READY_TIMEOUT_MS = 30_000;
const LOGTO_READY_TIMEOUT_MS = 60_000;
const OPENCONNECTOR_READY_TIMEOUT_MS = 60_000;
const OFFICE_READY_TIMEOUT_MS = 120_000;
const PG_POLL_INTERVAL_MS = 500;

export function assertInfraMigrationLedgerCompatible(
  rawLedger: string,
  checkout: readonly MigrationLineageEntry[],
): void {
  const database = parseDatabaseMigrationLedger(rawLedger);
  // A genuinely fresh database has no Drizzle rows and is allowed to migrate.
  if (database.length === 0) return;
  const mapped = mapDatabaseLedgerToCheckout(database, checkout);
  assertExactMigrationPrefix(mapped, checkout);
}

async function preflightInfraMigrationLedger(container: string): Promise<void> {
  const ledgerTable = queryPostgresContainer({
    container,
    database: "nautilo",
    sql: "SELECT to_regclass('drizzle.__drizzle_migrations');",
  });
  if (ledgerTable === "") return;
  const rawLedger = queryPostgresContainer({
    container,
    database: "nautilo",
    sql: `
      SELECT created_at::text || '|' || hash
      FROM drizzle.__drizzle_migrations
      ORDER BY id ASC;
    `,
  });
  const checkout = await readCheckoutMigrationLineage(
    join(DB_PACKAGE_DIR, "src", "migrations"),
  );
  assertInfraMigrationLedgerCompatible(rawLedger, checkout);
}

interface ExecOk {
  ok: true;
  code: 0;
}
interface ExecFail {
  ok: false;
  code: number;
  stderr: string;
}
type ExecResult = ExecOk | ExecFail;

export interface ContainerInspect {
  name: string;
  status: string;
  project: string;
  service: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; inherit?: boolean } = {},
): Promise<ExecResult> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (opts.inherit) process.stdout.write(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.inherit) process.stderr.write(chunk);
    });
    proc.on("close", (code) => {
      if (code === 0) res({ ok: true, code: 0 });
      else res({ ok: false, code: code ?? 1, stderr });
    });
  });
}

export function parseContainerNameConflict(stderr: string): string | null {
  const match = stderr.match(/container name "\/?([^"]+)"/i);
  return match?.[1] ?? null;
}

export function isSafeRepairCandidate(
  container: ContainerInspect,
  expectedNames: ReadonlySet<string>,
  projectName: string,
): boolean {
  return expectedNames.has(container.name) && container.project === projectName;
}

function isStaleContainerStatus(status: string): boolean {
  return status === "created" || status === "exited" || status === "dead";
}

/** Read stdout from a docker inspect/ps call. Same shape as `run` but captures stdout. */
function execOut(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolveExec) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", (code) => {
      resolveExec({ ok: code === 0, out: out.trim() });
    });
  });
}

async function inspectContainer(name: string): Promise<ContainerInspect | null> {
  const r = await execOut("docker", [
    "inspect",
    name,
    "--format",
    "{{.State.Status}}|{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}",
  ]);
  if (!r.ok || !r.out) return null;
  const [status = "", project = "", service = ""] = r.out.split("|");
  return { name, status, project, service };
}

async function removeContainerPreserveVolumes(name: string): Promise<ExecResult> {
  console.warn(
    `[infra:start] removing stale container ${name}; Docker volumes are preserved`,
  );
  return run("docker", ["rm", "-f", name], { inherit: true });
}

async function removeStaleExpectedContainers(
  projectName: string,
  expectedNames: ReadonlySet<string>,
): Promise<void> {
  for (const name of expectedNames) {
    const container = await inspectContainer(name);
    if (!container) continue;
    if (!isSafeRepairCandidate(container, expectedNames, projectName)) {
      console.warn(
        `[infra:start] found container ${name} but it is not clearly owned by compose project ${projectName}; leaving it untouched`,
      );
      continue;
    }
    if (!isStaleContainerStatus(container.status)) continue;
    const removed = await removeContainerPreserveVolumes(name);
    if (!removed.ok) {
      throw new Error(
        `failed to remove stale container ${name} before compose up (exit ${removed.code})`,
      );
    }
  }
}

async function composeUpWithVolumeSafeRepair(options: {
  label: string;
  projectName: string;
  composeArgs: string[];
  expectedContainers: string[];
  services?: string[];
  noPullOrBuild?: boolean;
}): Promise<ExecResult> {
  const expectedNames = new Set(options.expectedContainers);
  await removeStaleExpectedContainers(options.projectName, expectedNames);

  const args = [
    ...options.composeArgs,
    "up",
    "-d",
    ...(options.noPullOrBuild === true ? ["--pull", "never", "--no-build"] : []),
    ...(options.services ?? []),
  ];
  const first = await run("docker", args, { inherit: true });
  if (first.ok) return first;

  const conflictName = parseContainerNameConflict(first.stderr);
  if (!conflictName || !expectedNames.has(conflictName)) return first;

  const container = await inspectContainer(conflictName);
  if (
    !container ||
    !isSafeRepairCandidate(container, expectedNames, options.projectName)
  ) {
    console.error(
      `[infra:start] ${options.label} hit a container-name conflict for ${conflictName}, but it is not clearly owned by compose project ${options.projectName}; refusing automatic repair`,
    );
    return first;
  }

  const removed = await removeContainerPreserveVolumes(conflictName);
  if (!removed.ok) return removed;

  console.warn(`[infra:start] retrying ${options.label} compose up after safe container repair`);
  return run("docker", args, { inherit: true });
}

async function waitForPgReady(
  container: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await execOut("docker", [
      "exec",
      container,
      "pg_isready",
      "-U",
      "postgres",
    ]);
    if (r.ok) return;
    await new Promise((r2) => setTimeout(r2, PG_POLL_INTERVAL_MS));
  }
  throw new Error(
    `${container} did not become healthy within ${timeoutMs}ms`,
  );
}

/**
 * D475 — `pg_isready` is deliberately only a server-process probe. On a
 * fresh official Postgres image it can succeed while the entrypoint's
 * temporary init server is still executing `postgres-init.sh`; the service
 * roles needed by reconciliation do not exist yet. This probe is read-only
 * and fails until every expected bootstrap role exists. It never creates or
 * alters a role, and contains no credential value.
 */
export function buildPgBootstrapRoleProbeScript(
  roles: readonly string[],
): string {
  if (roles.length === 0 || new Set(roles).size !== roles.length) {
    throw new Error("Postgres bootstrap readiness received an invalid required role set");
  }
  for (const role of roles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
      throw new Error("Postgres bootstrap readiness received an invalid required role set");
    }
  }
  const quotedRoles = roles.map((role) => `'${role}'`).join(", ");
  return [
    "DO $nautilo_bootstrap$",
    "BEGIN",
    `  IF (SELECT count(*) FROM pg_roles WHERE rolname IN (${quotedRoles})) <> ${roles.length} THEN`,
    "    RAISE EXCEPTION 'required bootstrap service roles are not ready';",
    "  END IF;",
    "END",
    "$nautilo_bootstrap$;",
  ].join("\n");
}

type PgBootstrapRoleProbe = (input: {
  container: string;
  roles: readonly string[];
}) => Promise<boolean>;

type PgEntrypointProbe = (container: string) => Promise<boolean>;

async function probePgEntrypointComplete(container: string): Promise<boolean> {
  const result = await execOut("docker", [
    "exec",
    container,
    "sh",
    "-c",
    'test "$(cat /proc/1/comm)" = postgres',
  ]);
  return result.ok;
}

export async function waitForPgEntrypointComplete(
  container: string,
  timeoutMs: number,
  options: { probe?: PgEntrypointProbe; pollIntervalMs?: number } = {},
): Promise<void> {
  const probe = options.probe ?? probePgEntrypointComplete;
  const pollIntervalMs = options.pollIntervalMs ?? PG_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(container)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  throw new Error(`${container} did not complete its PostgreSQL entrypoint within ${timeoutMs}ms`);
}

async function probePgBootstrapRoles(input: {
  container: string;
  roles: readonly string[];
}): Promise<boolean> {
  const r = await execOut("docker", [
    "exec",
    input.container,
    "psql",
    "-X",
    "-q",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    buildPgBootstrapRoleProbeScript(input.roles),
  ]);
  return r.ok;
}

export async function waitForPgBootstrapRoles(
  container: string,
  roles: readonly string[],
  timeoutMs: number,
  options: {
    probe?: PgBootstrapRoleProbe;
    pollIntervalMs?: number;
  } = {},
): Promise<void> {
  // Validate before the first probe so malformed internal role names fail
  // closed rather than becoming a retry loop.
  buildPgBootstrapRoleProbeScript(roles);
  const deadline = Date.now() + timeoutMs;
  const probe = options.probe ?? probePgBootstrapRoles;
  const pollIntervalMs = options.pollIntervalMs ?? PG_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    if (await probe({ container, roles })) return;
    // This is a bounded condition-poll, not an unconditional post-ready
    // sleep: every pass re-reads pg_roles before it may proceed.
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  throw new Error(
    `${container} did not complete PostgreSQL bootstrap within ${timeoutMs}ms`,
  );
}

async function waitForPgReadyAndBootstrapRoles(
  container: string,
  roles: readonly string[],
  timeoutMs: number,
): Promise<void> {
  // One shared deadline means first-volume initialization cannot extend the
  // existing PostgreSQL readiness budget merely because pg_isready answered
  // before the init script had created the service roles.
  const deadline = Date.now() + timeoutMs;
  await waitForPgReady(container, Math.max(0, deadline - Date.now()));
  // The official image runs a temporary Postgres during init scripts. Roles
  // can already exist at that point, immediately before the entrypoint stops
  // the temporary server. Require PID 1 to be the final postgres process so
  // the following migration-ledger read cannot land in that shutdown gap.
  await waitForPgEntrypointComplete(
    container,
    Math.max(0, deadline - Date.now()),
  );
  await waitForPgBootstrapRoles(
    container,
    roles,
    Math.max(0, deadline - Date.now()),
  );
}

async function waitForUrl200(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${url} did not return 200 within ${timeoutMs}ms`);
}

export interface InfraStartOptions {
  /**
   * D202 opt-in flag, retained for API compatibility but now a no-op.
   * `infra:start` is the canonical orchestrator and always proceeds against
   * whichever instance `resolveInstance()` picks; the inner
   * `migrate-add-agent-role` sub-step self-grants regardless of this flag
   * (see the call site below for rationale).
   */
  iKnowWhatIAmDoing?: boolean | undefined;
  /**
   * D362 — also bring up the office engine (nwuno + collabora) profile as part
   * of this single compose orchestration, instead of the separate `office:up`
   * command. Best-effort: failures warn but do NOT fail infra:start (office is
   * optional and off by default).
   */
  office?: boolean | undefined;
  /**
   * A full instance clone already contains provisioned Logto application
   * state. Re-running first-boot provisioning can reject or mutate copied
   * operator-owned connectors, so clone orchestration opts out explicitly.
   */
  logtoAlreadyProvisioned?: boolean | undefined;
  /**
   * Explicit operator-home authority for disposable workers. The CLI leaves
   * this unset; acceptance harnesses pass their isolated HOME so the
   * compatibility claim-invite copy cannot escape to the desktop operator.
   */
  operatorHomeDir?: string | undefined;
  /** Disposable acceptance only: refuse image pulls and Compose builds. */
  noPullOrBuild?: boolean | undefined;
  /**
   * D508 local qualification only. It is intentionally API-only (no argv
   * flag): the controller installs the sole in-memory/browser capability
   * after infra is healthy, so infra must not mint a plaintext legacy file.
   */
  suppressBootstrapClaimInvite?: boolean | undefined;
}

export function shouldMintBootstrapClaimInvite(options: InfraStartOptions): boolean {
  return options.suppressBootstrapClaimInvite !== true;
}

export function shouldPreserveProvisionedLogto(
  explicit: boolean,
  cloneOperation: unknown,
): boolean {
  if (explicit) return true;
  if (cloneOperation === null) return false;
  if (deriveCloneOperationNextStage(cloneOperation) !== "complete") {
    throw new Error(
      "Refusing ordinary startup for an incomplete clone operation; inspect clone-operation.json and delete/recreate the target",
    );
  }
  return true;
}

export function bootstrapClaimInviteDepsForInfra(
  options: InfraStartOptions,
  env: NodeJS.ProcessEnv = process.env,
): { operatorHomeDir?: string } {
  const operatorHomeDir = options.operatorHomeDir?.trim() || env["HOME"]?.trim();
  return operatorHomeDir === undefined || operatorHomeDir === ""
    ? {}
    : { operatorHomeDir };
}

export function resolveInfraClaimInvitePaths(
  options: InfraStartOptions,
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
): { legacy: string; bootstrap: string } | null {
  const home = options.operatorHomeDir?.trim() || env["HOME"]?.trim();
  if (home === undefined || home === "") return null;
  const root = resolveNautiloStorageRoot(home, instanceId);
  return {
    legacy: join(root, "claim-invite.txt"),
    bootstrap: join(root, ".bootstrap", "claim-invite"),
  };
}

/**
 * D362 — bring up the `office` profile (nwuno + collabora) in the SAME compose
 * project as the rest of infra, so there's no separate `office:up` bringup
 * racing on the shared project. Best-effort: warns on failure, never throws.
 * Ports come from the selected credential authority (NAUTILO_OFFICE_PORT /
 * NAUTILO_COLLABORA_PORT), already applied by the caller.
 */
async function bringUpOfficeProfile(inst: ResolvedInstance): Promise<void> {
  const collaboraPort = process.env["NAUTILO_COLLABORA_PORT"];
  console.log("[infra:start] bringing up office engine (nwuno + collabora)...");
  // Name the services EXPLICITLY (office collabora). A bare `--profile office
  // up` would also start the file's no-profile `postgres` service (the Logto
  // DB, `-1`), which is the legacy Logto pass's job — not the office pass's.
  const up = await run(
    "docker",
    [
      ...dockerComposeNautiloPrefixArgs(inst),
      "--profile",
      "office",
      "up",
      "-d",
      "--build",
      "office",
      "collabora",
    ],
    { inherit: true },
  );
  if (!up.ok) {
    console.warn(
      `[infra:start] office engine compose up failed (exit ${up.code}); continuing without office`,
    );
    return;
  }
  // coolwsd serves discovery under net.service_root=/office-engine (D362 §3.1b).
  if (collaboraPort) {
    try {
      await waitForUrl200(
        `http://localhost:${collaboraPort}/office-engine/hosting/discovery`,
        OFFICE_READY_TIMEOUT_MS,
      );
      console.log(`[infra:start]   collabora ready at http://localhost:${collaboraPort}/office-engine/`);
    } catch (err) {
      console.warn(
        `[infra:start] collabora not ready: ${err instanceof Error ? err.message : String(err)} (continuing)`,
      );
    }
  }
}

export async function infraStart(options: InfraStartOptions = {}): Promise<number> {
  const inst = resolveInstance();
  const home = process.env["HOME"]?.trim();
  if (!home) {
    console.error("[infra:start] HOME is required to resolve clone provenance");
    return 1;
  }
  const cloneOperationPath = join(
    resolveNautiloStorageRoot(home, inst.instanceId),
    "clone-operation.json",
  );
  let logtoAlreadyProvisioned: boolean;
  try {
    const cloneOperation: unknown = existsSync(cloneOperationPath)
      ? (JSON.parse(readFileSync(cloneOperationPath, "utf8")) as unknown)
      : null;
    logtoAlreadyProvisioned = shouldPreserveProvisionedLogto(
      options.logtoAlreadyProvisioned === true,
      cloneOperation,
    );
  } catch (err) {
    console.error(
      `[infra:start] invalid clone provenance at ${cloneOperationPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const noPullOrBuild = options.noPullOrBuild === true ||
    process.env["NAUTILO_DISPOSABLE_NO_PULL_BUILD"] === "1";
  let credentialPlan: ReturnType<typeof ensureInfraCredentialAuthorityForInfraStart>;
  try {
    credentialPlan = ensureInfraCredentialAuthorityForInfraStart(inst);
    for (const [key, value] of Object.entries(credentialPlan.childEnv)) {
      process.env[key] = value;
    }
    process.env["NAUTILO_CRYPTO_DB_PASSWORD"] =
      credentialPlan.serviceSecrets.NAUTILO_CRYPTO_DB_PASSWORD;
    const openConnector = ensureOpenConnectorEncryptionKeyForInstance(inst);
    process.env["NAUTILO_OPENCONNECTOR_ENCRYPTION_KEY_PATH"] = openConnector.keyPath;
    process.env["NAUTILO_OPENCONNECTOR_DATA_DIR"] = openConnector.dataDir;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(formatInfraInstanceBanner(inst));
  console.log(
    `[infra] credentials: ${credentialPlan.source} (${credentialPlan.instanceEnvPath}; values redacted)`,
  );
  console.log("");

  const legacyPg = inst.compose.containers.legacyPostgres;
  const logtoDiscovery = `http://localhost:${inst.logto.corePort}/oidc/.well-known/openid-configuration`;

  console.log("[infra:start] bringing up legacy postgres...");
  const dbUp = await composeUpWithVolumeSafeRepair({
    label: "legacy postgres",
    projectName: inst.compose.projectName,
    composeArgs: dockerComposeDbDevPrefixRaw(inst.compose.projectName),
    expectedContainers: [inst.compose.containers.legacyPostgres],
    noPullOrBuild,
  });
  if (!dbUp.ok) {
    console.error(`[infra:start] docker compose db up failed (exit ${dbUp.code})`);
    return dbUp.code;
  }
  await waitForPgReadyAndBootstrapRoles(
    legacyPg,
    ["nautilo", "nautilo_agent"],
    PG_READY_TIMEOUT_MS,
  );

  console.log(`[infra:start]   ${legacyPg} healthy and bootstrap roles ready`);

  try {
    await preflightInfraMigrationLedger(legacyPg);
  } catch (err) {
    console.error(
      "[infra:start] migration lineage preflight failed before role repair, " +
        `Logto bootstrap, or db:migrate: ${err instanceof Error ? err.message : String(err)}. ` +
        "Do not edit migration ledger rows; add/review a forward repair migration or use a checkout whose journal exactly contains the running source.",
    );
    return 1;
  }

  console.log("[infra:start] reconciling persisted Nautilo service roles...");
  try {
    await reconcileServiceRoles({
      container: legacyPg,
      roles: [
        {
          name: "nautilo",
          password: credentialPlan.serviceSecrets.NAUTILO_DB_PASSWORD,
        },
        {
          name: "nautilo_agent",
          password: credentialPlan.serviceSecrets.NAUTILO_AGENT_DB_PASSWORD,
        },
      ],
    });
    await reconcileCryptoServiceRole(legacyPg);
    // The dormant credential is bootstrap/reconciliation-only in Wave 6.
    // Remove it before any product child process is launched.
    delete process.env["NAUTILO_CRYPTO_DB_PASSWORD"];
  } catch (err) {
    console.error(
      `[infra:start] Nautilo service-role repair failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log("[infra:start] bringing up Logto postgres for credential repair...");
  const logtoPgUp = await composeUpWithVolumeSafeRepair({
    label: "Logto postgres",
    projectName: inst.compose.projectName,
    composeArgs: dockerComposeNautiloPrefixArgs(inst),
    expectedContainers: [inst.compose.containers.logtoPostgres],
    services: ["postgres"],
    noPullOrBuild,
  });
  if (!logtoPgUp.ok) {
    console.error(
      `[infra:start] Logto postgres compose up failed (exit ${logtoPgUp.code})`,
    );
    return logtoPgUp.code;
  }
  await waitForPgReadyAndBootstrapRoles(
    inst.compose.containers.logtoPostgres,
    ["logto"],
    PG_READY_TIMEOUT_MS,
  );

  console.log("[infra:start] reconciling persisted Logto service role...");
  try {
    await reconcileServiceRoles({
      container: inst.compose.containers.logtoPostgres,
      roles: [
        {
          name: "logto",
          password: credentialPlan.serviceSecrets.LOGTO_DB_PASSWORD,
        },
      ],
    });
  } catch (err) {
    console.error(
      `[infra:start] Logto service-role repair failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(
    "[infra:start] bringing up Logto compose stack (postgres + logto + logto-seed)...",
  );
  console.log(
    "[infra:start] second compose pass: legacy postgres is intentionally not in this YAML; Docker may call it an \"orphan\".",
  );
  console.log(
    "[infra:start] compose note: those containers are from the first stack file only — safe to ignore. Do not use --remove-orphans here.",
  );
  const composeUp = await composeUpWithVolumeSafeRepair({
    label: "Logto",
    projectName: inst.compose.projectName,
    composeArgs: [
      ...dockerComposeNautiloPrefixArgs(inst),
      "--profile",
      "auth",
      "--profile",
      "connections",
    ],
    expectedContainers: [
      inst.compose.containers.logtoPostgres,
      inst.compose.containers.logtoCore,
      inst.compose.containers.logtoSeed,
      openConnectorContainerName(inst),
    ],
    noPullOrBuild,
  });
  if (!composeUp.ok) {
     
    console.error(
      `[infra:start] docker compose up -d failed (exit ${composeUp.code})`,
    );
    return composeUp.code;
  }

   
  console.log("[infra:start] waiting for Logto OIDC discovery...");

  // Stack 132 — defensive tenant role password resync before the OIDC
  // discovery wait. Catches any desync path (restore from snapshot,
  // manual volume ops, future bugs) that leaves the cluster-level
  // postgres tenant roles out of sync with what Logto's `tenants`
  // table expects. Idempotent no-op on healthy stacks; the read +
  // SQL generation + `ALTER ROLE` round-trip is a single `psql` call
  // (~ms). Honors `LOGTO_RESYNC_DRY_RUN=1` to print redacted SQL and
  // execute nothing. Failure is logged + swallowed: a resync failure
  // must not abort `infra:start` — the OIDC wait below is the
  // canonical health gate and will surface the real Logto boot error.
  try {
    resyncLogtoTenantRoles({ log: (m) => console.log(`[infra:start] ${m}`) });
  } catch (err) {
    console.warn(
      `[infra:start] tenant role resync skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await waitForUrl200(logtoDiscovery, LOGTO_READY_TIMEOUT_MS);
  } catch (err) {
    console.error(
      `[infra:start] ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(
    `[infra:start]   Logto reachable at http://localhost:${inst.logto.corePort}`,
  );

  const openConnectorUrl = `http://127.0.0.1:${process.env["NAUTILO_OPENCONNECTOR_PORT"]}`;
  try {
    await waitForUrl200(`${openConnectorUrl}/health`, OPENCONNECTOR_READY_TIMEOUT_MS);
  } catch (err) {
    console.error(
      `[infra:start] ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  console.log(`[infra:start]   OpenConnector reachable at ${openConnectorUrl}`);

  if (logtoAlreadyProvisioned) {
    console.log(
      "[infra:start] preserving provisioned Logto state and rebinding Workbench redirects",
    );
    const bootstrap = await run(
      "bun",
      [BOOTSTRAP_SCRIPT, "--preserve-provisioned-state"],
      { inherit: true },
    );
    if (!bootstrap.ok) {
      console.error(
        `[infra:start] Logto projection rebind failed (exit ${bootstrap.code})`,
      );
      return bootstrap.code;
    }
  } else {
    console.log("[infra:start] running bootstrap-logto (idempotent)...");
    const bootstrap = await run("bun", [BOOTSTRAP_SCRIPT], { inherit: true });
    if (!bootstrap.ok) {
      console.error(
        `[infra:start] bootstrap-logto failed (exit ${bootstrap.code})`,
      );
      return bootstrap.code;
    }
  }

  console.log("[infra:start] applying nautilo DB migrations...");
  const migrate = await run("bun", ["run", "db:migrate"], {
    cwd: DB_PACKAGE_DIR,
    inherit: true,
  });
  if (!migrate.ok) {
    console.error(`[infra:start] db:migrate failed (exit ${migrate.code})`);
    return migrate.code;
  }

  console.log("[infra:start] ensuring app-role ownership, grants, and nautilo_agent contract...");
  // `infra:start` is the canonical orchestrator for bringing up an
  // instance. The agent-role grants step is part of that single
  // operator-intent — we already ran `db:migrate` against this DB
  // immediately above (also unguarded). Forcing `iKnowWhatIAmDoing`
  // here suppresses the D202 default-instance refusal that would
  // otherwise fire on a plain `bun run infra:start` against the
  // canonical `(default)` instance, where the operator has no useful
  // remediation other than re-typing the orchestrator's intent. The
  // D202 guard remains active for *direct* `migrate-add-agent-role`
  // CLI invocations — the worktree-vs-default mis-target case it was
  // built to catch.
  const agentRole = await migrateAddAgentRole({
    apply: true,
    iKnowWhatIAmDoing: true,
  });
  if (agentRole !== 0) {
    console.error(`[infra:start] migrate-add-agent-role failed (exit ${agentRole})`);
    return agentRole;
  }
  try {
    await reconcileCryptoStoragePrivileges(legacyPg);
  } catch {
    console.error("[infra:start] post-migration crypto-role repair failed");
    return 1;
  }

  if (shouldMintBootstrapClaimInvite(options)) {
  console.log("[infra:start] minting bootstrap claim invite (idempotent)...");
  const claimHome = options.operatorHomeDir?.trim() || process.env["HOME"]?.trim();
  const explicitClaimPaths = resolveInfraClaimInvitePaths(options, inst.instanceId, process.env);
  const claim = await bootstrapClaimInvite({
    ...bootstrapClaimInviteDepsForInfra(options, process.env),
    ...(claimHome === undefined || claimHome === "" ? {} : {
      currentInstanceId: () => inst.instanceId,
      resolveClaimInvitePath: () => explicitClaimPaths!.legacy,
    }),
  });
  switch (claim.outcome.kind) {
    case "minted":
      console.log(
        formatClaimInviteBanner({
          redeemInput: claim.outcome.redeemInput,
          filePath: claim.outcome.filePath,
          bootstrapClaimInvitePath: claim.outcome.bootstrapClaimInvitePath,
        }),
      );
      break;
    case "already-claimed":
      console.log(
        `[infra:start]   first user @${claim.outcome.firstUserHandle} already claimed; skipping`,
      );
      break;
    case "preserved-existing":
      if (claim.outcome.reprintRedeemInput) {
        console.log(
          formatClaimInviteBanner({
            redeemInput: claim.outcome.reprintRedeemInput,
            filePath: claim.outcome.filePath,
            reprint: true,
            bootstrapClaimInvitePath: explicitClaimPaths?.bootstrap ?? join(
                bootstrapDirForInstance(resolveInstance().instanceId),
                "claim-invite",
            ),
          }),
        );
      } else {
        console.warn(
          `[infra:start]   un-redeemed claim in DB but could not reprint (missing or invalid ${claim.outcome.filePath}) — revoke the claim row in DB to mint again`,
        );
      }
      break;
    case "skipped-no-table":
      console.warn(
        "[infra:start]   invites table missing; run `bun run db:migrate` (check DB_DIRECT_CONNECTION or DB_CONNECTION_STRING / packages/db/.env.local), then re-run infra:start",
      );
      break;
  }
  } else {
    console.log("[infra:start] D508 disposable qualification: bootstrap claim invite mint suppressed.");
  }

  if (options.office === true) {
    await bringUpOfficeProfile(inst);
  }

  console.log("[infra:start] done. Run `bun run server` or `bun run dev-stack` next.");
  return 0;
}
