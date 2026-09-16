/**
 * D489 3.3 — transactional historical checkpoint compaction.
 *
 * Identifiers and payloads remain inside PostgreSQL. The only successful
 * output is aggregate row/byte evidence. Every delete and every invariant
 * check shares one transaction; any SQL error before COMMIT rolls back. A
 * transport failure at COMMIT remains unknown and requires re-inventory.
 */
import { spawnSync } from "node:child_process";
import { CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL } from "./checkpoint-retention-plan";

const CHECKPOINT_SEMANTIC_COMPACTION_BATCH_SIZE = 1_000;
const CHECKPOINT_SEMANTIC_COMPACTION_TIMEOUT_MS = 15 * 60_000;

export interface CheckpointSemanticAggregate {
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

export interface CheckpointSemanticCompactionResult {
  readonly groups: number;
  readonly before: CheckpointSemanticAggregate;
  readonly after: CheckpointSemanticAggregate;
  readonly deleted: CheckpointSemanticAggregate;
}

export interface CheckpointSemanticCompactionExecutor {
  execute(input: { readonly container: string; readonly database: "nautilo"; readonly script: string }):
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly stderr: string };
}

export class CheckpointSemanticCompactionError extends Error {
  constructor(readonly code: "execution-failed" | "invalid-aggregate-evidence" | "source-identity-mismatch", cause?: unknown) {
    super(`Checkpoint semantic compaction failed: ${code}`);
    this.cause = cause;
  }
}

/**
 * Exact Stack 208 retention, lifted across every thread/namespace:
 * latest checkpoint, its writes, and its channel-version blobs survive.
 * Legacy v1-v3 checkpoints are supported only without a parent because the
 * pinned saver reads a legacy parent's TASKS writes during resume.
 */
export function buildCheckpointSemanticCompactionScript(
  batchSize = CHECKPOINT_SEMANTIC_COMPACTION_BATCH_SIZE,
  expectedBefore?: CheckpointSemanticAggregate,
): string {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("Checkpoint compaction batch size must be between 1 and 10000");
  }
  if (expectedBefore !== undefined) {
    const fields = Object.values(expectedBefore);
    if (fields.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        expectedBefore.totalRows !== expectedBefore.checkpointRows + expectedBefore.writeRows + expectedBefore.blobRows ||
        expectedBefore.totalLogicalBytes !== expectedBefore.checkpointLogicalBytes + expectedBefore.writeLogicalBytes + expectedBefore.blobLogicalBytes) {
      throw new Error("Checkpoint compaction expected aggregate is invalid");
    }
  }
  const expectedBeforeGuard = expectedBefore === undefined ? "" : `
DO $expected_before$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM d489_before AS before
    WHERE before.checkpoint_rows = ${expectedBefore.checkpointRows}
      AND before.write_rows = ${expectedBefore.writeRows}
      AND before.blob_rows = ${expectedBefore.blobRows}
      AND before.checkpoint_logical_bytes = ${expectedBefore.checkpointLogicalBytes}
      AND before.write_logical_bytes = ${expectedBefore.writeLogicalBytes}
      AND before.blob_logical_bytes = ${expectedBefore.blobLogicalBytes}
      AND before.blob_payload_bytes = ${expectedBefore.blobPayloadBytes}
  ) THEN
    RAISE EXCEPTION 'checkpoint maintenance inventory changed before mutation';
  END IF;
END $expected_before$;
`;
  return `\\set ON_ERROR_STOP on
\\pset tuples_only on
\\pset format unaligned
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
LOCK TABLE langchain.checkpoints, langchain.checkpoint_writes, langchain.checkpoint_blobs
  IN SHARE ROW EXCLUSIVE MODE;

WITH schema_probe AS (${CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL})
SELECT (
  schema_probe.missing_required_checkpoint_tables = 0
  AND schema_probe.invalid_required_schema_items = 0
)::text AS checkpoint_schema_is_current
FROM schema_probe
\\gset
\\if :checkpoint_schema_is_current
\\else
DO $guard$ BEGIN RAISE EXCEPTION 'checkpoint maintenance schema validation failed'; END $guard$;
\\endif

CREATE TEMP TABLE d489_source_identity AS
SELECT oid AS database_oid, datname AS database_name
FROM pg_catalog.pg_database
WHERE datname = current_database();

CREATE TEMP TABLE d489_latest AS
SELECT DISTINCT ON (cp.thread_id, cp.checkpoint_ns)
  cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id,
  cp.parent_checkpoint_id, cp.checkpoint
FROM langchain.checkpoints AS cp
ORDER BY cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id DESC;
CREATE UNIQUE INDEX ON d489_latest(thread_id, checkpoint_ns);

DO $format$
BEGIN
  IF EXISTS (
    SELECT 1 FROM d489_latest
    WHERE jsonb_typeof(checkpoint) IS DISTINCT FROM 'object'
      OR jsonb_typeof(checkpoint -> 'v') IS DISTINCT FROM 'number'
      OR checkpoint ->> 'v' !~ '^[1-4]$'
      OR jsonb_typeof(checkpoint -> 'channel_versions') IS DISTINCT FROM 'object'
      OR ((checkpoint ->> 'v')::integer < 4 AND parent_checkpoint_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'checkpoint maintenance format validation failed';
  END IF;
END $format$;

CREATE TEMP TABLE d489_references AS
SELECT latest.thread_id, latest.checkpoint_ns, version.channel, version.version
FROM d489_latest AS latest
CROSS JOIN LATERAL jsonb_each_text(latest.checkpoint -> 'channel_versions') AS version(channel, version);
CREATE UNIQUE INDEX ON d489_references(thread_id, checkpoint_ns, channel, version);

DO $closure_before$
BEGIN
  IF EXISTS (
    SELECT 1 FROM d489_references AS ref
    LEFT JOIN langchain.checkpoint_blobs AS blob
      ON blob.thread_id = ref.thread_id
      AND blob.checkpoint_ns = ref.checkpoint_ns
      AND blob.channel = ref.channel
      AND blob.version = ref.version
    WHERE blob.thread_id IS NULL
  ) THEN
    RAISE EXCEPTION 'checkpoint maintenance reference validation failed';
  END IF;
END $closure_before$;

CREATE TEMP TABLE d489_before AS
SELECT
  (SELECT count(*)::bigint FROM langchain.checkpoints) AS checkpoint_rows,
  (SELECT coalesce(sum(pg_column_size(cp)), 0)::bigint FROM langchain.checkpoints AS cp) AS checkpoint_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_writes) AS write_rows,
  (SELECT coalesce(sum(pg_column_size(cw)), 0)::bigint FROM langchain.checkpoint_writes AS cw) AS write_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_blobs) AS blob_rows,
  (SELECT coalesce(sum(pg_column_size(cb)), 0)::bigint FROM langchain.checkpoint_blobs AS cb) AS blob_logical_bytes,
  (SELECT coalesce(sum(octet_length(cb.blob)), 0)::bigint FROM langchain.checkpoint_blobs AS cb) AS blob_payload_bytes;

CREATE TEMP TABLE d489_expected AS
SELECT
  (SELECT count(*)::bigint FROM d489_latest) AS checkpoint_rows,
  (SELECT coalesce(sum(pg_column_size(cp)), 0)::bigint
    FROM langchain.checkpoints AS cp JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)) AS checkpoint_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_writes AS cw
    JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)) AS write_rows,
  (SELECT coalesce(sum(pg_column_size(cw)), 0)::bigint FROM langchain.checkpoint_writes AS cw
    JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)) AS write_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_blobs AS cb
    JOIN d489_references AS ref USING (thread_id, checkpoint_ns, channel, version)) AS blob_rows,
  (SELECT coalesce(sum(pg_column_size(cb)), 0)::bigint FROM langchain.checkpoint_blobs AS cb
    JOIN d489_references AS ref USING (thread_id, checkpoint_ns, channel, version)) AS blob_logical_bytes,
  (SELECT coalesce(sum(octet_length(cb.blob)), 0)::bigint FROM langchain.checkpoint_blobs AS cb
    JOIN d489_references AS ref USING (thread_id, checkpoint_ns, channel, version)) AS blob_payload_bytes;
${expectedBeforeGuard}

DO $delete$
DECLARE affected integer;
BEGIN
  LOOP
    WITH candidates AS MATERIALIZED (
      SELECT cw.thread_id, cw.checkpoint_ns, cw.checkpoint_id, cw.task_id, cw.idx
      FROM langchain.checkpoint_writes AS cw
      LEFT JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)
      WHERE latest.checkpoint_id IS NULL
      ORDER BY cw.thread_id, cw.checkpoint_ns, cw.checkpoint_id, cw.task_id, cw.idx
      LIMIT ${batchSize}
    )
    DELETE FROM langchain.checkpoint_writes AS cw USING candidates AS doomed
    WHERE (cw.thread_id, cw.checkpoint_ns, cw.checkpoint_id, cw.task_id, cw.idx) =
      (doomed.thread_id, doomed.checkpoint_ns, doomed.checkpoint_id, doomed.task_id, doomed.idx);
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
  END LOOP;

  LOOP
    WITH candidates AS MATERIALIZED (
      SELECT cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id
      FROM langchain.checkpoints AS cp
      LEFT JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)
      WHERE latest.checkpoint_id IS NULL
      ORDER BY cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id
      LIMIT ${batchSize}
    )
    DELETE FROM langchain.checkpoints AS cp USING candidates AS doomed
    WHERE (cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id) =
      (doomed.thread_id, doomed.checkpoint_ns, doomed.checkpoint_id);
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
  END LOOP;

  LOOP
    WITH candidates AS MATERIALIZED (
      SELECT cb.thread_id, cb.checkpoint_ns, cb.channel, cb.version
      FROM langchain.checkpoint_blobs AS cb
      LEFT JOIN d489_references AS ref USING (thread_id, checkpoint_ns, channel, version)
      WHERE ref.thread_id IS NULL
      ORDER BY cb.thread_id, cb.checkpoint_ns, cb.channel, cb.version
      LIMIT ${batchSize}
    )
    DELETE FROM langchain.checkpoint_blobs AS cb USING candidates AS doomed
    WHERE (cb.thread_id, cb.checkpoint_ns, cb.channel, cb.version) =
      (doomed.thread_id, doomed.checkpoint_ns, doomed.channel, doomed.version);
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
  END LOOP;
END $delete$;

CREATE TEMP TABLE d489_after AS
SELECT
  (SELECT count(*)::bigint FROM langchain.checkpoints) AS checkpoint_rows,
  (SELECT coalesce(sum(pg_column_size(cp)), 0)::bigint FROM langchain.checkpoints AS cp) AS checkpoint_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_writes) AS write_rows,
  (SELECT coalesce(sum(pg_column_size(cw)), 0)::bigint FROM langchain.checkpoint_writes AS cw) AS write_logical_bytes,
  (SELECT count(*)::bigint FROM langchain.checkpoint_blobs) AS blob_rows,
  (SELECT coalesce(sum(pg_column_size(cb)), 0)::bigint FROM langchain.checkpoint_blobs AS cb) AS blob_logical_bytes,
  (SELECT coalesce(sum(octet_length(cb.blob)), 0)::bigint FROM langchain.checkpoint_blobs AS cb) AS blob_payload_bytes;

DO $verify$
BEGIN
  IF EXISTS (SELECT * FROM d489_expected EXCEPT SELECT * FROM d489_after)
    OR EXISTS (SELECT * FROM d489_after EXCEPT SELECT * FROM d489_expected)
    OR EXISTS (
      SELECT thread_id, checkpoint_ns, checkpoint_id FROM d489_latest
      EXCEPT
      SELECT thread_id, checkpoint_ns, checkpoint_id FROM langchain.checkpoints
    )
    OR EXISTS (
      SELECT 1 FROM langchain.checkpoint_writes AS cw
      LEFT JOIN d489_latest AS latest USING (thread_id, checkpoint_ns, checkpoint_id)
      WHERE latest.checkpoint_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM langchain.checkpoint_blobs AS cb
      LEFT JOIN d489_references AS ref USING (thread_id, checkpoint_ns, channel, version)
      WHERE ref.thread_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM d489_references AS ref
      LEFT JOIN langchain.checkpoint_blobs AS cb USING (thread_id, checkpoint_ns, channel, version)
      WHERE cb.thread_id IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM d489_source_identity AS identity
      JOIN pg_catalog.pg_database AS database
        ON database.oid = identity.database_oid AND database.datname = identity.database_name
      WHERE database.datname = current_database()
    )
  THEN
    RAISE EXCEPTION 'checkpoint maintenance postcondition failed';
  END IF;
END $verify$;

COMMIT;
SELECT json_build_object(
  'groups', expected.checkpoint_rows,
  'before', json_build_object(
    'checkpointRows', before.checkpoint_rows,
    'writeRows', before.write_rows,
    'blobRows', before.blob_rows,
    'checkpointLogicalBytes', before.checkpoint_logical_bytes,
    'writeLogicalBytes', before.write_logical_bytes,
    'blobLogicalBytes', before.blob_logical_bytes,
    'blobPayloadBytes', before.blob_payload_bytes
  ),
  'after', json_build_object(
    'checkpointRows', after.checkpoint_rows,
    'writeRows', after.write_rows,
    'blobRows', after.blob_rows,
    'checkpointLogicalBytes', after.checkpoint_logical_bytes,
    'writeLogicalBytes', after.write_logical_bytes,
    'blobLogicalBytes', after.blob_logical_bytes,
    'blobPayloadBytes', after.blob_payload_bytes
  )
)::text
FROM d489_before AS before CROSS JOIN d489_after AS after CROSS JOIN d489_expected AS expected;`;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseAggregate(value: unknown): CheckpointSemanticAggregate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const checkpointRows = nonNegativeInteger(row["checkpointRows"]);
  const writeRows = nonNegativeInteger(row["writeRows"]);
  const blobRows = nonNegativeInteger(row["blobRows"]);
  const checkpointLogicalBytes = nonNegativeInteger(row["checkpointLogicalBytes"]);
  const writeLogicalBytes = nonNegativeInteger(row["writeLogicalBytes"]);
  const blobLogicalBytes = nonNegativeInteger(row["blobLogicalBytes"]);
  const blobPayloadBytes = nonNegativeInteger(row["blobPayloadBytes"]);
  if ([checkpointRows, writeRows, blobRows, checkpointLogicalBytes, writeLogicalBytes, blobLogicalBytes, blobPayloadBytes].some((field) => field === undefined)) return undefined;
  return {
    checkpointRows: checkpointRows!, writeRows: writeRows!, blobRows: blobRows!,
    totalRows: checkpointRows! + writeRows! + blobRows!,
    checkpointLogicalBytes: checkpointLogicalBytes!, writeLogicalBytes: writeLogicalBytes!, blobLogicalBytes: blobLogicalBytes!,
    totalLogicalBytes: checkpointLogicalBytes! + writeLogicalBytes! + blobLogicalBytes!,
    blobPayloadBytes: blobPayloadBytes!,
  };
}

export function parseCheckpointSemanticCompactionOutput(stdout: string): CheckpointSemanticCompactionResult | undefined {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0]!.startsWith("{")) return undefined;
  let value: unknown;
  try { value = JSON.parse(lines[0]!); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const groups = nonNegativeInteger(row["groups"]);
  const before = parseAggregate(row["before"]);
  const after = parseAggregate(row["after"]);
  if (groups === undefined || before === undefined || after === undefined || after.checkpointRows !== groups) return undefined;
  const subtract = (left: number, right: number): number | undefined => left >= right ? left - right : undefined;
  const deletedFields = {
    checkpointRows: subtract(before.checkpointRows, after.checkpointRows),
    writeRows: subtract(before.writeRows, after.writeRows),
    blobRows: subtract(before.blobRows, after.blobRows),
    checkpointLogicalBytes: subtract(before.checkpointLogicalBytes, after.checkpointLogicalBytes),
    writeLogicalBytes: subtract(before.writeLogicalBytes, after.writeLogicalBytes),
    blobLogicalBytes: subtract(before.blobLogicalBytes, after.blobLogicalBytes),
    blobPayloadBytes: subtract(before.blobPayloadBytes, after.blobPayloadBytes),
  };
  if (Object.values(deletedFields).some((field) => field === undefined)) return undefined;
  const deleted = parseAggregate(deletedFields);
  return deleted === undefined ? undefined : { groups, before, after, deleted };
}

const defaultCheckpointSemanticCompactionExecutor: CheckpointSemanticCompactionExecutor = {
  execute: ({ container, database, script }) => {
    const result = spawnSync("docker", ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], {
      input: script, encoding: "utf8", maxBuffer: 1024 * 1024,
      timeout: CHECKPOINT_SEMANTIC_COMPACTION_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0) return { ok: false, stderr: String(result.stderr || result.stdout || result.error?.message || "semantic compaction failed") };
    return { ok: true, stdout: String(result.stdout) };
  },
};

export function executeCheckpointSemanticCompaction(input: {
  readonly container: string;
  readonly executor?: CheckpointSemanticCompactionExecutor;
  readonly expectedBefore?: CheckpointSemanticAggregate;
}): CheckpointSemanticCompactionResult {
  const execution = (input.executor ?? defaultCheckpointSemanticCompactionExecutor).execute({
    container: input.container, database: "nautilo", script: buildCheckpointSemanticCompactionScript(
      CHECKPOINT_SEMANTIC_COMPACTION_BATCH_SIZE,
      input.expectedBefore,
    ),
  });
  // stderr is deliberately never copied into the typed error or operation evidence.
  if (!execution.ok) throw new CheckpointSemanticCompactionError("execution-failed");
  const result = parseCheckpointSemanticCompactionOutput(execution.stdout);
  if (result === undefined) throw new CheckpointSemanticCompactionError("invalid-aggregate-evidence");
  return result;
}
