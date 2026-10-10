import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  encryptedCheckpointShadowNamespaceId,
  encryptedCheckpointShadowThreadId,
  readEncryptedCheckpointPhysicalManifest,
} from "../../src";

const THREAD = "subagent:task:manifest";
const SHADOW_THREAD = encryptedCheckpointShadowThreadId(THREAD);
const SHADOW_NAMESPACE = encryptedCheckpointShadowNamespaceId("");

type Query = Readonly<{ text: string; params?: readonly unknown[] }>;

function digest(value: unknown): Uint8Array {
  return Uint8Array.from(
    createHash("sha256").update(JSON.stringify(value), "utf8").digest(),
  );
}

function pool(overrides: Readonly<{
  checkpoints?: unknown[];
  blobs?: unknown[];
  writes?: unknown[];
}> = {}) {
  const queries: Query[] = [];
  let releases = 0;
  const client = {
    async query(text: string, params?: readonly unknown[]) {
      queries.push({ text, ...(params === undefined ? {} : { params }) });
      if (text.includes("FROM langchain.checkpoints")) {
        return { rows: overrides.checkpoints ?? [] };
      }
      if (text.includes("FROM langchain.checkpoint_blobs")) {
        return { rows: overrides.blobs ?? [] };
      }
      if (text.includes("FROM langchain.checkpoint_writes")) {
        return { rows: overrides.writes ?? [] };
      }
      return { rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  return {
    value: { connect: async () => client } as never,
    queries,
    releases: () => releases,
  };
}

describe("encrypted checkpoint physical manifest", () => {
  test("hashes canonical physical rows and ciphertext without decoding", async () => {
    const scenario = pool({
      checkpoints: [{
        thread_id: SHADOW_THREAD,
        checkpoint_ns: SHADOW_NAMESPACE,
        checkpoint_id: "checkpoint-2",
        parent_checkpoint_id: null,
        type: null,
        checkpoint_json: '{"v": 4}',
        metadata_json: '{"$nautiloCheckpointCell": 1}',
      }],
      blobs: [{
        thread_id: SHADOW_THREAD,
        checkpoint_ns: SHADOW_NAMESPACE,
        channel: "messages",
        version: "2",
        type: "nautilo.inline.checkpoint-cell.v1",
        blob_hex: "00ff",
      }],
      writes: [{
        thread_id: SHADOW_THREAD,
        checkpoint_ns: SHADOW_NAMESPACE,
        checkpoint_id: "checkpoint-2",
        task_id: "task-1",
        idx: "-1",
        channel: "__error__",
        type: null,
        blob_hex: "a0",
      }],
    });

    const manifest = await readEncryptedCheckpointPhysicalManifest(
      scenario.value,
      { logicalThreadId: THREAD },
    );

    expect(manifest).toEqual({
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: digest([
        "nautilo.encrypted-langgraph.checkpoints.v1",
        SHADOW_THREAD,
        SHADOW_NAMESPACE,
        [[SHADOW_THREAD, SHADOW_NAMESPACE, "checkpoint-2", null, null,
          '{"v": 4}', '{"$nautiloCheckpointCell": 1}']],
      ]),
      expectedBlobCount: 1,
      blobOrderedDigest: digest([
        "nautilo.encrypted-langgraph.checkpoint-blobs.v1",
        SHADOW_THREAD,
        SHADOW_NAMESPACE,
        [[SHADOW_THREAD, SHADOW_NAMESPACE, "messages", "2",
          "nautilo.inline.checkpoint-cell.v1", "00ff"]],
      ]),
      expectedPendingWriteCount: 1,
      pendingWriteOrderedDigest: digest([
        "nautilo.encrypted-langgraph.checkpoint-writes.v1",
        SHADOW_THREAD,
        SHADOW_NAMESPACE,
        [[SHADOW_THREAD, SHADOW_NAMESPACE, "checkpoint-2", "task-1", "-1",
          "__error__", null, "a0"]],
      ]),
    });
    expect(scenario.queries.map(query => query.text)).toHaveLength(5);
    expect(scenario.queries[0]?.text).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(scenario.queries[1]?.text).toContain("FROM langchain.checkpoints");
    expect(scenario.queries[2]?.text).toContain(
      "FROM langchain.checkpoint_blobs",
    );
    expect(scenario.queries[3]?.text).toContain(
      "FROM langchain.checkpoint_writes",
    );
    expect(scenario.queries[4]?.text).toBe("COMMIT");
    for (const query of scenario.queries.slice(1, 4)) {
      expect(query.params).toEqual([SHADOW_THREAD, SHADOW_NAMESPACE]);
    }
    expect(scenario.queries[2]?.text).toContain("encode(blob, 'hex')");
    expect(scenario.queries[3]?.text).toContain("encode(blob, 'hex')");
    expect(scenario.releases()).toBe(1);
  });

  test("returns deterministic non-null digests for empty manifests", async () => {
    const first = await readEncryptedCheckpointPhysicalManifest(
      pool().value,
      { logicalThreadId: THREAD },
    );
    const second = await readEncryptedCheckpointPhysicalManifest(
      pool().value,
      { logicalThreadId: THREAD },
    );
    expect(first.expectedCheckpointCount).toBe(0);
    expect(first.expectedBlobCount).toBe(0);
    expect(first.expectedPendingWriteCount).toBe(0);
    expect(first.checkpointOrderedDigest).toEqual(second.checkpointOrderedDigest);
    expect(first.blobOrderedDigest).toEqual(second.blobOrderedDigest);
    expect(first.pendingWriteOrderedDigest).toEqual(
      second.pendingWriteOrderedDigest,
    );
    expect(first.checkpointOrderedDigest).toHaveLength(32);
  });

  test("rejects duplicate or substituted physical coordinates and rolls back", async () => {
    const duplicate = {
      thread_id: SHADOW_THREAD,
      checkpoint_ns: SHADOW_NAMESPACE,
      channel: "messages",
      version: "2",
      type: "cell",
      blob_hex: "00",
    };
    const duplicateScenario = pool({ blobs: [duplicate, duplicate] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(readEncryptedCheckpointPhysicalManifest(
      duplicateScenario.value,
      { logicalThreadId: THREAD },
    )).rejects.toThrow("contains a duplicate");
    expect(duplicateScenario.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(duplicateScenario.releases()).toBe(1);

    const substituted = pool({ checkpoints: [{
      thread_id: "wrong",
      checkpoint_ns: SHADOW_NAMESPACE,
      checkpoint_id: "checkpoint-2",
      parent_checkpoint_id: null,
      type: null,
      checkpoint_json: "{}",
      metadata_json: "{}",
    }] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(readEncryptedCheckpointPhysicalManifest(
      substituted.value,
      { logicalThreadId: THREAD },
    )).rejects.toThrow("coordinate changed");
    expect(substituted.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(substituted.releases()).toBe(1);
  });
});
