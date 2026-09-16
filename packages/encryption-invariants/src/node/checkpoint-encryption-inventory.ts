import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CheckpointEncryptionClassification =
  | "protected_payload"
  | "bounded_routing_metadata"
  | "public_schema_metadata"
  | "forbidden_plaintext_filter";

export type CheckpointEncryptionCell = Readonly<{
  id: string;
  table: string;
  column: string;
  classification: CheckpointEncryptionClassification;
  rationale: string;
}>;

export const CHECKPOINT_ENCRYPTION_CELLS = Object.freeze([
  {
    id: "checkpoint.migrations.version",
    table: "langchain.checkpoint_migrations",
    column: "v",
    classification: "public_schema_metadata",
    rationale: "Pinned saver schema version only; never graph content.",
  },
  {
    id: "checkpoint.head.thread",
    table: "langchain.checkpoints",
    column: "thread_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque thread routing identity required to load and delete.",
  },
  {
    id: "checkpoint.head.namespace",
    table: "langchain.checkpoints",
    column: "checkpoint_ns",
    classification: "bounded_routing_metadata",
    rationale: "Opaque LangGraph checkpoint namespace routing identity.",
  },
  {
    id: "checkpoint.head.id",
    table: "langchain.checkpoints",
    column: "checkpoint_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque monotonic checkpoint identity.",
  },
  {
    id: "checkpoint.head.parent",
    table: "langchain.checkpoints",
    column: "parent_checkpoint_id",
    classification: "bounded_routing_metadata",
    rationale: "Fork/resume relationship without graph content.",
  },
  {
    id: "checkpoint.head.legacy_type",
    table: "langchain.checkpoints",
    column: "type",
    classification: "bounded_routing_metadata",
    rationale:
      "Unused nullable upstream legacy column. Protected persistence must "
      + "leave it NULL so it cannot become an unreviewed content channel.",
  },
  {
    id: "checkpoint.head.structure",
    table: "langchain.checkpoints",
    column: "checkpoint",
    classification: "bounded_routing_metadata",
    rationale:
      "Exact v4 allowlist: v, id, ts, channel_versions, versions_seen. "
      + "The protected wrapper rejects any other top-level field.",
  },
  {
    id: "checkpoint.head.metadata",
    table: "langchain.checkpoints",
    column: "metadata",
    classification: "protected_payload",
    rationale:
      "All metadata values require authenticated encryption. The Phase-0 "
      + "checkpoint placement decision determines the exact cell encoding.",
  },
  {
    id: "checkpoint.blob.thread",
    table: "langchain.checkpoint_blobs",
    column: "thread_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque thread routing identity.",
  },
  {
    id: "checkpoint.blob.namespace",
    table: "langchain.checkpoint_blobs",
    column: "checkpoint_ns",
    classification: "bounded_routing_metadata",
    rationale: "Opaque checkpoint namespace routing identity.",
  },
  {
    id: "checkpoint.blob.channel",
    table: "langchain.checkpoint_blobs",
    column: "channel",
    classification: "bounded_routing_metadata",
    rationale: "Closed graph-state channel name, never a dynamic value.",
  },
  {
    id: "checkpoint.blob.version",
    table: "langchain.checkpoint_blobs",
    column: "version",
    classification: "bounded_routing_metadata",
    rationale: "Opaque channel version coordinate.",
  },
  {
    id: "checkpoint.blob.type",
    table: "langchain.checkpoint_blobs",
    column: "type",
    classification: "bounded_routing_metadata",
    rationale: "Closed protected-cell type discriminator or empty marker.",
  },
  {
    id: "checkpoint.blob.payload",
    table: "langchain.checkpoint_blobs",
    column: "blob",
    classification: "protected_payload",
    rationale:
      "Channel plaintext requires authenticated encryption bound to its exact "
      + "thread/checkpoint/channel/version coordinate.",
  },
  {
    id: "checkpoint.write.thread",
    table: "langchain.checkpoint_writes",
    column: "thread_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque thread routing identity.",
  },
  {
    id: "checkpoint.write.namespace",
    table: "langchain.checkpoint_writes",
    column: "checkpoint_ns",
    classification: "bounded_routing_metadata",
    rationale: "Opaque checkpoint namespace routing identity.",
  },
  {
    id: "checkpoint.write.checkpoint",
    table: "langchain.checkpoint_writes",
    column: "checkpoint_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque parent checkpoint identity.",
  },
  {
    id: "checkpoint.write.task",
    table: "langchain.checkpoint_writes",
    column: "task_id",
    classification: "bounded_routing_metadata",
    rationale: "Opaque LangGraph task identity, not a Nautilo Task payload.",
  },
  {
    id: "checkpoint.write.index",
    table: "langchain.checkpoint_writes",
    column: "idx",
    classification: "bounded_routing_metadata",
    rationale: "Write ordering and idempotency coordinate.",
  },
  {
    id: "checkpoint.write.channel",
    table: "langchain.checkpoint_writes",
    column: "channel",
    classification: "bounded_routing_metadata",
    rationale: "Closed pending-write channel name.",
  },
  {
    id: "checkpoint.write.type",
    table: "langchain.checkpoint_writes",
    column: "type",
    classification: "bounded_routing_metadata",
    rationale: "Closed protected-cell type discriminator.",
  },
  {
    id: "checkpoint.write.payload",
    table: "langchain.checkpoint_writes",
    column: "blob",
    classification: "protected_payload",
    rationale:
      "Pending-write plaintext requires authenticated encryption bound to its "
      + "exact thread/checkpoint/task/index/channel coordinate.",
  },
  {
    id: "checkpoint.list.metadata_filter",
    table: "langchain.checkpoints",
    column: "metadata @> filter",
    classification: "forbidden_plaintext_filter",
    rationale:
      "The pinned saver forwards filters as plaintext JSONB. Protected "
      + "checkpoint list rejects filters until a bounded encrypted design exists.",
  },
] satisfies readonly CheckpointEncryptionCell[]);

export type CheckpointExecutionOwnership =
  | "wave9_active"
  | "wave10_background"
  | "wave12_autonomous";

export type CheckpointExecutionPath = Readonly<{
  id: string;
  sourcePath: string;
  anchor: string;
  ownership: CheckpointExecutionOwnership;
}>;

export const CHECKPOINT_EXECUTION_PATHS = Object.freeze([
  {
    id: "foreground.main",
    sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
    anchor: "export async function* langgraphExecutor",
    ownership: "wave9_active",
  },
  {
    id: "foreground.fork",
    sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts",
    anchor: "export async function* forkLanggraphExecutor",
    ownership: "wave9_active",
  },
  {
    id: "resume.approval",
    sourcePath: "packages/agent/src/graph/resume-approval.ts",
    anchor: "export async function resumeGraphWithApproval",
    ownership: "wave9_active",
  },
  {
    id: "resume.approval_ask",
    sourcePath: "packages/agent/src/graph/resume-approval-ask.ts",
    anchor: "export async function resumeGraphWithAskReply",
    ownership: "wave9_active",
  },
  {
    id: "resume.identity",
    sourcePath: "packages/agent/src/graph/resume-identity.ts",
    anchor: "export async function resumeGraphWithIdentity",
    ownership: "wave9_active",
  },
  {
    id: "resume.await_reply",
    sourcePath: "packages/agent/src/graph/resume-human-reply.ts",
    anchor: "export async function resumeGraphWithHumanReply",
    ownership: "wave12_autonomous",
  },
  {
    id: "subagent.scope",
    sourcePath: "packages/agent/src/subagents/scope-subagent/run.ts",
    anchor: "export function runScopeSubagentUntilPause",
    ownership: "wave9_active",
  },
  {
    id: "compaction.active",
    sourcePath: "packages/agent/src/checkpoints/checkpoint-compaction.ts",
    anchor: "export async function runCompaction",
    ownership: "wave9_active",
  },
  {
    id: "stenographer.extraction",
    sourcePath: "packages/reflection/src/stenographer/processor.ts",
    anchor: "export async function runStenographerExtraction",
    ownership: "wave10_background",
  },
  {
    id: "stenographer.compaction",
    sourcePath: "packages/reflection/src/stenographer/processor.ts",
    anchor: "export async function runStenographerCompaction",
    ownership: "wave10_background",
  },
  {
    id: "memory.review",
    sourcePath: "packages/agent/src/memory/background-reviewer.ts",
    anchor: "export async function prepareMemoryReview",
    ownership: "wave10_background",
  },
  {
    id: "memory.exit_flush",
    sourcePath: "packages/agent/src/memory/exit-flush.ts",
    anchor: "export async function runExitFlush",
    ownership: "wave10_background",
  },
  {
    id: "task.dispatch",
    sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts",
    anchor: "export async function dispatchTaskRun",
    ownership: "wave12_autonomous",
  },
  {
    id: "task.execute",
    sourcePath: "packages/runtime/src/tasks/task-run-executor.ts",
    anchor: "export const taskRunExecutor",
    ownership: "wave12_autonomous",
  },
  {
    id: "task.approval_resume",
    sourcePath: "packages/runtime/src/tasks/resume-task-approval.ts",
    anchor: "export async function runTaskApprovalResume",
    ownership: "wave12_autonomous",
  },
] satisfies readonly CheckpointExecutionPath[]);

export function validateCheckpointEncryptionInventory(
  repositoryRoot: string,
  paths: readonly CheckpointExecutionPath[] = CHECKPOINT_EXECUTION_PATHS,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();
  const anchors = new Set<string>();

  for (const path of paths) {
    if (ids.has(path.id)) {
      violations.push(`duplicate checkpoint execution id: ${path.id}`);
    }
    ids.add(path.id);

    const sourceAnchor = `${path.sourcePath}#${path.anchor}`;
    if (anchors.has(sourceAnchor)) {
      violations.push(`duplicate checkpoint execution anchor: ${sourceAnchor}`);
    }
    anchors.add(sourceAnchor);

    const absolutePath = resolve(repositoryRoot, path.sourcePath);
    if (!existsSync(absolutePath)) {
      violations.push(`missing checkpoint execution source: ${path.sourcePath}`);
      continue;
    }
    if (!readFileSync(absolutePath, "utf8").includes(path.anchor)) {
      violations.push(`missing checkpoint execution anchor: ${sourceAnchor}`);
    }
  }

  return violations.sort();
}
