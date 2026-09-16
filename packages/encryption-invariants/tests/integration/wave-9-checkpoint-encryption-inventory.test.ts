import { resolve } from "node:path";

import {
  CHECKPOINT_ENCRYPTION_CELLS,
  CHECKPOINT_EXECUTION_PATHS,
  validateCheckpointEncryptionInventory,
} from "../../src/node/checkpoint-encryption-inventory";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 9 checkpoint encryption inventory", () => {
  it("classifies every persisted column in the pinned four-table saver schema", () => {
    expect(
      CHECKPOINT_ENCRYPTION_CELLS.map((entry) =>
        `${entry.table}.${entry.column}`
      ),
    ).toEqual([
      "langchain.checkpoint_migrations.v",
      "langchain.checkpoints.thread_id",
      "langchain.checkpoints.checkpoint_ns",
      "langchain.checkpoints.checkpoint_id",
      "langchain.checkpoints.parent_checkpoint_id",
      "langchain.checkpoints.type",
      "langchain.checkpoints.checkpoint",
      "langchain.checkpoints.metadata",
      "langchain.checkpoint_blobs.thread_id",
      "langchain.checkpoint_blobs.checkpoint_ns",
      "langchain.checkpoint_blobs.channel",
      "langchain.checkpoint_blobs.version",
      "langchain.checkpoint_blobs.type",
      "langchain.checkpoint_blobs.blob",
      "langchain.checkpoint_writes.thread_id",
      "langchain.checkpoint_writes.checkpoint_ns",
      "langchain.checkpoint_writes.checkpoint_id",
      "langchain.checkpoint_writes.task_id",
      "langchain.checkpoint_writes.idx",
      "langchain.checkpoint_writes.channel",
      "langchain.checkpoint_writes.type",
      "langchain.checkpoint_writes.blob",
      "langchain.checkpoints.metadata @> filter",
    ]);
    expect(
      CHECKPOINT_ENCRYPTION_CELLS.filter(
        (entry) => entry.classification === "protected_payload",
      ).map((entry) => entry.id),
    ).toEqual([
      "checkpoint.head.metadata",
      "checkpoint.blob.payload",
      "checkpoint.write.payload",
    ]);
    expect(
      CHECKPOINT_ENCRYPTION_CELLS.filter(
        (entry) => entry.classification === "forbidden_plaintext_filter",
      ).map((entry) => entry.id),
    ).toEqual(["checkpoint.list.metadata_filter"]);
  });

  it("owns active paths in Wave 9 and leaves background/autonomous paths later", () => {
    expect(
      CHECKPOINT_EXECUTION_PATHS.filter(
        (entry) => entry.ownership === "wave9_active",
      ).map((entry) => entry.id),
    ).toEqual([
      "foreground.main",
      "foreground.fork",
      "resume.approval",
      "resume.approval_ask",
      "resume.identity",
      "subagent.scope",
      "compaction.active",
    ]);
    expect(
      CHECKPOINT_EXECUTION_PATHS.filter(
        (entry) => entry.ownership === "wave10_background",
      ).map((entry) => entry.id),
    ).toEqual([
      "stenographer.extraction",
      "stenographer.compaction",
      "memory.review",
      "memory.exit_flush",
    ]);
    expect(
      CHECKPOINT_EXECUTION_PATHS.filter(
        (entry) => entry.ownership === "wave12_autonomous",
      ).map((entry) => entry.id),
    ).toEqual([
      "resume.await_reply",
      "task.dispatch",
      "task.execute",
      "task.approval_resume",
    ]);
  });

  it("keeps every execution entrypoint anchored to current source", () => {
    expect(validateCheckpointEncryptionInventory(repositoryRoot)).toEqual([]);
  });

  it("fails closed when a registered source anchor drifts", () => {
    expect(validateCheckpointEncryptionInventory(repositoryRoot, [{
      id: "foreground.main",
      sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
      anchor: "missing M237 checkpoint anchor",
      ownership: "wave9_active",
    }])).toEqual([
      "missing checkpoint execution anchor: packages/runtime/src/executors/langgraph-executor.ts#missing M237 checkpoint anchor",
    ]);
  });
});
