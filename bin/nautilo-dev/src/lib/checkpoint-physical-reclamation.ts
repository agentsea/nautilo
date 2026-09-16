/** D489 3.4 — explicit post-semantic physical table reclamation. */
import { spawnSync } from "node:child_process";
import {
  CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL,
  parseCheckpointRetentionPhysicalSizes,
  type CheckpointRetentionPhysicalSizes,
} from "./checkpoint-retention-plan";
import type { CheckpointSemanticAggregate } from "./checkpoint-semantic-compaction";

export const CHECKPOINT_PHYSICAL_REWRITE_ORDER = [
  "checkpoint_writes",
  "checkpoints",
  "checkpoint_blobs",
] as const;
export type CheckpointPhysicalRelation = (typeof CHECKPOINT_PHYSICAL_REWRITE_ORDER)[number];
const CHECKPOINT_PHYSICAL_RECLAMATION_TIMEOUT_MS = 20 * 60_000;

export interface CheckpointPhysicalProbe {
  readonly physical: CheckpointRetentionPhysicalSizes;
  readonly rows: Pick<CheckpointSemanticAggregate, "checkpointRows" | "writeRows" | "blobRows" | "totalRows">;
  readonly blockerLocks: number;
  readonly activeClients: number;
}

export interface CheckpointPhysicalReclamationResult {
  readonly before: CheckpointPhysicalProbe;
  readonly after: CheckpointPhysicalProbe;
  readonly beforeRelationBytes: number;
  readonly afterRelationBytes: number;
  readonly reclaimedBytes: number;
  readonly rewritten: readonly CheckpointPhysicalRelation[];
  readonly statisticsRefreshed: true;
}

export type CheckpointPhysicalReclamationFailure =
  | "contention"
  | "execution-failed"
  | "invalid-probe"
  | "semantic-state-changed"
  | "physical-measurement-increased";

export class CheckpointPhysicalReclamationError extends Error {
  constructor(
    readonly code: CheckpointPhysicalReclamationFailure,
    readonly stage: "preflight" | CheckpointPhysicalRelation | "analyze" | "verification",
    cause?: unknown,
    readonly before?: CheckpointPhysicalProbe,
  ) {
    super(`Checkpoint physical reclamation failed: ${code}`);
    this.cause = cause;
  }
}

export interface CheckpointPhysicalExecutor {
  execute(input: { readonly container: string; readonly database: "nautilo"; readonly script: string }):
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly stderr: string };
}

export function buildCheckpointPhysicalProbeScript(): string {
  return `\\set ON_ERROR_STOP on
\\pset tuples_only on
\\pset format unaligned
SET statement_timeout = '60s';
SET lock_timeout = '5s';
SELECT json_build_object(
  'relations', physical.relations,
  'checkpointRows', (SELECT count(*)::bigint FROM langchain.checkpoints),
  'writeRows', (SELECT count(*)::bigint FROM langchain.checkpoint_writes),
  'blobRows', (SELECT count(*)::bigint FROM langchain.checkpoint_blobs),
  'blockerLocks', (
    SELECT count(*)::bigint FROM pg_catalog.pg_locks AS lock
    WHERE lock.pid <> pg_backend_pid() AND lock.granted
      AND lock.relation IN (
        'langchain.checkpoints'::regclass,
        'langchain.checkpoint_writes'::regclass,
        'langchain.checkpoint_blobs'::regclass
      )
  ),
  'activeClients', (
    SELECT count(*)::bigint FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
      AND activity.backend_type = 'client backend'
      AND activity.state IS DISTINCT FROM 'idle'
  )
)::text
FROM (${CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL}) AS physical;`;
}

export function buildCheckpointPhysicalRewriteScript(relation: CheckpointPhysicalRelation): string {
  if (!CHECKPOINT_PHYSICAL_REWRITE_ORDER.includes(relation)) throw new Error("Unsupported checkpoint relation");
  return `\\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '15min';
VACUUM (FULL) langchain.${relation};`;
}

export function buildCheckpointPhysicalAnalyzeScript(): string {
  return `\\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '5min';
ANALYZE langchain.checkpoint_writes;
ANALYZE langchain.checkpoints;
ANALYZE langchain.checkpoint_blobs;`;
}

function safeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseCheckpointPhysicalProbe(stdout: string): CheckpointPhysicalProbe | undefined {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return undefined;
  let value: unknown;
  try { value = JSON.parse(lines[0]!); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const physical = parseCheckpointRetentionPhysicalSizes(row["relations"]);
  const checkpointRows = safeInteger(row["checkpointRows"]);
  const writeRows = safeInteger(row["writeRows"]);
  const blobRows = safeInteger(row["blobRows"]);
  const blockerLocks = safeInteger(row["blockerLocks"]);
  const activeClients = safeInteger(row["activeClients"]);
  if ([checkpointRows, writeRows, blobRows, blockerLocks, activeClients].some((field) => field === undefined) || physical === undefined) return undefined;
  return {
    physical,
    rows: {
      checkpointRows: checkpointRows!, writeRows: writeRows!, blobRows: blobRows!,
      totalRows: checkpointRows! + writeRows! + blobRows!,
    },
    blockerLocks: blockerLocks!, activeClients: activeClients!,
  };
}

export const defaultCheckpointPhysicalExecutor: CheckpointPhysicalExecutor = {
  execute: ({ container, database, script }) => {
    const result = spawnSync("docker", ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], {
      input: script, encoding: "utf8", maxBuffer: 1024 * 1024,
      timeout: CHECKPOINT_PHYSICAL_RECLAMATION_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0) return { ok: false, stderr: String(result.stderr || result.stdout || result.error?.message || "physical reclamation failed") };
    return { ok: true, stdout: String(result.stdout) };
  },
};

function assertSemanticRows(
  probe: CheckpointPhysicalProbe,
  expected: CheckpointSemanticAggregate,
  stage: "preflight" | "verification",
): void {
  if (
    probe.rows.checkpointRows !== expected.checkpointRows ||
    probe.rows.writeRows !== expected.writeRows ||
    probe.rows.blobRows !== expected.blobRows ||
    probe.rows.totalRows !== expected.totalRows
  ) throw new CheckpointPhysicalReclamationError("semantic-state-changed", stage);
}

function executeProbe(
  container: string,
  executor: CheckpointPhysicalExecutor,
  stage: "preflight" | "verification",
): CheckpointPhysicalProbe {
  const result = executor.execute({ container, database: "nautilo", script: buildCheckpointPhysicalProbeScript() });
  if (!result.ok) throw new CheckpointPhysicalReclamationError("execution-failed", stage);
  const probe = parseCheckpointPhysicalProbe(result.stdout);
  if (probe === undefined) throw new CheckpointPhysicalReclamationError("invalid-probe", stage);
  return probe;
}

export async function executeCheckpointPhysicalReclamation(input: {
  readonly container: string;
  readonly expectedSemanticState: CheckpointSemanticAggregate;
  readonly executor?: CheckpointPhysicalExecutor;
  readonly onReady?: (before: CheckpointPhysicalProbe) => Promise<void> | void;
  readonly progress?: (event: { readonly stage: "preflight" | CheckpointPhysicalRelation | "analyze" | "verification"; readonly status: "starting" | "complete" }) => Promise<void> | void;
}): Promise<CheckpointPhysicalReclamationResult> {
  const executor = input.executor ?? defaultCheckpointPhysicalExecutor;
  await input.progress?.({ stage: "preflight", status: "starting" });
  const before = executeProbe(input.container, executor, "preflight");
  assertSemanticRows(before, input.expectedSemanticState, "preflight");
  if (before.blockerLocks > 0 || before.activeClients > 0) {
    throw new CheckpointPhysicalReclamationError("contention", "preflight", undefined, before);
  }
  await input.onReady?.(before);
  await input.progress?.({ stage: "preflight", status: "complete" });
  const rewritten: CheckpointPhysicalRelation[] = [];
  for (const relation of CHECKPOINT_PHYSICAL_REWRITE_ORDER) {
    await input.progress?.({ stage: relation, status: "starting" });
    const rewrite = executor.execute({ container: input.container, database: "nautilo", script: buildCheckpointPhysicalRewriteScript(relation) });
    if (!rewrite.ok) throw new CheckpointPhysicalReclamationError("execution-failed", relation);
    rewritten.push(relation);
    await input.progress?.({ stage: relation, status: "complete" });
  }
  await input.progress?.({ stage: "analyze", status: "starting" });
  const analyze = executor.execute({ container: input.container, database: "nautilo", script: buildCheckpointPhysicalAnalyzeScript() });
  if (!analyze.ok) throw new CheckpointPhysicalReclamationError("execution-failed", "analyze");
  await input.progress?.({ stage: "analyze", status: "complete" });
  await input.progress?.({ stage: "verification", status: "starting" });
  const after = executeProbe(input.container, executor, "verification");
  assertSemanticRows(after, input.expectedSemanticState, "verification");
  if (after.physical.totalBytes > before.physical.totalBytes) {
    throw new CheckpointPhysicalReclamationError("physical-measurement-increased", "verification");
  }
  await input.progress?.({ stage: "verification", status: "complete" });
  return {
    before, after,
    beforeRelationBytes: before.physical.totalBytes,
    afterRelationBytes: after.physical.totalBytes,
    reclaimedBytes: before.physical.totalBytes - after.physical.totalBytes,
    rewritten,
    statisticsRefreshed: true,
  };
}
