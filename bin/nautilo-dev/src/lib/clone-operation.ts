import { writeOwnerOnlyJsonAtomically } from "./d489-operation-records";

export const CLONE_STAGES = [
  "topology-created",
  "home-rebound",
  "databases-started",
  "historical-databases-imported",
  "historical-state-verified",
  "identity-rebound",
  "nautilo-migrated",
  "logto-migrated",
  "credentials-reconciled",
  "services-started",
  "acceptance-passed",
] as const;

export type CloneStage = (typeof CLONE_STAGES)[number];

export interface CloneOperationRecord {
  formatVersion: 1;
  sourceInstanceId: string;
  targetInstanceId: string;
  backupName: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "failed" | "complete";
  /** Full clone starts services; provision hands that lifecycle to dev-stack. */
  mode?: "full" | "provision";
  completedStages: CloneStage[];
  failure?: string;
}

/**
 * Validate only the secret-free progress fields and derive the next fixed
 * production stage. The free-form `failure` field is deliberately ignored.
 */
export function deriveCloneOperationNextStage(record: unknown): CloneStage | "complete" {
  if (typeof record !== "object" || record === null) {
    throw new Error("Invalid clone operation record");
  }
  const candidate = record as { status?: unknown; mode?: unknown; completedStages?: unknown };
  if (!(["running", "failed", "complete"] as const).includes(candidate.status as never)) {
    throw new Error("Invalid clone operation status");
  }
  if (!Array.isArray(candidate.completedStages)) {
    throw new Error("Invalid clone operation completed stages");
  }
  if (candidate.mode !== undefined && candidate.mode !== "full" && candidate.mode !== "provision") {
    throw new Error("Invalid clone operation mode");
  }
  const completed = candidate.completedStages;
  if (
    completed.length > CLONE_STAGES.length ||
    completed.some((stage, index) => stage !== CLONE_STAGES[index])
  ) {
    throw new Error("Clone operation stages are not a strict prefix");
  }
  const expectedCompletedCount = candidate.mode === "provision"
    ? CLONE_STAGES.indexOf("services-started")
    : CLONE_STAGES.length;
  if (candidate.status === "complete") {
    if (completed.length !== expectedCompletedCount) {
      throw new Error("Complete clone operation has incomplete stages");
    }
    return "complete";
  }
  if (completed.length >= expectedCompletedCount) {
    throw new Error("Incomplete clone operation has no next stage");
  }
  const next = CLONE_STAGES[completed.length];
  if (next === undefined) throw new Error("Incomplete clone operation has no next stage");
  return next;
}

async function writeCloneOperation(
  path: string,
  record: CloneOperationRecord,
): Promise<void> {
  await writeOwnerOnlyJsonAtomically(path, record);
}

export async function runCloneStages(input: {
  record: CloneOperationRecord;
  operationPath: string;
  stages: ReadonlyArray<{
    name: CloneStage;
    run: () => Promise<void>;
  }>;
  now?: () => string;
}): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());
  await writeCloneOperation(input.operationPath, input.record);
  try {
    for (const stage of input.stages) {
      await stage.run();
      input.record.completedStages.push(stage.name);
      input.record.updatedAt = now();
      await writeCloneOperation(input.operationPath, input.record);
    }
    input.record.status = "complete";
    input.record.updatedAt = now();
    await writeCloneOperation(input.operationPath, input.record);
  } catch (error) {
    input.record.status = "failed";
    input.record.failure =
      error instanceof Error ? error.message : "Clone failed with a non-Error value";
    input.record.updatedAt = now();
    await writeCloneOperation(input.operationPath, input.record);
    throw error instanceof Error
      ? error
      : new Error("Clone failed with a non-Error value");
  }
}
