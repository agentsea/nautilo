import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BackgroundEncryptionOwnership =
  | "wave10_vertical"
  | "wave10_dark_adapter";

export type BackgroundEncryptionDuty =
  | "background_start"
  | "metadata_discovery"
  | "plaintext_read"
  | "plaintext_write"
  | "model_invoke"
  | "protected_read"
  | "protected_write"
  | "reconcile"
  | "protected_invoke";

export type BackgroundEncryptionSurface = Readonly<{
  readonly id: string;
  readonly sourcePath: string;
  readonly anchor: string;
  readonly ownership: BackgroundEncryptionOwnership;
  readonly duties: readonly BackgroundEncryptionDuty[];
}>;

export const BACKGROUND_ENCRYPTION_SURFACES = Object.freeze([
  {
    id: "stenographer.server",
    sourcePath: "packages/server/src/app.ts",
    anchor: "const stenographerWorker = new StenographerWorker",
    ownership: "wave10_vertical",
    duties: ["background_start"],
  },
  {
    id: "stenographer.worker",
    sourcePath: "packages/runtime/src/stenographer/worker.ts",
    anchor: "private async runOnce",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "model_invoke", "plaintext_write"],
  },
  {
    id: "stenographer.source.live",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "async function tryClaimRoom",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.source.historical",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "export async function claimNextHistoricalExtraction",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.source.rebuild",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "export async function claimJournalRebuildExtraction",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.source.prior",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "async function loadPriorContextRows",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.source.journal",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "async function loadPromptJournal",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.model.extraction",
    sourcePath: "packages/reflection/src/stenographer/processor.ts",
    anchor: "export async function runStenographerExtraction",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "model_invoke", "protected_invoke"],
  },
  {
    id: "stenographer.model.compaction",
    sourcePath: "packages/reflection/src/stenographer/processor.ts",
    anchor: "export async function runStenographerCompaction",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "model_invoke", "protected_invoke"],
  },
  {
    id: "stenographer.compaction.claim",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "async function tryClaimCompactionRoom",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "plaintext_read", "protected_read"],
  },
  {
    id: "stenographer.publish.events",
    sourcePath: "packages/runtime/src/stenographer/native-record-publication.ts",
    anchor: "export async function createNativeStenographerExtractionPublisher",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "plaintext_write", "protected_write", "reconcile"],
  },
  {
    id: "stenographer.publish.compaction",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "export async function publishCompaction",
    ownership: "wave10_vertical",
    duties: [
      "plaintext_read",
      "plaintext_write",
      "protected_read",
      "protected_write",
      "reconcile",
    ],
  },
  {
    id: "stenographer.rebuild",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "export async function prepareNextJournalRebuild",
    ownership: "wave10_vertical",
    duties: ["metadata_discovery", "plaintext_write", "reconcile"],
  },
  {
    id: "stenographer.admin_status",
    sourcePath: "packages/db/src/queries/stenographer-status.ts",
    anchor: "export async function queryStenographerAdminStatus",
    ownership: "wave10_vertical",
    duties: ["plaintext_read"],
  },
  {
    id: "reflection.worker",
    sourcePath:
      "packages/runtime/src/reflection/production-reflection-memory.ts",
    anchor: "const worker = new ReflectionSemanticWorker",
    ownership: "wave10_vertical",
    duties: ["background_start", "protected_read", "protected_write"],
  },
  {
    id: "reflection.model",
    sourcePath:
      "packages/runtime/src/reflection/production-reflection-memory.ts",
    anchor: "const invokeForRecords = async",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "model_invoke", "protected_invoke"],
  },
  {
    id: "reflection.publish",
    sourcePath:
      "packages/runtime/src/reflection/production-reflection-memory.ts",
    anchor: "const proposals: DurableOrganizerProposalApplicationPort",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "plaintext_write", "protected_write"],
  },
  {
    id: "foreground.journal.read",
    sourcePath: "packages/runtime/src/context/build-transcript-context-deps.ts",
    anchor: "export function defaultBuildTranscriptContextDeps",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "foreground.journal.main",
    sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
    anchor: "export async function* langgraphExecutor",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "foreground.journal.fork",
    sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts",
    anchor: "export async function* forkLanggraphExecutor",
    ownership: "wave10_vertical",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "memory.caller.main",
    sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
    anchor: "await memoryReviewAdmission(memoryAccessEnvelope, langgraphThreadId,",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery"],
  },
  {
    id: "memory.caller.fork",
    sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts",
    anchor: "await memoryReviewAdmission(memoryAccessEnvelope, checkpointThreadId,",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery"],
  },
  {
    id: "memory.review",
    sourcePath: "packages/agent/src/memory/background-reviewer.ts",
    anchor: "export async function prepareMemoryReview",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "model_invoke", "protected_invoke"],
  },
  {
    id: "memory.search",
    sourcePath: "packages/agent/src/tools/memory/search-memory.ts",
    anchor: "export function createSearchMemoryTool",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "protected_read"],
  },
  {
    id: "memory.manage",
    sourcePath: "packages/agent/src/tools/memory/manage-memory.ts",
    anchor: "export function createManageMemoryTool",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "plaintext_write", "protected_write"],
  },
  {
    id: "memory.exit_flush",
    sourcePath: "packages/agent/src/memory/exit-flush.ts",
    anchor: "export async function runExitFlush",
    ownership: "wave10_dark_adapter",
    duties: [
      "plaintext_read",
      "plaintext_write",
      "model_invoke",
      "protected_invoke",
    ],
  },
  {
    id: "task.server",
    sourcePath: "packages/server/src/app.ts",
    anchor: "const taskObserver = new TaskObserver",
    ownership: "wave10_dark_adapter",
    duties: ["background_start"],
  },
  {
    id: "task.observer",
    sourcePath: "packages/runtime/src/tasks/task-observer.ts",
    anchor: "export class TaskObserver",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery", "protected_invoke"],
  },
  {
    id: "task.dispatch",
    sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts",
    anchor: "export async function dispatchTaskRun",
    ownership: "wave10_dark_adapter",
    duties: [
      "metadata_discovery",
      "plaintext_read",
      "plaintext_write",
      "protected_invoke",
    ],
  },
  {
    id: "task.job",
    sourcePath: "packages/runtime/src/job.ts",
    anchor: "async persist(): Promise<void>",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_write"],
  },
  {
    id: "task.job_persistence",
    sourcePath: "packages/db/src/queries/jobs.ts",
    anchor: "export async function persistJob",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_write"],
  },
  {
    id: "task.execute",
    sourcePath: "packages/runtime/src/tasks/task-run-executor.ts",
    anchor: "export const taskRunExecutor",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "model_invoke", "protected_invoke"],
  },
  {
    id: "task.lifecycle",
    sourcePath: "packages/runtime/src/tasks/lifecycle.ts",
    anchor: "export async function unpauseTask",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery", "protected_invoke"],
  },
  {
    id: "task.approval_resume",
    sourcePath: "packages/runtime/src/tasks/resume-task-approval.ts",
    anchor: "export async function runTaskApprovalResume",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery"],
  },
  {
    id: "task.await_reply",
    sourcePath: "packages/server/src/messaging/await-resume.ts",
    anchor: "export async function maybeResumeAwaitingTask",
    ownership: "wave10_dark_adapter",
    duties: ["metadata_discovery"],
  },
  {
    id: "job.manager",
    sourcePath: "packages/runtime/src/job-manager.ts",
    anchor: "export class JobManager",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "plaintext_write", "protected_invoke"],
  },
  {
    id: "job.route",
    sourcePath: "packages/server/src/routes/jobs.ts",
    anchor: "export function jobRoutes",
    ownership: "wave10_dark_adapter",
    duties: ["plaintext_read", "plaintext_write"],
  },
] as const satisfies readonly BackgroundEncryptionSurface[]);

export function validateBackgroundEncryptionInventory(
  repositoryRoot: string,
  surfaces: readonly BackgroundEncryptionSurface[] =
    BACKGROUND_ENCRYPTION_SURFACES,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();
  const anchors = new Set<string>();

  for (const surface of surfaces) {
    if (ids.has(surface.id)) {
      violations.push(`duplicate background encryption id: ${surface.id}`);
    }
    ids.add(surface.id);

    const sourceAnchor = `${surface.sourcePath}#${surface.anchor}`;
    if (anchors.has(sourceAnchor)) {
      violations.push(
        `duplicate background encryption anchor: ${sourceAnchor}`,
      );
    }
    anchors.add(sourceAnchor);

    const path = resolve(repositoryRoot, surface.sourcePath);
    if (!existsSync(path)) {
      violations.push(
        `missing background encryption source: ${surface.sourcePath}`,
      );
      continue;
    }
    if (!readFileSync(path, "utf8").includes(surface.anchor)) {
      violations.push(
        `missing background encryption anchor: ${sourceAnchor}`,
      );
    }
  }

  return violations.sort();
}
