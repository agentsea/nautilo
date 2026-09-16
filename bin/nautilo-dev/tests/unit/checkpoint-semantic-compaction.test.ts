import { describe, expect, test } from "bun:test";
import {
  CheckpointSemanticCompactionError,
  buildCheckpointSemanticCompactionScript,
  executeCheckpointSemanticCompaction,
  parseCheckpointSemanticCompactionOutput,
} from "../../src/lib/checkpoint-semantic-compaction";

const aggregateEvidence = JSON.stringify({
  groups: 2,
  before: {
    checkpointRows: 5, writeRows: 7, blobRows: 6,
    checkpointLogicalBytes: 500, writeLogicalBytes: 700, blobLogicalBytes: 600, blobPayloadBytes: 400,
  },
  after: {
    checkpointRows: 2, writeRows: 3, blobRows: 4,
    checkpointLogicalBytes: 200, writeLogicalBytes: 300, blobLogicalBytes: 400, blobPayloadBytes: 250,
  },
});

describe("checkpoint semantic compaction SQL", () => {
  test("is one deterministic bounded transaction with exact Stack 208 retention order", () => {
    const sql = buildCheckpointSemanticCompactionScript(17);
    expect(sql).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("IN SHARE ROW EXCLUSIVE MODE");
    expect(sql).toContain("DISTINCT ON (cp.thread_id, cp.checkpoint_ns)");
    expect(sql).toContain("ORDER BY cp.thread_id, cp.checkpoint_ns, cp.checkpoint_id DESC");
    expect(sql).toContain("LIMIT 17");
    expect(sql).toContain("jsonb_each_text(latest.checkpoint -> 'channel_versions')");
    expect(sql.indexOf("DELETE FROM langchain.checkpoint_writes")).toBeLessThan(sql.indexOf("DELETE FROM langchain.checkpoints"));
    expect(sql.indexOf("DELETE FROM langchain.checkpoints")).toBeLessThan(sql.indexOf("DELETE FROM langchain.checkpoint_blobs"));
    expect(sql.indexOf("DO $verify$")).toBeLessThan(sql.indexOf("COMMIT;"));
    expect(sql).not.toContain("RAISE NOTICE");
  });

  test("fails closed for malformed/current-unsupported legacy state and verifies reference closure and identity", () => {
    const sql = buildCheckpointSemanticCompactionScript();
    expect(sql).toContain("::integer < 4 AND parent_checkpoint_id IS NOT NULL");
    expect(sql).toContain("!~ '^[1-4]$'");
    expect(sql).toContain("checkpoint maintenance format validation failed");
    expect(sql).toContain("checkpoint maintenance reference validation failed");
    expect(sql).toContain("d489_source_identity");
    expect(sql).toContain("d489_expected EXCEPT SELECT * FROM d489_after");
    expect(sql).not.toMatch(/RAISE EXCEPTION[^;]*(thread|namespace|channel|checkpoint_id)/i);
  });

  test("rejects unbounded batch sizes", () => {
    expect(() => buildCheckpointSemanticCompactionScript(0)).toThrow();
    expect(() => buildCheckpointSemanticCompactionScript(10_001)).toThrow();
  });

  test("fails before DELETE when the protected inventory changed", () => {
    const sql = buildCheckpointSemanticCompactionScript(1000, {
      checkpointRows: 2, writeRows: 3, blobRows: 4, totalRows: 9,
      checkpointLogicalBytes: 20, writeLogicalBytes: 30, blobLogicalBytes: 40,
      totalLogicalBytes: 90, blobPayloadBytes: 25,
    });
    expect(sql).toContain("checkpoint maintenance inventory changed before mutation");
    expect(sql.indexOf("DO $expected_before$")).toBeLessThan(sql.indexOf("DO $delete$"));
  });
});

describe("checkpoint semantic aggregate evidence", () => {
  test("returns before, after, and deleted aggregates without identifiers or payloads", () => {
    expect(parseCheckpointSemanticCompactionOutput(aggregateEvidence)).toEqual({
      groups: 2,
      before: {
        checkpointRows: 5, writeRows: 7, blobRows: 6, totalRows: 18,
        checkpointLogicalBytes: 500, writeLogicalBytes: 700, blobLogicalBytes: 600, totalLogicalBytes: 1800,
        blobPayloadBytes: 400,
      },
      after: {
        checkpointRows: 2, writeRows: 3, blobRows: 4, totalRows: 9,
        checkpointLogicalBytes: 200, writeLogicalBytes: 300, blobLogicalBytes: 400, totalLogicalBytes: 900,
        blobPayloadBytes: 250,
      },
      deleted: {
        checkpointRows: 3, writeRows: 4, blobRows: 2, totalRows: 9,
        checkpointLogicalBytes: 300, writeLogicalBytes: 400, blobLogicalBytes: 200, totalLogicalBytes: 900,
        blobPayloadBytes: 150,
      },
    });
    expect(aggregateEvidence).not.toContain("thread_id");
    expect(aggregateEvidence).not.toContain("checkpoint_id");
  });

  test("rejects malformed, increasing, or group-mismatched evidence", () => {
    expect(parseCheckpointSemanticCompactionOutput("warning\n" + aggregateEvidence)).toBeUndefined();
    expect(parseCheckpointSemanticCompactionOutput(aggregateEvidence.replace('"groups":2', '"groups":3'))).toBeUndefined();
    expect(parseCheckpointSemanticCompactionOutput(aggregateEvidence.replace('"checkpointRows":2', '"checkpointRows":9'))).toBeUndefined();
  });

  test("never surfaces executor stderr", () => {
    expect(() => executeCheckpointSemanticCompaction({
      container: "disposable",
      executor: { execute: () => ({ ok: false, stderr: "postgres://secret checkpoint-id-secret" }) },
    })).toThrow(CheckpointSemanticCompactionError);
    try {
      executeCheckpointSemanticCompaction({ container: "disposable", executor: { execute: () => ({ ok: false, stderr: "secret" }) } });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
