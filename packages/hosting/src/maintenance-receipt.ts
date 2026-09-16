import type { HostingBackend } from "./types";

export const MAINTENANCE_RECEIPT_SCHEMA_VERSION = 1 as const;

export const MAINTENANCE_RECEIPT_STAGES = [
  "planned",
  "quiesced",
  "provider-backup",
  "portable-export",
  "release",
  "migration",
  "verification",
  "restore-target",
  "restore",
  "restore-verification",
  "cutover",
  "complete",
] as const;

export type MaintenanceReceiptStage = (typeof MAINTENANCE_RECEIPT_STAGES)[number];

export const MAINTENANCE_BACKUP_KINDS = [
  "application-postgres",
  "logto-postgres",
  "server-volume",
] as const;

export type MaintenanceBackupKind = (typeof MAINTENANCE_BACKUP_KINDS)[number];
export type MaintenanceWorkflowState = "pending" | "complete";
export type MaintenanceVerificationSubject = "candidate" | "restore-target";

export const MAINTENANCE_PROVIDER_WORKFLOW_OPERATIONS = [
  "backup-application-postgres",
  "backup-logto-postgres",
  "backup-server-volume",
  "export-portable",
  "restore-application-postgres",
  "restore-logto-postgres",
  "restore-server-volume",
  "restore-portable",
] as const;

export type MaintenanceProviderWorkflowOperation =
  (typeof MAINTENANCE_PROVIDER_WORKFLOW_OPERATIONS)[number];

export interface MaintenanceProviderWorkflowCheckpoint {
  readonly operation: MaintenanceProviderWorkflowOperation;
  readonly workflowId: string;
  readonly state: MaintenanceWorkflowState;
  readonly completedAt?: string | undefined;
}

export interface MaintenanceBackupReference {
  readonly kind: MaintenanceBackupKind;
  readonly backupId: string;
}

export interface MaintenanceBackupSetCheckpoint {
  readonly backups: readonly MaintenanceBackupReference[];
  readonly completedAt: string;
}

export interface MaintenancePortableExportCheckpoint {
  /** Opaque object-store identity only; never a URL, credential, or local path. */
  readonly objectId: string;
  readonly sha256: string;
  readonly completedAt: string;
}

export interface MaintenanceReleaseCheckpoint {
  readonly releaseId: string;
  readonly appliedAt: string;
}

export interface MaintenanceMigrationCheckpoint {
  readonly migrationId: string;
  readonly completedAt: string;
}

export interface MaintenanceRestoreTargetCheckpoint {
  readonly projectId: string;
  readonly environmentId: string;
  readonly createdAt: string;
}

export interface MaintenanceVerificationCheckpoint {
  readonly subject: MaintenanceVerificationSubject;
  readonly verifiedAt: string;
}

export interface MaintenanceCutoverCheckpoint {
  readonly committedAt: string;
}

export interface MaintenanceFailureSummary {
  readonly operation: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
}

/**
 * Durable non-secret state for one upgrade/recovery transaction. Provider
 * payloads, backup bytes, object-store URLs, credentials, raw errors, and local
 * paths are deliberately excluded.
 */
export interface MaintenanceReceiptV1 {
  readonly schemaVersion: typeof MAINTENANCE_RECEIPT_SCHEMA_VERSION;
  readonly maintenanceId: string;
  readonly launchId: string;
  readonly backend: HostingBackend;
  readonly revision: number;
  readonly stage: MaintenanceReceiptStage;
  readonly sourceReleaseId: string;
  readonly targetReleaseId: string;
  readonly providerWorkflows?: readonly MaintenanceProviderWorkflowCheckpoint[] | undefined;
  readonly backupSet?: MaintenanceBackupSetCheckpoint | undefined;
  readonly portableExport?: MaintenancePortableExportCheckpoint | undefined;
  readonly release?: MaintenanceReleaseCheckpoint | undefined;
  readonly migration?: MaintenanceMigrationCheckpoint | undefined;
  readonly restoreTarget?: MaintenanceRestoreTargetCheckpoint | undefined;
  readonly verification?: MaintenanceVerificationCheckpoint | undefined;
  readonly cutover?: MaintenanceCutoverCheckpoint | undefined;
  readonly lastFailure?: MaintenanceFailureSummary | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MaintenanceReceipt = MaintenanceReceiptV1;

export type MaintenanceReceiptValidationCode =
  | "invalid-type"
  | "unknown-field"
  | "unsupported-version"
  | "invalid-value"
  | "duplicate-backup"
  | "missing-checkpoint"
  | "conflicting-checkpoint"
  | "secret-material"
  | "invalid-transition";

export type MaintenanceReceiptValidationResult =
  | { readonly ok: true; readonly receipt: MaintenanceReceipt }
  | {
      readonly ok: false;
      readonly code: MaintenanceReceiptValidationCode;
      readonly path: string;
    };

type MaintenanceReceiptValidationFailure = Extract<
  MaintenanceReceiptValidationResult,
  { readonly ok: false }
>;

export type MaintenanceReceiptTransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid-transition"; readonly path: string };

export interface CreateMaintenanceReceiptInput {
  readonly maintenanceId: string;
  readonly launchId: string;
  readonly backend: HostingBackend;
  readonly sourceReleaseId: string;
  readonly targetReleaseId: string;
  readonly now: string;
}

type PlainObject = Record<string, unknown> & {
  readonly schemaVersion?: unknown;
  readonly maintenanceId?: unknown;
  readonly launchId?: unknown;
  readonly backend?: unknown;
  readonly revision?: unknown;
  readonly stage?: unknown;
  readonly sourceReleaseId?: unknown;
  readonly targetReleaseId?: unknown;
  readonly providerWorkflows?: unknown;
  readonly backupSet?: unknown;
  readonly portableExport?: unknown;
  readonly release?: unknown;
  readonly migration?: unknown;
  readonly restoreTarget?: unknown;
  readonly verification?: unknown;
  readonly cutover?: unknown;
  readonly lastFailure?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly workflowId?: unknown;
  readonly state?: unknown;
  readonly completedAt?: unknown;
  readonly backups?: unknown;
  readonly kind?: unknown;
  readonly backupId?: unknown;
  readonly objectId?: unknown;
  readonly sha256?: unknown;
  readonly releaseId?: unknown;
  readonly appliedAt?: unknown;
  readonly migrationId?: unknown;
  readonly projectId?: unknown;
  readonly environmentId?: unknown;
  readonly subject?: unknown;
  readonly verifiedAt?: unknown;
  readonly committedAt?: unknown;
  readonly operation?: unknown;
  readonly retryable?: unknown;
  readonly occurredAt?: unknown;
};

const RECEIPT_KEYS = new Set([
  "schemaVersion", "maintenanceId", "launchId", "backend", "revision", "stage",
  "sourceReleaseId", "targetReleaseId", "providerWorkflows", "backupSet",
  "portableExport", "release", "migration", "restoreTarget", "verification",
  "cutover", "lastFailure", "createdAt", "updatedAt",
]);
const WORKFLOW_KEYS = new Set(["operation", "workflowId", "state", "completedAt"]);
const BACKUP_SET_KEYS = new Set(["backups", "completedAt"]);
const BACKUP_KEYS = new Set(["kind", "backupId"]);
const EXPORT_KEYS = new Set(["objectId", "sha256", "completedAt"]);
const RELEASE_KEYS = new Set(["releaseId", "appliedAt"]);
const MIGRATION_KEYS = new Set(["migrationId", "completedAt"]);
const RESTORE_TARGET_KEYS = new Set(["projectId", "environmentId", "createdAt"]);
const VERIFICATION_KEYS = new Set(["subject", "verifiedAt"]);
const CUTOVER_KEYS = new Set(["committedAt"]);
const FAILURE_KEYS = new Set(["operation", "retryable", "occurredAt"]);
const BACKENDS = new Set<HostingBackend>(["railway", "digitalocean-droplet"]);
const STAGES = new Set<string>(MAINTENANCE_RECEIPT_STAGES);
const BACKUP_KINDS = new Set<string>(MAINTENANCE_BACKUP_KINDS);
const WORKFLOW_OPERATIONS = new Set<string>(MAINTENANCE_PROVIDER_WORKFLOW_OPERATIONS);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_WORKFLOW_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|[A-Za-z][A-Za-z0-9]{0,63}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SAFE_OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEY =
  /^(?:.*(?:token|secret|password|credential|api[_-]?key|authorization|cookie)|environment|variables?|env|raw|stack|cause|message|error|url|path)$/i;
const SECRET_LIKE_VALUE =
  /(?:\bBearer\s+\S+|:\/\/[^\s/:@]+:[^\s/@]+@|^(?:sk|pk|rk|gsk|tvly|xi|dop|railway)[_-][A-Za-z0-9_-]{8,}$|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/i;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function secretPath(value: unknown, path = "$"): string | undefined {
  if (typeof value === "string") return SECRET_LIKE_VALUE.test(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretPath(value[index], `${path}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) return `${path}.${key}`;
    const found = secretPath(nested, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unknownField(value: PlainObject, allowed: ReadonlySet<string>, path: string): string | undefined {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key === undefined ? undefined : `${path}.${key}`;
}

function invalid(code: MaintenanceReceiptValidationCode, path: string): MaintenanceReceiptValidationFailure {
  return { ok: false, code, path };
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function parseExactObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): { readonly ok: true; readonly value: PlainObject } | { readonly ok: false; readonly result: MaintenanceReceiptValidationFailure } {
  if (!isPlainObject(value)) return { ok: false, result: invalid("invalid-type", path) };
  const extra = unknownField(value, allowed, path);
  return extra === undefined
    ? { ok: true, value }
    : { ok: false, result: invalid("unknown-field", extra) };
}

function parseWorkflow(
  value: unknown,
  path: string,
): MaintenanceProviderWorkflowCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, WORKFLOW_KEYS, path);
  if (!parsed.ok) return parsed.result;
  const item = parsed.value;
  if (typeof item.operation !== "string" || !WORKFLOW_OPERATIONS.has(item.operation)) {
    return invalid("invalid-value", `${path}.operation`);
  }
  if (typeof item.workflowId !== "string" || !SAFE_WORKFLOW_ID.test(item.workflowId)) {
    return invalid("invalid-value", `${path}.workflowId`);
  }
  if (item.state !== "pending" && item.state !== "complete") {
    return invalid("invalid-value", `${path}.state`);
  }
  if (item.completedAt !== undefined && !isTimestamp(item.completedAt)) {
    return invalid("invalid-value", `${path}.completedAt`);
  }
  if ((item.state === "complete") !== (item.completedAt !== undefined)) {
    return invalid("invalid-value", `${path}.completedAt`);
  }
  return {
    operation: item.operation as MaintenanceProviderWorkflowOperation,
    workflowId: item.workflowId,
    state: item.state,
    ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
  };
}

function parseWorkflows(
  value: unknown,
): readonly MaintenanceProviderWorkflowCheckpoint[] | MaintenanceReceiptValidationFailure {
  if (!Array.isArray(value)) return invalid("invalid-type", "$.providerWorkflows");
  const operations = new Set<string>();
  const workflows: MaintenanceProviderWorkflowCheckpoint[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const path = `$.providerWorkflows[${String(index)}]`;
    const workflow = parseWorkflow(value[index], path);
    if (isValidationFailure(workflow)) return workflow;
    if (operations.has(workflow.operation)) return invalid("conflicting-checkpoint", `${path}.operation`);
    operations.add(workflow.operation);
    workflows.push(workflow);
  }
  if (workflows.length === 0) return invalid("invalid-value", "$.providerWorkflows");
  return workflows;
}

function parseBackupSet(value: unknown): MaintenanceBackupSetCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, BACKUP_SET_KEYS, "$.backupSet");
  if (!parsed.ok) return parsed.result;
  if (!Array.isArray(parsed.value.backups)) return invalid("invalid-type", "$.backupSet.backups");
  if (!isTimestamp(parsed.value.completedAt)) return invalid("invalid-value", "$.backupSet.completedAt");
  const backups: MaintenanceBackupReference[] = [];
  const kinds = new Set<string>();
  for (let index = 0; index < parsed.value.backups.length; index += 1) {
    const path = `$.backupSet.backups[${String(index)}]`;
    const entry = parseExactObject(parsed.value.backups[index], BACKUP_KEYS, path);
    if (!entry.ok) return entry.result;
    if (typeof entry.value.kind !== "string" || !BACKUP_KINDS.has(entry.value.kind)) {
      return invalid("invalid-value", `${path}.kind`);
    }
    if (!safeId(entry.value.backupId)) return invalid("invalid-value", `${path}.backupId`);
    if (kinds.has(entry.value.kind)) return invalid("duplicate-backup", path);
    kinds.add(entry.value.kind);
    backups.push({
      kind: entry.value.kind as MaintenanceBackupKind,
      backupId: entry.value.backupId,
    });
  }
  if (kinds.size !== MAINTENANCE_BACKUP_KINDS.length) {
    return invalid("missing-checkpoint", "$.backupSet.backups");
  }
  return { backups, completedAt: parsed.value.completedAt };
}

function parsePortableExport(value: unknown): MaintenancePortableExportCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, EXPORT_KEYS, "$.portableExport");
  if (!parsed.ok) return parsed.result;
  if (!safeId(parsed.value.objectId)) return invalid("invalid-value", "$.portableExport.objectId");
  if (typeof parsed.value.sha256 !== "string" || !SHA256.test(parsed.value.sha256)) {
    return invalid("invalid-value", "$.portableExport.sha256");
  }
  if (!isTimestamp(parsed.value.completedAt)) return invalid("invalid-value", "$.portableExport.completedAt");
  return {
    objectId: parsed.value.objectId,
    sha256: parsed.value.sha256,
    completedAt: parsed.value.completedAt,
  };
}

function parseRelease(value: unknown): MaintenanceReleaseCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, RELEASE_KEYS, "$.release");
  if (!parsed.ok) return parsed.result;
  if (!safeId(parsed.value.releaseId)) return invalid("invalid-value", "$.release.releaseId");
  if (!isTimestamp(parsed.value.appliedAt)) return invalid("invalid-value", "$.release.appliedAt");
  return { releaseId: parsed.value.releaseId, appliedAt: parsed.value.appliedAt };
}

function parseMigration(value: unknown): MaintenanceMigrationCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, MIGRATION_KEYS, "$.migration");
  if (!parsed.ok) return parsed.result;
  if (!safeId(parsed.value.migrationId)) return invalid("invalid-value", "$.migration.migrationId");
  if (!isTimestamp(parsed.value.completedAt)) return invalid("invalid-value", "$.migration.completedAt");
  return { migrationId: parsed.value.migrationId, completedAt: parsed.value.completedAt };
}

function parseRestoreTarget(value: unknown): MaintenanceRestoreTargetCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, RESTORE_TARGET_KEYS, "$.restoreTarget");
  if (!parsed.ok) return parsed.result;
  if (!safeId(parsed.value.projectId)) return invalid("invalid-value", "$.restoreTarget.projectId");
  if (!safeId(parsed.value.environmentId)) return invalid("invalid-value", "$.restoreTarget.environmentId");
  if (!isTimestamp(parsed.value.createdAt)) return invalid("invalid-value", "$.restoreTarget.createdAt");
  return {
    projectId: parsed.value.projectId,
    environmentId: parsed.value.environmentId,
    createdAt: parsed.value.createdAt,
  };
}

function parseVerification(value: unknown): MaintenanceVerificationCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, VERIFICATION_KEYS, "$.verification");
  if (!parsed.ok) return parsed.result;
  if (parsed.value.subject !== "candidate" && parsed.value.subject !== "restore-target") {
    return invalid("invalid-value", "$.verification.subject");
  }
  if (!isTimestamp(parsed.value.verifiedAt)) return invalid("invalid-value", "$.verification.verifiedAt");
  return { subject: parsed.value.subject, verifiedAt: parsed.value.verifiedAt };
}

function parseCutover(value: unknown): MaintenanceCutoverCheckpoint | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, CUTOVER_KEYS, "$.cutover");
  if (!parsed.ok) return parsed.result;
  if (!isTimestamp(parsed.value.committedAt)) return invalid("invalid-value", "$.cutover.committedAt");
  return { committedAt: parsed.value.committedAt };
}

function parseFailure(value: unknown): MaintenanceFailureSummary | MaintenanceReceiptValidationFailure {
  const parsed = parseExactObject(value, FAILURE_KEYS, "$.lastFailure");
  if (!parsed.ok) return parsed.result;
  if (typeof parsed.value.operation !== "string" || !SAFE_OPERATION.test(parsed.value.operation)) {
    return invalid("invalid-value", "$.lastFailure.operation");
  }
  if (typeof parsed.value.retryable !== "boolean") return invalid("invalid-type", "$.lastFailure.retryable");
  if (!isTimestamp(parsed.value.occurredAt)) return invalid("invalid-value", "$.lastFailure.occurredAt");
  return {
    operation: parsed.value.operation,
    retryable: parsed.value.retryable,
    occurredAt: parsed.value.occurredAt,
  };
}

function isValidationFailure(value: object): value is MaintenanceReceiptValidationFailure {
  return "ok" in value && value.ok === false;
}

function requiresStage(stage: MaintenanceReceiptStage, candidates: readonly MaintenanceReceiptStage[]): boolean {
  return candidates.includes(stage);
}

function validateCheckpointShape(receipt: MaintenanceReceipt): MaintenanceReceiptValidationFailure | undefined {
  const stage = receipt.stage;
  const needsWorkflow = stage !== "planned" && stage !== "quiesced";
  if (needsWorkflow && receipt.providerWorkflows === undefined) {
    return invalid("missing-checkpoint", "$.providerWorkflows");
  }
  if (!needsWorkflow && receipt.providerWorkflows !== undefined) {
    return invalid("conflicting-checkpoint", "$.providerWorkflows");
  }

  const afterBackup = !requiresStage(stage, ["planned", "quiesced", "provider-backup"]);
  if (afterBackup && receipt.backupSet === undefined) return invalid("missing-checkpoint", "$.backupSet");
  const completedWorkflowOperations = new Set(
    receipt.providerWorkflows
      ?.filter((workflow) => workflow.state === "complete")
      .map((workflow) => workflow.operation) ?? [],
  );
  const backupWorkflowsComplete = MAINTENANCE_BACKUP_KINDS.every((kind) =>
    completedWorkflowOperations.has(`backup-${kind}`),
  );
  if (receipt.backupSet !== undefined && !backupWorkflowsComplete) {
    return invalid("conflicting-checkpoint", "$.backupSet");
  }

  if (receipt.portableExport !== undefined && requiresStage(stage, [
    "planned", "quiesced", "provider-backup",
  ])) {
    return invalid("conflicting-checkpoint", "$.portableExport");
  }
  if (receipt.portableExport !== undefined
      && !completedWorkflowOperations.has("export-portable")) {
    return invalid("conflicting-checkpoint", "$.portableExport");
  }
  if (receipt.release !== undefined && requiresStage(stage, [
    "planned", "quiesced", "provider-backup", "portable-export",
  ])) {
    return invalid("conflicting-checkpoint", "$.release");
  }
  if (receipt.migration !== undefined && requiresStage(stage, [
    "planned", "quiesced", "provider-backup", "portable-export", "release",
  ])) {
    return invalid("conflicting-checkpoint", "$.migration");
  }
  if (receipt.restoreTarget !== undefined && !requiresStage(stage, [
    "restore-target", "restore", "restore-verification", "cutover", "complete",
  ])) {
    return invalid("conflicting-checkpoint", "$.restoreTarget");
  }
  if (receipt.verification !== undefined && !requiresStage(stage, [
    "verification", "restore-verification", "cutover", "complete",
  ])) {
    return invalid("conflicting-checkpoint", "$.verification");
  }
  if (receipt.cutover !== undefined && !requiresStage(stage, ["cutover", "complete"])) {
    return invalid("conflicting-checkpoint", "$.cutover");
  }

  const afterExport = requiresStage(stage, [
    "release", "migration", "verification", "restore-target", "restore",
    "restore-verification", "cutover", "complete",
  ]);
  if (afterExport && receipt.portableExport === undefined) return invalid("missing-checkpoint", "$.portableExport");

  const upgradeStage = requiresStage(stage, ["migration", "verification"])
    || (stage === "complete" && receipt.restoreTarget === undefined);
  if (upgradeStage && receipt.release === undefined) return invalid("missing-checkpoint", "$.release");
  if (upgradeStage && receipt.release?.releaseId !== receipt.targetReleaseId) {
    return invalid("conflicting-checkpoint", "$.release.releaseId");
  }
  if ((stage === "verification" || (stage === "complete" && receipt.restoreTarget === undefined))
      && receipt.migration === undefined) {
    return invalid("missing-checkpoint", "$.migration");
  }

  const restoreStage = requiresStage(stage, ["restore-target", "restore", "restore-verification", "cutover"])
    || (stage === "complete" && receipt.restoreTarget !== undefined);
  if (restoreStage && receipt.restoreTarget === undefined) return invalid("missing-checkpoint", "$.restoreTarget");
  if (requiresStage(stage, ["restore-verification", "cutover"])
      || (stage === "complete" && receipt.restoreTarget !== undefined)) {
    const restoreWorkflowsComplete = MAINTENANCE_BACKUP_KINDS.every((kind) =>
      completedWorkflowOperations.has(`restore-${kind}`),
    );
    const portableRestoreComplete = completedWorkflowOperations.has("restore-portable");
    if (!restoreWorkflowsComplete && !portableRestoreComplete) {
      return invalid("missing-checkpoint", "$.providerWorkflows");
    }
  }

  if (stage === "verification") {
    if (receipt.verification?.subject !== "candidate") return invalid("missing-checkpoint", "$.verification");
  }
  if (stage === "restore-verification" || stage === "cutover"
      || (stage === "complete" && receipt.restoreTarget !== undefined)) {
    if (receipt.verification?.subject !== "restore-target") return invalid("missing-checkpoint", "$.verification");
  }
  if ((stage === "cutover" || (stage === "complete" && receipt.restoreTarget !== undefined))
      && receipt.cutover === undefined) {
    return invalid("missing-checkpoint", "$.cutover");
  }
  if (stage === "complete" && receipt.restoreTarget === undefined
      && receipt.verification?.subject !== "candidate") {
    return invalid("missing-checkpoint", "$.verification");
  }
  if (receipt.cutover !== undefined && receipt.restoreTarget === undefined) {
    return invalid("conflicting-checkpoint", "$.cutover");
  }
  return undefined;
}

export function parseMaintenanceReceipt(value: unknown): MaintenanceReceiptValidationResult {
  const secret = secretPath(value);
  if (secret !== undefined) return invalid("secret-material", secret);
  const parsed = parseExactObject(value, RECEIPT_KEYS, "$");
  if (!parsed.ok) return parsed.result;
  const item = parsed.value;
  if (item.schemaVersion !== MAINTENANCE_RECEIPT_SCHEMA_VERSION) return invalid("unsupported-version", "$.schemaVersion");
  if (!safeId(item.maintenanceId)) return invalid("invalid-value", "$.maintenanceId");
  if (!safeId(item.launchId)) return invalid("invalid-value", "$.launchId");
  if (typeof item.backend !== "string" || !BACKENDS.has(item.backend as HostingBackend)) return invalid("invalid-value", "$.backend");
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 0) return invalid("invalid-value", "$.revision");
  if (typeof item.stage !== "string" || !STAGES.has(item.stage)) return invalid("invalid-value", "$.stage");
  if (!safeId(item.sourceReleaseId)) return invalid("invalid-value", "$.sourceReleaseId");
  if (!safeId(item.targetReleaseId)) return invalid("invalid-value", "$.targetReleaseId");
  if (item.sourceReleaseId === item.targetReleaseId) return invalid("invalid-value", "$.targetReleaseId");
  if (!isTimestamp(item.createdAt)) return invalid("invalid-value", "$.createdAt");
  if (!isTimestamp(item.updatedAt) || Date.parse(item.updatedAt) < Date.parse(item.createdAt)) {
    return invalid("invalid-value", "$.updatedAt");
  }

  const providerWorkflows = item.providerWorkflows === undefined
    ? undefined
    : parseWorkflows(item.providerWorkflows);
  if (providerWorkflows !== undefined && isValidationFailure(providerWorkflows)) {
    return providerWorkflows;
  }
  const backupSet = item.backupSet === undefined ? undefined : parseBackupSet(item.backupSet);
  if (backupSet !== undefined && isValidationFailure(backupSet)) return backupSet;
  const portableExport = item.portableExport === undefined ? undefined : parsePortableExport(item.portableExport);
  if (portableExport !== undefined && isValidationFailure(portableExport)) return portableExport;
  const release = item.release === undefined ? undefined : parseRelease(item.release);
  if (release !== undefined && isValidationFailure(release)) return release;
  const migration = item.migration === undefined ? undefined : parseMigration(item.migration);
  if (migration !== undefined && isValidationFailure(migration)) return migration;
  const restoreTarget = item.restoreTarget === undefined ? undefined : parseRestoreTarget(item.restoreTarget);
  if (restoreTarget !== undefined && isValidationFailure(restoreTarget)) return restoreTarget;
  const verification = item.verification === undefined ? undefined : parseVerification(item.verification);
  if (verification !== undefined && isValidationFailure(verification)) return verification;
  const cutover = item.cutover === undefined ? undefined : parseCutover(item.cutover);
  if (cutover !== undefined && isValidationFailure(cutover)) return cutover;
  const lastFailure = item.lastFailure === undefined ? undefined : parseFailure(item.lastFailure);
  if (lastFailure !== undefined && isValidationFailure(lastFailure)) return lastFailure;

  const receipt: MaintenanceReceipt = {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA_VERSION,
    maintenanceId: item.maintenanceId,
    launchId: item.launchId,
    backend: item.backend as HostingBackend,
    revision: item.revision as number,
    stage: item.stage as MaintenanceReceiptStage,
    sourceReleaseId: item.sourceReleaseId,
    targetReleaseId: item.targetReleaseId,
    ...(providerWorkflows === undefined ? {} : { providerWorkflows }),
    ...(backupSet === undefined ? {} : { backupSet }),
    ...(portableExport === undefined ? {} : { portableExport }),
    ...(release === undefined ? {} : { release }),
    ...(migration === undefined ? {} : { migration }),
    ...(restoreTarget === undefined ? {} : { restoreTarget }),
    ...(verification === undefined ? {} : { verification }),
    ...(cutover === undefined ? {} : { cutover }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  return validateCheckpointShape(receipt) ?? { ok: true, receipt };
}

const TRANSITIONS: Readonly<Record<MaintenanceReceiptStage, ReadonlySet<MaintenanceReceiptStage>>> = {
  planned: new Set(["planned", "quiesced"]),
  quiesced: new Set(["quiesced", "provider-backup"]),
  "provider-backup": new Set(["provider-backup", "portable-export"]),
  "portable-export": new Set(["portable-export", "release", "restore-target"]),
  release: new Set(["release", "migration", "restore-target"]),
  migration: new Set(["migration", "verification", "restore-target"]),
  verification: new Set(["verification", "complete"]),
  "restore-target": new Set(["restore-target", "restore"]),
  restore: new Set(["restore", "restore-verification"]),
  "restore-verification": new Set(["restore-verification", "cutover"]),
  cutover: new Set(["cutover", "complete"]),
  complete: new Set(["complete"]),
};

function transitionFailure(path: string): MaintenanceReceiptTransitionResult {
  return { ok: false, code: "invalid-transition", path };
}

function sameCheckpoint(previous: unknown, next: unknown): boolean {
  return previous === undefined || JSON.stringify(previous) === JSON.stringify(next);
}

function validWorkflowLedgerTransition(
  previous: readonly MaintenanceProviderWorkflowCheckpoint[] | undefined,
  next: readonly MaintenanceProviderWorkflowCheckpoint[] | undefined,
): boolean {
  if (previous === undefined) return true;
  if (next === undefined || next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === undefined || after === undefined) return false;
    if (before.operation !== after.operation || before.workflowId !== after.workflowId) return false;
    if (before.state === "complete" && JSON.stringify(before) !== JSON.stringify(after)) return false;
    if (before.state === "pending" && after.state !== "pending" && after.state !== "complete") return false;
  }
  return true;
}

export function validateMaintenanceReceiptTransition(
  previous: MaintenanceReceipt,
  next: MaintenanceReceipt,
): MaintenanceReceiptTransitionResult {
  for (const key of ["schemaVersion", "maintenanceId", "launchId", "backend", "sourceReleaseId", "targetReleaseId", "createdAt"] as const) {
    if (next[key] !== previous[key]) return transitionFailure(`$.${key}`);
  }
  if (next.revision !== previous.revision + 1) return transitionFailure("$.revision");
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) return transitionFailure("$.updatedAt");
  if (!TRANSITIONS[previous.stage].has(next.stage)) return transitionFailure("$.stage");
  for (const key of ["backupSet", "portableExport", "release", "migration", "restoreTarget", "verification", "cutover"] as const) {
    if (!sameCheckpoint(previous[key], next[key])) return transitionFailure(`$.${key}`);
  }
  if (!validWorkflowLedgerTransition(previous.providerWorkflows, next.providerWorkflows)) {
    return transitionFailure("$.providerWorkflows");
  }
  const parsed = parseMaintenanceReceipt(next);
  return parsed.ok ? { ok: true } : transitionFailure(parsed.path);
}

export function createMaintenanceReceipt(input: CreateMaintenanceReceiptInput): MaintenanceReceipt {
  const candidate: MaintenanceReceipt = {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA_VERSION,
    maintenanceId: input.maintenanceId,
    launchId: input.launchId,
    backend: input.backend,
    revision: 0,
    stage: "planned",
    sourceReleaseId: input.sourceReleaseId,
    targetReleaseId: input.targetReleaseId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const parsed = parseMaintenanceReceipt(candidate);
  if (!parsed.ok) throw new Error(`Invalid initial maintenance receipt: ${parsed.code} at ${parsed.path}`);
  return parsed.receipt;
}
