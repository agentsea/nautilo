import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ProtectedExecutionDuty =
  | "carry_coordinates"
  | "resolve_current_lease"
  | "wipe_terminal_lease";

export type ProtectedExecutionEntrypoint = Readonly<{
  id: string;
  sourcePath: string;
  anchor: string;
  requiredDuties: readonly ProtectedExecutionDuty[];
}>;

const CARRY_AND_RESOLVE = [
  "carry_coordinates",
  "resolve_current_lease",
] as const satisfies readonly ProtectedExecutionDuty[];

const FULL_EXECUTION_LIFECYCLE = [
  "carry_coordinates",
  "resolve_current_lease",
  "wipe_terminal_lease",
] as const satisfies readonly ProtectedExecutionDuty[];

/**
 * Wave 8's executable inventory of independently reachable Agent execution
 * and resume seams on the merged Wave 7 baseline.
 *
 * This is intentionally source-anchored. Adding, renaming, or moving an
 * execution entrance must update this registry and its negative invariant
 * fixture before repository assurance can pass.
 */
export const PROTECTED_EXECUTION_ENTRYPOINTS =
  Object.freeze([
    {
      id: "foreground.conductor",
      sourcePath: "packages/server/src/messaging/dispatch.ts",
      anchor: "async function runSerializedGroupRoomConductorAfterPersist",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "foreground.main",
      sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
      anchor: "export async function* langgraphExecutor",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "foreground.fork",
      sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts",
      anchor: "export async function* forkLanggraphExecutor",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "resume.approval",
      sourcePath: "packages/agent/src/graph/resume-approval.ts",
      anchor: "export async function resumeGraphWithApproval",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "resume.approval_ask",
      sourcePath: "packages/agent/src/graph/resume-approval-ask.ts",
      anchor: "export async function resumeGraphWithAskReply",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "resume.identity",
      sourcePath: "packages/agent/src/graph/resume-identity.ts",
      anchor: "export async function resumeGraphWithIdentity",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "resume.await_reply",
      sourcePath: "packages/agent/src/graph/resume-human-reply.ts",
      anchor: "export async function resumeGraphWithHumanReply",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "task.dispatch",
      sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts",
      anchor: "export async function dispatchTaskRun",
      requiredDuties: CARRY_AND_RESOLVE,
    },
    {
      id: "task.execute",
      sourcePath: "packages/runtime/src/tasks/task-run-executor.ts",
      anchor: "export const taskRunExecutor",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "task.approval_resume",
      sourcePath: "packages/runtime/src/tasks/resume-task-approval.ts",
      anchor: "export async function runTaskApprovalResume",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "subagent.scope",
      sourcePath: "packages/agent/src/subagents/scope-subagent/run.ts",
      anchor: "export function runScopeSubagentUntilPause",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "compaction.model",
      sourcePath: "packages/agent/src/checkpoints/checkpoint-compaction.ts",
      anchor: "export async function runCompaction",
      requiredDuties: CARRY_AND_RESOLVE,
    },
    {
      id: "stenographer.extraction",
      sourcePath: "packages/runtime/src/stenographer/protected-stenographer-extraction.ts",
      anchor: "export async function runProtectedStenographerExtraction",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "stenographer.compaction",
      sourcePath: "packages/runtime/src/stenographer/protected-stenographer-compaction.ts",
      anchor: "export async function runProtectedStenographerCompaction",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "memory.review",
      sourcePath: "packages/agent/src/memory/background-reviewer.ts",
      anchor: "export async function prepareMemoryReview",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "memory.exit_flush",
      sourcePath: "packages/agent/src/memory/exit-flush.ts",
      anchor: "export async function runExitFlush",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
    {
      id: "artifact.read",
      sourcePath: "packages/agent/src/tools/file/artifact-store.ts",
      anchor: "export async function resolveWorkspaceArtifact",
      requiredDuties: CARRY_AND_RESOLVE,
    },
    {
      id: "artifact.write",
      sourcePath: "packages/agent/src/tools/file/artifact-store.ts",
      anchor: "export async function applyWorkspaceArtifactRowChange",
      requiredDuties: FULL_EXECUTION_LIFECYCLE,
    },
  ] satisfies readonly ProtectedExecutionEntrypoint[]);

export function validateProtectedExecutionEntrypoints(
  repositoryRoot: string,
  entries: readonly ProtectedExecutionEntrypoint[] =
    PROTECTED_EXECUTION_ENTRYPOINTS,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();
  const sourceAnchors = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) {
      violations.push(`duplicate protected execution id: ${entry.id}`);
    }
    ids.add(entry.id);

    const sourceAnchor = `${entry.sourcePath}#${entry.anchor}`;
    if (sourceAnchors.has(sourceAnchor)) {
      violations.push(
        `duplicate protected execution source anchor: ${sourceAnchor}`,
      );
    }
    sourceAnchors.add(sourceAnchor);

    const sourcePath = resolve(repositoryRoot, entry.sourcePath);
    if (!existsSync(sourcePath)) {
      violations.push(
        `missing protected execution source: ${entry.sourcePath}`,
      );
      continue;
    }
    if (!readFileSync(sourcePath, "utf8").includes(entry.anchor)) {
      violations.push(
        `missing protected execution anchor: ${sourceAnchor}`,
      );
    }
  }

  return violations.sort();
}
