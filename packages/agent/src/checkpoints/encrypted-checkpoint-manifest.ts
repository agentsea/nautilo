import { createHash } from "node:crypto";

import type pg from "pg";

import {
  encryptedCheckpointShadowNamespaceId,
  encryptedCheckpointShadowThreadId,
} from "./encrypted-checkpoint-saver";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

type ManifestScalar = string | null;
type ManifestRow = readonly ManifestScalar[];
type ManifestResult = Readonly<{ rows: unknown[] }>;
type ManifestClient = Readonly<{
  query(text: string, params?: readonly unknown[]): Promise<ManifestResult>;
  release(error?: Error | boolean): void;
}>;

export type EncryptedCheckpointManifestPool = Pick<pg.Pool, "connect">;

export type EncryptedCheckpointPhysicalManifest = Readonly<{
  contract: "encrypted_langgraph_v1";
  expectedCheckpointCount: number;
  checkpointOrderedDigest: Uint8Array;
  expectedBlobCount: number;
  blobOrderedDigest: Uint8Array;
  expectedPendingWriteCount: number;
  pendingWriteOrderedDigest: Uint8Array;
}>;

const CHECKPOINTS_SQL = `SELECT
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  type,
  checkpoint::text AS checkpoint_json,
  metadata::text AS metadata_json
FROM langchain.checkpoints
WHERE thread_id = $1 AND checkpoint_ns = $2
ORDER BY checkpoint_id COLLATE "C" ASC`;

const BLOBS_SQL = `SELECT
  thread_id,
  checkpoint_ns,
  channel,
  version,
  type,
  CASE WHEN blob IS NULL THEN NULL ELSE encode(blob, 'hex') END AS blob_hex
FROM langchain.checkpoint_blobs
WHERE thread_id = $1 AND checkpoint_ns = $2
ORDER BY channel COLLATE "C" ASC, version COLLATE "C" ASC`;

const WRITES_SQL = `SELECT
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  task_id,
  idx::text AS idx,
  channel,
  type,
  encode(blob, 'hex') AS blob_hex
FROM langchain.checkpoint_writes
WHERE thread_id = $1 AND checkpoint_ns = $2
ORDER BY checkpoint_id COLLATE "C" ASC, task_id COLLATE "C" ASC, idx ASC`;

function rowRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Encrypted checkpoint manifest row is malformed");
  }
  return value as Record<string, unknown>;
}

function scalar(
  row: Record<string, unknown>,
  key: string,
  nullable = false,
): ManifestScalar {
  const value = row[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError("Encrypted checkpoint manifest row is malformed");
  }
  return value;
}

function hexScalar(
  row: Record<string, unknown>,
  key: string,
  nullable = false,
): ManifestScalar {
  const value = scalar(row, key, nullable);
  if (value !== null && !/^(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new TypeError("Encrypted checkpoint manifest row is malformed");
  }
  return value;
}

function assertCoordinate(
  row: Record<string, unknown>,
  threadId: string,
  checkpointNs: string,
): void {
  if (row["thread_id"] !== threadId || row["checkpoint_ns"] !== checkpointNs) {
    throw new TypeError("Encrypted checkpoint manifest coordinate changed");
  }
}

function rows(
  input: unknown[],
  threadId: string,
  checkpointNs: string,
  fields: readonly Readonly<{
    key: string;
    nullable?: boolean;
    encoding?: "text" | "hex";
  }>[],
): readonly ManifestRow[] {
  if (input.length > POSTGRES_INTEGER_MAX) {
    throw new TypeError("Encrypted checkpoint manifest is too large");
  }
  return Object.freeze(input.map(value => {
    const row = rowRecord(value);
    assertCoordinate(row, threadId, checkpointNs);
    return Object.freeze(fields.map(field => field.encoding === "hex"
      ? hexScalar(row, field.key, field.nullable === true)
      : scalar(row, field.key, field.nullable === true)));
  }));
}

function orderedDigest(
  label: string,
  threadId: string,
  checkpointNs: string,
  manifestRows: readonly ManifestRow[],
): Uint8Array {
  const canonical = JSON.stringify(Object.freeze([
    label,
    threadId,
    checkpointNs,
    manifestRows,
  ]));
  return Uint8Array.from(
    createHash("sha256").update(canonical, "utf8").digest(),
  );
}

function assertUnique(
  manifestRows: readonly ManifestRow[],
  indexes: readonly number[],
): void {
  const seen = new Set<string>();
  for (const row of manifestRows) {
    const identity = JSON.stringify(indexes.map(index => row[index]));
    if (seen.has(identity)) {
      throw new TypeError("Encrypted checkpoint manifest contains a duplicate");
    }
    seen.add(identity);
  }
}

/**
 * Hash the exact encrypted LangGraph rows for one logical thread/namespace.
 * JSONB is read through PostgreSQL's canonical text representation and bytea
 * is lowercase hex; no checkpoint cell is decoded or opened. Each digest is
 * SHA-256 over the UTF-8 bytes of `JSON.stringify([domainV1,
 * physicalThreadId, physicalCheckpointNamespace, rows])`. Every row is an
 * array in the SELECT column order above containing only strings or null.
 * SQL primary-key order is part of the contract, including C collation for
 * text keys. Empty row arrays therefore have stable non-null digests.
 */
export async function readEncryptedCheckpointPhysicalManifest(
  pool: EncryptedCheckpointManifestPool,
  input: Readonly<{ logicalThreadId: string; checkpointNamespace?: string }>,
): Promise<EncryptedCheckpointPhysicalManifest> {
  if (typeof input.logicalThreadId !== "string"
    || input.logicalThreadId.length === 0
    || (input.checkpointNamespace !== undefined
      && typeof input.checkpointNamespace !== "string")) {
    throw new TypeError("Encrypted checkpoint manifest coordinate is malformed");
  }
  const threadId = encryptedCheckpointShadowThreadId(input.logicalThreadId);
  const checkpointNs = encryptedCheckpointShadowNamespaceId(
    input.checkpointNamespace ?? "",
  );
  const client = await pool.connect() as unknown as ManifestClient;
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const checkpointResult = await client.query(CHECKPOINTS_SQL, [
      threadId,
      checkpointNs,
    ]);
    const blobResult = await client.query(BLOBS_SQL, [threadId, checkpointNs]);
    const writeResult = await client.query(WRITES_SQL, [threadId, checkpointNs]);
    const checkpoints = rows(
      checkpointResult.rows,
      threadId,
      checkpointNs,
      [
        { key: "thread_id" },
        { key: "checkpoint_ns" },
        { key: "checkpoint_id" },
        { key: "parent_checkpoint_id", nullable: true },
        { key: "type", nullable: true },
        { key: "checkpoint_json" },
        { key: "metadata_json" },
      ],
    );
    const blobs = rows(blobResult.rows, threadId, checkpointNs, [
      { key: "thread_id" },
      { key: "checkpoint_ns" },
      { key: "channel" },
      { key: "version" },
      { key: "type" },
      { key: "blob_hex", nullable: true, encoding: "hex" },
    ]);
    const writes = rows(writeResult.rows, threadId, checkpointNs, [
      { key: "thread_id" },
      { key: "checkpoint_ns" },
      { key: "checkpoint_id" },
      { key: "task_id" },
      { key: "idx" },
      { key: "channel" },
      { key: "type", nullable: true },
      { key: "blob_hex", encoding: "hex" },
    ]);
    assertUnique(checkpoints, [0, 1, 2]);
    assertUnique(blobs, [0, 1, 2, 3]);
    assertUnique(writes, [0, 1, 2, 3, 4]);
    await client.query("COMMIT");
    committed = true;
    return Object.freeze({
      contract: "encrypted_langgraph_v1" as const,
      expectedCheckpointCount: checkpoints.length,
      checkpointOrderedDigest: orderedDigest(
        "nautilo.encrypted-langgraph.checkpoints.v1",
        threadId,
        checkpointNs,
        checkpoints,
      ),
      expectedBlobCount: blobs.length,
      blobOrderedDigest: orderedDigest(
        "nautilo.encrypted-langgraph.checkpoint-blobs.v1",
        threadId,
        checkpointNs,
        blobs,
      ),
      expectedPendingWriteCount: writes.length,
      pendingWriteOrderedDigest: orderedDigest(
        "nautilo.encrypted-langgraph.checkpoint-writes.v1",
        threadId,
        checkpointNs,
        writes,
      ),
    });
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
