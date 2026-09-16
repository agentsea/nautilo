/**
 * D489 Phase 3.1 — read-only historical checkpoint inventory.
 *
 * This command has deliberately narrow authority: it opens one `psql`
 * session to the selected local Postgres container, uses a repeatable-read
 * read-only transaction, emits aggregate-only evidence, and rolls back.
 * `--apply` composes the 3.2 consent/backup/quiescence gate with the 3.3
 * transactional semantic sweep. Physical table rewriting remains separate.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  resolveInstanceUncached,
  resolveNautiloRootDir,
  validateNautiloInstanceIdValue,
  type ResolvedInstance,
} from "@nautilo/config";
import { evaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";
import { defaultBackupQuiescenceDeps } from "../lib/backup-quiescence";
import {
  CheckpointMaintenanceGateError,
  gateCheckpointMaintenanceApply,
} from "../lib/checkpoint-maintenance-gate";
import { withCheckpointMaintenanceBackupSession } from "../lib/checkpoint-maintenance-backups";
import {
  CheckpointSemanticCompactionError,
  executeCheckpointSemanticCompaction,
  type CheckpointSemanticCompactionExecutor,
  type CheckpointSemanticCompactionResult,
} from "../lib/checkpoint-semantic-compaction";
import {
  CheckpointPhysicalReclamationError,
  executeCheckpointPhysicalReclamation,
  type CheckpointPhysicalExecutor,
  type CheckpointPhysicalReclamationResult,
} from "../lib/checkpoint-physical-reclamation";
import { selectCloneSource } from "../lib/clone-source-selection";
import { captureCanonicalDefaultSourceEvidence, assertCanonicalDefaultSourceEvidenceUnchanged } from "./clone";
import type { CanonicalDefaultSourceIsolationEvidence } from "./clone";
import { saveCheckpointMaintenanceRecovery } from "./save";
import {
  FULL_DEV_BACKUP_MANIFEST,
  sha256File,
  type VerifiedFullBackup,
} from "../lib/full-dev-backup";
import {
  writeCheckpointMaintenanceOperationRecord,
  type D489Failure,
  type CheckpointMaintenanceStage,
} from "../lib/d489-operation-records";
import { formatBytes } from "../lib/format-bytes";
import {
  CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL,
  CHECKPOINT_RETENTION_PLAN_SQL,
  CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL,
  parseCheckpointRetentionPhysicalSizes,
  parseCheckpointRetentionPlan,
  parseCheckpointRetentionSchemaProbe,
  type CheckpointRetentionPhysicalSizes,
  type CheckpointRetentionPlan,
  type CheckpointRetentionPlanRow,
  type CheckpointRetentionSchemaProbeRow,
} from "../lib/checkpoint-retention-plan";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";

const COMPACT_CHECKPOINTS_HELP: HelpSpec = {
  name: "compact-checkpoints",
  summary: "Dry-run inventory, protected semantic cleanup, or separately requested physical reclamation.",
  usage: "bun run dev:compact-checkpoints --instance <default|name> [--json] [--apply --i-know-what-i-am-doing [--reclaim-physical]]",
  flags: [
    {
      flag: "--instance <default|name>",
      description: "Required explicit target. `default` and `(default)` classify the canonical default instance.",
    },
    { flag: "--json", description: "Emit one versioned aggregate-only JSON document." },
    { flag: "--apply", description: "After verified recovery and writer quiescence, retain only latest resumable checkpoint state. Performs no physical rewrite." },
    { flag: "--reclaim-physical", description: "With --apply, additionally take bounded ACCESS EXCLUSIVE locks and VACUUM FULL the saver tables after semantic verification." },
    { flag: "--i-know-what-i-am-doing", description: "Required explicit consent for protected-default --apply." },
    { flag: "--help, -h", description: "Show this help and exit." },
  ],
  examples: [
    {
      cmd: "bun run dev:compact-checkpoints --instance default",
      desc: "Read the canonical default database without changing it.",
    },
    {
      cmd: "bun run dev:compact-checkpoints --instance feature-489 --json",
      desc: "Emit the aggregate-only inventory for a named development instance.",
    },
    {
      cmd: "bun run dev:compact-checkpoints --instance default --apply --i-know-what-i-am-doing",
      desc: "Publish a verified recovery backup, quiesce writers, transact semantic cleanup, verify, and restore writers.",
    },
    {
      cmd: "bun run dev:compact-checkpoints --instance default --apply --reclaim-physical --i-know-what-i-am-doing",
      desc: "After semantic verification, explicitly rewrite saver tables and refresh statistics while writers remain quiesced.",
    },
  ],
  notes: [
    "Dry-run is the default and always uses REPEATABLE READ READ ONLY, bounded lock/statement timeouts, and ROLLBACK.",
    "Logical reclaimable bytes are an estimate only. Physical reclaim requires a later explicit table rewrite stage.",
  ],
};

export const COMPACT_CHECKPOINTS_FORMAT_VERSION = 1 as const;
/** Covers Docker/psql startup as well as the 60s server-side statement limit. */
export const COMPACT_CHECKPOINTS_SPAWN_TIMEOUT_MS = 65_000;

export type CompactCheckpointsOutcomeCode =
  | "current-schema"
  | "absent-required-checkpoint-schema"
  | "invalid-required-checkpoint-schema"
  | "invalid-retained-checkpoint-format"
  | "unsupported-retained-legacy-parent-format"
  | "invalid-aggregate-projection"
  | "snapshot-timeout"
  | "snapshot-permission-denied"
  | "instance-unavailable"
  | "instance-resolution-mismatch"
  | "snapshot-execution-failed";

export interface CompactCheckpointsSuccess {
  readonly formatVersion: typeof COMPACT_CHECKPOINTS_FORMAT_VERSION;
  readonly kind: "checkpoint-maintenance-inventory";
  readonly mode: "dry-run";
  readonly target: "canonical-default" | "named-instance";
  readonly outcome: "current-schema";
  readonly plan: CheckpointRetentionPlan;
  readonly physical: CheckpointRetentionPhysicalSizes;
}

export interface CompactCheckpointsFailure {
  readonly formatVersion: typeof COMPACT_CHECKPOINTS_FORMAT_VERSION;
  readonly kind: "checkpoint-maintenance-inventory";
  readonly mode: "dry-run";
  readonly target: "canonical-default" | "named-instance";
  readonly outcome: Exclude<CompactCheckpointsOutcomeCode, "current-schema">;
}

export type CompactCheckpointsResult = CompactCheckpointsSuccess | CompactCheckpointsFailure;

interface ParsedArgs {
  readonly explicitInstance: string;
  readonly resolvedInstanceId: string;
  readonly target: "canonical-default" | "named-instance";
  readonly asJson: boolean;
  readonly apply: boolean;
  readonly iKnowWhatIAmDoing: boolean;
  readonly reclaimPhysical: boolean;
}

export interface CompactCheckpointsSnapshotExecutor {
  execute(input: { readonly container: string; readonly database: "nautilo"; readonly script: string }):
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly stderr: string };
}

export interface CompactCheckpointsDeps {
  readonly resolveInstance?: (env: NodeJS.ProcessEnv) => ResolvedInstance;
  readonly instanceRootExists?: (env: NodeJS.ProcessEnv) => boolean;
  readonly executor?: CompactCheckpointsSnapshotExecutor;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (line: string) => void;
  /** Narrow 3.2 seams: tests prove gate/record ordering without Docker or files. */
  readonly mutationGuard?: () => boolean;
  readonly applyGate?: () => Promise<void>;
  readonly writeApplyRecord?: () => Promise<void>;
  readonly writeApplyFailureRecord?: (error: unknown) => Promise<void>;
  readonly semanticExecutor?: CheckpointSemanticCompactionExecutor;
  readonly physicalExecutor?: CheckpointPhysicalExecutor;
}

function findSemanticCompactionError(error: unknown): CheckpointSemanticCompactionError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof CheckpointSemanticCompactionError) return current;
    seen.add(current);
    if (current instanceof Error && current.cause !== undefined) current = current.cause;
    else return undefined;
  }
  return undefined;
}

function findPhysicalReclamationError(error: unknown): CheckpointPhysicalReclamationError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof CheckpointPhysicalReclamationError) return current;
    seen.add(current);
    if (current instanceof Error && current.cause !== undefined) current = current.cause;
    else return undefined;
  }
  return undefined;
}

export function isCheckpointPhysicalOutcomeAmbiguous(error: CheckpointPhysicalReclamationError): boolean {
  return error.code === "execution-failed" &&
    (error.stage === "checkpoint_writes" || error.stage === "checkpoints" ||
      error.stage === "checkpoint_blobs" || error.stage === "analyze");
}

/** Compare only immutable source/topology identity; checkpoint aggregates are expected to change. */
export function assertCheckpointMaintenanceSourceIdentityUnchanged(
  before: CanonicalDefaultSourceIsolationEvidence,
  after: CanonicalDefaultSourceIsolationEvidence,
): void {
  if (
    before.instanceJsonHash !== after.instanceJsonHash ||
    before.instanceEnvHash !== after.instanceEnvHash ||
    before.volumeState !== after.volumeState ||
    JSON.stringify(before.projectObjects) !== JSON.stringify(after.projectObjects) ||
    before.writersRunning !== after.writersRunning ||
    JSON.stringify(before.databaseLedger) !== JSON.stringify(after.databaseLedger) ||
    before.serverListenerState !== after.serverListenerState ||
    before.logtoCoreState !== after.logtoCoreState ||
    before.databaseIdentity !== after.databaseIdentity
  ) {
    throw new Error("Checkpoint maintenance source identity changed");
  }
}

export function checkpointFailureEvidence(error: unknown): {
  readonly failure: D489Failure;
  readonly retryState: "safe-to-retry" | "manual-recovery-required";
  readonly restorationFailed: boolean;
  readonly writersPaused: boolean;
  readonly writersQuiesced: boolean;
  readonly writersRestored: boolean;
} {
  const code = error instanceof CheckpointMaintenanceGateError ? error.code : null;
  const semanticCause = findSemanticCompactionError(error);
  const physicalCause = findPhysicalReclamationError(error);
  const writersPaused = error instanceof CheckpointMaintenanceGateError && error.writerState !== undefined &&
    (error.writerState.paused.nautiloWriterStopped || error.writerState.paused.logtoWriterStopped);
  const writersRestored = writersPaused && error instanceof CheckpointMaintenanceGateError &&
    error.writerState?.restoration === "restored";
  const writersQuiesced = error instanceof CheckpointMaintenanceGateError && error.writerBoundary === "mutation" &&
    error.writerState?.quiesced === true;
  if (physicalCause !== undefined) {
    const ambiguous = isCheckpointPhysicalOutcomeAmbiguous(physicalCause);
    return {
      failure: {
        code: ambiguous ? "operation-interrupted" : "physical-reclamation-failed",
        guidance: "inspect-postgres-recovery-and-rerun-explicitly",
      },
      retryState: "manual-recovery-required",
      restorationFailed: false,
      writersPaused,
      writersQuiesced,
      writersRestored,
    };
  }
  if (semanticCause !== undefined) {
    const commitAmbiguous = semanticCause.code === "execution-failed";
    return {
      failure: {
        code: commitAmbiguous ? "operation-interrupted" : "semantic-verification-failed",
        guidance: "inspect-postgres-recovery-and-rerun-explicitly",
      },
      retryState: "manual-recovery-required",
      restorationFailed: false,
      writersPaused,
      writersQuiesced,
      writersRestored,
    };
  }
  switch (code) {
    case "backup":
      return {
        failure: { code: "backup-verification-failed", guidance: "retry-after-backup-verification" },
        retryState: "safe-to-retry",
        restorationFailed: false,
        writersPaused,
        writersQuiesced,
        writersRestored,
      };
    case "source-evidence":
      return {
        failure: { code: "lineage-verification-failed", guidance: "retry-after-backup-verification" },
        retryState: "safe-to-retry",
        restorationFailed: false,
        writersPaused,
        writersQuiesced,
        writersRestored,
      };
    case "writer-quiescence":
      return {
        failure: { code: "writer-quiescence-failed", guidance: "retry-after-writer-quiescence" },
        retryState: "safe-to-retry",
        restorationFailed: false,
        writersPaused,
        writersQuiesced,
        writersRestored,
      };
    case "resume":
      return {
        failure: { code: "service-restoration-failed", guidance: "restore-paused-services-before-retry" },
        retryState: "manual-recovery-required",
        restorationFailed: true,
        writersPaused,
        writersQuiesced,
        writersRestored: false,
      };
    default:
      return {
        failure: { code: "operation-interrupted", guidance: "inspect-postgres-recovery-and-rerun-explicitly" },
        retryState: "manual-recovery-required",
        restorationFailed: false,
        writersPaused,
        writersQuiesced,
        writersRestored,
      };
  }
}

export function checkpointFailureOperationState(
  error: unknown,
  input: { readonly backupVerified: boolean; readonly gateCompleted: boolean },
): {
  readonly completedStages: readonly CheckpointMaintenanceStage[];
  readonly serviceRestoration:
    | { readonly intent: "not-needed"; readonly result: "not-attempted" }
    | { readonly intent: "restore-paused-services"; readonly result: "restored" | "failed" };
} {
  const evidence = checkpointFailureEvidence(error);
  const completedStages: CheckpointMaintenanceStage[] = ["inventory-read", "consent-verified"];
  if (input.backupVerified) completedStages.push("backup-verified");
  if (input.gateCompleted || evidence.writersQuiesced) completedStages.push("writers-quiesced");
  if (input.gateCompleted || evidence.writersRestored) completedStages.push("services-restored");
  const serviceRestoration = evidence.restorationFailed
    ? { intent: "restore-paused-services", result: "failed" } as const
    : input.gateCompleted || evidence.writersRestored
      ? { intent: "restore-paused-services", result: "restored" } as const
      : { intent: "not-needed", result: "not-attempted" } as const;
  return { completedStages, serviceRestoration };
}

/**
 * A nonzero psql exit after submitting COMMIT cannot prove whether PostgreSQL
 * committed. Record that state as interrupted until a fresh inventory proves
 * the database outcome; never claim rollback merely from transport failure.
 */
export function checkpointSemanticFailureOperationState(
  error: unknown,
  input: { readonly semanticStarted: boolean; readonly semanticResultPresent: boolean },
): {
  readonly status: "failed" | "interrupted";
  readonly semanticStatus: "not-started" | "failed" | "interrupted" | "complete";
  readonly interruption: "none" | "during-semantic-cleanup";
} {
  const semanticError = findSemanticCompactionError(error);
  if (
    input.semanticStarted &&
    !input.semanticResultPresent &&
    semanticError?.code === "execution-failed"
  ) {
    return {
      status: "interrupted",
      semanticStatus: "interrupted",
      interruption: "during-semantic-cleanup",
    };
  }
  return {
    status: "failed",
    semanticStatus: input.semanticResultPresent
      ? "complete"
      : input.semanticStarted
        ? "failed"
        : "not-started",
    interruption: "none",
  };
}

function explicitInstanceArg(argv: readonly string[]): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--instance") continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    values.push(value);
    index += 1;
  }
  return values.length === 1 ? values[0] : undefined;
}

export function parseCompactCheckpointsArgs(argv: readonly string[]):
  | { readonly ok: true; readonly value: ParsedArgs }
  | { readonly ok: false; readonly message: string } {
  const supported = new Set(["--instance", "--json", "--apply", "--reclaim-physical", "--i-know-what-i-am-doing", "--help", "-h"]);
  let jsonCount = 0;
  let commandCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      if (arg === "compact-checkpoints" && index === 0) {
        commandCount += 1;
        continue;
      }
      return { ok: false, message: `compact-checkpoints: unexpected positional argument ${arg}` };
    }
    if (!supported.has(arg)) return { ok: false, message: `compact-checkpoints: unsupported flag ${arg}` };
    if (arg === "--json") jsonCount += 1;
    if (arg === "--instance") index += 1;
  }
  if (commandCount > 1 || jsonCount > 1) return { ok: false, message: "compact-checkpoints: duplicate command flag" };
  const instance = explicitInstanceArg(argv)?.trim();
  if (!instance) return { ok: false, message: "compact-checkpoints: --instance <default|name> is required" };
  const target = /^(default|\(default\))$/i.test(instance) ? "canonical-default" : "named-instance";
  if (argv.includes("--reclaim-physical") && !argv.includes("--apply")) {
    return { ok: false, message: "compact-checkpoints: --reclaim-physical requires --apply" };
  }
  if (target === "named-instance") {
    const validationError = validateNautiloInstanceIdValue(instance);
    if (validationError !== null) return { ok: false, message: `compact-checkpoints: invalid --instance: ${validationError}` };
  }
  return {
    ok: true,
    value: { explicitInstance: instance, resolvedInstanceId: target === "canonical-default" ? "" : instance, target, asJson: argv.includes("--json"), apply: argv.includes("--apply"), iKnowWhatIAmDoing: argv.includes("--i-know-what-i-am-doing"), reclaimPhysical: argv.includes("--reclaim-physical") },
  };
}

/** One session, one transaction, no content rows. A disconnected psql session rolls back on any error. */
export function buildCompactCheckpointsSnapshotScript(): string {
  return `\\set ON_ERROR_STOP on
\\pset tuples_only on
\\pset format unaligned
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
WITH schema_probe AS (${CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL})
SELECT json_build_object('kind', 'schema', 'row', row_to_json(schema_probe))::text
FROM schema_probe;
WITH schema_probe AS (${CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL})
SELECT (
  schema_probe.missing_required_checkpoint_tables = 0
  AND schema_probe.invalid_required_schema_items = 0
)::text AS checkpoint_schema_is_current
FROM schema_probe
\\gset
\\if :checkpoint_schema_is_current
WITH plan AS (${CHECKPOINT_RETENTION_PLAN_SQL})
SELECT json_build_object('kind', 'plan', 'row', row_to_json(plan))::text
FROM plan;
SELECT json_build_object('kind', 'physical', 'relations', relations)::text
FROM (${CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL}) AS physical;
\\endif
ROLLBACK;`;
}

const defaultExecutor: CompactCheckpointsSnapshotExecutor = {
  execute: ({ container, database, script }) => {
    const result = spawnSync(
      "docker",
      ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"],
      {
        input: script,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: COMPACT_CHECKPOINTS_SPAWN_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { ok: false, stderr: "ETIMEDOUT" };
    }
    if (result.error || result.status !== 0) {
      return { ok: false, stderr: String(result.stderr || result.stdout || result.error?.message || "snapshot execution failed") };
    }
    return { ok: true, stdout: String(result.stdout) };
  },
};

function defaultInstanceRootExists(env: NodeJS.ProcessEnv): boolean {
  return existsSync(join(resolveNautiloRootDir({ env }), "instance.json"));
}

function defaultResolveInstance(env: NodeJS.ProcessEnv): ResolvedInstance {
  return resolveInstanceUncached(env, { skipUserConfigOverlay: true });
}

function snapshotFailureOutcome(stderr: string): CompactCheckpointsFailure["outcome"] {
  // Never surface stderr: Docker and psql errors can contain a connection URL.
  if (/permission denied|must be owner|insufficient privilege/i.test(stderr)) return "snapshot-permission-denied";
  if (/ETIMEDOUT|statement timeout|lock timeout|canceling statement due to/i.test(stderr)) return "snapshot-timeout";
  return "snapshot-execution-failed";
}

function noPlan(target: CompactCheckpointsFailure["target"], outcome: CompactCheckpointsFailure["outcome"]): CompactCheckpointsFailure {
  return { formatVersion: COMPACT_CHECKPOINTS_FORMAT_VERSION, kind: "checkpoint-maintenance-inventory", mode: "dry-run", target, outcome };
}

function parseSnapshotOutput(
  stdout: string,
  target: CompactCheckpointsFailure["target"],
): CompactCheckpointsResult {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("{")) return noPlan(target, "invalid-aggregate-projection");
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
    } catch {
      return noPlan(target, "invalid-aggregate-projection");
    }
  }
  const schema = records.find((record) => record["kind"] === "schema")?.["row"];
  const validKinds = new Set(["schema", "plan", "physical"]);
  if (
    records.length === 0 ||
    records.some((record) => typeof record["kind"] !== "string" || !validKinds.has(record["kind"])) ||
    records.filter((record) => record["kind"] === "schema").length !== 1
  ) return noPlan(target, "invalid-aggregate-projection");
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return noPlan(target, "invalid-aggregate-projection");
  }
  const schemaOutcome = parseCheckpointRetentionSchemaProbe(schema as CheckpointRetentionSchemaProbeRow);
  if (!schemaOutcome.ok) {
    return records.length === 1
      ? noPlan(target, schemaOutcome.code)
      : noPlan(target, "invalid-aggregate-projection");
  }

  const plan = records.find((record) => record["kind"] === "plan")?.["row"];
  const physical = records.find((record) => record["kind"] === "physical")?.["relations"];
  if (
    records.length !== 3 ||
    records.filter((record) => record["kind"] === "plan").length !== 1 ||
    records.filter((record) => record["kind"] === "physical").length !== 1
  ) return noPlan(target, "invalid-aggregate-projection");
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return noPlan(target, "invalid-aggregate-projection");
  const planOutcome = parseCheckpointRetentionPlan(plan as CheckpointRetentionPlanRow);
  if (!planOutcome.ok) return noPlan(target, planOutcome.code);
  const physicalOutcome = parseCheckpointRetentionPhysicalSizes(physical);
  if (!physicalOutcome) return noPlan(target, "invalid-aggregate-projection");
  return {
    formatVersion: COMPACT_CHECKPOINTS_FORMAT_VERSION,
    kind: "checkpoint-maintenance-inventory",
    mode: "dry-run",
    target,
    outcome: "current-schema",
    plan: planOutcome.plan,
    physical: physicalOutcome,
  };
}

export function formatCompactCheckpointsResult(result: CompactCheckpointsResult): string {
  if (result.outcome !== "current-schema") {
    return `Checkpoint inventory (dry run, target=${result.target})\nOutcome: ${result.outcome}\nNo changes were made.`;
  }
  const aggregateRows = [
    ["Current", result.plan.current.totalRows, result.plan.current.totalLogicalBytes, result.plan.current.blobPayloadBytes],
    ["Retained", result.plan.retained.totalRows, result.plan.retained.totalLogicalBytes, result.plan.retained.blobPayloadBytes],
    ["Reclaimable (estimate)", result.plan.reclaimable.totalRows, result.plan.reclaimable.totalLogicalBytes, result.plan.reclaimable.blobPayloadBytes],
  ];
  const logical = aggregateRows
    .map(([label, rows, bytes, payload]) => `  ${String(label).padEnd(23)} ${String(rows).padStart(10)} rows  ${formatBytes(Number(bytes)).padStart(10)}  payload ${formatBytes(Number(payload))}`)
    .join("\n");
  const physical = result.physical.relations
    .map((row) => `  ${row.relation.padEnd(20)} table (incl. TOAST) ${formatBytes(row.tableBytes).padStart(10)}  index ${formatBytes(row.indexBytes).padStart(10)}  TOAST ${formatBytes(row.toastBytes).padStart(10)}  total ${formatBytes(row.totalBytes)}`)
    .join("\n");
  return [
    `Checkpoint inventory (dry run, target=${result.target})`,
    "Schema: current-schema",
    "",
    "Logical retention (aggregate-only):",
    logical,
    "",
    "Physical relation sizes (measured; not reclaimable until an explicit rewrite):",
    physical,
    "",
    "No changes were made.",
  ].join("\n");
}

type CheckpointApplyOutcome =
  | "consent-required"
  | "canonical-default-only"
  | "invalid-injected-seams"
  | "gated-no-delete"
  | "semantic-complete"
  | "physical-complete"
  | "gate-failed";

export function formatCheckpointApplyOutcome(
  target: CompactCheckpointsFailure["target"],
  outcome: CheckpointApplyOutcome,
  asJson: boolean,
  human: string,
  physical?: CheckpointPhysicalReclamationResult,
): string {
  if (!asJson) {
    return physical === undefined ? human : [
      human,
      `Physical before: ${formatBytes(physical.beforeRelationBytes)}`,
      `Physical after: ${formatBytes(physical.afterRelationBytes)}`,
      `Physically reclaimed: ${formatBytes(physical.reclaimedBytes)}`,
    ].join("\n");
  }
  return JSON.stringify({
    formatVersion: COMPACT_CHECKPOINTS_FORMAT_VERSION,
    kind: "checkpoint-maintenance-inventory",
    mode: "apply",
    target,
    outcome,
    ...(physical === undefined ? {} : {
      physical: {
        beforeRelationBytes: physical.beforeRelationBytes,
        afterRelationBytes: physical.afterRelationBytes,
        reclaimedBytes: physical.reclaimedBytes,
        statisticsRefreshed: physical.statisticsRefreshed,
      },
    }),
  });
}

/** CLI entry point; accepts raw argv so an explicit --instance cannot be lost during global normalization. */
export async function compactCheckpointsCmd(rawArgv: readonly string[], deps: CompactCheckpointsDeps = {}): Promise<number> {
  const write = deps.write ?? console.log;
  if (hasHelpFlag([...rawArgv])) {
    write(formatHelp(COMPACT_CHECKPOINTS_HELP));
    return 0;
  }
  const parsed = parseCompactCheckpointsArgs(rawArgv);
  if (!parsed.ok) {
    write(parsed.message);
    return 2;
  }
  // Derive a private environment from the same explicit selector that the
  // report classifies. Do not trust a worktree fallback or mutate process.env.
  const env = { ...(deps.env ?? process.env), NAUTILO_INSTANCE_ID: parsed.value.resolvedInstanceId };
  const rootExists = deps.instanceRootExists ?? defaultInstanceRootExists;
  if (!rootExists(env)) {
    const result = noPlan(parsed.value.target, "instance-unavailable");
    write(parsed.value.asJson ? JSON.stringify(result) : formatCompactCheckpointsResult(result));
    return 1;
  }
  let instance: ResolvedInstance;
  try {
    instance = (deps.resolveInstance ?? defaultResolveInstance)(env);
  } catch {
    const result = noPlan(parsed.value.target, "instance-unavailable");
    write(parsed.value.asJson ? JSON.stringify(result) : formatCompactCheckpointsResult(result));
    return 1;
  }
  if (instance.instanceId !== parsed.value.resolvedInstanceId) {
    const result = noPlan(parsed.value.target, "instance-resolution-mismatch");
    write(parsed.value.asJson ? JSON.stringify(result) : formatCompactCheckpointsResult(result));
    return 1;
  }
  const execution = (deps.executor ?? defaultExecutor).execute({
    container: instance.compose.containers.legacyPostgres,
    database: "nautilo",
    script: buildCompactCheckpointsSnapshotScript(),
  });
  const result = execution.ok
    ? parseSnapshotOutput(execution.stdout, parsed.value.target)
    : noPlan(parsed.value.target, snapshotFailureOutcome(execution.stderr));
  if (parsed.value.apply && result.outcome === "current-schema") {
    const guard = deps.mutationGuard === undefined
      ? evaluateDefaultInstanceMutationGuard({ commandName: "dev:compact-checkpoints", instanceId: instance.instanceId, cwd: process.cwd(), isDryRunOrReadOnly: false, iKnowWhatIAmDoing: parsed.value.iKnowWhatIAmDoing, env }).allowed
      : deps.mutationGuard();
    if (!guard) {
      write(formatCheckpointApplyOutcome(parsed.value.target, "consent-required", parsed.value.asJson, "compact-checkpoints: protected-default mutation consent is required"));
      return 2;
    }
    // Phase 3.2 owns consent/recovery/quiescence; Phase 3.3's transactional
    // semantic sweep executes only inside that established writer boundary.
    if (parsed.value.target !== "canonical-default") {
      write(formatCheckpointApplyOutcome(parsed.value.target, "canonical-default-only", parsed.value.asJson, "compact-checkpoints: --apply is currently limited to the canonical default recovery path"));
      return 2;
    }
    if (parsed.value.reclaimPhysical && !parsed.value.asJson) {
      write("Physical reclamation requested: each saver table will take a bounded ACCESS EXCLUSIVE lock after semantic verification; readers and writers may block until each VACUUM FULL finishes.");
    }
    const source = selectCloneSource((env as NodeJS.ProcessEnv)["HOME"]?.trim() || homedir(), { kind: "canonical-default" });
    const snapshots = join(resolveNautiloRootDir({ env }), "dev-snapshots");
    const operationPath = join(resolveNautiloRootDir({ env }), "checkpoint-maintenance-operation.json");
    const aggregate = result.plan.current;
    const metrics = {
      checkpointRows: aggregate.checkpoints.rows,
      writeRows: aggregate.writes.rows,
      blobRows: aggregate.blobs.rows,
      totalRows: aggregate.totalRows,
      checkpointLogicalBytes: aggregate.checkpoints.logicalBytes,
      writeLogicalBytes: aggregate.writes.logicalBytes,
      blobLogicalBytes: aggregate.blobs.logicalBytes,
      totalLogicalBytes: aggregate.totalLogicalBytes,
      blobPayloadBytes: aggregate.blobPayloadBytes,
    };
    const startedAt = new Date().toISOString();
    let verifiedBackup: VerifiedFullBackup | undefined;
    let writersRestored = false;
    let productionSessionEntered = false;
    let productionFailureRecordAttempted = false;
    let semanticStarted = false;
    let semanticResult: CheckpointSemanticCompactionResult | undefined;
    let physicalStarted = false;
    let physicalBeforeRelationBytes: number | null = null;
    let physicalResult: CheckpointPhysicalReclamationResult | undefined;
    const writeProductionRunningRecord = async (): Promise<void> => {
      await writeCheckpointMaintenanceOperationRecord(operationPath, {
        formatVersion: 1, kind: "checkpoint-maintenance", status: "running", startedAt, updatedAt: new Date().toISOString(), target: "canonical-default", mode: "apply", consent: { apply: "explicit", defaultDangerAcknowledgment: "acknowledged" }, backup: { status: "not-required", manifestSha256: null, artifactCount: null, artifactBytes: null }, metrics: { before: metrics, after: null }, semanticCleanup: { status: "not-started" }, physicalReclamation: parsed.value.reclaimPhysical ? { intent: "explicit", status: "not-started", beforeRelationBytes: null, afterRelationBytes: null, reclaimedBytes: null } : { intent: "not-requested", status: "not-requested", beforeRelationBytes: null, afterRelationBytes: null, reclaimedBytes: null }, completedStages: ["inventory-read", "consent-verified"], serviceRestoration: { intent: "not-needed", result: "not-attempted" }, interruption: "none", artifactPolicy: "current-plus-one-previous-or-failed", failure: null, recovery: { retryState: "not-needed", guidance: "none" },
      });
    };
    const writeProductionFailureRecord = async (error: unknown): Promise<void> => {
      const evidence = checkpointFailureEvidence(error);
      const artifacts = verifiedBackup?.manifest.artifacts;
      const operationState = checkpointFailureOperationState(error, {
        backupVerified: artifacts !== undefined,
        gateCompleted: writersRestored,
      });
      const physicalError = findPhysicalReclamationError(error);
      const completedStages: CheckpointMaintenanceStage[] = operationState.completedStages
        .filter((stage) => stage !== "services-restored");
      if (semanticResult !== undefined) completedStages.push("semantic-cleanup", "semantic-verified");
      if (parsed.value.reclaimPhysical && (physicalStarted || physicalResult !== undefined || physicalError !== undefined)) {
        completedStages.push("physical-reclamation");
      }
      if (operationState.completedStages.includes("services-restored")) completedStages.push("services-restored");
      const semanticFailureState = checkpointSemanticFailureOperationState(error, {
        semanticStarted,
        semanticResultPresent: semanticResult !== undefined,
      });
      const physicalAmbiguous = physicalError !== undefined && isCheckpointPhysicalOutcomeAmbiguous(physicalError);
      const status = physicalError === undefined
        ? semanticFailureState.status
        : physicalAmbiguous ? "interrupted" : "failed";
      const interruption = physicalError === undefined
        ? semanticFailureState.interruption
        : physicalAmbiguous ? "during-physical-reclamation" : "none";
      const measuredBefore = physicalResult?.beforeRelationBytes ?? physicalBeforeRelationBytes ?? physicalError?.before?.physical.totalBytes ?? null;
      const physicalReclamation = !parsed.value.reclaimPhysical
        ? { intent: "not-requested", status: "not-requested", beforeRelationBytes: null, afterRelationBytes: null, reclaimedBytes: null } as const
        : physicalResult !== undefined
          ? { intent: "explicit", status: "complete", beforeRelationBytes: physicalResult.beforeRelationBytes, afterRelationBytes: physicalResult.afterRelationBytes, reclaimedBytes: physicalResult.reclaimedBytes } as const
          : physicalError !== undefined
            ? { intent: "explicit", status: physicalAmbiguous ? "interrupted" : "failed", beforeRelationBytes: measuredBefore, afterRelationBytes: null, reclaimedBytes: null } as const
            : { intent: "explicit", status: "not-started", beforeRelationBytes: null, afterRelationBytes: null, reclaimedBytes: null } as const;
      await writeCheckpointMaintenanceOperationRecord(operationPath, {
        formatVersion: 1, kind: "checkpoint-maintenance", status, startedAt, updatedAt: new Date().toISOString(), target: "canonical-default", mode: "apply", consent: { apply: "explicit", defaultDangerAcknowledgment: "acknowledged" }, backup: artifacts === undefined ? { status: "failed", manifestSha256: null, artifactCount: null, artifactBytes: null } : { status: "verified", manifestSha256: await sha256File(join(verifiedBackup!.dir, FULL_DEV_BACKUP_MANIFEST)), artifactCount: Object.values(artifacts).length, artifactBytes: Object.values(artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) }, metrics: { before: semanticResult?.before ?? metrics, after: semanticResult?.after ?? null }, semanticCleanup: { status: semanticFailureState.semanticStatus }, physicalReclamation, completedStages, serviceRestoration: operationState.serviceRestoration, interruption, artifactPolicy: "current-plus-one-previous-or-failed", failure: evidence.failure, recovery: { retryState: evidence.retryState, guidance: evidence.failure.guidance },
      });
    };
    try {
      const injectedApplySeams = [
        deps.applyGate,
        deps.writeApplyRecord,
        deps.writeApplyFailureRecord,
      ];
      if (injectedApplySeams.some((seam) => seam !== undefined) &&
          injectedApplySeams.some((seam) => seam === undefined)) {
        write(formatCheckpointApplyOutcome(parsed.value.target, "invalid-injected-seams", parsed.value.asJson, "compact-checkpoints: injected apply gate and success/failure record writers must be provided together"));
        return 1;
      }
      if (deps.applyGate !== undefined) {
        const writeApplyRecord = deps.writeApplyRecord!;
        await deps.applyGate();
        await writeApplyRecord();
        write(formatCheckpointApplyOutcome(parsed.value.target, "gated-no-delete", parsed.value.asJson, "Checkpoint maintenance gate completed; injected test seams performed no semantic cleanup or physical reclamation."));
        return 0;
      }
      await withCheckpointMaintenanceBackupSession({
        root: snapshots,
        action: async (session) => {
          productionSessionEntered = true;
          try {
            await writeProductionRunningRecord();
            const gate = await gateCheckpointMaintenanceApply({
              assertConsent: () => undefined,
              captureSourceEvidence: () => captureCanonicalDefaultSourceEvidence(source),
              assertSourceEvidenceUnchanged: (before) => assertCanonicalDefaultSourceEvidenceUnchanged(before, source),
              publishVerifiedRecoveryBackup: async () => {
                const recovery = await session.captureRecoveryBackup({
                  capture: (name) => saveCheckpointMaintenanceRecovery(name, {
                    instanceEnv: env,
                    snapshotRoot: snapshots,
                    log: parsed.value.asJson ? () => undefined : write,
                  }),
                });
                verifiedBackup = recovery.current;
                return verifiedBackup;
              },
              quiescence: defaultBackupQuiescenceDeps(instance, parsed.value.asJson ? () => undefined : write),
              afterWritersQuiesced: async () => {
                semanticStarted = true;
                semanticResult = executeCheckpointSemanticCompaction({
                  container: instance.compose.containers.legacyPostgres,
                  expectedBefore: metrics,
                  ...(deps.semanticExecutor === undefined ? {} : { executor: deps.semanticExecutor }),
                });
                if (!parsed.value.reclaimPhysical) return;
                physicalResult = await executeCheckpointPhysicalReclamation({
                  container: instance.compose.containers.legacyPostgres,
                  expectedSemanticState: semanticResult.after,
                  ...(deps.physicalExecutor === undefined ? {} : { executor: deps.physicalExecutor }),
                  ...(parsed.value.asJson ? {} : { progress: ({ stage, status }: { readonly stage: "preflight" | "checkpoint_writes" | "checkpoints" | "checkpoint_blobs" | "analyze" | "verification"; readonly status: "starting" | "complete" }) => {
                    write(`Physical reclamation ${stage}: ${status}`);
                  } }),
                  onReady: async (before) => {
                    physicalStarted = true;
                    physicalBeforeRelationBytes = before.physical.totalBytes;
                    if (verifiedBackup === undefined) throw new Error("Verified recovery backup evidence is unavailable");
                    const artifacts = verifiedBackup.manifest.artifacts;
                    await writeCheckpointMaintenanceOperationRecord(operationPath, {
                      formatVersion: 1, kind: "checkpoint-maintenance", status: "running", startedAt, updatedAt: new Date().toISOString(), target: "canonical-default", mode: "apply", consent: { apply: "explicit", defaultDangerAcknowledgment: "acknowledged" }, backup: { status: "verified", manifestSha256: await sha256File(join(verifiedBackup.dir, FULL_DEV_BACKUP_MANIFEST)), artifactCount: Object.values(artifacts).length, artifactBytes: Object.values(artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) }, metrics: { before: semanticResult!.before, after: semanticResult!.after }, semanticCleanup: { status: "complete" }, physicalReclamation: { intent: "explicit", status: "running", beforeRelationBytes: physicalBeforeRelationBytes, afterRelationBytes: null, reclaimedBytes: null }, completedStages: ["inventory-read", "consent-verified", "backup-verified", "writers-quiesced", "semantic-cleanup", "semantic-verified", "physical-reclamation"], serviceRestoration: { intent: "restore-paused-services", result: "not-attempted" }, interruption: "none", artifactPolicy: "current-plus-one-previous-or-failed", failure: null, recovery: { retryState: "not-needed", guidance: "none" },
                    });
                  },
                });
              },
            });
            writersRestored = true;
            if (semanticResult === undefined) throw new CheckpointSemanticCompactionError("invalid-aggregate-evidence");
            try {
              assertCheckpointMaintenanceSourceIdentityUnchanged(
                gate.sourceEvidence,
                await captureCanonicalDefaultSourceEvidence(source),
              );
            } catch (error) {
              throw new CheckpointSemanticCompactionError("source-identity-mismatch", error);
            }
            const finalPhysical = parsed.value.reclaimPhysical
              ? physicalResult === undefined
                ? (() => { throw new CheckpointPhysicalReclamationError("invalid-probe", "verification"); })()
                : { intent: "explicit", status: "complete", beforeRelationBytes: physicalResult.beforeRelationBytes, afterRelationBytes: physicalResult.afterRelationBytes, reclaimedBytes: physicalResult.reclaimedBytes } as const
              : { intent: "not-requested", status: "not-requested", beforeRelationBytes: null, afterRelationBytes: null, reclaimedBytes: null } as const;
            await writeCheckpointMaintenanceOperationRecord(operationPath, {
              formatVersion: 1, kind: "checkpoint-maintenance", status: "complete", startedAt, updatedAt: new Date().toISOString(), target: "canonical-default", mode: "apply", consent: { apply: "explicit", defaultDangerAcknowledgment: "acknowledged" }, backup: { status: "verified", manifestSha256: await sha256File(join(gate.backup.dir, FULL_DEV_BACKUP_MANIFEST)), artifactCount: Object.values(gate.backup.manifest.artifacts).length, artifactBytes: Object.values(gate.backup.manifest.artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) }, metrics: { before: semanticResult.before, after: semanticResult.after }, semanticCleanup: { status: "complete" }, physicalReclamation: finalPhysical, completedStages: ["inventory-read", "consent-verified", "backup-verified", "writers-quiesced", "semantic-cleanup", "semantic-verified", ...(parsed.value.reclaimPhysical ? ["physical-reclamation" as const] : []), "services-restored"], serviceRestoration: { intent: "restore-paused-services", result: "restored" }, interruption: "none", artifactPolicy: "current-plus-one-previous-or-failed", failure: null, recovery: { retryState: "not-needed", guidance: "none" },
            });
          } catch (error) {
            productionFailureRecordAttempted = true;
            await writeProductionFailureRecord(error).catch(() => undefined);
            throw error;
          }
        },
      });
      write(formatCheckpointApplyOutcome(parsed.value.target, parsed.value.reclaimPhysical ? "physical-complete" : "semantic-complete", parsed.value.asJson, parsed.value.reclaimPhysical ? "Checkpoint semantic cleanup and explicit physical reclamation completed with verified relation measurements." : "Checkpoint semantic cleanup and verification completed; physical reclamation was not requested.", physicalResult));
    } catch (error) {
      if (deps.writeApplyFailureRecord !== undefined) {
        await deps.writeApplyFailureRecord(error).catch(() => undefined);
      } else if (productionSessionEntered && !productionFailureRecordAttempted) {
        await writeProductionFailureRecord(error).catch(() => undefined);
      }
      write(formatCheckpointApplyOutcome(parsed.value.target, "gate-failed", parsed.value.asJson, "Checkpoint maintenance failed; recovery evidence was retained and the operation record contains next-step guidance."));
      return 1;
    }
    return 0;
  }
  write(parsed.value.asJson ? JSON.stringify(result) : formatCompactCheckpointsResult(result));
  return result.outcome === "current-schema" ? 0 : 1;
}
