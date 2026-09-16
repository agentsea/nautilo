import { buildEventFeedReaderRoleSql } from "./event-feed-role";
import {
  buildAgentRoleGrantsSql,
} from "./agent-role-grants";
import {
  buildAppRoleOwnershipRepairSql,
  buildVectorExtensionRepairSql,
} from "./legacy-role-repair";

/**
 * D488 hosted-Postgres bootstrap contract.
 *
 * `infra/postgres-init.sh` is a Docker-entrypoint convenience: it runs only
 * when a volume is empty and historically creates an identical superset on
 * both clusters. Hosted Postgres needs the opposite shape: an independently
 * retryable, cluster-specific operation which is safe after a job restart.
 * This module is that operation's provider-neutral core. A transient
 * `nautilo-bootstrap` image supplies the concrete admin adapter later.
 *
 * Intentionally not carried from the shell script:
 * - the app cluster does not create Logto roles/databases, and the Logto
 *   cluster does not create app/agent/crypto roles or a vector extension;
 * - Docker/psql environment handling, migrations, and Logto's later tenant
 *   seed are outside this pre-seed cluster contract;
 * - password repair/rotation is deliberately absent. Existing credentials
 *   are validated and a mismatch fails closed rather than being changed.
 */

const secretBrand = Symbol("HostedDatabaseSecret");
const secretValues = new WeakMap<object, string>();

/** A password that cannot accidentally be rendered by a plan or receipt. */
export interface HostedDatabaseSecret {
  readonly [secretBrand]: true;
}

/**
 * Wrap an operator-provided password at the process boundary. The value is
 * intentionally not readable through this module's result, checkpoint, or
 * operation types.
 *
 * This is an accidental-serialization guard, not a cryptographic in-process
 * boundary. The bootstrap process necessarily has the plaintext long enough
 * to authenticate. The callback helper below limits that exposure to a single
 * adapter operation; JavaScript strings are immutable, so there is no
 * meaningful in-place zeroing operation to promise here.
 */
export function createHostedDatabaseSecret(value: string): HostedDatabaseSecret {
  if (value.length === 0) {
    throw new Error("hosted database credential must not be empty");
  }
  const secret = { [secretBrand]: true } as HostedDatabaseSecret;
  secretValues.set(secret, value);
  return Object.freeze(secret);
}

/**
 * Give a concrete admin adapter the password only for one operation. The
 * callback cannot return the string, and errors are replaced with a stable
 * redacted error so a driver exception cannot carry a credential into a
 * receipt or operator log. This function deliberately makes no copy of the
 * immutable JavaScript string retained in the module-private WeakMap.
 */
export async function withHostedDatabaseSecret(
  secret: HostedDatabaseSecret,
  use: (value: string) => void | Promise<void>,
): Promise<void> {
  if (secret[secretBrand] !== true) {
    throw new Error("invalid hosted database credential");
  }
  const value = secretValues.get(secret);
  if (typeof value !== "string") {
    throw new Error("invalid hosted database credential");
  }
  try {
    await use(value);
  } catch {
    throw new Error("hosted database secret consumer failed");
  }
}

export type HostedClusterKind = "app" | "logto";
export type HostedClusterDatabase = "postgres" | "nautilo" | "logto_nautilo";

export type HostedClusterStage =
  | "ensure-primary-role"
  | "ensure-agent-role"
  | "ensure-crypto-role"
  | "ensure-database"
  | "reconcile-database-access"
  | "require-vector"
  | "reconcile-app-contract"
  | "validate-primary-credential"
  | "validate-agent-credential"
  | "validate-crypto-credential";

export type HostedRoleName = "nautilo" | "nautilo_agent" | "nautilo_crypto" | "logto";

export interface HostedRoleAttributes {
  readonly login: true;
  readonly superuser: false;
  readonly createDatabase: false;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: false;
  readonly bypassRls: boolean;
}

/** Secret-safe instruction passed to the injected admin adapter. */
export interface HostedRoleCreation {
  readonly role: HostedRoleName;
  readonly password: HostedDatabaseSecret;
  readonly attributes: HostedRoleAttributes;
}

export interface HostedDatabaseCreation {
  readonly database: Exclude<HostedClusterDatabase, "postgres">;
  readonly owner: HostedRoleName;
  /** PostgreSQL rejects CREATE DATABASE inside an explicit transaction. */
  readonly transaction: "forbidden";
}

export interface HostedSqlOperation {
  readonly database: HostedClusterDatabase;
  readonly stage: HostedClusterStage;
  /** Canonical no-secret SQL assembled from existing grant/repair builders. */
  readonly sql: string;
}

export interface HostedCredentialValidation {
  readonly database: Exclude<HostedClusterDatabase, "postgres">;
  readonly role: HostedRoleName;
  readonly password: HostedDatabaseSecret;
}

export interface HostedRequiredExtension {
  readonly database: "nautilo";
  readonly extension: "vector";
  readonly stage: "require-vector";
  readonly sql: string;
}

/**
 * The future bootstrap image implements this adapter. No concrete connection
 * is included here, keeping all tests deterministic and mutation-free.
 */
export interface HostedClusterAdminAdapter {
  roleExists(role: HostedRoleName): Promise<boolean>;
  createRole(input: HostedRoleCreation): Promise<void>;
  reconcileRoleAttributes(input: {
    role: HostedRoleName;
    attributes: HostedRoleAttributes;
  }): Promise<void>;
  databaseExists(database: Exclude<HostedClusterDatabase, "postgres">): Promise<boolean>;
  createDatabase(input: HostedDatabaseCreation): Promise<void>;
  executeSql(input: HostedSqlOperation): Promise<void>;
  /** Returns false only when the provider image/cluster lacks pgvector. */
  ensureRequiredExtension(input: HostedRequiredExtension): Promise<boolean>;
  validateCredential(input: HostedCredentialValidation): Promise<boolean>;
}

export interface HostedAppClusterCredentials {
  readonly nautilo: HostedDatabaseSecret;
  readonly nautiloAgent: HostedDatabaseSecret;
  readonly nautiloCrypto: HostedDatabaseSecret;
}

export interface HostedLogtoClusterCredentials {
  readonly logto: HostedDatabaseSecret;
}

export interface HostedClusterReconciliationRequest {
  readonly cluster: "app";
  readonly credentials: HostedAppClusterCredentials;
}

export interface HostedLogtoClusterReconciliationRequest {
  readonly cluster: "logto";
  readonly credentials: HostedLogtoClusterCredentials;
}

export type HostedClusterRequest =
  | HostedClusterReconciliationRequest
  | HostedLogtoClusterReconciliationRequest;

/** Receipt-safe checkpoint; it contains neither SQL nor credential values. */
export interface HostedClusterCheckpoint {
  readonly cluster: HostedClusterKind;
  readonly stage: HostedClusterStage;
  readonly outcome: "created" | "already-present" | "reconciled" | "validated";
}

export type HostedClusterFailureKind =
  | "adapter-failure"
  | "vector-unavailable"
  | "credential-mismatch";

export interface HostedClusterFailure {
  readonly kind: HostedClusterFailureKind;
  readonly cluster: HostedClusterKind;
  readonly stage: HostedClusterStage;
  /** No driver error, SQL text, or credential is surfaced. */
  readonly retryable: boolean;
}

export type HostedClusterReconciliationResult =
  | {
      readonly status: "succeeded";
      readonly checkpoints: readonly HostedClusterCheckpoint[];
    }
  | {
      readonly status: "failed";
      readonly checkpoints: readonly HostedClusterCheckpoint[];
      readonly failure: HostedClusterFailure;
    };

const NAUTILO_ROLE_ATTRIBUTES: HostedRoleAttributes = Object.freeze({
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: true,
});

const NAUTILO_AGENT_ROLE_ATTRIBUTES: HostedRoleAttributes = Object.freeze({
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
});

const NAUTILO_CRYPTO_ROLE_ATTRIBUTES: HostedRoleAttributes = Object.freeze({
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: false,
  replication: false,
  bypassRls: false,
});

/** Logto's seed creates its tenant roles, so this is the minimal extra power. */
const LOGTO_ROLE_ATTRIBUTES: HostedRoleAttributes = Object.freeze({
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: true,
  inherit: true,
  replication: false,
  bypassRls: false,
});

/**
 * Database-level boundary for the dedicated app cluster. The detailed schema
 * grants, sensitive revokes, views, and default privileges come from the
 * established builders below rather than being duplicated here.
 */
const APP_DATABASE_ACCESS_SQL = `
ALTER DATABASE nautilo OWNER TO nautilo;
REVOKE ALL ON DATABASE nautilo FROM PUBLIC, nautilo_agent, nautilo_crypto;
GRANT ALL ON DATABASE nautilo TO nautilo;
GRANT CONNECT ON DATABASE nautilo TO nautilo_agent, nautilo_crypto;
`.trim();

/** PUBLIC keeps default CONNECT for Logto's seed-created tenant roles. */
const LOGTO_DATABASE_ACCESS_SQL = `
ALTER DATABASE logto_nautilo OWNER TO logto;
GRANT ALL ON DATABASE logto_nautilo TO logto;
`.trim();

/**
 * Reuses the canonical existing repair builders. Unlike the legacy full
 * helper, vector is a separate, explicitly checkpointed stage here.
 */
const APP_SCHEMA_CONTRACT_SQL = [
  buildEventFeedReaderRoleSql(),
  buildAppRoleOwnershipRepairSql(),
  buildAgentRoleGrantsSql(),
  // The role-level portion is password-bearing only when a caller supplies
  // an option. With no option it reads an env variable, so it is intentionally
  // not used by the hosted reconciler; the required crypto role is created by
  // the opaque adapter and its attributes are reconciled above.
].join("\n\n");

function checkpoint(
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  outcome: HostedClusterCheckpoint["outcome"],
): HostedClusterCheckpoint {
  return { cluster: request.cluster, stage, outcome };
}

function failure(
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  kind: HostedClusterFailureKind,
): HostedClusterReconciliationResult {
  return {
    status: "failed",
    checkpoints: [],
    failure: {
      kind,
      cluster: request.cluster,
      stage,
      retryable: kind === "adapter-failure" || kind === "vector-unavailable",
    },
  };
}

async function runStage<T>(
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  work: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: HostedClusterReconciliationResult }> {
  try {
    return { ok: true, value: await work() };
  } catch {
    return { ok: false, result: failure(request, stage, "adapter-failure") };
  }
}

async function ensureRole(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  role: HostedRoleName,
  password: HostedDatabaseSecret,
  attributes: HostedRoleAttributes,
): Promise<{ readonly checkpoint: HostedClusterCheckpoint } | { readonly result: HostedClusterReconciliationResult }> {
  const exists = await runStage(request, stage, () => adapter.roleExists(role));
  if (!exists.ok) return { result: exists.result };
  if (!exists.value) {
    const created = await runStage(request, stage, () =>
      adapter.createRole({ role, password, attributes }),
    );
    if (!created.ok) return { result: created.result };
  }
  const reconciled = await runStage(request, stage, () =>
    adapter.reconcileRoleAttributes({ role, attributes }),
  );
  if (!reconciled.ok) return { result: reconciled.result };
  return { checkpoint: checkpoint(request, stage, exists.value ? "already-present" : "created") };
}

async function ensureDatabase(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterRequest,
  database: Exclude<HostedClusterDatabase, "postgres">,
  owner: HostedRoleName,
): Promise<{ readonly checkpoint: HostedClusterCheckpoint } | { readonly result: HostedClusterReconciliationResult }> {
  const stage: HostedClusterStage = "ensure-database";
  const exists = await runStage(request, stage, () => adapter.databaseExists(database));
  if (!exists.ok) return { result: exists.result };
  if (!exists.value) {
    const created = await runStage(request, stage, () =>
      adapter.createDatabase({ database, owner, transaction: "forbidden" }),
    );
    if (!created.ok) return { result: created.result };
  }
  return { checkpoint: checkpoint(request, stage, exists.value ? "already-present" : "created") };
}

async function reconcileSql(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  database: HostedClusterDatabase,
  sql: string,
): Promise<{ readonly checkpoint: HostedClusterCheckpoint } | { readonly result: HostedClusterReconciliationResult }> {
  const executed = await runStage(request, stage, () =>
    adapter.executeSql({ database, stage, sql }),
  );
  return executed.ok
    ? { checkpoint: checkpoint(request, stage, "reconciled") }
    : { result: executed.result };
}

async function validateCredential(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterRequest,
  stage: HostedClusterStage,
  database: Exclude<HostedClusterDatabase, "postgres">,
  role: HostedRoleName,
  password: HostedDatabaseSecret,
): Promise<{ readonly checkpoint: HostedClusterCheckpoint } | { readonly result: HostedClusterReconciliationResult }> {
  const checked = await runStage(request, stage, () =>
    adapter.validateCredential({ database, role, password }),
  );
  if (!checked.ok) return { result: checked.result };
  if (!checked.value) return { result: failure(request, stage, "credential-mismatch") };
  return { checkpoint: checkpoint(request, stage, "validated") };
}

async function requireVector(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterReconciliationRequest,
): Promise<
  { readonly checkpoint: HostedClusterCheckpoint }
  | { readonly result: HostedClusterReconciliationResult }
> {
  const stage: HostedClusterStage = "require-vector";
  const installed = await runStage(request, stage, () =>
    adapter.ensureRequiredExtension({
      database: "nautilo",
      extension: "vector",
      stage,
      sql: buildVectorExtensionRepairSql(),
    }),
  );
  if (!installed.ok) return { result: installed.result };
  if (!installed.value) return { result: failure(request, stage, "vector-unavailable") };
  return { checkpoint: checkpoint(request, stage, "reconciled") };
}

/**
 * Reconcile one isolated hosted cluster. Results are intentionally typed and
 * redacted so a receipt-driven caller can persist checkpoints, retry after
 * any stage, and surface a safe failure without ever rotating a credential.
 */
export async function reconcileHostedCluster(
  adapter: HostedClusterAdminAdapter,
  request: HostedClusterRequest,
): Promise<HostedClusterReconciliationResult> {
  const checkpoints: HostedClusterCheckpoint[] = [];
  const append = <T extends { readonly checkpoint: HostedClusterCheckpoint } | { readonly result: HostedClusterReconciliationResult }>(
    step: T,
  ): HostedClusterReconciliationResult | null => {
    if ("result" in step) {
      return step.result.status === "failed"
        ? { ...step.result, checkpoints: [...checkpoints, ...step.result.checkpoints] }
        : step.result;
    }
    checkpoints.push(step.checkpoint);
    return null;
  };

  if (request.cluster === "app") {
    let stopped = append(await ensureRole(adapter, request, "ensure-primary-role", "nautilo", request.credentials.nautilo, NAUTILO_ROLE_ATTRIBUTES));
    if (stopped) return stopped;
    stopped = append(await ensureRole(adapter, request, "ensure-agent-role", "nautilo_agent", request.credentials.nautiloAgent, NAUTILO_AGENT_ROLE_ATTRIBUTES));
    if (stopped) return stopped;
    stopped = append(await ensureRole(adapter, request, "ensure-crypto-role", "nautilo_crypto", request.credentials.nautiloCrypto, NAUTILO_CRYPTO_ROLE_ATTRIBUTES));
    if (stopped) return stopped;
    stopped = append(await ensureDatabase(adapter, request, "nautilo", "nautilo"));
    if (stopped) return stopped;
    stopped = append(await reconcileSql(adapter, request, "reconcile-database-access", "postgres", APP_DATABASE_ACCESS_SQL));
    if (stopped) return stopped;
    stopped = append(await requireVector(adapter, request));
    if (stopped) return stopped;
    stopped = append(await reconcileSql(adapter, request, "reconcile-app-contract", "nautilo", APP_SCHEMA_CONTRACT_SQL));
    if (stopped) return stopped;
    stopped = append(await validateCredential(adapter, request, "validate-primary-credential", "nautilo", "nautilo", request.credentials.nautilo));
    if (stopped) return stopped;
    stopped = append(await validateCredential(adapter, request, "validate-agent-credential", "nautilo", "nautilo_agent", request.credentials.nautiloAgent));
    if (stopped) return stopped;
    stopped = append(await validateCredential(adapter, request, "validate-crypto-credential", "nautilo", "nautilo_crypto", request.credentials.nautiloCrypto));
    if (stopped) return stopped;
  } else {
    let stopped = append(await ensureRole(adapter, request, "ensure-primary-role", "logto", request.credentials.logto, LOGTO_ROLE_ATTRIBUTES));
    if (stopped) return stopped;
    stopped = append(await ensureDatabase(adapter, request, "logto_nautilo", "logto"));
    if (stopped) return stopped;
    stopped = append(await reconcileSql(adapter, request, "reconcile-database-access", "postgres", LOGTO_DATABASE_ACCESS_SQL));
    if (stopped) return stopped;
    stopped = append(await validateCredential(adapter, request, "validate-primary-credential", "logto_nautilo", "logto", request.credentials.logto));
    if (stopped) return stopped;
  }

  return { status: "succeeded", checkpoints };
}

/** Exposed for exact contract tests; it contains no credentials. */
export function getHostedClusterContractSql(cluster: HostedClusterKind): {
  readonly databaseAccess: string;
  readonly schemaContract?: string;
} {
  return cluster === "app"
    ? { databaseAccess: APP_DATABASE_ACCESS_SQL, schemaContract: APP_SCHEMA_CONTRACT_SQL }
    : { databaseAccess: LOGTO_DATABASE_ACCESS_SQL };
}

/** Exposed for adapter contract tests; no role password is included. */
export function getHostedClusterRoleAttributes(
  role: HostedRoleName,
): HostedRoleAttributes {
  switch (role) {
    case "nautilo": return NAUTILO_ROLE_ATTRIBUTES;
    case "nautilo_agent": return NAUTILO_AGENT_ROLE_ATTRIBUTES;
    case "nautilo_crypto": return NAUTILO_CRYPTO_ROLE_ATTRIBUTES;
    case "logto": return LOGTO_ROLE_ATTRIBUTES;
  }
}
