import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, expect, test } from "bun:test";
import { resolveDirectAgentDatabaseConnectionString } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import pg from "pg";

import {
  encryptedCheckpointShadowNamespaceId,
  encryptedCheckpointShadowThreadId,
  readEncryptedCheckpointPhysicalManifest,
} from "../../src";

const PRIVATE_CHECKPOINT = "manifest-private-checkpoint-payload";
const PRIVATE_BLOB = "manifest-private-blob-payload";
const PRIVATE_WRITE = "manifest-private-write-payload";

function errorFrom(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

async function cleanup(
  pool: pg.Pool,
  ownedThreadIds: readonly string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of [
      "checkpoint_writes",
      "checkpoint_blobs",
      "checkpoints",
    ] as const) {
      await client.query(
        `DELETE FROM langchain.${table} WHERE thread_id = ANY($1::text[])`,
        [ownedThreadIds],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("encrypted checkpoint manifest with the actual agent role", () => {
  test("hashes only one exact shadow coordinate and observes opaque byte changes", async () => {
    bootstrapTestDbInstance();
    const fixtureId = randomUUID();
    const logicalThreadId = `subagent:task:manifest:${fixtureId}`;
    const otherLogicalThreadId = `subagent:task:manifest-other:${fixtureId}`;
    const shadowThreadId = encryptedCheckpointShadowThreadId(logicalThreadId);
    const otherShadowThreadId = encryptedCheckpointShadowThreadId(
      otherLogicalThreadId,
    );
    const shadowNamespace = encryptedCheckpointShadowNamespaceId("");
    const otherShadowNamespace = encryptedCheckpointShadowNamespaceId("other");
    const ownedThreadIds = [
      logicalThreadId,
      shadowThreadId,
      otherShadowThreadId,
    ];
    const pool = new pg.Pool({
      connectionString: resolveDirectAgentDatabaseConnectionString(),
      max: 2,
    });

    let outcome:
      | Readonly<{ status: "fulfilled" }>
      | Readonly<{ status: "rejected"; error: unknown }>;
    try {
      const identity = await pool.query<{ current_user: string }>(
        "SELECT current_user",
      );
      expect(identity.rows).toEqual([{ current_user: "nautilo_agent" }]);

      const seedClient = await pool.connect();
      try {
        await seedClient.query("BEGIN");
        for (const [threadId, checkpointNs, checkpointId] of [
          [shadowThreadId, shadowNamespace, `checkpoint-${fixtureId}`],
          [logicalThreadId, "", `ordinary-${fixtureId}`],
          [otherShadowThreadId, shadowNamespace, `other-${fixtureId}`],
          [shadowThreadId, otherShadowNamespace, `other-ns-${fixtureId}`],
        ] as const) {
          await seedClient.query(
            `INSERT INTO langchain.checkpoints (
              thread_id, checkpoint_ns, checkpoint_id,
              parent_checkpoint_id, type, checkpoint, metadata
            ) VALUES ($1, $2, $3, NULL, NULL, $4::jsonb, $5::jsonb)`,
            [
              threadId,
              checkpointNs,
              checkpointId,
              JSON.stringify({
                v: 4,
                id: checkpointId,
                channel_versions: { messages: "1", empty: "1" },
              }),
              JSON.stringify({
                $nautiloCheckpointCell: 1,
                ciphertext: Buffer.from(PRIVATE_CHECKPOINT).toString("base64"),
              }),
            ],
          );
          await seedClient.query(
            `INSERT INTO langchain.checkpoint_blobs (
              thread_id, checkpoint_ns, channel, version, type, blob
            ) VALUES
              ($1, $2, 'empty', '1', 'empty', NULL),
              ($1, $2, 'messages', '1', 'nautilo.inline.checkpoint-cell.v1', $3)`,
            [threadId, checkpointNs, Buffer.from(PRIVATE_BLOB)],
          );
          await seedClient.query(
            `INSERT INTO langchain.checkpoint_writes (
              thread_id, checkpoint_ns, checkpoint_id,
              task_id, idx, channel, type, blob
            ) VALUES (
              $1, $2, $3, $4, -1, '__error__',
              'nautilo.inline.checkpoint-cell.v1', $5
            )`,
            [
              threadId,
              checkpointNs,
              checkpointId,
              `task-${fixtureId}`,
              Buffer.from(PRIVATE_WRITE),
            ],
          );
        }
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        seedClient.release();
      }

      const initial = await readEncryptedCheckpointPhysicalManifest(pool, {
        logicalThreadId,
      });
      expect(initial.contract).toBe("encrypted_langgraph_v1");
      expect(initial.expectedCheckpointCount).toBe(1);
      expect(initial.expectedBlobCount).toBe(2);
      expect(initial.expectedPendingWriteCount).toBe(1);
      expect(initial.checkpointOrderedDigest).toHaveLength(32);
      expect(initial.blobOrderedDigest).toHaveLength(32);
      expect(initial.pendingWriteOrderedDigest).toHaveLength(32);
      const publicManifest = JSON.stringify(initial);
      expect(publicManifest).not.toContain(PRIVATE_CHECKPOINT);
      expect(publicManifest).not.toContain(PRIVATE_BLOB);
      expect(publicManifest).not.toContain(PRIVATE_WRITE);

      await pool.query(
        `UPDATE langchain.checkpoint_blobs
         SET blob = $3
         WHERE thread_id = $1 AND checkpoint_ns = $2
           AND channel = 'messages' AND version = '1'`,
        [shadowThreadId, shadowNamespace, Buffer.from(`${PRIVATE_BLOB}:changed`)],
      );
      const changed = await readEncryptedCheckpointPhysicalManifest(pool, {
        logicalThreadId,
      });
      expect(changed.expectedCheckpointCount).toBe(1);
      expect(changed.expectedBlobCount).toBe(2);
      expect(changed.expectedPendingWriteCount).toBe(1);
      expect(changed.checkpointOrderedDigest).toEqual(
        initial.checkpointOrderedDigest,
      );
      expect(changed.pendingWriteOrderedDigest).toEqual(
        initial.pendingWriteOrderedDigest,
      );
      expect(changed.blobOrderedDigest).not.toEqual(initial.blobOrderedDigest);

      await pool.query(
        `UPDATE langchain.checkpoint_blobs
         SET blob = $3
         WHERE thread_id = $1 AND checkpoint_ns = $2
           AND channel = 'messages' AND version = '1'`,
        [logicalThreadId, "", Buffer.from("ordinary-changed")],
      );
      const afterOrdinaryMutation =
        await readEncryptedCheckpointPhysicalManifest(pool, {
          logicalThreadId,
        });
      expect(afterOrdinaryMutation).toEqual(changed);
      outcome = { status: "fulfilled" };
    } catch (error) {
      outcome = { status: "rejected", error };
    }

    let cleanupError: unknown;
    try {
      await cleanup(pool, ownedThreadIds);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await pool.end();
    } catch (error) {
      cleanupError = cleanupError === undefined
        ? error
        : new AggregateError(
            [cleanupError, error],
            "Encrypted checkpoint manifest fixture cleanup failed",
          );
    }
    if (outcome.status === "rejected") {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [outcome.error, cleanupError],
          "Encrypted checkpoint manifest fixture and cleanup failed",
        );
      }
      throw errorFrom(
        outcome.error,
        "Encrypted checkpoint manifest fixture failed",
      );
    }
    if (cleanupError !== undefined) {
      throw errorFrom(
        cleanupError,
        "Encrypted checkpoint manifest fixture cleanup failed",
      );
    }
  });
});
