import { PHYSICAL_FILE_URI_COLUMNS, physicalFileUriBase, rebindPhysicalFileUri } from "@nautilo/db";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  resolveInstanceUncached,
  resolveNautiloStorageRoot,
  resolvedInstanceChildEnv,
  validateNautiloInstanceIdValue,
  type ResolvedInstance,
} from "@nautilo/config";
import { parseEnvFile } from "@nautilo/config-guard";
import { DEPENDENCY_PINS } from "../../../../deploy/dependency-pins";
import { buildEventFeedReaderRoleSql } from "../../../../packages/db/src/utils/event-feed-role";
import {
  verifyFullBackupDirectory,
  verifyCanonicalDefaultFullBackupDirectory,
  sha256File,
  type VerifiedFullBackup,
} from "../lib/full-dev-backup";
import {
  assertExactMigrationPrefix,
  captureDatabaseMigrationLineage,
  mapDatabaseLedgerToCheckout,
  planMigrationLineageReconciliation,
  readCheckoutMigrationLineage,
  type DatabaseMigrationEntry,
  type MigrationLineageEntry,
  type MigrationLineageReconciliationPlan,
} from "../lib/migration-lineage";
import {
  importPostgresDatabaseGzip,
  postgresMajorVersion,
  queryPostgresContainer,
} from "../lib/postgres-archive";
import {
  assertCloneTargetAbsent,
  inspectCloneTargetState,
} from "../lib/clone-preflight";
import {
  rebindCloneEnvContent,
  writeReboundCloneEnv,
} from "../lib/clone-config-rebind";
import {
  CLONE_STAGES,
  runCloneStages,
  type CloneOperationRecord,
  type CloneStage,
} from "../lib/clone-operation";
import {
  dockerComposeDbDevPrefixRaw,
  dockerComposeNautiloPrefixRaw,
  ensureClonedInfraCredentialAuthorityBeforeVolume,
  ensureOpenConnectorEncryptionKeyForInstance,
  infraPersistentVolumeNames,
  NAUTILO_REPO_ROOT,
} from "../lib/compose-infra";
import { findListenerPid, looksLikeNautiloServer } from "../lib/listener-pid";
import {
  parseCloneSource,
  selectCloneMaterialization,
  type CloneSourceSelection,
  type CloneTargetSelection,
} from "../lib/clone-source-selection";
import type { CloneSeedHandle } from "../lib/clone-seed-store";
import { collectDockerPublishedTcpPorts } from "../lib/docker-published-ports";
import {
  VERIFY_FAILURE_IDS_JSON_FLAG,
  parseAuthoritativeVerifyFailureId,
  type AuthoritativeVerifyFailureId,
} from "./verify";

const DB_PACKAGE_DIR = join(NAUTILO_REPO_ROOT, "packages", "db");
const MIGRATIONS_DIR = join(DB_PACKAGE_DIR, "src", "migrations");
const WORKBENCH_INDEX = join(
  NAUTILO_REPO_ROOT,
  "apps",
  "workbench",
  "dist",
  "index.html",
);

export function isCloneWorkbenchIndexHtml(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return /<!doctype\s+html|<html(?:\s|>)/i.test(readFileSync(path, "utf8").slice(0, 4096));
  } catch {
    return false;
  }
}

export function resolveCloneWorkbenchIndex(
  env: NodeJS.ProcessEnv,
): { indexPath: string; explicit: boolean } {
  const configured = env["NAUTILO_WORKBENCH_DIST"]?.trim() ?? "";
  return configured === ""
    ? { indexPath: WORKBENCH_INDEX, explicit: false }
    : { indexPath: join(configured, "index.html"), explicit: true };
}
const OPERATION_FILE = "clone-operation.json";
const TARGET_FREE_SPACE_MULTIPLIER = 3;

export interface CloneArgs {
  from: string;
  to: string;
}

export function clonePortInventoryWarningSink(
  quiet: boolean,
  warn: (message: string) => void = console.warn,
): ((message: string) => void) | undefined {
  return quiet ? undefined : warn;
}

export interface CloneMaterializationRequest {
  source: CloneSourceSelection;
  target: CloneTargetSelection;
}

/** Explicit capability produced only by the canonical-default seed admission. */
export interface CanonicalDefaultCloneAdmission {
  readonly seed: CloneSeedHandle;
  /** The seed repository, not the materializer, owns this truthful label. */
  readonly freshness?: "fresh" | "reused";
}

export type CloneMaterializationMode = "full" | "provision";

export interface CloneMaterializationOptions {
  /** Provision stops before workbench/server/acceptance; dev-stack owns that tail. */
  readonly mode?: CloneMaterializationMode;
  /** The provision owns the only infra:start invocation, including Office. */
  readonly office?: boolean;
  /** Suppress progress and child stdout so a composing caller can own one JSON document. */
  readonly quiet?: boolean;
  /** D489 disposable worker only: isolated lineage plus the real migration runner. */
  readonly disposableMigrationAcceptance?: {
    readonly checkoutLineage: readonly MigrationLineageEntry[];
    readonly run: (input: {
      readonly target: ResolvedInstance;
      readonly targetEnv: NodeJS.ProcessEnv;
    }) => Promise<void>;
  };
  /** Disposable acceptance only: Compose must use already-present images. */
  readonly noPullOrBuild?: boolean;
}

export const CLONE_DATABASES_STARTED_FAILURE_CODES = [
  "legacy-compose",
  "logto-compose",
  "legacy-readiness",
  "logto-readiness",
  "major-version",
] as const;
export type CloneDatabasesStartedFailureCode =
  typeof CLONE_DATABASES_STARTED_FAILURE_CODES[number];
export const CLONE_COMPOSE_FAILURE_CATEGORIES = [
  "port-conflict",
  "container-name-conflict",
  "missing-image",
  "compose-config",
  "daemon-unavailable",
  "unknown",
] as const;
export type CloneComposeFailureCategory = typeof CLONE_COMPOSE_FAILURE_CATEGORIES[number];

export function classifyCloneComposeFailure(error: unknown): CloneComposeFailureCategory {
  const text = error instanceof Error ? error.message : "";
  if (/port is already allocated|address already in use|failed to bind host port|bind for .+ failed/i.test(text)) {
    return "port-conflict";
  }
  if (/container name .+ already in use|conflict.+container name/i.test(text)) {
    return "container-name-conflict";
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect/i.test(text)) {
    return "daemon-unavailable";
  }
  if (/no such image|pull access denied|pull policy.+never|image.+must be built|not found locally|unable to get image/i.test(text)) {
    return "missing-image";
  }
  if (/compose.+(?:config|project)|interpolat|invalid.+ya?ml|variable .+ is not set|no configuration file/i.test(text)) {
    return "compose-config";
  }
  return "unknown";
}

/** Fixed-code failure written to clone-operation.json before target cleanup. */
export class CloneDatabasesStartedError extends Error {
  constructor(
    readonly code: CloneDatabasesStartedFailureCode,
    cause?: unknown,
    readonly composeCategory: CloneComposeFailureCategory | null = null,
  ) {
    super(`Clone database startup failed at ${code}`, { cause });
    this.name = "CloneDatabasesStartedError";
  }
}

export function cloneDatabasesStartedFailureCode(
  error: unknown,
): CloneDatabasesStartedFailureCode | null {
  return error instanceof CloneDatabasesStartedError ? error.code : null;
}

export function cloneDatabasesStartedComposeCategory(
  error: unknown,
): CloneComposeFailureCategory | null {
  return error instanceof CloneDatabasesStartedError ? error.composeCategory : null;
}

export async function runCloneDatabasesStartedSteps(input: Readonly<Record<
  CloneDatabasesStartedFailureCode,
  () => Promise<void>
>>): Promise<void> {
  for (const code of CLONE_DATABASES_STARTED_FAILURE_CODES) {
    try {
      await input[code]();
    } catch (error) {
      const composeCategory = code === "legacy-compose" || code === "logto-compose"
        ? classifyCloneComposeFailure(error)
        : null;
      throw new CloneDatabasesStartedError(code, error, composeCategory);
    }
  }
}

export const CLONE_ACCEPTANCE_FAILURE_CODES = [
  "verify-command",
  "identity-rebind",
  "historical-anchors",
  "lineage",
  "resource-isolation",
  "source-isolation",
] as const;
export type CloneAcceptanceFailureCode = typeof CLONE_ACCEPTANCE_FAILURE_CODES[number];

/** Fixed internal boundary for a failed full-clone acceptance stage. */
export class CloneAcceptanceError extends Error {
  constructor(readonly code: CloneAcceptanceFailureCode, cause?: unknown) {
    super(`Clone acceptance failed at ${code}`, { cause });
    this.name = "CloneAcceptanceError";
  }
}

export class CloneVerifyCommandError extends Error {
  constructor(readonly failureId: AuthoritativeVerifyFailureId, cause?: unknown) {
    super(`Clone verify command failed at ${failureId}`, { cause });
    this.name = "CloneVerifyCommandError";
  }
}

export function cloneAcceptanceFailureCode(error: unknown): CloneAcceptanceFailureCode | null {
  return error instanceof CloneAcceptanceError ? error.code : null;
}

export function cloneAcceptanceVerifyFailureId(error: unknown): AuthoritativeVerifyFailureId | null {
  if (!(error instanceof CloneAcceptanceError) || error.code !== "verify-command") return null;
  return error.cause instanceof CloneVerifyCommandError ? error.cause.failureId : "unknown";
}

export async function runCloneAcceptanceSteps(input: Readonly<Record<
  CloneAcceptanceFailureCode,
  () => Promise<void>
>>): Promise<void> {
  for (const code of CLONE_ACCEPTANCE_FAILURE_CODES) {
    try {
      await input[code]();
    } catch (error) {
      throw new CloneAcceptanceError(code, error);
    }
  }
}

export function assertCloneComposeEnvAuthority(
  target: ResolvedInstance,
  targetRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  const expected = {
    NAUTILO_INSTANCE_ID: target.instanceId,
    NAUTILO_INSTANCE_ROOT: targetRoot,
    COMPOSE_PROJECT_NAME: target.compose.projectName,
    NAUTILO_DB_PORT: String(target.db.postgresHostPort),
    NAUTILO_LOGTO_DB_PORT: String(target.logto.dbPort),
    NAUTILO_OPENCONNECTOR_ENCRYPTION_KEY_PATH: join(
      targetRoot,
      "runtime-secrets/openconnector-encryption.key",
    ),
    NAUTILO_OPENCONNECTOR_DATA_DIR: join(targetRoot, "openconnector-data"),
  } as const;
  if (Object.entries(expected).some(([key, value]) => env[key] !== value)) {
    throw new Error("Clone Compose config authority mismatch");
  }
}

const CLONE_FILE_URI_COLUMNS = PHYSICAL_FILE_URI_COLUMNS;
// Workspace mutation receipt/outbox correlation binds artifact identity,
// logical path, revision, and content SHA; its storage URI fields are physical
// replay pointers required only to be nonempty. Rebinding these five physical
// columns therefore preserves the canonical receipt/content proofs.

const cloneFileUriBase = physicalFileUriBase;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const rebindCloneFileUriValue = rebindPhysicalFileUri;

export function buildCloneFileUriRebindSql(
  sourceRoot: string,
  targetRoot: string,
): { updateSql: string; verifySql: string } {
  if (sourceRoot === targetRoot) throw new Error("Clone file-URI roots must differ");
  const sourceBase = sqlLiteral(cloneFileUriBase(sourceRoot));
  const targetBase = sqlLiteral(cloneFileUriBase(targetRoot));
  const within = (expression: string, base: string): string => `(
    ${expression} = ${base} OR (
      left(${expression}, char_length(${base})) = ${base}
      AND substr(${expression}, char_length(${base}) + 1, 1) = '/'
    )
  )`;
  const updates = CLONE_FILE_URI_COLUMNS.map(([table, column]) => `
    UPDATE public."${table}"
    SET "${column}" = ${targetBase} || substr("${column}", char_length(${sourceBase}) + 1)
    WHERE ${within(`"${column}"`, sourceBase)};
  `).join("");
  const physicalUris = CLONE_FILE_URI_COLUMNS.map(([table, column]) => `
    SELECT "${column}" AS uri FROM public."${table}" WHERE "${column}" IS NOT NULL
  `).join(" UNION ALL ");
  return {
    updateSql: `BEGIN;${updates}COMMIT;`,
    verifySql: `
      SELECT
        count(*) FILTER (WHERE ${within("uri", sourceBase)})::text
        || '|' ||
        count(*) FILTER (
          WHERE left(uri, char_length('file://')) = 'file://'
            AND NOT ${within("uri", targetBase)}
        )::text
      FROM (${physicalUris}) AS cloned_physical_uris;
    `,
  };
}

function rebindCloneFileUris(
  target: ResolvedInstance,
  sourceRoot: string,
  targetRoot: string,
): void {
  const sql = buildCloneFileUriRebindSql(sourceRoot, targetRoot);
  queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.updateSql,
  });
  const remaining = queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.verifySql,
  });
  if (remaining !== "0|0") {
    throw new Error("Clone file-URI rebind left source-root or external file authority");
  }
}

/**
 * Pure capability check: reject an absent, failed, or non-canonical admission
 * before inspecting a source root, Docker, or any other live surface.
 */
export function validateCanonicalDefaultCloneAdmission(
  admission: CanonicalDefaultCloneAdmission | undefined,
): asserts admission is CanonicalDefaultCloneAdmission {
  const operation = admission?.seed?.operation;
  if (operation === undefined || operation.status !== "published") {
    throw new Error("Canonical default source requires an admitted published clone seed");
  }
  if (operation.source.authority !== "canonical-default") {
    throw new Error("Canonical default clone admission has the wrong source authority");
  }
}

export type CloneMaterializer = (
  request: CloneMaterializationRequest,
) => Promise<number>;

/**
 * The clone runner deliberately keeps its stage machine declarative. This is
 * a narrow test seam: it pins the externally visible operation journal to the
 * work performed by cloneDevInstance without making Docker or a source
 * instance injectable into normal command execution.
 */
export function buildCloneStagePlan(
  actions: Readonly<Record<CloneStage, () => Promise<void>>>,
): ReadonlyArray<{ name: CloneStage; run: () => Promise<void> }> {
  return CLONE_STAGES.map((name) => ({ name, run: actions[name] }));
}

export function assertCloneResourceIsolation(input: {
  sourceObjects: ReturnType<typeof dockerObjectsForProject>;
  targetObjects: ReturnType<typeof dockerObjectsForProject>;
  sourceVolumes: readonly string[];
  targetVolumes: readonly string[];
}): void {
  if (
    input.sourceObjects.containers.some((name) => input.targetObjects.containers.includes(name)) ||
    input.sourceObjects.networks.some((name) => input.targetObjects.networks.includes(name)) ||
    input.sourceVolumes.some((name) => input.targetVolumes.includes(name))
  ) {
    throw new Error("Source/target isolation proof failed");
  }
}

export function formatCloneFailure(operationPath: string, targetId: string): string {
  return (
    `[dev:clone] failed; evidence preserved at ${operationPath}. ` +
    `Cleanup explicitly with: bun run dev:delete-instance ${targetId} --yes`
  );
}

export function formatCloneReady(input: {
  targetId: string;
  targetUrl: string;
  appliedMigrationCount: number;
}): string {
  return (
    `[dev:clone] ${input.targetId} is ready at ${input.targetUrl}; ` +
    `${input.appliedMigrationCount} Nautilo migration(s) applied.`
  );
}

export function buildCloneSourceCaptureCommand(
  backupName: string,
  sourceId: string,
): string[] {
  return [
    join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts"),
    "save",
    backupName,
    "--instance",
    sourceId,
  ];
}

export function validateCloneArgs(args: CloneArgs): void {
  for (const [label, id] of [["--from", args.from], ["--to", args.to]] as const) {
    if (id === "" || validateNautiloInstanceIdValue(id) !== null) {
      throw new Error(`${label} must be a valid nonempty named-instance id`);
    }
  }
  if (args.from === args.to) throw new Error("--from and --to must differ");
}

function cleanInstanceEnv(instanceId: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env["HOME"] ?? homedir(),
    USERPROFILE: process.env["USERPROFILE"],
    PATH: process.env["PATH"],
    NAUTILO_INSTANCE_ID: instanceId,
  };
}

function envValues(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of parseEnvFile(raw)) {
    if (entry.type === "pair") values[entry.key] = entry.value;
  }
  return values;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? NAUTILO_REPO_ROOT,
      env: options.env ?? process.env,
      stdio: options.inherit === false ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stderr = "";
    child.stdout?.on("data", () => {
      // A quiet composing caller intentionally discards progress output, but
      // still drains the pipe so a verbose child cannot deadlock.
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`));
    });
  });
}

function runCloneVerify(
  targetId: string,
  env: NodeJS.ProcessEnv,
  quiet: boolean,
): Promise<void> {
  const args = [
    join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts"),
    "verify",
    "--instance",
    targetId,
    VERIFY_FAILURE_IDS_JSON_FLAG,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("bun", args, {
      cwd: NAUTILO_REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
      if (!quiet) process.stderr.write(chunk);
    });
    child.on("error", (error) => reject(new CloneVerifyCommandError("unknown", error)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new CloneVerifyCommandError(parseAuthoritativeVerifyFailureId(stdout)));
    });
  });
}

function dockerObjectsForProject(projectName: string): {
  containers: string[];
  networks: string[];
} {
  const collect = (args: string[]): string[] => {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "Docker inspection failed").trim());
    }
    return result.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  };
  return {
    containers: collect([
      "ps", "-a", "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format", "{{.Names}}",
    ]),
    networks: collect([
      "network", "ls", "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format", "{{.Name}}",
    ]),
  };
}

export interface SourceIsolationEvidence {
  instanceJsonHash: string;
  instanceEnvHash: string;
  volumeState: string;
  projectObjects: ReturnType<typeof dockerObjectsForProject>;
  writersRunning: boolean;
  databaseLedger?: DatabaseMigrationEntry[];
  rowAnchors?: Record<string, number>;
}

/** Canonical capture additionally proves restoration of its live writers. */
export interface CanonicalDefaultSourceIsolationEvidence extends SourceIsolationEvidence {
  readonly serverListenerState: "absent" | `recognized:${number}`;
  readonly logtoCoreState: "true|false" | "absent";
  readonly databaseIdentity: string;
}

export const CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES = [
  "source-selector",
  "source-root",
  "source-mode",
  "source-listener",
  "source-logto",
  "source-database-identity",
  "source-snapshot",
] as const;
export type CanonicalDefaultSourceEvidenceFailureCode =
  typeof CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES[number];

/** Stable, secret-free boundary for canonical-source admission diagnostics. */
export class CanonicalDefaultSourceEvidenceError extends Error {
  constructor(readonly code: CanonicalDefaultSourceEvidenceFailureCode) {
    super(`Canonical default source evidence failed at ${code}`);
    this.name = "CanonicalDefaultSourceEvidenceError";
  }
}

export function canonicalDefaultSourceEvidenceFailureCode(
  error: unknown,
): CanonicalDefaultSourceEvidenceFailureCode | null {
  return error instanceof CanonicalDefaultSourceEvidenceError ? error.code : null;
}

function canonicalEvidenceStep<T>(
  code: CanonicalDefaultSourceEvidenceFailureCode,
  action: () => T,
): T {
  try {
    return action();
  } catch {
    throw new CanonicalDefaultSourceEvidenceError(code);
  }
}

async function canonicalEvidenceStepAsync<T>(
  code: CanonicalDefaultSourceEvidenceFailureCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new CanonicalDefaultSourceEvidenceError(code);
  }
}

export function assertSourceEvidenceEqual(
  expected: SourceIsolationEvidence,
  actual: SourceIsolationEvidence,
): void {
  if (
    actual.instanceJsonHash !== expected.instanceJsonHash ||
    actual.instanceEnvHash !== expected.instanceEnvHash ||
    actual.volumeState !== expected.volumeState ||
    JSON.stringify(actual.projectObjects) !== JSON.stringify(expected.projectObjects) ||
    actual.writersRunning !== expected.writersRunning ||
    JSON.stringify(actual.databaseLedger) !== JSON.stringify(expected.databaseLedger) ||
    JSON.stringify(actual.rowAnchors) !== JSON.stringify(expected.rowAnchors)
  ) {
    throw new Error("Source isolation proof failed: source state changed during clone");
  }
}

export function assertCanonicalDefaultSourceEvidenceEqual(
  expected: CanonicalDefaultSourceIsolationEvidence,
  actual: CanonicalDefaultSourceIsolationEvidence,
): void {
  assertSourceEvidenceEqual(expected, actual);
  if (
    expected.serverListenerState !== actual.serverListenerState ||
    expected.logtoCoreState !== actual.logtoCoreState ||
    expected.databaseIdentity !== actual.databaseIdentity
  ) {
    throw new Error("Source isolation proof failed: canonical writer or identity state changed during clone");
  }
}

/** Only a schema-aware query may label the identity marker unavailable. */
export function canonicalDatabaseIdentityEvidence(queryResult: string): string {
  return queryResult === "__nautilo_identity_relation_absent__"
    ? "unavailable"
    : queryResult === ""
      ? "missing"
      : queryResult;
}

export const CANONICAL_DATABASE_IDENTITY_RELATION_SQL = `
  SELECT to_regclass('public.nautilo_instance_identity') IS NOT NULL;
`;
export const CANONICAL_DATABASE_IDENTITY_VALUE_SQL = `
  SELECT instance_id
  FROM public.nautilo_instance_identity
  WHERE id = 'self'
  LIMIT 1;
`;

/**
 * The relation probe and row read are deliberately separate statements.
 * PostgreSQL must never plan a reference to an optional legacy relation until
 * its existence has been established. A relation dropped between the reads
 * fails closed through the typed evidence boundary.
 */
export function captureCanonicalDatabaseIdentityEvidence(
  query: (sql: string) => string,
): string {
  return canonicalEvidenceStep("source-database-identity", () => {
    const relationExists = query(CANONICAL_DATABASE_IDENTITY_RELATION_SQL);
    if (relationExists === "f") {
      return canonicalDatabaseIdentityEvidence("__nautilo_identity_relation_absent__");
    }
    if (relationExists !== "t") {
      throw new Error("invalid identity relation probe");
    }
    return canonicalDatabaseIdentityEvidence(query(CANONICAL_DATABASE_IDENTITY_VALUE_SQL));
  });
}

function dockerContainerRunning(container: string): boolean {
  const result = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", container],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function volumeState(inst: ResolvedInstance): string {
  return infraPersistentVolumeNames(inst)
    .map((name) => {
      const result = spawnSync("docker", ["volume", "inspect", name], {
        encoding: "utf8",
      });
      if (result.status === 0) return result.stdout.trim();
      if (/\bno such volume\b/i.test(result.stderr)) return `${name}:absent`;
      if (result.error) throw result.error;
      throw new Error(`Could not inspect source volume ${name}`);
    })
    .join("\n");
}

function readAnchorCounts(
  backup: VerifiedFullBackup,
  inst: ResolvedInstance,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of Object.keys(backup.manifest.rowAnchors)) {
    const [database, table] = key.split(".");
    if (!database || !table || !/^[a-z_][a-z0-9_]*$/i.test(table)) {
      throw new Error(`Invalid backup row anchor ${key}`);
    }
    const container =
      database === "nautilo"
        ? inst.compose.containers.legacyPostgres
        : database === "logto"
          ? inst.compose.containers.logtoPostgres
          : null;
    if (container === null) throw new Error(`Invalid backup row anchor ${key}`);
    counts[key] = Number.parseInt(
      queryPostgresContainer({
        container,
        database: database === "nautilo" ? "nautilo" : "logto_nautilo",
        sql: `SELECT count(*) FROM public.${table};`,
      }),
      10,
    );
  }
  return counts;
}

async function captureSourceEvidence(
  sourceRoot: string,
  source: ResolvedInstance,
  backup?: VerifiedFullBackup,
): Promise<SourceIsolationEvidence> {
  const writersRunning =
    dockerContainerRunning(source.compose.containers.legacyPostgres) &&
    dockerContainerRunning(source.compose.containers.logtoPostgres);
  return {
    instanceJsonHash: await sha256File(join(sourceRoot, "instance.json")),
    instanceEnvHash: await sha256File(join(sourceRoot, "instance.env")),
    volumeState: volumeState(source),
    projectObjects: dockerObjectsForProject(source.compose.projectName),
    writersRunning,
    ...(writersRunning
      ? {
          databaseLedger: readDatabaseLedger(
            source.compose.containers.legacyPostgres,
          ),
          ...(backup === undefined ? {} : { rowAnchors: readAnchorCounts(backup, source) }),
        }
      : {}),
  };
}

async function assertSourceEvidenceUnchanged(
  expected: SourceIsolationEvidence,
  sourceRoot: string,
  source: ResolvedInstance,
  backup: VerifiedFullBackup,
): Promise<void> {
  const actual = await captureSourceEvidence(sourceRoot, source, backup);
  assertSourceEvidenceEqual(expected, actual);
}

/** Production source proof used by canonical seed capture before and after it. */
export async function captureCanonicalDefaultSourceEvidence(
  selection: CloneSourceSelection,
): Promise<CanonicalDefaultSourceIsolationEvidence> {
  if (selection.kind !== "canonical-default" || selection.instanceId !== "") {
    throw new CanonicalDefaultSourceEvidenceError("source-selector");
  }
  const userHome = process.env["HOME"]?.trim() || homedir();
  if (selection.root !== resolveNautiloStorageRoot(userHome, "")) {
    throw new CanonicalDefaultSourceEvidenceError("source-root");
  }
  const source = canonicalEvidenceStep("source-mode", () => resolveInstanceUncached(cleanInstanceEnv(""), {
    skipUserConfigOverlay: true,
  }));
  if (source.deploymentMode !== "local-self-host") {
    throw new CanonicalDefaultSourceEvidenceError("source-mode");
  }
  const listenerPid = canonicalEvidenceStep("source-listener", () => {
    const pid = findListenerPid(source.server.port);
    if (pid !== null && !looksLikeNautiloServer(pid)) {
      throw new Error("unrecognized listener");
    }
    return pid;
  });
  const logtoState = canonicalEvidenceStep("source-logto", () => spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}|{{.State.Paused}}", source.compose.containers.logtoCore],
    { encoding: "utf8" },
  ));
  if (logtoState.error) throw new CanonicalDefaultSourceEvidenceError("source-logto");
  const logtoCoreState = logtoState.status === 0
    ? logtoState.stdout.trim()
    : "absent";
  if (logtoCoreState !== "absent" && logtoCoreState !== "true|false") {
    throw new CanonicalDefaultSourceEvidenceError("source-logto");
  }
  const databaseIdentity = captureCanonicalDatabaseIdentityEvidence((sql) => queryPostgresContainer({
      container: source.compose.containers.legacyPostgres,
      database: "nautilo",
      // Do not catch query failures: permission, transient, and relation-race
      // errors are not proof that an older schema lacks the marker.
      sql,
    }));
  return {
    ...(await canonicalEvidenceStepAsync("source-snapshot", () => captureSourceEvidence(selection.root, source))),
    serverListenerState: listenerPid === null ? "absent" : `recognized:${listenerPid}`,
    logtoCoreState,
    databaseIdentity,
  };
}

export async function assertCanonicalDefaultSourceEvidenceUnchanged(
  expected: CanonicalDefaultSourceIsolationEvidence,
  selection: CloneSourceSelection,
): Promise<void> {
  assertCanonicalDefaultSourceEvidenceEqual(expected, await captureCanonicalDefaultSourceEvidence(selection));
}

export interface PostgresSqlReadinessProbe {
  readonly isPgReady: () => boolean;
  readonly readMajorVersion: () => number;
  readonly sleep: () => Promise<void>;
}

/**
 * pg_isready proves the postmaster is accepting connection attempts, but not
 * that the psql query used immediately after it can complete. Keep polling
 * until the exact version query succeeds, so a transient first-boot query
 * failure is classified as readiness rather than a version mismatch.
 */
export async function waitForPostgresSqlReadiness(
  probe: PostgresSqlReadinessProbe,
  maxAttempts = 60,
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (probe.isPgReady()) {
      try {
        return probe.readMajorVersion();
      } catch {
        // The SQL server is still finishing first-boot readiness. The stable
        // failure below deliberately does not expose a raw database error.
      }
    }
    await probe.sleep();
  }
  throw new Error("PostgreSQL did not become SQL-ready");
}

async function waitForPostgres(container: string): Promise<number> {
  return waitForPostgresSqlReadiness({
    isPgReady: () => spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-U", "postgres"],
      { encoding: "utf8" },
    ).status === 0,
    readMajorVersion: () => postgresMajorVersion(container),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 500)),
  });
}

export function buildCloneDatabaseRecreateSql(
  database: string,
  owner: string,
): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(database) || !/^[a-z_][a-z0-9_]*$/.test(owner)) {
    throw new Error("Unsafe database recreate request");
  }
  if (
    (database !== "nautilo" || owner !== "nautilo") &&
    (database !== "logto_nautilo" || owner !== "logto")
  ) {
    throw new Error("Unsupported clone database recreate request");
  }
  const postCreate =
    database === "nautilo"
      ? `
        REVOKE ALL ON DATABASE nautilo FROM PUBLIC;
        GRANT ALL ON DATABASE nautilo TO nautilo;
        DO $do$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logto') THEN
            EXECUTE 'REVOKE ALL ON DATABASE nautilo FROM logto';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
            EXECUTE 'REVOKE ALL ON DATABASE nautilo FROM nautilo_agent';
            EXECUTE 'GRANT CONNECT ON DATABASE nautilo TO nautilo_agent';
          END IF;
        END
        $do$;
        ${buildEventFeedReaderRoleSql()}
      `
      : `
          DO $do$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo') THEN
              EXECUTE 'REVOKE ALL ON DATABASE logto_nautilo FROM nautilo';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
              EXECUTE 'REVOKE ALL ON DATABASE logto_nautilo FROM nautilo_agent';
            END IF;
          END
          $do$;
          GRANT ALL ON DATABASE logto_nautilo TO logto;
        `;
  return `
    DROP DATABASE IF EXISTS ${database} WITH (FORCE);
    CREATE DATABASE ${database} OWNER ${owner};
    ${postCreate}
  `;
}

function recreateDatabase(container: string, database: string, owner: string): void {
  queryPostgresContainer({
    container,
    database: "postgres",
    sql: buildCloneDatabaseRecreateSql(database, owner),
  });
}

type ClonePostgresQuery = typeof queryPostgresContainer;
type ClonePostgresImport = typeof importPostgresDatabaseGzip;

/** Restore the product database only after provisioning the canonical
 * restricted feed-reader role referenced by historical schema grants. */
export async function restoreCloneNautiloDatabase(
  input: Readonly<{ container: string; inputPath: string }>,
  dependencies: Readonly<{
    query?: ClonePostgresQuery;
    importDatabase?: ClonePostgresImport;
  }> = {},
): Promise<void> {
  const query = dependencies.query ?? queryPostgresContainer;
  const importDatabase = dependencies.importDatabase ?? importPostgresDatabaseGzip;
  query({
    container: input.container,
    database: "postgres",
    sql: buildCloneDatabaseRecreateSql("nautilo", "nautilo"),
  });
  await importDatabase({
    container: input.container,
    database: "nautilo",
    inputPath: input.inputPath,
  });
}

function ensureLogtoRestoreGrantRole(container: string): void {
  queryPostgresContainer({
    container,
    database: "postgres",
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles
          WHERE rolname = 'logto_tenant_logto_nautilo'
        ) THEN
          CREATE ROLE logto_tenant_logto_nautilo NOLOGIN;
        END IF;
      END
      $$;
    `,
  });
}

export const LOGTO_RESTORE_ROLE_TOPOLOGY_SQL = `
  DO $do$
  DECLARE
    tenant record;
    base_role text;
  BEGIN
    FOR tenant IN
      SELECT db_user
      FROM public.tenants
      WHERE db_user IS NOT NULL
    LOOP
      IF tenant.db_user NOT IN (
        'logto_tenant_logto_nautilo_admin',
        'logto_tenant_logto_nautilo_default'
      ) THEN
        RAISE EXCEPTION 'unexpected Logto tenant database role';
      END IF;
      base_role := regexp_replace(tenant.db_user, '_(admin|default)$', '');
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = base_role) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', base_role);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = tenant.db_user) THEN
        EXECUTE format('CREATE ROLE %I LOGIN', tenant.db_user);
      END IF;
      EXECUTE format('GRANT %I TO %I', base_role, tenant.db_user);
      EXECUTE format('GRANT %I TO logto WITH ADMIN OPTION', base_role);
      EXECUTE format(
        'GRANT %I TO logto WITH ADMIN OPTION',
        tenant.db_user
      );
    END LOOP;
  END
  $do$;
`;

function ensureLogtoRestoreRoleTopology(container: string): void {
  queryPostgresContainer({
    container,
    database: "logto_nautilo",
    sql: LOGTO_RESTORE_ROLE_TOPOLOGY_SQL,
  });
}

function readDatabaseLedger(container: string): DatabaseMigrationEntry[] {
  const raw = queryPostgresContainer({
    container,
    database: "nautilo",
    sql: `
      SELECT created_at::text || '|' || hash
      FROM drizzle.__drizzle_migrations
      ORDER BY id ASC;
    `,
  });
  if (raw === "") return [];
  return raw.split("\n").map((line, index) => {
    const separator = line.indexOf("|");
    const createdAt = Number(line.slice(0, separator));
    const sha256 = line.slice(separator + 1);
    if (separator < 1 || !Number.isFinite(createdAt) || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Invalid imported migration row ${index}`);
    }
    return { createdAt, sha256 };
  });
}

function quotedSqlLiteral(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid migration schema anchor: ${value}`);
  }
  return `'${value}'`;
}

export function migrationSchemaAnchorsSatisfied(
  container: string,
  migrationSql: string,
  query: typeof queryPostgresContainer = queryPostgresContainer,
): boolean {
  // A replacement can retain its name while changing its definition. Existing
  // names cannot prove that such a migration has already been applied.
  if (/\bDROP\s+CONSTRAINT\b/i.test(migrationSql)) return false;
  const matches = (pattern: RegExp): string[] =>
    [...migrationSql.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
  const tables = [...new Set(matches(/CREATE TABLE "([^"]+)"/g))];
  const indexes = [...new Set(matches(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g))];
  const constraints = [...new Set(matches(/CONSTRAINT "([^"]+)"/g))];
  const columns = [...migrationSql.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/g)]
    .map((match) => [match[1]!, match[2]!] as const);
  if (tables.length + indexes.length + constraints.length + columns.length === 0) return false;

  const checks: string[] = [];
  if (tables.length > 0) {
    checks.push(`(
      SELECT count(DISTINCT c.relname) = ${tables.length}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname IN (${tables.map(quotedSqlLiteral).join(", ")})
    )`);
  }
  if (indexes.length > 0) {
    checks.push(`(
      SELECT count(DISTINCT indexname) = ${indexes.length}
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (${indexes.map(quotedSqlLiteral).join(", ")})
    )`);
  }
  if (constraints.length > 0) {
    checks.push(`(
      SELECT count(DISTINCT c.conname) = ${constraints.length}
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname IN (${constraints.map(quotedSqlLiteral).join(", ")})
    )`);
  }
  if (columns.length > 0) {
    const values = columns
      .map(([table, column]) => `(${quotedSqlLiteral(table)}, ${quotedSqlLiteral(column)})`)
      .join(", ");
    checks.push(`NOT EXISTS (
      SELECT 1
      FROM (VALUES ${values}) AS expected(table_name, column_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns actual
        WHERE actual.table_schema = 'public'
          AND actual.table_name = expected.table_name
          AND actual.column_name = expected.column_name
      )
    )`);
  }
  return query({
    container,
    database: "nautilo",
    sql: `SELECT (${checks.join(" AND ")})::text;`,
  }) === "true";
}

function applyDivergentTargetMigrationPlan(input: {
  readonly target: ResolvedInstance;
  readonly checkout: readonly MigrationLineageEntry[];
  readonly plan: MigrationLineageReconciliationPlan;
}): void {
  if (input.target.instanceId === "" || input.plan.kind !== "divergent") {
    throw new Error("Divergent migration reconciliation is restricted to a disposable named target");
  }
  const container = input.target.compose.containers.legacyPostgres;
  for (const migration of input.plan.missingCheckout) {
    const migrationPath = join(MIGRATIONS_DIR, `${migration.tag}.sql`);
    const migrationSql = readFileSync(migrationPath, "utf8");
    const actualHash = createHash("sha256").update(migrationSql).digest("hex");
    if (actualHash !== migration.sha256) {
      throw new Error(`Target reconciliation migration changed during clone: ${migration.tag}`);
    }
    if (migrationSchemaAnchorsSatisfied(container, migrationSql)) continue;
    const applied = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "nautilo",
      ],
      {
        input: `BEGIN;\n${migrationSql}\nCOMMIT;\n`,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (applied.error) throw applied.error;
    if (applied.status !== 0) {
      throw new Error(
        `Target-only migration reconciliation failed for ${migration.tag}: ` +
          (applied.stderr || applied.stdout || "psql failed").trim(),
      );
    }
  }

  for (const [index, migration] of input.checkout.entries()) {
    if (
      migration.index !== index ||
      !Number.isFinite(migration.createdAt) ||
      !/^[a-f0-9]{64}$/.test(migration.sha256)
    ) {
      throw new Error(`Invalid checkout migration during target reconciliation at index ${index}`);
    }
  }
  const canonicalRows = input.checkout
    .map((migration) =>
      `('${migration.sha256}', ${migration.createdAt})`,
    )
    .join(",\n");
  queryPostgresContainer({
    container,
    database: "nautilo",
    sql: `
      BEGIN;
      DELETE FROM drizzle.__drizzle_migrations WHERE id IS NOT NULL;
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ${canonicalRows};
      COMMIT;
    `,
  });
}

function assertHistoricalAnchors(
  backup: VerifiedFullBackup,
  target: ResolvedInstance,
): void {
  for (const [key, expected] of Object.entries(backup.manifest.rowAnchors)) {
    const [database, table] = key.split(".");
    if (!database || !table || !/^[a-z_][a-z0-9_]*$/i.test(table)) {
      throw new Error(`Invalid backup row anchor ${key}`);
    }
    const container =
      database === "nautilo"
        ? target.compose.containers.legacyPostgres
        : database === "logto"
          ? target.compose.containers.logtoPostgres
          : null;
    const dbName = database === "nautilo" ? "nautilo" : "logto_nautilo";
    if (container === null) throw new Error(`Invalid backup row anchor ${key}`);
    const actual = Number.parseInt(
      queryPostgresContainer({
        container,
        database: dbName,
        sql: `SELECT count(*) FROM public.${table};`,
      }),
      10,
    );
    if (actual !== expected) {
      throw new Error(`Historical row anchor mismatch for ${key}: ${actual} != ${expected}`);
    }
  }
}

export interface CloneLogtoApplicationIdentity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

function indexCloneLogtoApplications(
  applications: readonly CloneLogtoApplicationIdentity[],
): Map<string, CloneLogtoApplicationIdentity> {
  const byId = new Map<string, CloneLogtoApplicationIdentity>();
  for (const application of applications) {
    if (
      application.id.trim() === "" ||
      application.name.trim() === "" ||
      application.type.trim() === "" ||
      byId.has(application.id)
    ) {
      throw new Error("Clone Logto application projection is invalid");
    }
    byId.set(application.id, application);
  }
  return byId;
}

/**
 * Clone bootstrap may add the D515 browser SPA to an older populated source.
 * Preserve every historical application byte-for-byte and admit only that
 * one exact, instance-persisted Nautilo-owned projection.
 */
export function assertCloneLogtoApplicationProjection(input: {
  readonly historical: readonly CloneLogtoApplicationIdentity[];
  readonly current: readonly CloneLogtoApplicationIdentity[];
  readonly mobileWebAppId?: string;
}): void {
  const historical = indexCloneLogtoApplications(input.historical);
  const current = indexCloneLogtoApplications(input.current);
  for (const [id, expected] of historical) {
    const actual = current.get(id);
    if (
      actual === undefined ||
      actual.name !== expected.name ||
      actual.type !== expected.type
    ) {
      throw new Error("Clone Logto application projection changed historical state");
    }
  }

  const mobileWebAppId = input.mobileWebAppId?.trim() ?? "";
  const mobileWebApplication = current.get(mobileWebAppId);
  if (
    mobileWebAppId === "" ||
    mobileWebApplication?.name !== "Nautilo Mobile Web" ||
    mobileWebApplication.type !== "SPA"
  ) {
    throw new Error("Clone Logto Mobile Web application projection is unavailable");
  }
  const added = [...current.values()].filter((application) => !historical.has(application.id));
  if (
    added.length > 1 ||
    (added.length === 1 && added[0]?.id !== mobileWebAppId)
  ) {
    throw new Error("Clone Logto application projection added unexpected state");
  }
}

function readCloneLogtoApplications(
  target: ResolvedInstance,
): readonly CloneLogtoApplicationIdentity[] {
  const raw = queryPostgresContainer({
    container: target.compose.containers.logtoPostgres,
    database: "logto_nautilo",
    sql: `
      SELECT COALESCE(
        json_agg(
          json_build_object('id', id, 'name', name, 'type', type)
          ORDER BY id
        )::text,
        '[]'
      )
      FROM public.applications;
    `,
  });
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Clone Logto application projection is invalid");
  }
  return parsed.map((value): CloneLogtoApplicationIdentity => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>)["id"] !== "string" ||
      typeof (value as Record<string, unknown>)["name"] !== "string" ||
      typeof (value as Record<string, unknown>)["type"] !== "string"
    ) {
      throw new Error("Clone Logto application projection is invalid");
    }
    return {
      id: (value as Record<string, string>)["id"]!,
      name: (value as Record<string, string>)["name"]!,
      type: (value as Record<string, string>)["type"]!,
    };
  });
}

function mobileWebAppIdFromInstanceEnv(path: string): string | undefined {
  const value = envValues(readFileSync(path, "utf8"))["LOGTO_MOBILE_WEB_APP_ID"]?.trim();
  return value === "" ? undefined : value;
}

function assertHistoricalAnchorsAfterReconciliation(input: {
  readonly backup: VerifiedFullBackup;
  readonly target: ResolvedInstance;
  readonly historicalLogtoApplications: readonly CloneLogtoApplicationIdentity[];
  readonly targetEnvPath: string;
}): void {
  for (const [key, expected] of Object.entries(input.backup.manifest.rowAnchors)) {
    if (key === "logto.applications") {
      if (input.historicalLogtoApplications.length !== expected) {
        throw new Error(
          `Historical row anchor mismatch for ${key}: ` +
            `${input.historicalLogtoApplications.length} != ${expected}`,
        );
      }
      const mobileWebAppId = mobileWebAppIdFromInstanceEnv(input.targetEnvPath);
      assertCloneLogtoApplicationProjection({
        historical: input.historicalLogtoApplications,
        current: readCloneLogtoApplications(input.target),
        ...(mobileWebAppId === undefined ? {} : { mobileWebAppId }),
      });
      continue;
    }
    const [database, table] = key.split(".");
    if (!database || !table || !/^[a-z_][a-z0-9_]*$/i.test(table)) {
      throw new Error(`Invalid backup row anchor ${key}`);
    }
    const container =
      database === "nautilo"
        ? input.target.compose.containers.legacyPostgres
        : database === "logto"
          ? input.target.compose.containers.logtoPostgres
          : null;
    if (container === null) throw new Error(`Invalid backup row anchor ${key}`);
    const actual = Number.parseInt(
      queryPostgresContainer({
        container,
        database: database === "nautilo" ? "nautilo" : "logto_nautilo",
        sql: `SELECT count(*) FROM public.${table};`,
      }),
      10,
    );
    if (actual !== expected) {
      throw new Error(`Historical row anchor mismatch for ${key}: ${actual} != ${expected}`);
    }
  }
}

function rebindDeploymentIdentity(target: ResolvedInstance): void {
  const escaped = target.instanceId.replaceAll("'", "''");
  queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: `
      INSERT INTO public.nautilo_instance_identity (id, instance_id)
      VALUES ('self', '${escaped}')
      ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id;
    `,
  });
  const marker = queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: "SELECT instance_id FROM public.nautilo_instance_identity WHERE id = 'self';",
  });
  if (marker !== target.instanceId) throw new Error("Target database identity rebind failed");
}

export function buildCloneServerIdentityRebindSql(input: {
  readonly instanceId: string;
  readonly serverInstanceId: string;
}): { updateSql: string; verifySql: string; profileName: string } {
  if (input.instanceId === "" || validateNautiloInstanceIdValue(input.instanceId) !== null) {
    throw new Error("Unsafe clone instance id");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input.serverInstanceId,
  )) {
    throw new Error("Unsafe clone server instance id");
  }
  const instanceId = sqlLiteral(input.instanceId);
  const serverInstanceId = `${sqlLiteral(input.serverInstanceId)}::uuid`;
  const profileNameValue = `Nautilo Clone — ${input.instanceId}`;
  const profileName = sqlLiteral(profileNameValue);
  const profileDescription = sqlLiteral(
    `Development clone ${input.instanceId} of Nautilo Default.`,
  );
  return {
    profileName: profileNameValue,
    updateSql: `
      BEGIN;
      DELETE FROM public.ordinary_request_admissions;
      DELETE FROM public.remote_controller_bindings;
      DELETE FROM public.remote_pairing_challenges;
      DELETE FROM public.remote_controller_installations;
      DELETE FROM public.member_rollouts;

      ALTER TABLE public.owned_photo_entries
        DISABLE TRIGGER owned_photo_entries_identity_immutable;
      ALTER TABLE public.agent_photo_selection_revisions
        DISABLE TRIGGER agent_photo_selection_revisions_append_only_update;
      ALTER TABLE public.photo_library_operations
        DISABLE TRIGGER photo_library_operations_identity_immutable;
      UPDATE public.owned_photo_entries
      SET server_instance_id = ${serverInstanceId}
      WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId};
      UPDATE public.agent_photo_selection_revisions
      SET server_instance_id = ${serverInstanceId}
      WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId};
      UPDATE public.photo_library_operations
      SET server_instance_id = ${serverInstanceId}
      WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId};
      ALTER TABLE public.owned_photo_entries
        ENABLE TRIGGER owned_photo_entries_identity_immutable;
      ALTER TABLE public.agent_photo_selection_revisions
        ENABLE TRIGGER agent_photo_selection_revisions_append_only_update;
      ALTER TABLE public.photo_library_operations
        ENABLE TRIGGER photo_library_operations_identity_immutable;

      INSERT INTO public.nautilo_instance_identity (
        id, instance_id, server_instance_id, server_binding_generation
      ) VALUES ('self', ${instanceId}, ${serverInstanceId}, 1)
      ON CONFLICT (id) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        server_instance_id = EXCLUDED.server_instance_id,
        server_binding_generation = EXCLUDED.server_binding_generation;

      INSERT INTO public.server_profile (id, name, description, reviewed_at, updated_at)
      VALUES ('server', ${profileName}, ${profileDescription}, NULL, now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        reviewed_at = NULL,
        updated_at = EXCLUDED.updated_at;
      COMMIT;
    `,
    verifySql: `
      SELECT json_build_object(
        'instanceId', identity.instance_id,
        'serverInstanceId', identity.server_instance_id,
        'serverBindingGeneration', identity.server_binding_generation,
        'profileName', profile.name,
        'misboundPhotos', (
          (SELECT count(*) FROM public.owned_photo_entries
            WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId}) +
          (SELECT count(*) FROM public.agent_photo_selection_revisions
            WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId}) +
          (SELECT count(*) FROM public.photo_library_operations
            WHERE server_instance_id IS DISTINCT FROM ${serverInstanceId})
        ),
        'copiedAuthorityRows', (
          (SELECT count(*) FROM public.ordinary_request_admissions) +
          (SELECT count(*) FROM public.remote_controller_bindings) +
          (SELECT count(*) FROM public.remote_pairing_challenges) +
          (SELECT count(*) FROM public.remote_controller_installations) +
          (SELECT count(*) FROM public.member_rollouts)
        )
      )::text
      FROM public.nautilo_instance_identity AS identity
      INNER JOIN public.server_profile AS profile ON profile.id = 'server'
      WHERE identity.id = 'self';
    `,
  };
}

function rebindCloneServerIdentity(
  target: ResolvedInstance,
  serverInstanceId: string,
): void {
  const sql = buildCloneServerIdentityRebindSql({
    instanceId: target.instanceId,
    serverInstanceId,
  });
  queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.updateSql,
  });
  const raw = queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.verifySql,
  });
  const evidence = JSON.parse(raw) as {
    instanceId?: unknown;
    serverInstanceId?: unknown;
    serverBindingGeneration?: unknown;
    profileName?: unknown;
    misboundPhotos?: unknown;
    copiedAuthorityRows?: unknown;
  };
  if (
    evidence.instanceId !== target.instanceId ||
    evidence.serverInstanceId !== serverInstanceId ||
    evidence.serverBindingGeneration !== 1 ||
    evidence.profileName !== sql.profileName ||
    Number(evidence.misboundPhotos) !== 0 ||
    Number(evidence.copiedAuthorityRows) !== 0
  ) {
    throw new Error("Target server identity projection failed");
  }
}

export function buildCloneWorkbenchIdentityRebindSql(
  federatedHostname: string,
): { updateSql: string; verifySql: string } {
  const hostname = federatedHostname.trim().toLowerCase();
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
    hostname.includes("..")
  ) {
    throw new Error("Unsafe clone federated hostname");
  }
  const hostnameSql = sqlLiteral(hostname);
  const canonicalExternalId = `'@' || u.handle || '@' || ${hostnameSql}`;
  const localWorkbenchRows = `
    FROM public.channel_identities AS ci
    INNER JOIN public.users AS u ON u.id = ci.user_id
    WHERE ci.channel = 'workbench'
      AND u.server IS NULL
      AND u.handle IS NOT NULL
      AND btrim(u.handle) <> ''`;
  return {
    updateSql: `
      UPDATE public.channel_identities AS ci
      SET external_id = ${canonicalExternalId}
      FROM public.users AS u
      WHERE ci.user_id = u.id
        AND ci.channel = 'workbench'
        AND u.server IS NULL
        AND u.handle IS NOT NULL
        AND btrim(u.handle) <> ''
        AND ci.external_id IS DISTINCT FROM ${canonicalExternalId};
    `,
    verifySql: `
      SELECT count(*)::text
      ${localWorkbenchRows}
        AND ci.external_id IS DISTINCT FROM ${canonicalExternalId};
    `,
  };
}

function rebindLocalWorkbenchIdentities(target: ResolvedInstance): void {
  const sql = buildCloneWorkbenchIdentityRebindSql(target.hostname.federated);
  queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.updateSql,
  });
  const remaining = queryPostgresContainer({
    container: target.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: sql.verifySql,
  });
  if (remaining !== "0") {
    throw new Error("Clone Workbench identity rebind left source-host identities");
  }
}

async function stopTarget(target: ResolvedInstance, env: NodeJS.ProcessEnv): Promise<void> {
  await run(
    "bun",
    [
      join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts"),
      "server-stop",
      "--instance",
      target.instanceId,
    ],
    { env },
  ).catch(() => undefined);
  await run("docker", [
    ...dockerComposeNautiloPrefixRaw(target.compose.projectName),
    "--profile", "auth", "stop",
  ], { env }).catch(() => undefined);
  await run("docker", [
    ...dockerComposeDbDevPrefixRaw(target.compose.projectName),
    "stop",
  ], { env }).catch(() => undefined);
}

/**
 * Existing `dev:clone` entrypoint. It intentionally supplies only a named
 * source. The dev-stack `--clone-default` preset calls the same shared
 * materializer with the explicit typed canonical-default source selection.
 */
export async function cloneDevInstance(
  args: CloneArgs,
  materialize: CloneMaterializer = materializeClone,
): Promise<number> {
  validateCloneArgs(args);
  const userHome = process.env["HOME"]?.trim() || homedir();
  return materialize(selectCloneMaterialization({
    userHome,
    source: parseCloneSource(args.from),
    targetId: args.to,
  }));
}

/**
 * Shared clone spine. Callers select source and target before invoking this
 * function; the current `dev:clone` entrypoint uses it with its historical
 * named-to-named selection and complete start/acceptance lifecycle.
 */
export async function materializeClone(
  request: CloneMaterializationRequest,
  canonicalAdmission?: CanonicalDefaultCloneAdmission,
  options: CloneMaterializationOptions = {},
): Promise<number> {
  const mode = options.mode ?? "full";
  if (
    options.disposableMigrationAcceptance !== undefined &&
    process.env["NAUTILO_D489_LIVE_CHILD"] !== "1"
  ) {
    throw new Error("Disposable migration acceptance is restricted to the isolated D489 worker");
  }
  const log = options.quiet === true ? (_message: string): void => undefined : console.log;
  const runClone = (
    command: string,
    args: string[],
    runOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<void> => run(command, args, { ...runOptions, inherit: options.quiet !== true });
  if (request.source.kind === "canonical-default") validateCanonicalDefaultCloneAdmission(canonicalAdmission);
  const sourceId = request.source.instanceId;
  const targetId = request.target.instanceId;
  if (request.source.kind === "named") {
    validateCloneArgs({ from: sourceId, to: targetId });
  } else if (targetId === "" || validateNautiloInstanceIdValue(targetId) !== null) {
    throw new Error("Canonical default clone target must be a valid nonempty named-instance id");
  }
  if (request.target.projectName !== `nautilo-${targetId}`) {
    throw new Error("Resolved target topology is not the expected named dev instance");
  }
  const userHome = process.env["HOME"]?.trim() || homedir();
  const sourceRoot = request.source.root;
  const targetRoot = request.target.root;
  if (sourceRoot !== resolveNautiloStorageRoot(userHome, sourceId)) {
    throw new Error(request.source.kind === "named"
      ? "Resolved source root is not the expected named dev instance root"
      : "Resolved canonical default source root is not the expected default root");
  }
  if (targetRoot !== resolveNautiloStorageRoot(userHome, targetId)) {
    throw new Error("Resolved target root is not the expected named dev instance root");
  }
  if (!existsSync(join(sourceRoot, "instance.json"))) {
    throw new Error(`Source instance does not exist: ${sourceRoot}`);
  }
  const source = resolveInstanceUncached(cleanInstanceEnv(sourceId), {
    skipUserConfigOverlay: true,
  });
  if (
    (request.source.kind === "named" && source.deploymentMode !== "dev-multi-instance") ||
    (request.source.kind === "canonical-default" && source.deploymentMode !== "local-self-host")
  ) {
    throw new Error(request.source.kind === "named"
      ? "Source must be a local dev-multi-instance instance"
      : "Canonical default source must be a local-self-host instance");
  }
  const checkout = options.disposableMigrationAcceptance?.checkoutLineage ??
    await readCheckoutMigrationLineage(MIGRATIONS_DIR);

  const targetProject = request.target.projectName;
  assertCloneTargetAbsent(
    inspectCloneTargetState({
      root: targetRoot,
      projectName: targetProject,
      volumeNames: [
        `${targetProject}_nautilo_pgdata`,
        `${targetProject}_pgdata`,
      ],
    }),
  );

  if (
    !dockerContainerRunning(source.compose.containers.legacyPostgres) ||
    !dockerContainerRunning(source.compose.containers.logtoPostgres)
  ) {
    throw new Error(
      "Source instance databases must both be running before cloning; " +
        `start ${sourceId || "(default)"} and retry`,
    );
  }
  const liveLineage = captureDatabaseMigrationLineage(
    readDatabaseLedger(source.compose.containers.legacyPostgres),
    checkout,
  );
  const migrationPlan = planMigrationLineageReconciliation(liveLineage, checkout);
  if (migrationPlan.kind === "exact-prefix") {
    assertExactMigrationPrefix(liveLineage, checkout);
  }

  let backup: VerifiedFullBackup;
  if (request.source.kind === "named") {
    const liveName = `auto-clone-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    log(
      `[dev:clone] source is at migration ${liveLineage.at(-1)?.index ?? -1}; ` +
        "capturing a fresh verified full backup...",
    );
    await runClone(
      "bun",
      buildCloneSourceCaptureCommand(liveName, sourceId),
      { env: cleanInstanceEnv(sourceId) },
    );
    backup = await verifyFullBackupDirectory(join(sourceRoot, "dev-snapshots", liveName));
  } else {
    backup = await verifyCanonicalDefaultFullBackupDirectory(canonicalAdmission!.seed.backup.dir);
    log(
      `[clone-default] ${canonicalAdmission?.freshness === "fresh" ? "using fresh" : "reusing"} admitted seed ${backup.manifest.name}; ` +
        `captured ${backup.manifest.createdAt}, migration ${backup.manifest.drizzle.lastAppliedIndex}.`,
    );
  }
  if (
    backup.manifest.sourceInstanceId !== sourceId ||
    backup.manifest.postgres.nautiloMajor !== 17 ||
    backup.manifest.postgres.logtoMajor !== 16
  ) {
    throw new Error("Fresh source backup is not compatible with this clone runtime");
  }
  const backupMigrationPlan = planMigrationLineageReconciliation(
    backup.manifest.drizzle.entries,
    checkout,
  );
  if (backupMigrationPlan.kind === "exact-prefix") {
    assertExactMigrationPrefix(backup.manifest.drizzle.entries, checkout);
  }
  if (
    JSON.stringify(backup.manifest.drizzle.entries) !==
    JSON.stringify(liveLineage)
  ) {
    throw new Error(
      "Running source migration ledger changed while the fresh backup was captured",
    );
  }
  log(
    `[dev:clone] captured ${backup.manifest.name} (${backup.manifest.createdAt}, ` +
      `migration ${backup.manifest.drizzle.lastAppliedIndex}, ` +
      `${JSON.stringify(backup.manifest.rowAnchors)})`,
  );
  const fs = await statfs(userHome);
  const required =
    Object.values(backup.manifest.artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) *
    TARGET_FREE_SPACE_MULTIPLIER;
  if (fs.bavail * fs.bsize < required) {
    throw new Error("Insufficient free disk space for clone materialization");
  }
  const sourceEvidence = await captureSourceEvidence(
    sourceRoot,
    source,
    backup,
  );

  // Resolving Tau is the first target write and happens only after every read-only gate.
  const portInventoryWarning = clonePortInventoryWarningSink(options.quiet === true);
  const target = resolveInstanceUncached(cleanInstanceEnv(targetId), {
    skipUserConfigOverlay: true,
    additionalClaimedPorts: () => collectDockerPublishedTcpPorts({
      ...(portInventoryWarning === undefined ? {} : { warn: portInventoryWarning }),
    }),
  });
  if (
    target.instanceId !== targetId ||
    target.deploymentMode !== "dev-multi-instance" ||
    target.compose.projectName !== targetProject
  ) {
    throw new Error("Resolved target topology is not the expected named dev instance");
  }
  const cloneServerInstanceId = randomUUID();
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(targetRoot, 0o700);
  const operationPath = join(targetRoot, OPERATION_FILE);
  const startedAt = new Date().toISOString();
  const record: CloneOperationRecord = {
    formatVersion: 1,
    sourceInstanceId: sourceId,
    targetInstanceId: targetId,
    backupName: backup.manifest.name,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    mode,
    completedStages: [],
  };
  const sourceEnvRaw = await readFile(
    join(backup.dir, backup.manifest.artifacts.instanceEnv.file),
    "utf8",
  );
  const reboundEnv = rebindCloneEnvContent({
    sourceRaw: sourceEnvRaw,
    sourceRoot,
    targetRoot,
    target,
  });
  const targetEnvPath = join(targetRoot, "instance.env");
  const values = envValues(reboundEnv);
  const targetEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...values,
    ...resolvedInstanceChildEnv(target, values),
    NAUTILO_INSTANCE_ID: targetId,
    NAUTILO_INSTANCE_ROOT: targetRoot,
    NAUTILO_LOGTO_REBIND_FROM_INSTANCE_ID: sourceId,
  };
  let historicalLogtoApplications: readonly CloneLogtoApplicationIdentity[] | undefined;

  const actions = {
    "topology-created": () => Promise.resolve(),
    "home-rebound": async () => {
        await runClone("tar", [
          "--exclude=clone-operation.json",
          "--exclude=.protected-instance",
          "--exclude=certs",
          "-xzf",
          join(backup.dir, backup.manifest.artifacts.nautiloHome.file),
          "-C",
          targetRoot,
        ]);
        await writeReboundCloneEnv(targetEnvPath, reboundEnv);
        const credentialPlan = ensureClonedInfraCredentialAuthorityBeforeVolume(
          target,
          targetEnv,
        );
        Object.assign(targetEnv, credentialPlan.childEnv, {
          NAUTILO_CRYPTO_DB_PASSWORD:
            credentialPlan.serviceSecrets.NAUTILO_CRYPTO_DB_PASSWORD,
        });
        const openConnector = ensureOpenConnectorEncryptionKeyForInstance(
          target,
          targetEnv,
        );
        Object.assign(targetEnv, {
          NAUTILO_OPENCONNECTOR_ENCRYPTION_KEY_PATH: openConnector.keyPath,
          NAUTILO_OPENCONNECTOR_DATA_DIR: openConnector.dataDir,
        });
    },
    "databases-started": async () => {
        let legacyPostgresMajor!: number;
        let logtoPostgresMajor!: number;
        await runCloneDatabasesStartedSteps({
          "legacy-compose": async () => {
            assertCloneComposeEnvAuthority(target, targetRoot, targetEnv);
            await runClone("docker", [
              ...dockerComposeDbDevPrefixRaw(target.compose.projectName),
              "config", "--quiet",
            ], { env: targetEnv });
            await runClone("docker", [
              ...dockerComposeDbDevPrefixRaw(target.compose.projectName),
              "up", "-d",
              ...(options.noPullOrBuild === true ? ["--pull", "never", "--no-build"] : []),
              "legacy-postgres",
            ], { env: targetEnv });
          },
          "logto-compose": async () => {
            assertCloneComposeEnvAuthority(target, targetRoot, targetEnv);
            await runClone("docker", [
              ...dockerComposeNautiloPrefixRaw(target.compose.projectName),
              "config", "--quiet",
            ], { env: targetEnv });
            await runClone("docker", [
              ...dockerComposeNautiloPrefixRaw(target.compose.projectName),
              "up", "-d",
              ...(options.noPullOrBuild === true ? ["--pull", "never", "--no-build"] : []),
              "postgres",
            ], { env: targetEnv });
          },
          "legacy-readiness": async () => {
            legacyPostgresMajor = await waitForPostgres(target.compose.containers.legacyPostgres);
          },
          "logto-readiness": async () => {
            logtoPostgresMajor = await waitForPostgres(target.compose.containers.logtoPostgres);
          },
          "major-version": () => {
            if (
              legacyPostgresMajor !== backup.manifest.postgres.nautiloMajor ||
              logtoPostgresMajor !== backup.manifest.postgres.logtoMajor
            ) {
              throw new Error("Target PostgreSQL major does not match backup");
            }
            return Promise.resolve();
          },
        });
    },
    "historical-databases-imported": async () => {
        await restoreCloneNautiloDatabase({
          container: target.compose.containers.legacyPostgres,
          inputPath: join(backup.dir, backup.manifest.artifacts.nautiloDatabase.file),
        });
        recreateDatabase(target.compose.containers.logtoPostgres, "logto_nautilo", "logto");
        ensureLogtoRestoreGrantRole(target.compose.containers.logtoPostgres);
        await importPostgresDatabaseGzip({
          container: target.compose.containers.logtoPostgres,
          database: "logto_nautilo",
          inputPath: join(backup.dir, backup.manifest.artifacts.logtoDatabase.file),
        });
        ensureLogtoRestoreRoleTopology(target.compose.containers.logtoPostgres);
    },
    "historical-state-verified": () => {
        const mapped = readDatabaseLedger(target.compose.containers.legacyPostgres);
        if (mapped.length !== backup.manifest.drizzle.entries.length) {
          throw new Error("Imported historical migration ledger length mismatch");
        }
        for (let i = 0; i < mapped.length; i++) {
          const actual = mapped[i]!;
          const expected = backup.manifest.drizzle.entries[i]!;
          if (actual.createdAt !== expected.createdAt || actual.sha256 !== expected.sha256) {
            throw new Error(`Imported historical migration ledger diverges at ${i}`);
          }
        }
        assertHistoricalAnchors(backup, target);
        historicalLogtoApplications = readCloneLogtoApplications(target);
        return Promise.resolve();
    },
    "identity-rebound": () => {
        rebindDeploymentIdentity(target);
        rebindLocalWorkbenchIdentities(target);
        return Promise.resolve();
    },
    "nautilo-migrated": async () => {
      if (options.disposableMigrationAcceptance !== undefined) {
        await options.disposableMigrationAcceptance.run({ target, targetEnv });
      } else if (migrationPlan.kind === "divergent") {
        applyDivergentTargetMigrationPlan({ target, checkout, plan: migrationPlan });
      } else {
        await runClone("bun", ["run", "db:migrate"], {
          cwd: DB_PACKAGE_DIR,
          env: targetEnv,
        });
      }
      rebindCloneFileUris(target, sourceRoot, targetRoot);
      rebindCloneServerIdentity(target, cloneServerInstanceId);
    },
    "logto-migrated": () => runClone(
        "bun",
        [
          "x",
          `@logto/cli@${DEPENDENCY_PINS.logtoImageTag}`,
          "db",
          "alteration",
          "deploy",
          DEPENDENCY_PINS.logtoImageTag,
        ],
        {
          env: {
            ...targetEnv,
            DB_URL:
              `postgres://logto:${encodeURIComponent(values["LOGTO_DB_PASSWORD"] ?? "logto")}` +
              `@localhost:${target.logto.dbPort}/logto_nautilo`,
          },
        },
      ),
    "credentials-reconciled": async () => {
      await runClone("bun",
        [
          join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts"),
          "infra-start",
          "--instance",
          targetId,
          "--logto-already-provisioned",
          ...(options.office === true ? ["--office"] : []),
        ],
        { env: targetEnv });
      if (mode === "provision") {
        if (historicalLogtoApplications === undefined) {
          throw new Error("Historical Logto application projection was not captured");
        }
        assertHistoricalAnchorsAfterReconciliation({
          backup,
          target,
          historicalLogtoApplications,
          targetEnvPath,
        });
        const finalLineage = mapDatabaseLedgerToCheckout(readDatabaseLedger(target.compose.containers.legacyPostgres), checkout);
        if (finalLineage.length !== checkout.length) throw new Error("Provisioned target migration ledger is incomplete");
        assertCloneResourceIsolation({
          sourceObjects: dockerObjectsForProject(source.compose.projectName),
          targetObjects: dockerObjectsForProject(target.compose.projectName),
          sourceVolumes: infraPersistentVolumeNames(source), targetVolumes: infraPersistentVolumeNames(target),
        });
        await assertSourceEvidenceUnchanged(sourceEvidence, sourceRoot, source, backup);
      }
    },
    "services-started": async () => {
        const workbench = resolveCloneWorkbenchIndex(targetEnv);
        if (!isCloneWorkbenchIndexHtml(workbench.indexPath)) {
          if (workbench.explicit) {
            throw new Error("Clone workbench dist does not contain a valid HTML index");
          }
          await runClone(
            "bunx",
            ["turbo", "run", "build", "--filter=@nautilo/workbench"],
            { env: targetEnv },
          );
          if (!isCloneWorkbenchIndexHtml(workbench.indexPath)) {
            throw new Error("Clone workbench build did not produce a valid HTML index");
          }
        }
        await runClone(
          "bun",
          [
            join(NAUTILO_REPO_ROOT, "bin/nautilo-dev/src/index.ts"),
            "server-start",
            "--require-workbench-dist",
            "--instance",
            targetId,
          ],
          { env: targetEnv },
        );
    },
    "acceptance-passed": () => runCloneAcceptanceSteps({
      "verify-command": () => runCloneVerify(targetId, targetEnv, options.quiet === true),
      "identity-rebind": () => {
        rebindCloneServerIdentity(target, cloneServerInstanceId);
        rebindLocalWorkbenchIdentities(target);
        return Promise.resolve();
      },
      "historical-anchors": () => {
        if (historicalLogtoApplications === undefined) {
          throw new Error("Historical Logto application projection was not captured");
        }
        assertHistoricalAnchorsAfterReconciliation({
          backup,
          target,
          historicalLogtoApplications,
          targetEnvPath,
        });
        return Promise.resolve();
      },
      "lineage": () => {
        const finalLineage = mapDatabaseLedgerToCheckout(
          readDatabaseLedger(target.compose.containers.legacyPostgres),
          checkout,
        );
        if (finalLineage.length !== checkout.length) {
          throw new Error(
            `Target migration ledger is incomplete (${finalLineage.length} != ${checkout.length})`,
          );
        }
        return Promise.resolve();
      },
      "resource-isolation": () => {
        const sourceObjects = dockerObjectsForProject(source.compose.projectName);
        const targetObjects = dockerObjectsForProject(target.compose.projectName);
        assertCloneResourceIsolation({
          sourceObjects,
          targetObjects,
          sourceVolumes: infraPersistentVolumeNames(source),
          targetVolumes: infraPersistentVolumeNames(target),
        });
        return Promise.resolve();
      },
      "source-isolation": () => assertSourceEvidenceUnchanged(
          sourceEvidence,
          sourceRoot,
          source,
          backup,
        ),
    }),
  } satisfies Readonly<Record<CloneStage, () => Promise<void>>>;
  const stages = mode === "full"
    ? buildCloneStagePlan(actions)
    : buildCloneStagePlan(actions).filter(({ name }) =>
      name !== "services-started" && name !== "acceptance-passed",
    );

  try {
    await runCloneStages({ record, operationPath, stages });
  } catch (error) {
    await stopTarget(target, targetEnv);
    console.error(formatCloneFailure(operationPath, targetId));
    throw error;
  }
  if (mode === "provision") {
    log(`[clone-default] ${targetId} provisioned; dev-stack owns build, server, and acceptance.`);
    return 0;
  }
  log(formatCloneReady({
    targetId,
    targetUrl: target.server.url,
    appliedMigrationCount: migrationPlan.missingCheckout.length,
  }));
  return 0;
}
