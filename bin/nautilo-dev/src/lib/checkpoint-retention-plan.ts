/**
 * D489 Phase 1 — read-only historical checkpoint retention planning.
 *
 * This module deliberately has no database client dependency. Its SQL is a
 * bounded, aggregate-only projection for the pinned
 * `@langchain/langgraph-checkpoint-postgres` 1.0.1 schema. A future command
 * must run the statements in order on one connection: begin, set bounded
 * timeouts, validate schema, read the plan, then roll back.
 *
 * Checkpoint identifiers, namespaces, channel names, versions, and payloads
 * are used only inside the SQL joins. They are never selected into the DTOs or
 * error messages below.
 */

const CHECKPOINT_SCHEMA = "langchain";

const CHECKPOINT_RETENTION_SNAPSHOT_BEGIN_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
const CHECKPOINT_RETENTION_SNAPSHOT_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";
const CHECKPOINT_RETENTION_SNAPSHOT_STATEMENT_TIMEOUT_SQL =
  "SET LOCAL statement_timeout = '60s'";
const CHECKPOINT_RETENTION_SNAPSHOT_ROLLBACK_SQL = "ROLLBACK";

/**
 * Verify the exact table shape the pinned saver needs before evaluating a
 * plan. The primary-key checks matter: without them an aggregate join could
 * count duplicate retained blobs or writes and make the estimate unsafe.
 */
export const CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL = `
WITH required_columns(table_name, column_name, data_type, is_nullable) AS (
  VALUES
    ('checkpoints', 'thread_id', 'text', 'NO'),
    ('checkpoints', 'checkpoint_ns', 'text', 'NO'),
    ('checkpoints', 'checkpoint_id', 'text', 'NO'),
    ('checkpoints', 'parent_checkpoint_id', 'text', 'YES'),
    ('checkpoints', 'checkpoint', 'jsonb', 'NO'),
    ('checkpoint_blobs', 'thread_id', 'text', 'NO'),
    ('checkpoint_blobs', 'checkpoint_ns', 'text', 'NO'),
    ('checkpoint_blobs', 'channel', 'text', 'NO'),
    ('checkpoint_blobs', 'version', 'text', 'NO'),
    ('checkpoint_blobs', 'type', 'text', 'NO'),
    ('checkpoint_blobs', 'blob', 'bytea', 'YES'),
    ('checkpoint_writes', 'thread_id', 'text', 'NO'),
    ('checkpoint_writes', 'checkpoint_ns', 'text', 'NO'),
    ('checkpoint_writes', 'checkpoint_id', 'text', 'NO'),
    ('checkpoint_writes', 'task_id', 'text', 'NO'),
    ('checkpoint_writes', 'idx', 'integer', 'NO'),
    ('checkpoint_writes', 'channel', 'text', 'NO'),
    ('checkpoint_writes', 'type', 'text', 'YES'),
    ('checkpoint_writes', 'blob', 'bytea', 'NO')
),
actual_primary_keys AS (
  SELECT
    table_class.relname AS table_name,
    array_agg(attribute.attname ORDER BY key_column.ordinality)::text[] AS columns
  FROM pg_catalog.pg_constraint AS pk_constraint
  JOIN pg_catalog.pg_class AS table_class ON table_class.oid = pk_constraint.conrelid
  JOIN pg_catalog.pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
  JOIN LATERAL unnest(pk_constraint.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality)
    ON TRUE
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = table_class.oid AND attribute.attnum = key_column.attribute_number
  WHERE table_schema.nspname = '${CHECKPOINT_SCHEMA}' AND pk_constraint.contype = 'p'
  GROUP BY table_class.relname
),
required_primary_keys(table_name, columns) AS (
  VALUES
    ('checkpoints', ARRAY['thread_id', 'checkpoint_ns', 'checkpoint_id']::text[]),
    ('checkpoint_blobs', ARRAY['thread_id', 'checkpoint_ns', 'channel', 'version']::text[]),
    ('checkpoint_writes', ARRAY['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx']::text[])
),
invalid_columns AS (
  SELECT count(*)::bigint AS count
  FROM required_columns AS required
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = '${CHECKPOINT_SCHEMA}'
    AND actual.table_name = required.table_name
    AND actual.column_name = required.column_name
  WHERE actual.data_type IS DISTINCT FROM required.data_type
    OR actual.is_nullable IS DISTINCT FROM required.is_nullable
),
invalid_primary_keys AS (
  SELECT count(*)::bigint AS count
  FROM required_primary_keys AS required
  LEFT JOIN actual_primary_keys AS actual ON actual.table_name = required.table_name
  WHERE actual.columns IS DISTINCT FROM required.columns
)
SELECT
  (
    SELECT count(*)::bigint
    FROM (VALUES ('checkpoints'), ('checkpoint_blobs'), ('checkpoint_writes')) AS required(table_name)
    LEFT JOIN pg_catalog.pg_namespace AS table_schema
      ON table_schema.nspname = '${CHECKPOINT_SCHEMA}'
    LEFT JOIN pg_catalog.pg_class AS table_class
      ON table_class.relname = required.table_name
      AND table_class.relnamespace = table_schema.oid
      AND table_class.relkind = 'r'
    WHERE table_class.oid IS NULL
  ) AS missing_required_checkpoint_tables,
  (SELECT count FROM invalid_columns) + (SELECT count FROM invalid_primary_keys)
    AS invalid_required_schema_items`;

/**
 * Physical sizes deliberately remain separate from the logical retention
 * estimate.  These are catalog totals at snapshot time, not a promise of
 * reclaimable disk space: only a later explicit rewrite may reclaim it.
 */
export const CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL = `
SELECT coalesce(
  json_agg(
    json_build_object(
      'relation', table_class.relname,
      'table_bytes', pg_table_size(table_class.oid),
      'index_bytes', pg_indexes_size(table_class.oid),
      'toast_bytes', CASE
        WHEN table_class.reltoastrelid = 0 THEN 0
        ELSE pg_total_relation_size(table_class.reltoastrelid)
      END,
      'total_bytes', pg_total_relation_size(table_class.oid)
    )
    ORDER BY table_class.relname
  ),
  '[]'::json
) AS relations
FROM pg_catalog.pg_class AS table_class
JOIN pg_catalog.pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
WHERE table_schema.nspname = '${CHECKPOINT_SCHEMA}'
  AND table_class.relkind = 'r'
  AND table_class.relname IN ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes')`;

/**
 * The current/retained projection exactly mirrors Stack 208 retention:
 *
 * - one latest checkpoint per (thread_id, checkpoint_ns), by checkpoint_id DESC;
 * - writes for that checkpoint only;
 * - blobs whose (channel, version) appear in that checkpoint's
 *   channel_versions object.
 *
 * `safe_latest` prevents a malformed JSON value from reaching
 * jsonb_each_text. The associated status counts are parsed fail-closed, so a
 * caller can never use the partial aggregates it produces in that case.
 */
export const CHECKPOINT_RETENTION_PLAN_SQL = `
WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (checkpoint.thread_id, checkpoint.checkpoint_ns)
    checkpoint.thread_id,
    checkpoint.checkpoint_ns,
    checkpoint.checkpoint_id,
    checkpoint.parent_checkpoint_id,
    checkpoint.checkpoint
  FROM ${CHECKPOINT_SCHEMA}.checkpoints AS checkpoint
  ORDER BY checkpoint.thread_id, checkpoint.checkpoint_ns, checkpoint.checkpoint_id DESC
),
safe_latest AS MATERIALIZED (
  SELECT *
  FROM latest
  WHERE jsonb_typeof(checkpoint) = 'object'
    AND jsonb_typeof(checkpoint -> 'v') = 'number'
    AND checkpoint ->> 'v' ~ '^[1-4]$'
    AND jsonb_typeof(checkpoint -> 'channel_versions') = 'object'
),
current_checkpoints AS (
  SELECT count(*)::bigint AS rows, coalesce(sum(pg_column_size(checkpoint_row)), 0)::bigint AS logical_bytes
  FROM ${CHECKPOINT_SCHEMA}.checkpoints AS checkpoint_row
),
current_writes AS (
  SELECT count(*)::bigint AS rows, coalesce(sum(pg_column_size(write_row)), 0)::bigint AS logical_bytes
  FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes AS write_row
),
current_blobs AS (
  SELECT
    count(*)::bigint AS rows,
    coalesce(sum(pg_column_size(blob_row)), 0)::bigint AS logical_bytes,
    coalesce(sum(octet_length(blob_row.blob)), 0)::bigint AS payload_bytes
  FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs AS blob_row
),
retained_checkpoints AS (
  SELECT
    count(*)::bigint AS rows,
    coalesce(sum(pg_column_size(full_checkpoint)), 0)::bigint AS logical_bytes
  FROM ${CHECKPOINT_SCHEMA}.checkpoints AS full_checkpoint
  JOIN latest AS checkpoint
    ON checkpoint.thread_id = full_checkpoint.thread_id
    AND checkpoint.checkpoint_ns = full_checkpoint.checkpoint_ns
    AND checkpoint.checkpoint_id = full_checkpoint.checkpoint_id
),
retained_writes AS (
  SELECT count(*)::bigint AS rows, coalesce(sum(pg_column_size(write_row)), 0)::bigint AS logical_bytes
  FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes AS write_row
  JOIN latest AS checkpoint
    ON checkpoint.thread_id = write_row.thread_id
    AND checkpoint.checkpoint_ns = write_row.checkpoint_ns
    AND checkpoint.checkpoint_id = write_row.checkpoint_id
),
retained_blobs AS (
  SELECT
    count(*)::bigint AS rows,
    coalesce(sum(pg_column_size(blob_row)), 0)::bigint AS logical_bytes,
    coalesce(sum(octet_length(blob_row.blob)), 0)::bigint AS payload_bytes
  FROM safe_latest AS checkpoint
  CROSS JOIN LATERAL jsonb_each_text(checkpoint.checkpoint -> 'channel_versions') AS version(channel, version)
  JOIN ${CHECKPOINT_SCHEMA}.checkpoint_blobs AS blob_row
    ON blob_row.thread_id = checkpoint.thread_id
    AND blob_row.checkpoint_ns = checkpoint.checkpoint_ns
    AND blob_row.channel = version.channel
    AND blob_row.version = version.version
),
invalid_retained_formats AS (
  SELECT count(*)::bigint AS rows
  FROM latest AS checkpoint
  WHERE jsonb_typeof(checkpoint.checkpoint) IS DISTINCT FROM 'object'
    OR jsonb_typeof(checkpoint.checkpoint -> 'v') IS DISTINCT FROM 'number'
    OR checkpoint.checkpoint ->> 'v' !~ '^[1-4]$'
    OR jsonb_typeof(checkpoint.checkpoint -> 'channel_versions') IS DISTINCT FROM 'object'
),
unsupported_retained_legacy_parents AS (
  SELECT count(*)::bigint AS rows
  FROM safe_latest AS checkpoint
  WHERE (checkpoint.checkpoint ->> 'v')::integer < 4
    AND checkpoint.parent_checkpoint_id IS NOT NULL
)
SELECT
  current_checkpoints.rows AS current_checkpoint_rows,
  current_checkpoints.logical_bytes AS current_checkpoint_logical_bytes,
  current_writes.rows AS current_write_rows,
  current_writes.logical_bytes AS current_write_logical_bytes,
  current_blobs.rows AS current_blob_rows,
  current_blobs.logical_bytes AS current_blob_logical_bytes,
  current_blobs.payload_bytes AS current_blob_payload_bytes,
  retained_checkpoints.rows AS retained_checkpoint_rows,
  retained_checkpoints.logical_bytes AS retained_checkpoint_logical_bytes,
  retained_writes.rows AS retained_write_rows,
  retained_writes.logical_bytes AS retained_write_logical_bytes,
  retained_blobs.rows AS retained_blob_rows,
  retained_blobs.logical_bytes AS retained_blob_logical_bytes,
  retained_blobs.payload_bytes AS retained_blob_payload_bytes,
  invalid_retained_formats.rows AS invalid_retained_checkpoint_formats,
  unsupported_retained_legacy_parents.rows AS unsupported_retained_legacy_parent_formats
FROM current_checkpoints
CROSS JOIN current_writes
CROSS JOIN current_blobs
CROSS JOIN retained_checkpoints
CROSS JOIN retained_writes
CROSS JOIN retained_blobs
CROSS JOIN invalid_retained_formats
CROSS JOIN unsupported_retained_legacy_parents`;

export interface CheckpointRetentionSnapshotStatement {
  readonly name:
    | "begin"
    | "lock-timeout"
    | "statement-timeout"
    | "schema-probe"
    | "plan"
    | "rollback";
  readonly sql: string;
}

/** Build static SQL only; it has no values to interpolate or log. */
export function buildCheckpointRetentionSnapshotStatements(): readonly CheckpointRetentionSnapshotStatement[] {
  return [
    { name: "begin", sql: CHECKPOINT_RETENTION_SNAPSHOT_BEGIN_SQL },
    { name: "lock-timeout", sql: CHECKPOINT_RETENTION_SNAPSHOT_LOCK_TIMEOUT_SQL },
    { name: "statement-timeout", sql: CHECKPOINT_RETENTION_SNAPSHOT_STATEMENT_TIMEOUT_SQL },
    { name: "schema-probe", sql: CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL },
    { name: "plan", sql: CHECKPOINT_RETENTION_PLAN_SQL },
    { name: "rollback", sql: CHECKPOINT_RETENTION_SNAPSHOT_ROLLBACK_SQL },
  ];
}

export interface CheckpointRetentionTableAggregate {
  readonly rows: number;
  readonly logicalBytes: number;
  readonly blobPayloadBytes: number;
}

export interface CheckpointRetentionAggregate {
  readonly checkpoints: CheckpointRetentionTableAggregate;
  readonly writes: CheckpointRetentionTableAggregate;
  readonly blobs: CheckpointRetentionTableAggregate;
  readonly totalRows: number;
  readonly totalLogicalBytes: number;
  readonly blobPayloadBytes: number;
}

export interface CheckpointRetentionPlan {
  readonly current: CheckpointRetentionAggregate;
  readonly retained: CheckpointRetentionAggregate;
  readonly reclaimable: CheckpointRetentionAggregate;
  /** Deletes create free space; a table rewrite is needed before it is physical reclaim. */
  readonly physicalReclamation: {
    readonly status: "estimate-only-until-explicit-table-rewrite";
    /** Physical relation bytes are intentionally unmeasured in this logical plan. */
    readonly relationBytes: null;
    /** Logical rows freed; this is not a measured physical-size reduction. */
    readonly estimatedReclaimableBytes: number;
  };
}

export type CheckpointRetentionPlanFailureCode =
  | "absent-required-checkpoint-schema"
  | "invalid-required-checkpoint-schema"
  | "invalid-retained-checkpoint-format"
  | "unsupported-retained-legacy-parent-format"
  | "invalid-aggregate-projection";

export interface CheckpointRetentionPlanFailure {
  readonly ok: false;
  readonly code: CheckpointRetentionPlanFailureCode;
}

export interface CheckpointRetentionPlanSuccess {
  readonly ok: true;
  readonly plan: CheckpointRetentionPlan;
}

export type CheckpointRetentionPlanOutcome =
  | CheckpointRetentionPlanFailure
  | CheckpointRetentionPlanSuccess;

export type CheckpointRetentionSchemaProbeOutcome =
  | CheckpointRetentionPlanFailure
  | { readonly ok: true };

/** Aggregate-only row shape returned by CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL. */
export interface CheckpointRetentionSchemaProbeRow {
  readonly missing_required_checkpoint_tables?: unknown;
  readonly invalid_required_schema_items: unknown;
}

export interface CheckpointRetentionPhysicalRelation {
  readonly relation: "checkpoints" | "checkpoint_blobs" | "checkpoint_writes";
  /** pg_table_size: heap plus toast/FSM/VM; toastBytes is a subset, not an addend. */
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly toastBytes: number;
  readonly totalBytes: number;
}

export interface CheckpointRetentionPhysicalSizes {
  readonly relations: readonly CheckpointRetentionPhysicalRelation[];
  /** Sum of tableBytes, each of which already includes its TOAST relation. */
  readonly totalTableBytes: number;
  readonly totalIndexBytes: number;
  readonly totalToastBytes: number;
  /** Sum of pg_total_relation_size per table; do not add the other totals to this. */
  readonly totalBytes: number;
}

/** Aggregate-only row shape returned by CHECKPOINT_RETENTION_PLAN_SQL. */
export interface CheckpointRetentionPlanRow {
  readonly current_checkpoint_rows: unknown;
  readonly current_checkpoint_logical_bytes: unknown;
  readonly current_write_rows: unknown;
  readonly current_write_logical_bytes: unknown;
  readonly current_blob_rows: unknown;
  readonly current_blob_logical_bytes: unknown;
  readonly current_blob_payload_bytes: unknown;
  readonly retained_checkpoint_rows: unknown;
  readonly retained_checkpoint_logical_bytes: unknown;
  readonly retained_write_rows: unknown;
  readonly retained_write_logical_bytes: unknown;
  readonly retained_blob_rows: unknown;
  readonly retained_blob_logical_bytes: unknown;
  readonly retained_blob_payload_bytes: unknown;
  readonly invalid_retained_checkpoint_formats: unknown;
  readonly unsupported_retained_legacy_parent_formats: unknown;
}

function parseNonNegativeSafeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function field(
  row: CheckpointRetentionPlanRow,
  name: keyof CheckpointRetentionPlanRow,
): number | undefined {
  return parseNonNegativeSafeInteger(row[name]);
}

function aggregate(
  checkpoints: CheckpointRetentionTableAggregate,
  writes: CheckpointRetentionTableAggregate,
  blobs: CheckpointRetentionTableAggregate,
): CheckpointRetentionAggregate {
  return {
    checkpoints,
    writes,
    blobs,
    totalRows: checkpoints.rows + writes.rows + blobs.rows,
    totalLogicalBytes: checkpoints.logicalBytes + writes.logicalBytes + blobs.logicalBytes,
    blobPayloadBytes: blobs.blobPayloadBytes,
  };
}

function tableAggregate(
  rows: number | undefined,
  logicalBytes: number | undefined,
  blobPayloadBytes: number | undefined = 0,
): CheckpointRetentionTableAggregate | undefined {
  if (rows === undefined || logicalBytes === undefined || blobPayloadBytes === undefined) return undefined;
  return { rows, logicalBytes, blobPayloadBytes };
}

function aggregatesFromPlanRow(
  row: CheckpointRetentionPlanRow,
  prefix: "current" | "retained",
): CheckpointRetentionAggregate | undefined {
  const checkpoints = tableAggregate(
    field(row, `${prefix}_checkpoint_rows`),
    field(row, `${prefix}_checkpoint_logical_bytes`),
  );
  const writes = tableAggregate(
    field(row, `${prefix}_write_rows`),
    field(row, `${prefix}_write_logical_bytes`),
  );
  const blobs = tableAggregate(
    field(row, `${prefix}_blob_rows`),
    field(row, `${prefix}_blob_logical_bytes`),
    field(row, `${prefix}_blob_payload_bytes`),
  );
  return checkpoints === undefined || writes === undefined || blobs === undefined
    ? undefined
    : aggregate(checkpoints, writes, blobs);
}

function reclaimable(
  current: CheckpointRetentionAggregate,
  retained: CheckpointRetentionAggregate,
): CheckpointRetentionAggregate | undefined {
  const subtract = (
    currentTable: CheckpointRetentionTableAggregate,
    retainedTable: CheckpointRetentionTableAggregate,
  ): CheckpointRetentionTableAggregate | undefined => {
    if (
      retainedTable.rows > currentTable.rows ||
      retainedTable.logicalBytes > currentTable.logicalBytes ||
      retainedTable.blobPayloadBytes > currentTable.blobPayloadBytes
    ) {
      return undefined;
    }
    return {
      rows: currentTable.rows - retainedTable.rows,
      logicalBytes: currentTable.logicalBytes - retainedTable.logicalBytes,
      blobPayloadBytes: currentTable.blobPayloadBytes - retainedTable.blobPayloadBytes,
    };
  };

  const checkpoints = subtract(current.checkpoints, retained.checkpoints);
  const writes = subtract(current.writes, retained.writes);
  const blobs = subtract(current.blobs, retained.blobs);
  return checkpoints === undefined || writes === undefined || blobs === undefined
    ? undefined
    : aggregate(checkpoints, writes, blobs);
}

/** Fail closed before the plan query when required saver tables/keys do not match. */
export function parseCheckpointRetentionSchemaProbe(
  row: CheckpointRetentionSchemaProbeRow,
): CheckpointRetentionSchemaProbeOutcome {
  const missingTables = row.missing_required_checkpoint_tables === undefined
    ? 0
    : parseNonNegativeSafeInteger(row.missing_required_checkpoint_tables);
  if (missingTables === undefined || missingTables > 0) {
    return { ok: false, code: "absent-required-checkpoint-schema" };
  }
  const invalidItems = parseNonNegativeSafeInteger(row.invalid_required_schema_items);
  if (invalidItems === undefined || invalidItems > 0) {
    return { ok: false, code: "invalid-required-checkpoint-schema" };
  }
  return { ok: true };
}

/** Parse the catalog-only physical projection without admitting arbitrary relation names. */
export function parseCheckpointRetentionPhysicalSizes(value: unknown): CheckpointRetentionPhysicalSizes | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const expected = ["checkpoint_blobs", "checkpoint_writes", "checkpoints"] as const;
  const relations: CheckpointRetentionPhysicalRelation[] = [];
  for (const [index, row] of value.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
    const record = row as Record<string, unknown>;
    const relation = record["relation"];
    if (relation !== expected[index]) return undefined;
    const tableBytes = parseNonNegativeSafeInteger(record["table_bytes"]);
    const indexBytes = parseNonNegativeSafeInteger(record["index_bytes"]);
    const toastBytes = parseNonNegativeSafeInteger(record["toast_bytes"]);
    const totalBytes = parseNonNegativeSafeInteger(record["total_bytes"]);
    if (tableBytes === undefined || indexBytes === undefined || toastBytes === undefined || totalBytes === undefined) {
      return undefined;
    }
    // These values intentionally overlap: pg_table_size includes TOAST and
    // pg_total_relation_size includes both table and index bytes. They must
    // therefore not be added, but neither subset may exceed its parent.
    if (toastBytes > tableBytes || tableBytes > totalBytes || indexBytes > totalBytes) return undefined;
    relations.push({ relation: expected[index]!, tableBytes, indexBytes, toastBytes, totalBytes });
  }
  return {
    relations,
    totalTableBytes: relations.reduce((sum, row) => sum + row.tableBytes, 0),
    totalIndexBytes: relations.reduce((sum, row) => sum + row.indexBytes, 0),
    totalToastBytes: relations.reduce((sum, row) => sum + row.toastBytes, 0),
    totalBytes: relations.reduce((sum, row) => sum + row.totalBytes, 0),
  };
}

/**
 * Convert the SQL's scalar aggregate projection into a bounded public DTO.
 * This deliberately rejects malformed projection values and any legacy parent
 * reader requirement rather than expose a deletion estimate that could be
 * acted on later.
 */
export function parseCheckpointRetentionPlan(
  row: CheckpointRetentionPlanRow,
): CheckpointRetentionPlanOutcome {
  const invalidFormats = field(row, "invalid_retained_checkpoint_formats");
  const unsupportedLegacyParents = field(row, "unsupported_retained_legacy_parent_formats");
  if (invalidFormats === undefined || unsupportedLegacyParents === undefined) {
    return { ok: false, code: "invalid-aggregate-projection" };
  }
  if (invalidFormats > 0) return { ok: false, code: "invalid-retained-checkpoint-format" };
  if (unsupportedLegacyParents > 0) {
    return { ok: false, code: "unsupported-retained-legacy-parent-format" };
  }

  const current = aggregatesFromPlanRow(row, "current");
  const retained = aggregatesFromPlanRow(row, "retained");
  if (current === undefined || retained === undefined) {
    return { ok: false, code: "invalid-aggregate-projection" };
  }
  const reclaimed = reclaimable(current, retained);
  if (reclaimed === undefined) return { ok: false, code: "invalid-aggregate-projection" };

  return {
    ok: true,
    plan: {
      current,
      retained,
      reclaimable: reclaimed,
      physicalReclamation: {
        status: "estimate-only-until-explicit-table-rewrite",
        relationBytes: null,
        estimatedReclaimableBytes: reclaimed.totalLogicalBytes,
      },
    },
  };
}
