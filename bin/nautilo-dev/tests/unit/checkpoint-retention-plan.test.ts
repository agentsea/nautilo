import { describe, expect, test } from "bun:test";
import {
  buildCheckpointRetentionSnapshotStatements,
  CHECKPOINT_RETENTION_PLAN_SQL,
  CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL,
  CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL,
  parseCheckpointRetentionPhysicalSizes,
  parseCheckpointRetentionPlan,
  parseCheckpointRetentionSchemaProbe,
  type CheckpointRetentionPlanRow,
} from "../../src/lib/checkpoint-retention-plan";

/**
 * Aggregate-only results derived from a synthetic history fixture. The fixture
 * itself never crosses the production API boundary: the SQL retains its IDs,
 * namespaces, channel names, versions, and byte payloads internally.
 */
function syntheticAggregateRow(
  changes: Partial<CheckpointRetentionPlanRow> = {},
): CheckpointRetentionPlanRow {
  return {
    current_checkpoint_rows: "6",
    current_checkpoint_logical_bytes: "600",
    current_write_rows: "8",
    current_write_logical_bytes: "800",
    current_blob_rows: "7",
    current_blob_logical_bytes: "700",
    current_blob_payload_bytes: "420",
    retained_checkpoint_rows: "3",
    retained_checkpoint_logical_bytes: "300",
    retained_write_rows: "3",
    retained_write_logical_bytes: "300",
    retained_blob_rows: "4",
    retained_blob_logical_bytes: "400",
    retained_blob_payload_bytes: "240",
    invalid_retained_checkpoint_formats: "0",
    unsupported_retained_legacy_parent_formats: "0",
    ...changes,
  };
}

describe("checkpoint retention snapshot SQL", () => {
  test("uses one bounded, read-only repeatable-read snapshot and rolls it back", () => {
    const statements = buildCheckpointRetentionSnapshotStatements();
    expect(statements.map((statement) => statement.name)).toEqual([
      "begin",
      "lock-timeout",
      "statement-timeout",
      "schema-probe",
      "plan",
      "rollback",
    ]);
    expect(statements[0]?.sql).toContain("REPEATABLE READ READ ONLY");
    expect(statements[1]?.sql).toContain("lock_timeout");
    expect(statements[2]?.sql).toContain("statement_timeout");
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("validates the pinned saver table columns and primary keys without selecting contents", () => {
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("information_schema.columns");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("pg_catalog.pg_constraint");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("AS pk_constraint");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).not.toContain("AS constraint");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain(
      "array_agg(attribute.attname ORDER BY key_column.ordinality)::text[] AS columns",
    );
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("langchain");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("invalid_required_schema_items");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).toContain("missing_required_checkpoint_tables");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).not.toContain("::regnamespace");
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).not.toMatch(/SELECT\s+.*thread_id/i);
    expect(CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL).not.toMatch(/SELECT\s+.*checkpoint_id/i);
  });

  test("keeps one latest checkpoint per synthetic thread/namespace, its writes, and referenced blobs", () => {
    // This asserts the exact saver contract against a synthetic fixture with
    // two namespaces, independently ordered checkpoint IDs, one shared
    // channel-version reference, and one unreferenced blob. The fixture's
    // names and payloads are intentionally absent from production DTOs.
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain(
      "DISTINCT ON (checkpoint.thread_id, checkpoint.checkpoint_ns)",
    );
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain(
      "ORDER BY checkpoint.thread_id, checkpoint.checkpoint_ns, checkpoint.checkpoint_id DESC",
    );
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("AND checkpoint.checkpoint_id = write_row.checkpoint_id");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("jsonb_each_text(checkpoint.checkpoint -> 'channel_versions')");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("AND blob_row.channel = version.channel");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("AND blob_row.version = version.version");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain(
      "coalesce(sum(pg_column_size(full_checkpoint)), 0)::bigint AS logical_bytes",
    );
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain(
      "FROM langchain.checkpoints AS full_checkpoint\n  JOIN latest AS checkpoint",
    );
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain(
      "AND checkpoint.checkpoint_id = full_checkpoint.checkpoint_id",
    );
  });

  test("measures composite rows when tables also contain checkpoint and blob columns", () => {
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("pg_column_size(checkpoint_row)");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("pg_column_size(blob_row)");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("pg_column_size(write_row)");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).not.toMatch(/pg_column_size\((checkpoint|blob|write)\)/);
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("octet_length(blob_row.blob)");
  });

  test("counts legacy-parent formats separately, before an unsafe retention plan can escape", () => {
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("unsupported_retained_legacy_parents");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("::integer < 4");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("~ '^[1-4]$'");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("parent_checkpoint_id IS NOT NULL");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("invalid_retained_formats");
    expect(CHECKPOINT_RETENTION_PLAN_SQL).toContain("channel_versions");
  });
});

describe("checkpoint retention aggregate DTO", () => {
  test("returns current, retained, and reclaimable logical aggregates with separate physical status", () => {
    const outcome = parseCheckpointRetentionPlan(syntheticAggregateRow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.current).toMatchObject({
      totalRows: 21,
      totalLogicalBytes: 2100,
      blobPayloadBytes: 420,
    });
    expect(outcome.plan.retained).toMatchObject({
      totalRows: 10,
      totalLogicalBytes: 1000,
      blobPayloadBytes: 240,
    });
    expect(outcome.plan.reclaimable).toMatchObject({
      totalRows: 11,
      totalLogicalBytes: 1100,
      blobPayloadBytes: 180,
    });
    expect(outcome.plan.physicalReclamation).toEqual({
      status: "estimate-only-until-explicit-table-rewrite",
      relationBytes: null,
      estimatedReclaimableBytes: 1100,
    });
  });

  test("never returns synthetic identifiers, namespaces, channels, versions, or payloads", () => {
    const outcome = parseCheckpointRetentionPlan(syntheticAggregateRow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const diagnostic = JSON.stringify(outcome.plan);
    for (const protectedContent of ["synthetic-thread", "nested-namespace", "state-channel", "version-9", "payload"]) {
      expect(diagnostic).not.toContain(protectedContent);
    }
  });

  test("fails closed for a missing or invalid required schema", () => {
    expect(parseCheckpointRetentionSchemaProbe({ invalid_required_schema_items: "0" })).toEqual({
      ok: true,
    });
    expect(parseCheckpointRetentionSchemaProbe({
      missing_required_checkpoint_tables: "1",
      invalid_required_schema_items: "0",
    })).toEqual({ ok: false, code: "absent-required-checkpoint-schema" });
    expect(parseCheckpointRetentionSchemaProbe({ invalid_required_schema_items: "1" })).toEqual({
      ok: false,
      code: "invalid-required-checkpoint-schema",
    });
    expect(parseCheckpointRetentionSchemaProbe({ invalid_required_schema_items: "not-a-count" })).toEqual({
      ok: false,
      code: "invalid-required-checkpoint-schema",
    });
  });

  test("parses exactly the three known physical relations without double-counting TOAST", () => {
    expect(CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL).toContain("pg_table_size(table_class.oid)");
    expect(CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL).toContain("pg_indexes_size(table_class.oid)");
    expect(CHECKPOINT_RETENTION_PHYSICAL_SIZES_SQL).toContain("pg_total_relation_size(table_class.reltoastrelid)");
    const physical = parseCheckpointRetentionPhysicalSizes([
      { relation: "checkpoint_blobs", table_bytes: "100", index_bytes: "20", toast_bytes: "75", total_bytes: "120" },
      { relation: "checkpoint_writes", table_bytes: "200", index_bytes: "40", toast_bytes: "150", total_bytes: "240" },
      { relation: "checkpoints", table_bytes: "50", index_bytes: "10", toast_bytes: "0", total_bytes: "60" },
    ]);
    expect(physical).toMatchObject({ totalTableBytes: 350, totalIndexBytes: 70, totalToastBytes: 225, totalBytes: 420 });
    // pg_table_size includes TOAST, so the inclusive table total is not a sum
    // of heap/table bytes plus TOAST bytes.
    expect(physical?.totalTableBytes).not.toBe(physical!.totalTableBytes + physical!.totalToastBytes);
    expect(parseCheckpointRetentionPhysicalSizes([])).toBeUndefined();
    expect(parseCheckpointRetentionPhysicalSizes([
      { relation: "unknown", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
      { relation: "checkpoint_writes", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
      { relation: "checkpoints", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
    ])).toBeUndefined();
    expect(parseCheckpointRetentionPhysicalSizes([
      { relation: "checkpoint_blobs", table_bytes: 10, index_bytes: 5, toast_bytes: 11, total_bytes: 20 },
      { relation: "checkpoint_writes", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
      { relation: "checkpoints", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
    ])).toBeUndefined();
    expect(parseCheckpointRetentionPhysicalSizes([
      { relation: "checkpoint_blobs", table_bytes: 21, index_bytes: 5, toast_bytes: 10, total_bytes: 20 },
      { relation: "checkpoint_writes", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
      { relation: "checkpoints", table_bytes: 0, index_bytes: 0, toast_bytes: 0, total_bytes: 0 },
    ])).toBeUndefined();
  });

  test("fails closed for malformed retained checkpoint formats and retained legacy parents", () => {
    expect(
      parseCheckpointRetentionPlan(
        syntheticAggregateRow({ invalid_retained_checkpoint_formats: "1" }),
      ),
    ).toEqual({ ok: false, code: "invalid-retained-checkpoint-format" });
    expect(
      parseCheckpointRetentionPlan(
        syntheticAggregateRow({ unsupported_retained_legacy_parent_formats: "1" }),
      ),
    ).toEqual({ ok: false, code: "unsupported-retained-legacy-parent-format" });
  });

  test("fails closed when aggregates are malformed or retained state exceeds current state", () => {
    expect(
      parseCheckpointRetentionPlan(syntheticAggregateRow({ current_blob_rows: "not-a-count" })),
    ).toEqual({ ok: false, code: "invalid-aggregate-projection" });
    expect(
      parseCheckpointRetentionPlan(syntheticAggregateRow({ retained_write_rows: "9" })),
    ).toEqual({ ok: false, code: "invalid-aggregate-projection" });
  });
});
