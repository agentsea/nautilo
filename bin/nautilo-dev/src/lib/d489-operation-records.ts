import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";

/**
 * D489 operation evidence is deliberately an allow-listed, aggregate-only
 * format. Do not add instance roots, backup paths, checkpoint identifiers,
 * namespaces, channels, payloads, credentials, or arbitrary error text.
 */
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const D489_OPERATION_RECORD_FORMAT_VERSION = 1 as const;
export const CLONE_SEED_STAGES = ["captured", "verified", "published"] as const;
export const CHECKPOINT_MAINTENANCE_STAGES = [
  "inventory-read",
  "consent-verified",
  "backup-verified",
  "writers-quiesced",
  "semantic-cleanup",
  "semantic-verified",
  "physical-reclamation",
  "services-restored",
] as const;

export type CloneSeedStage = (typeof CLONE_SEED_STAGES)[number];
export type CheckpointMaintenanceStage = (typeof CHECKPOINT_MAINTENANCE_STAGES)[number];

export interface D489AggregateMetrics {
  readonly checkpointRows: number;
  readonly writeRows: number;
  readonly blobRows: number;
  readonly totalRows: number;
  readonly checkpointLogicalBytes: number;
  readonly writeLogicalBytes: number;
  readonly blobLogicalBytes: number;
  readonly totalLogicalBytes: number;
  readonly blobPayloadBytes: number;
}

export interface CloneSeedOperationRecord {
  readonly formatVersion: typeof D489_OPERATION_RECORD_FORMAT_VERSION;
  readonly kind: "clone-seed";
  readonly status: "capturing" | "published" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly source: {
    readonly authority: "canonical-default";
    readonly deploymentMode: "local-self-host";
    readonly checkoutCommitSha: string;
    readonly lineage: {
      readonly appliedMigrationCount: number;
      readonly lastAppliedIndex: number;
      readonly sha256: string;
    };
  };
  readonly capture: {
    readonly capturedAt: string;
    readonly freshness: "fresh" | "reused";
    readonly manifestSha256: string;
    readonly artifactCount: number;
    readonly artifactBytes: number;
  };
  readonly completedStages: readonly CloneSeedStage[];
  readonly artifactPolicy: "current-plus-one-previous-or-failed";
  readonly failure: D489Failure | null;
  readonly recovery: D489Recovery;
}

export interface CheckpointMaintenanceOperationRecord {
  readonly formatVersion: typeof D489_OPERATION_RECORD_FORMAT_VERSION;
  readonly kind: "checkpoint-maintenance";
  readonly status: "planned" | "running" | "failed" | "interrupted" | "complete";
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Classification only: an instance identifier is never persisted. */
  readonly target: "canonical-default" | "named-instance";
  readonly mode: "dry-run" | "apply";
  readonly consent: {
    readonly apply: "not-requested" | "explicit";
    readonly defaultDangerAcknowledgment: "not-required" | "acknowledged";
  };
  readonly backup: {
    readonly status: "not-required" | "verified" | "failed";
    readonly manifestSha256: string | null;
    readonly artifactCount: number | null;
    readonly artifactBytes: number | null;
  };
  readonly metrics: {
    readonly before: D489AggregateMetrics;
    /** Null until semantic cleanup was committed and re-verified. */
    readonly after: D489AggregateMetrics | null;
  };
  readonly semanticCleanup: {
    readonly status:
      | "not-started"
      | "dry-run-projected"
      | "complete"
      | "rolled-back"
      | "failed"
      | "interrupted";
  };
  readonly physicalReclamation: {
    readonly intent: "not-requested" | "explicit";
    readonly status:
      | "not-requested"
      | "not-started"
      | "running"
      | "complete"
      | "failed"
      | "interrupted";
    /** Physical bytes remain unknown until a completed explicit rewrite. */
    readonly beforeRelationBytes: number | null;
    readonly afterRelationBytes: number | null;
    readonly reclaimedBytes: number | null;
  };
  readonly completedStages: readonly CheckpointMaintenanceStage[];
  readonly serviceRestoration: {
    readonly intent: "not-needed" | "restore-paused-services";
    readonly result: "not-attempted" | "restored" | "failed";
  };
  readonly interruption:
    | "none"
    | "before-mutation"
    | "during-semantic-cleanup"
    | "during-physical-reclamation";
  readonly artifactPolicy: "current-plus-one-previous-or-failed";
  readonly failure: D489Failure | null;
  readonly recovery: D489Recovery;
}

export interface D489Failure {
  readonly code:
    | "seed-capture-failed"
    | "seed-verification-failed"
    | "seed-publication-failed"
    | "seed-interrupted"
    | "backup-verification-failed"
    | "lineage-verification-failed"
    | "writer-quiescence-failed"
    | "semantic-cleanup-failed"
    | "semantic-verification-failed"
    | "physical-reclamation-failed"
    | "service-restoration-failed"
    | "operation-interrupted";
  readonly guidance:
    | "retry-capture"
    | "reuse-current-artifact"
    | "retry-after-backup-verification"
    | "retry-after-writer-quiescence"
    | "restore-from-verified-backup"
    | "inspect-postgres-recovery-and-rerun-explicitly"
    | "restore-paused-services-before-retry";
}

export interface D489Recovery {
  readonly retryState: "not-needed" | "safe-to-retry" | "manual-recovery-required";
  readonly guidance:
    | "none"
    | "retry-capture"
    | "reuse-current-artifact"
    | "retry-after-backup-verification"
    | "retry-after-writer-quiescence"
    | "restore-from-verified-backup"
    | "inspect-postgres-recovery-and-rerun-explicitly"
    | "restore-paused-services-before-retry";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid D489 operation record: ${message}`);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unknown, forbidden, or missing fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== "string" ||
    !ISO_INSTANT_RE.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== value
  ) fail(`${label} must be a strict ISO timestamp`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`);
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(`${label} is unsupported`);
  return value as T;
}

function stagePrefix<T extends string>(value: unknown, stages: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value) || value.length > stages.length) fail(`${label} is not a bounded stage list`);
  value.forEach((entry, index) => {
    if (entry !== stages[index]) fail(`${label} must be an ordered stage prefix`);
  });
  return stages.filter((_, index) => index < value.length);
}

function parseFailure(value: unknown): D489Failure | null {
  if (value === null) return null;
  if (!isRecord(value)) fail("failure must be null or a typed failure");
  exactKeys(value, ["code", "guidance"], "failure");
  return {
    code: enumValue(value["code"], [
      "seed-capture-failed", "seed-verification-failed", "seed-publication-failed", "seed-interrupted",
      "backup-verification-failed", "lineage-verification-failed", "writer-quiescence-failed",
      "semantic-cleanup-failed", "semantic-verification-failed", "physical-reclamation-failed",
      "service-restoration-failed", "operation-interrupted",
    ], "failure.code"),
    guidance: enumValue(value["guidance"], [
      "retry-capture", "reuse-current-artifact", "retry-after-backup-verification", "retry-after-writer-quiescence",
      "restore-from-verified-backup", "inspect-postgres-recovery-and-rerun-explicitly",
      "restore-paused-services-before-retry",
    ], "failure.guidance"),
  };
}

function parseRecovery(value: unknown): D489Recovery {
  if (!isRecord(value)) fail("recovery must be an object");
  exactKeys(value, ["retryState", "guidance"], "recovery");
  return {
    retryState: enumValue(value["retryState"], ["not-needed", "safe-to-retry", "manual-recovery-required"], "recovery.retryState"),
    guidance: enumValue(value["guidance"], [
      "none", "retry-capture", "reuse-current-artifact", "retry-after-backup-verification", "retry-after-writer-quiescence",
      "restore-from-verified-backup", "inspect-postgres-recovery-and-rerun-explicitly",
      "restore-paused-services-before-retry",
    ], "recovery.guidance"),
  };
}

function parseMetrics(value: unknown, label: string): D489AggregateMetrics {
  if (!isRecord(value)) fail(`${label} must be aggregate-only metrics`);
  const keys = [
    "checkpointRows", "writeRows", "blobRows", "totalRows", "checkpointLogicalBytes",
    "writeLogicalBytes", "blobLogicalBytes", "totalLogicalBytes", "blobPayloadBytes",
  ] as const;
  exactKeys(value, keys, label);
  const metrics: D489AggregateMetrics = {
    checkpointRows: nonNegative(value["checkpointRows"], `${label}.checkpointRows`),
    writeRows: nonNegative(value["writeRows"], `${label}.writeRows`),
    blobRows: nonNegative(value["blobRows"], `${label}.blobRows`),
    totalRows: nonNegative(value["totalRows"], `${label}.totalRows`),
    checkpointLogicalBytes: nonNegative(value["checkpointLogicalBytes"], `${label}.checkpointLogicalBytes`),
    writeLogicalBytes: nonNegative(value["writeLogicalBytes"], `${label}.writeLogicalBytes`),
    blobLogicalBytes: nonNegative(value["blobLogicalBytes"], `${label}.blobLogicalBytes`),
    totalLogicalBytes: nonNegative(value["totalLogicalBytes"], `${label}.totalLogicalBytes`),
    blobPayloadBytes: nonNegative(value["blobPayloadBytes"], `${label}.blobPayloadBytes`),
  };
  if (
    metrics.totalRows !== metrics.checkpointRows + metrics.writeRows + metrics.blobRows ||
    metrics.totalLogicalBytes !== metrics.checkpointLogicalBytes + metrics.writeLogicalBytes + metrics.blobLogicalBytes
  ) fail(`${label} totals are inconsistent`);
  return metrics;
}

function stageSubsequence<T extends string>(value: unknown, stages: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value) || value.length > stages.length) fail(`${label} is not a bounded stage list`);
  let previousIndex = -1;
  value.forEach((entry) => {
    const index = stages.indexOf(entry as T);
    if (index < 0 || index <= previousIndex) fail(`${label} must be an ordered unique stage subsequence`);
    previousIndex = index;
  });
  return stages.filter((stage) => value.includes(stage));
}

function assertAfterDoesNotExceedBefore(before: D489AggregateMetrics, after: D489AggregateMetrics): void {
  for (const key of Object.keys(before) as (keyof D489AggregateMetrics)[]) {
    if (after[key] > before[key]) fail("after metrics cannot exceed before metrics");
  }
}

function assertSafeRawEvidence(value: unknown): void {
  // Payload byte counts are intentionally allowed aggregates; payload content is not.
  const forbiddenKey = /(?:password|credential|secret|token|connection|string|checkpoint(?:_|-)?id|thread(?:_|-)?id|namespace|channel)/i;
  const forbiddenValue = /(?:postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|\b(?:password|secret|token)\s*[=:])/i;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (forbiddenValue.test(candidate)) fail("contains a forbidden credential or connection value");
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (isRecord(candidate)) {
      for (const [key, nested] of Object.entries(candidate)) {
        if (forbiddenKey.test(key)) fail("contains a forbidden sensitive or identifier field");
        visit(nested);
      }
    }
  };
  visit(value);
}

function assertTimes(startedAt: string, updatedAt: string, captureAt?: string): void {
  if (Date.parse(updatedAt) < Date.parse(startedAt)) fail("updatedAt precedes startedAt");
  if (captureAt !== undefined && Date.parse(captureAt) < Date.parse(startedAt)) fail("capturedAt precedes startedAt");
}

function assertFailureRecovery(failure: D489Failure | null, recovery: D489Recovery): void {
  if (failure === null) {
    if (recovery.retryState !== "not-needed" || recovery.guidance !== "none") {
      fail("operation without failure cannot carry recovery action");
    }
    return;
  }
  if (recovery.retryState === "not-needed" || recovery.guidance !== failure.guidance) {
    fail("failure and recovery guidance must agree on a non-empty action");
  }
  const allowedGuidance: Record<D489Failure["code"], readonly D489Failure["guidance"][]> = {
    "seed-capture-failed": ["retry-capture"],
    "seed-verification-failed": ["retry-capture"],
    "seed-publication-failed": ["reuse-current-artifact"],
    "seed-interrupted": ["reuse-current-artifact"],
    "backup-verification-failed": ["retry-after-backup-verification"],
    "lineage-verification-failed": ["retry-after-backup-verification"],
    "writer-quiescence-failed": ["retry-after-writer-quiescence"],
    "semantic-cleanup-failed": ["restore-from-verified-backup", "inspect-postgres-recovery-and-rerun-explicitly"],
    "semantic-verification-failed": ["restore-from-verified-backup", "inspect-postgres-recovery-and-rerun-explicitly"],
    "physical-reclamation-failed": ["inspect-postgres-recovery-and-rerun-explicitly"],
    "service-restoration-failed": ["restore-paused-services-before-retry"],
    "operation-interrupted": ["inspect-postgres-recovery-and-rerun-explicitly"],
  };
  if (!allowedGuidance[failure.code].includes(failure.guidance)) {
    fail("failure code has incompatible recovery guidance");
  }
}

export function parseCloneSeedOperationRecord(
  value: unknown,
  options: { readonly now?: Date; readonly maxAgeMs?: number } = {},
): CloneSeedOperationRecord {
  assertSafeRawEvidence(value);
  if (!isRecord(value)) fail("clone seed record must be an object");
  exactKeys(value, ["formatVersion", "kind", "status", "startedAt", "updatedAt", "source", "capture", "completedStages", "artifactPolicy", "failure", "recovery"], "clone seed record");
  if (value["formatVersion"] !== D489_OPERATION_RECORD_FORMAT_VERSION || value["kind"] !== "clone-seed") fail("unsupported clone seed version");
  if (!isRecord(value["source"])) fail("source must be an object");
  const sourceValue = value["source"];
  exactKeys(sourceValue, ["authority", "deploymentMode", "checkoutCommitSha", "lineage"], "source");
  if (sourceValue["authority"] !== "canonical-default" || sourceValue["deploymentMode"] !== "local-self-host") fail("source authority is unsupported");
  if (typeof sourceValue["checkoutCommitSha"] !== "string" || !COMMIT_SHA_RE.test(sourceValue["checkoutCommitSha"])) fail("source.checkoutCommitSha must be a commit digest");
  if (!isRecord(sourceValue["lineage"])) fail("source.lineage must be an object");
  const lineage = sourceValue["lineage"];
  exactKeys(lineage, ["appliedMigrationCount", "lastAppliedIndex", "sha256"], "source.lineage");
  const appliedMigrationCount = nonNegative(lineage["appliedMigrationCount"], "source.lineage.appliedMigrationCount");
  const rawLastAppliedIndex = lineage["lastAppliedIndex"];
  if (!Number.isSafeInteger(rawLastAppliedIndex) || (rawLastAppliedIndex as number) < -1) fail("source.lineage.lastAppliedIndex must be a safe integer at least -1");
  const lastAppliedIndex = rawLastAppliedIndex as number;
  if (appliedMigrationCount === 0 ? lastAppliedIndex !== -1 : lastAppliedIndex !== appliedMigrationCount - 1) fail("source.lineage is inconsistent");
  if (!isRecord(value["capture"])) fail("capture must be an object");
  const captureValue = value["capture"];
  exactKeys(captureValue, ["capturedAt", "freshness", "manifestSha256", "artifactCount", "artifactBytes"], "capture");
  const startedAt = timestamp(value["startedAt"], "startedAt");
  const updatedAt = timestamp(value["updatedAt"], "updatedAt");
  const capturedAt = timestamp(captureValue["capturedAt"], "capture.capturedAt");
  assertTimes(startedAt, updatedAt, capturedAt);
  if (options.maxAgeMs !== undefined) {
    const now = (options.now ?? new Date()).getTime();
    const captureTime = Date.parse(capturedAt);
    if (
      !Number.isSafeInteger(options.maxAgeMs) ||
      options.maxAgeMs < 0 ||
      captureTime > now ||
      now - captureTime > options.maxAgeMs
    ) fail("clone seed is stale or from the future");
  }
  const status = enumValue(value["status"], ["capturing", "published", "failed", "interrupted"], "status");
  const completedStages = stagePrefix(value["completedStages"], CLONE_SEED_STAGES, "completedStages");
  const failure = parseFailure(value["failure"]);
  const recovery = parseRecovery(value["recovery"]);
  if (status === "published" && completedStages.length !== CLONE_SEED_STAGES.length) fail("published seed must complete every stage");
  if ((status === "failed" || status === "interrupted") !== (failure !== null)) fail("terminal seed failure must include typed recovery evidence");
  if (failure !== null && !failure.code.startsWith("seed-")) fail("clone seed failure must use a seed-specific code");
  if (status === "interrupted" && failure?.code !== "seed-interrupted") fail("interrupted seed must use the interrupted failure code");
  if (status === "failed" && failure?.code === "seed-interrupted") fail("failed seed cannot use the interrupted failure code");
  assertFailureRecovery(failure, recovery);
  if (value["artifactPolicy"] !== "current-plus-one-previous-or-failed") fail("clone seed artifact policy is unsupported");
  return {
    formatVersion: D489_OPERATION_RECORD_FORMAT_VERSION,
    kind: "clone-seed",
    status,
    startedAt,
    updatedAt,
    source: { authority: "canonical-default", deploymentMode: "local-self-host", checkoutCommitSha: sourceValue["checkoutCommitSha"], lineage: { appliedMigrationCount, lastAppliedIndex, sha256: sha256(lineage["sha256"], "source.lineage.sha256") } },
    capture: { capturedAt, freshness: enumValue(captureValue["freshness"], ["fresh", "reused"], "capture.freshness"), manifestSha256: sha256(captureValue["manifestSha256"], "capture.manifestSha256"), artifactCount: nonNegative(captureValue["artifactCount"], "capture.artifactCount"), artifactBytes: nonNegative(captureValue["artifactBytes"], "capture.artifactBytes") },
    completedStages,
    artifactPolicy: "current-plus-one-previous-or-failed",
    failure,
    recovery,
  };
}

export function parseCheckpointMaintenanceOperationRecord(value: unknown): CheckpointMaintenanceOperationRecord {
  assertSafeRawEvidence(value);
  if (!isRecord(value)) fail("checkpoint maintenance record must be an object");
  exactKeys(value, ["formatVersion", "kind", "status", "startedAt", "updatedAt", "target", "mode", "consent", "backup", "metrics", "semanticCleanup", "physicalReclamation", "completedStages", "serviceRestoration", "interruption", "artifactPolicy", "failure", "recovery"], "checkpoint maintenance record");
  if (value["formatVersion"] !== D489_OPERATION_RECORD_FORMAT_VERSION || value["kind"] !== "checkpoint-maintenance") fail("unsupported checkpoint maintenance version");
  const startedAt = timestamp(value["startedAt"], "startedAt");
  const updatedAt = timestamp(value["updatedAt"], "updatedAt");
  assertTimes(startedAt, updatedAt);
  const target = enumValue(value["target"], ["canonical-default", "named-instance"], "target");
  const mode = enumValue(value["mode"], ["dry-run", "apply"], "mode");
  if (!isRecord(value["consent"])) fail("consent must be an object");
  const consentValue = value["consent"];
  exactKeys(consentValue, ["apply", "defaultDangerAcknowledgment"], "consent");
  const consent = { apply: enumValue(consentValue["apply"], ["not-requested", "explicit"], "consent.apply"), defaultDangerAcknowledgment: enumValue(consentValue["defaultDangerAcknowledgment"], ["not-required", "acknowledged"], "consent.defaultDangerAcknowledgment") } as const;
  if (mode === "apply" && consent.apply !== "explicit") fail("apply requires explicit consent");
  if (mode === "dry-run" && consent.apply !== "not-requested") fail("dry-run cannot carry apply consent");
  if (target === "canonical-default" && mode === "apply" && consent.defaultDangerAcknowledgment !== "acknowledged") fail("canonical default apply requires danger acknowledgment");
  if (target === "named-instance" && consent.defaultDangerAcknowledgment !== "not-required") fail("named instance cannot carry default acknowledgment");
  if (!isRecord(value["backup"])) fail("backup must be an object");
  const backupValue = value["backup"];
  exactKeys(backupValue, ["status", "manifestSha256", "artifactCount", "artifactBytes"], "backup");
  const backupStatus = enumValue(backupValue["status"], ["not-required", "verified", "failed"], "backup.status");
  const nullableNumber = (candidate: unknown, label: string): number | null => candidate === null ? null : nonNegative(candidate, label);
  const backup = { status: backupStatus, manifestSha256: backupValue["manifestSha256"] === null ? null : sha256(backupValue["manifestSha256"], "backup.manifestSha256"), artifactCount: nullableNumber(backupValue["artifactCount"], "backup.artifactCount"), artifactBytes: nullableNumber(backupValue["artifactBytes"], "backup.artifactBytes") };
  const backupEvidencePresent = backup.manifestSha256 !== null && backup.artifactCount !== null && backup.artifactBytes !== null;
  if ((backupStatus === "verified") !== backupEvidencePresent || (backupStatus === "not-required" && backupEvidencePresent)) fail("backup evidence does not match backup status");
  if (!isRecord(value["metrics"])) fail("metrics must be an object");
  const metricsValue = value["metrics"];
  exactKeys(metricsValue, ["before", "after"], "metrics");
  const before = parseMetrics(metricsValue["before"], "metrics.before");
  const after = metricsValue["after"] === null ? null : parseMetrics(metricsValue["after"], "metrics.after");
  if (after !== null) assertAfterDoesNotExceedBefore(before, after);
  if (!isRecord(value["semanticCleanup"])) fail("semanticCleanup must be an object");
  const semanticValue = value["semanticCleanup"];
  exactKeys(semanticValue, ["status"], "semanticCleanup");
  const semanticCleanup = { status: enumValue(semanticValue["status"], ["not-started", "dry-run-projected", "complete", "rolled-back", "failed", "interrupted"], "semanticCleanup.status") } as const;
  const completedStages = stageSubsequence(value["completedStages"], CHECKPOINT_MAINTENANCE_STAGES, "completedStages");
  if (
    mode === "apply" &&
    (semanticCleanup.status !== "not-started" || completedStages.includes("backup-verified")) &&
    backupStatus !== "verified"
  ) {
    fail("checkpoint mutation requires verified backup evidence");
  }
  if (semanticCleanup.status === "complete" && after === null) fail("completed semantic cleanup requires after metrics");
  if (mode === "dry-run" && semanticCleanup.status !== "dry-run-projected") fail("dry-run cannot report mutation state");
  if (!isRecord(value["physicalReclamation"])) fail("physicalReclamation must be an object");
  const physicalValue = value["physicalReclamation"];
  exactKeys(physicalValue, ["intent", "status", "beforeRelationBytes", "afterRelationBytes", "reclaimedBytes"], "physicalReclamation");
  const physical = {
    intent: enumValue(physicalValue["intent"], ["not-requested", "explicit"], "physicalReclamation.intent"),
    status: enumValue(physicalValue["status"], ["not-requested", "not-started", "running", "complete", "failed", "interrupted"], "physicalReclamation.status"),
    beforeRelationBytes: nullableNumber(physicalValue["beforeRelationBytes"], "physicalReclamation.beforeRelationBytes"),
    afterRelationBytes: nullableNumber(physicalValue["afterRelationBytes"], "physicalReclamation.afterRelationBytes"),
    reclaimedBytes: nullableNumber(physicalValue["reclaimedBytes"], "physicalReclamation.reclaimedBytes"),
  } as const;
  if ((physical.intent === "not-requested") !== (physical.status === "not-requested")) fail("physical reclamation intent and status disagree");
  if (physical.status === "not-requested" && completedStages.includes("physical-reclamation")) fail("skipped physical reclamation cannot be recorded as a completed stage");
  if (
    physical.status !== "not-requested" &&
    physical.status !== "not-started" &&
    !completedStages.includes("physical-reclamation")
  ) fail("performed physical reclamation requires a stage record");
  if (physical.status === "complete") {
    if (semanticCleanup.status !== "complete" || physical.beforeRelationBytes === null || physical.afterRelationBytes === null || physical.reclaimedBytes === null || physical.beforeRelationBytes < physical.afterRelationBytes || physical.reclaimedBytes !== physical.beforeRelationBytes - physical.afterRelationBytes) fail("physical completion requires measured rewrite evidence after semantic cleanup");
  } else if (physical.reclaimedBytes !== null) fail("physical bytes cannot be claimed before completed rewrite");
  if (!isRecord(value["serviceRestoration"])) fail("serviceRestoration must be an object");
  const restorationValue = value["serviceRestoration"];
  exactKeys(restorationValue, ["intent", "result"], "serviceRestoration");
  const serviceRestoration = { intent: enumValue(restorationValue["intent"], ["not-needed", "restore-paused-services"], "serviceRestoration.intent"), result: enumValue(restorationValue["result"], ["not-attempted", "restored", "failed"], "serviceRestoration.result") } as const;
  if (serviceRestoration.intent === "not-needed" && serviceRestoration.result !== "not-attempted") fail("unpaused services cannot be restored");
  const interruption = enumValue(value["interruption"], ["none", "before-mutation", "during-semantic-cleanup", "during-physical-reclamation"], "interruption");
  const status = enumValue(value["status"], ["planned", "running", "failed", "interrupted", "complete"], "status");
  const failure = parseFailure(value["failure"]);
  const recovery = parseRecovery(value["recovery"]);
  if ((status === "failed" || status === "interrupted") !== (failure !== null)) fail("failed or interrupted operation requires typed failure evidence");
  if (failure !== null && failure.code.startsWith("seed-")) fail("maintenance operation cannot use a seed failure code");
  if (status === "interrupted" && interruption === "none") fail("interrupted operation needs interruption state");
  if (status !== "interrupted" && interruption !== "none") fail("only interrupted operation can have interruption state");
  assertFailureRecovery(failure, recovery);
  if (status === "complete" && mode === "apply" && semanticCleanup.status !== "complete") fail("complete apply requires semantic completion");
  if (status === "complete" && physical.intent === "explicit" && physical.status !== "complete") fail("complete explicit physical reclamation requires rewrite completion");
  if (status === "complete" && serviceRestoration.intent === "restore-paused-services" && serviceRestoration.result !== "restored") fail("complete operation must restore paused services");
  if (value["artifactPolicy"] !== "current-plus-one-previous-or-failed") fail("maintenance artifact policy is unsupported");
  return { formatVersion: D489_OPERATION_RECORD_FORMAT_VERSION, kind: "checkpoint-maintenance", status, startedAt, updatedAt, target, mode, consent, backup, metrics: { before, after }, semanticCleanup, physicalReclamation: physical, completedStages, serviceRestoration, interruption, artifactPolicy: "current-plus-one-previous-or-failed", failure, recovery };
}

/** Atomically replace one owner-only JSON record; callers validate before publishing. */
export async function writeOwnerOnlyJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeCloneSeedOperationRecord(path: string, value: unknown): Promise<CloneSeedOperationRecord> {
  const record = parseCloneSeedOperationRecord(value);
  await writeOwnerOnlyJsonAtomically(path, record);
  return record;
}

export async function writeCheckpointMaintenanceOperationRecord(path: string, value: unknown): Promise<CheckpointMaintenanceOperationRecord> {
  const record = parseCheckpointMaintenanceOperationRecord(value);
  await writeOwnerOnlyJsonAtomically(path, record);
  return record;
}
