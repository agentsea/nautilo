import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";
import {
  setupCheckpointSaver,
  type CheckpointCellCrypto,
} from "@nautilo/agent";
import { resolveDirectDatabaseConnectionString } from "@nautilo/db";
import pg from "pg";

import { createLiveShadowCheckpointSaver } from
  "../../src/conversation/live-shadow-checkpoint-saver";
import { setupTestDb } from "./helpers";

const MARKER = "M311_CHECKPOINT_PLAINTEXT_MUST_NOT_REACH_POSTGRES";
const THREAD_ID = "m311-live-shadow-checkpoint-integration";
const SHADOW_THREAD_ID =
  `nautilo:encrypted-checkpoint-shadow:v1:${Buffer.from(THREAD_ID).toString("base64url")}`;

let inspectionPool: pg.Pool;

function deterministicTestCrypto(): CheckpointCellCrypto {
  const crypto: CheckpointCellCrypto = {
    executeAuthorizedOperation: async ({ execute }) => {
      const controller = new AbortController();
      return execute(Object.freeze({
        signal: controller.signal,
        assertActive: () => controller.signal.throwIfAborted(),
        assertCommitAllowed: () => Promise.resolve(),
        remainingMs: () => 30_000,
      }));
    },
    seal: async ({ plaintext }) => {
      const ciphertext = new Uint8Array(plaintext.length + 1);
      ciphertext[0] = 0xa5;
      for (let index = 0; index < plaintext.length; index += 1) {
        ciphertext[index + 1] = plaintext[index]! ^ 0x5a;
      }
      return ciphertext;
    },
    open: async ({ ciphertext }) => {
      if (ciphertext[0] !== 0xa5) {
        throw new Error("test checkpoint ciphertext is malformed");
      }
      const plaintext = new Uint8Array(ciphertext.length - 1);
      for (let index = 1; index < ciphertext.length; index += 1) {
        plaintext[index - 1] = ciphertext[index]! ^ 0x5a;
      }
      return plaintext;
    },
  };
  return Object.freeze(crypto);
}

beforeAll(async () => {
  await setupTestDb();
  await setupCheckpointSaver();
  inspectionPool = new pg.Pool({
    connectionString: resolveDirectDatabaseConnectionString(),
    max: 1,
  });
});

afterAll(async () => {
  await inspectionPool.end();
});

describe("live Shadow encrypted checkpoint assembly", () => {
  test("round-trips through real PostgreSQL without storing plaintext cells", async () => {
    const saver = createLiveShadowCheckpointSaver({
      logicalThreadId: THREAD_ID,
      checkpoint: {
        crypto: deterministicTestCrypto(),
        namespaceId: "m311-checkpoint-namespace",
        namespaceAccessRevision: 1,
        agentAuthorizationRevision: 1,
        authorizationSession: Object.freeze({}),
      },
    });
    const config = { configurable: { thread_id: THREAD_ID } };
    const checkpoint: Checkpoint = {
      v: 4,
      id: "00000000-0000-4000-8000-000000000311",
      ts: new Date().toISOString(),
      channel_values: { messages: MARKER },
      channel_versions: { messages: "1" },
      versions_seen: {},
    };
    const metadata = {
      source: "input",
      step: -1,
      parents: {},
    } as CheckpointMetadata;

    try {
      await saver.deleteThread(THREAD_ID);
      await saver.put(config, checkpoint, metadata, { messages: "1" });

      const reopened = await saver.getTuple(config);
      expect(reopened?.checkpoint.channel_values["messages"]).toBe(MARKER);

      const physical = await inspectionPool.query<{
        checkpoint: string;
        metadata: string;
      }>(
        `SELECT checkpoint::text AS checkpoint, metadata::text AS metadata
         FROM langchain.checkpoints
         WHERE thread_id = $1`,
        [SHADOW_THREAD_ID],
      );
      const blobs = await inspectionPool.query<{ blob: string }>(
        `SELECT encode(blob, 'base64') AS blob
         FROM langchain.checkpoint_blobs
         WHERE thread_id = $1`,
        [SHADOW_THREAD_ID],
      );
      expect(physical.rows).toHaveLength(1);
      expect(blobs.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify({
        checkpoints: physical.rows,
        blobs: blobs.rows,
      })).not.toContain(MARKER);

      await saver.deleteThread(THREAD_ID);
      const afterDelete = await inspectionPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM langchain.checkpoints
         WHERE thread_id = $1`,
        [SHADOW_THREAD_ID],
      );
      expect(afterDelete.rows[0]?.count).toBe("0");
    } finally {
      await saver.end();
    }
  });
});
