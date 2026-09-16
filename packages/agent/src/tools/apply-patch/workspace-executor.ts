/** D448 — workspace-only apply_patch orchestration over injected private-tree ports. */
import type {
  ApplyPatchError,
  ApplyPatchPlannedOperation,
  ApplyPatchPreflightSummary,
} from "./contract";
import { preflightApplyPatch } from "./preflight";
import type { ApplyPatchNativeOperation, ApplyPatchProcessWrapperResult } from "./process-wrapper";
import { classifyApplyPatchText } from "./text-classifier";
import { buildWorkspaceUnifiedDiff } from "./unified-diff";
import {
  cleanupWorkspaceApplyPatchStage,
  stageWorkspaceApplyPatch,
  type ApplyPatchWorkspaceArtifactReadPort,
  type ApplyPatchWorkspaceTreePort,
  type WorkspaceArtifactSnapshot,
  type WorkspaceApplyPatchStage,
} from "./workspace-staging";

export interface ApplyPatchWorkspaceRunner<TreeHandle> {
  run(input: { readonly tree: TreeHandle; readonly patch: string }): Promise<ApplyPatchProcessWrapperResult>;
}

export type WorkspaceObservedFile = {
  readonly path: string;
  readonly before: WorkspaceArtifactSnapshot | null;
  readonly after: Uint8Array | null;
};

export type WorkspaceApplyPatchOperationReconciliation =
  | {
      readonly operation: "add" | "update" | "delete";
      readonly path: string;
      readonly state: "applied";
      readonly destination: WorkspaceObservedFile;
    }
  | {
      readonly operation: "move";
      readonly fromPath: string;
      readonly path: string;
      readonly state: "applied";
      readonly source: WorkspaceObservedFile;
      readonly destination: WorkspaceObservedFile;
    };

/** Actual terminal facts returned by the authoritative artifact/revision adapter. */
export type WorkspaceCommitOperationOutcome =
  | {
      readonly operation: "add" | "update" | "delete";
      readonly path: string;
      readonly state: "committed";
      readonly revisionIds: readonly string[];
    }
  | {
      readonly operation: "move";
      readonly fromPath: string;
      readonly path: string;
      readonly state: "committed";
      readonly revisionIds: readonly string[];
    }
  | {
      readonly operation: "add" | "update" | "delete";
      readonly path: string;
      readonly state: "failed" | "unknown";
    }
  | {
      readonly operation: "move";
      readonly fromPath: string;
      readonly path: string;
      readonly state: "failed" | "unknown";
    };

export type WorkspaceCommitOutcome = {
  readonly operations: readonly WorkspaceCommitOperationOutcome[];
  /** Present only when the coordinator composed later authoritative text. */
  readonly rebased?: true;
};

/** A pre-mutation admission failure, before any authoritative Workspace write. */
export type WorkspaceCommitAdmissionRejection = {
  readonly rejected: true;
  /** Empty because admission occurs before the first authoritative mutation. */
  readonly operations: readonly [];
  readonly error: ApplyPatchError;
};

export type WorkspaceCommitResult = WorkspaceCommitOutcome | WorkspaceCommitAdmissionRejection;

/** Existing staged artifact identities, resolved before the native runner. */
export type WorkspaceCommitAdmission = {
  readonly existingArtifactIds: readonly string[];
};

export interface ApplyPatchWorkspaceCommitPort {
  reconcileApplied(
    operations: readonly WorkspaceApplyPatchOperationReconciliation[],
    admission?: WorkspaceCommitAdmission,
  ): Promise<WorkspaceCommitResult>;
}

export type WorkspaceApplyPatchExecutionResult =
  | {
      readonly ok: true;
      readonly process: Extract<ApplyPatchProcessWrapperResult, { ok: true }>["process"];
      readonly report: Extract<ApplyPatchProcessWrapperResult, { ok: true }>["report"];
      readonly commit: WorkspaceCommitOutcome;
      /** Built from pre-cleanup observations for authoritative commits only. */
      readonly unifiedDiff: string;
      readonly cleanupWarning?: string;
    }
  | {
      readonly ok: false;
      readonly error: ApplyPatchError;
      readonly process?: Extract<ApplyPatchProcessWrapperResult, { ok: false }>["process"];
      readonly report?: Extract<ApplyPatchProcessWrapperResult, { ok: true }>["report"];
      readonly commit?: WorkspaceCommitOutcome;
      /** Present only when exact committed observations could be retained. */
      readonly unifiedDiff?: string;
      readonly cleanupWarning?: string;
    };

function fail(
  code: ApplyPatchError["code"],
  message: string,
  retryable = false,
  details: Omit<Extract<WorkspaceApplyPatchExecutionResult, { ok: false }>, "ok" | "error"> = {},
): WorkspaceApplyPatchExecutionResult {
  return { ok: false, error: { code, message, retryable }, ...details };
}

function samePlan(report: readonly ApplyPatchNativeOperation[], preflight: ApplyPatchPreflightSummary): boolean {
  return report.length === preflight.operations.length && report.every((operation, index) => {
    const expected = preflight.operations[index]!;
    return operation.kind === expected.operation &&
      operation.path === expected.path &&
      (operation.kind !== "move" || (expected.operation === "move" && operation.fromPath === expected.fromPath));
  });
}

function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === right || (
    left !== null &&
    right !== null &&
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

async function observedFiles<TreeHandle>(
  stage: WorkspaceApplyPatchStage<TreeHandle>,
  tree: ApplyPatchWorkspaceTreePort<TreeHandle>,
): Promise<Map<string, WorkspaceObservedFile>> {
  const output = new Map<string, WorkspaceObservedFile>();
  for (const staged of stage.paths) {
    const after = await tree.readFile(stage.tree, staged.path);
    if (after !== null && !classifyApplyPatchText(after).supported) {
      throw new Error("private tree contains unsupported output");
    }
    output.set(staged.path, { path: staged.path, before: staged.before, after });
  }
  return output;
}

function operationReferencesPath(candidate: ApplyPatchPlannedOperation, path: string): boolean {
  return candidate.path === path || (candidate.operation === "move" && candidate.fromPath === path);
}

/**
 * The private tree exposes terminal bytes only. An isolated native delete/add
 * pair for one path is therefore one externally observable replacement: its
 * intermediate absence cannot be read without weakening the private-tree
 * boundary. Commit the exact initial and terminal images as one update, but
 * only after exact native plan/state agreement and only when no other native
 * operation references that path.
 */
function isDeleteAddReplacement(
  operations: readonly ApplyPatchPlannedOperation[],
  states: readonly { readonly state: "applied" | "not_applied" | "unknown" }[],
  index: number,
): boolean {
  const deletion = operations[index];
  const addition = operations[index + 1];
  return deletion?.operation === "delete" &&
    addition?.operation === "add" &&
    deletion.path === addition.path &&
    states[index]?.state === "applied" &&
    states[index + 1]?.state === "applied" &&
    operations.filter((candidate) => operationReferencesPath(candidate, deletion.path)).length === 2;
}

function replacementEffect(
  candidate: ApplyPatchPlannedOperation,
  observed: Map<string, WorkspaceObservedFile>,
): WorkspaceApplyPatchOperationReconciliation {
  const destination = observed.get(candidate.path);
  if (destination === undefined || destination.before === null || destination.after === null) {
    throw new Error("reported delete/add replacement has incomplete terminal bytes");
  }
  return { operation: "update", path: candidate.path, state: "applied", destination };
}

function assertExpectedEffect(
  candidate: ApplyPatchPlannedOperation,
  state: "applied" | "not_applied" | "unknown",
  observed: Map<string, WorkspaceObservedFile>,
): WorkspaceApplyPatchOperationReconciliation | null {
  const destination = observed.get(candidate.path);
  const source = candidate.operation === "move" ? observed.get(candidate.fromPath) : undefined;
  if (destination === undefined || (candidate.operation === "move" && source === undefined)) {
    throw new Error("missing observed candidate path");
  }

  if (state === "unknown") return null;
  if (state === "not_applied") {
    if (!equalBytes(destination.before?.bytes ?? null, destination.after) ||
      (source !== undefined && !equalBytes(source.before?.bytes ?? null, source.after))) {
      throw new Error("reported not-applied operation changed private-tree bytes");
    }
    return null;
  }

  if (candidate.operation === "delete") {
    if (destination.after !== null) throw new Error("reported delete left destination bytes");
    return { operation: "delete", path: candidate.path, state, destination };
  }
  if (candidate.operation === "move") {
    if (source!.after !== null || destination.after === null) {
      throw new Error("reported move did not remove source and materialize destination");
    }
    return {
      operation: "move",
      fromPath: candidate.fromPath,
      path: candidate.path,
      state,
      source: source!,
      destination,
    };
  }
  if (destination.after === null) throw new Error("reported applied operation has no destination bytes");
  return { operation: candidate.operation, path: candidate.path, state, destination };
}

function outcomeUnknown(
  operations: readonly WorkspaceApplyPatchOperationReconciliation[],
): WorkspaceCommitOutcome {
  return {
    operations: operations.map((operation) => operation.operation === "move"
      ? { operation: "move", fromPath: operation.fromPath, path: operation.path, state: "unknown" }
      : { operation: operation.operation, path: operation.path, state: "unknown" }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameOperation(
  expected: WorkspaceApplyPatchOperationReconciliation,
  actual: Record<string, unknown>,
): boolean {
  return actual["operation"] === expected.operation &&
    actual["path"] === expected.path &&
    (expected.operation !== "move" || actual["fromPath"] === expected.fromPath);
}

/** Runtime-validate a dependency-injected port before trusting its mutation facts. */
function validateCommitOutcome(
  value: unknown,
  requested: readonly WorkspaceApplyPatchOperationReconciliation[],
): WorkspaceCommitOutcome | null {
  const outer = record(value);
  if (
    outer === null ||
    !exactKeys(
      outer,
      outer["rebased"] === undefined
        ? ["operations"]
        : ["operations", "rebased"],
    ) ||
    (outer["rebased"] !== undefined && outer["rebased"] !== true) ||
    !Array.isArray(outer["operations"]) ||
    outer["operations"].length !== requested.length) return null;

  const operations: WorkspaceCommitOperationOutcome[] = [];
  for (const [index, raw] of outer["operations"].entries()) {
    const item = record(raw);
    const expected = requested[index]!;
    if (item === null || !sameOperation(expected, item) ||
      typeof item["operation"] !== "string" || typeof item["path"] !== "string" ||
      (expected.operation === "move" && typeof item["fromPath"] !== "string")) return null;
    const committed = item["state"] === "committed";
    const base = expected.operation === "move"
      ? ["fromPath", "operation", "path", "state"]
      : ["operation", "path", "state"];
    if (committed) {
      if (!exactKeys(item, [...base, "revisionIds"]) || !Array.isArray(item["revisionIds"]) ||
        item["revisionIds"].length === 0 ||
        !item["revisionIds"].every((id) => typeof id === "string" && id.length > 0)) return null;
      operations.push(expected.operation === "move"
        ? { operation: "move", fromPath: expected.fromPath, path: expected.path, state: "committed", revisionIds: item["revisionIds"] as string[] }
        : { operation: expected.operation, path: expected.path, state: "committed", revisionIds: item["revisionIds"] as string[] });
    } else {
      if ((item["state"] !== "failed" && item["state"] !== "unknown") || !exactKeys(item, base)) return null;
      operations.push(expected.operation === "move"
        ? { operation: "move", fromPath: expected.fromPath, path: expected.path, state: item["state"] }
        : { operation: expected.operation, path: expected.path, state: item["state"] });
    }
  }
  return {
    operations,
    ...(outer["rebased"] === true ? { rebased: true } : {}),
  };
}

function isCommitAdmissionRejection(
  value: WorkspaceCommitResult,
): value is WorkspaceCommitAdmissionRejection {
  return "rejected" in value && value.rejected === true;
}

function hasIncomplete(outcome: WorkspaceCommitOutcome): boolean {
  return outcome.operations.some((operation) => operation.state !== "committed");
}

function committedOperations(
  requested: readonly WorkspaceApplyPatchOperationReconciliation[],
  outcome: WorkspaceCommitOutcome,
): WorkspaceApplyPatchOperationReconciliation[] {
  return requested.filter((_, index) => outcome.operations[index]?.state === "committed");
}

function appendCleanupWarning(
  result: WorkspaceApplyPatchExecutionResult,
  warning: string,
): WorkspaceApplyPatchExecutionResult {
  return { ...result, cleanupWarning: warning };
}

/**
 * Preflight failure calls neither runner nor commit. Exact native-plan and
 * private-tree effect checks happen before any authoritative reconciliation.
 */
export async function executeWorkspaceApplyPatch<TreeHandle>(input: {
  readonly patch: string;
  readonly artifacts: ApplyPatchWorkspaceArtifactReadPort;
  readonly tree: ApplyPatchWorkspaceTreePort<TreeHandle>;
  readonly runner: ApplyPatchWorkspaceRunner<TreeHandle>;
  readonly commit: ApplyPatchWorkspaceCommitPort;
}): Promise<WorkspaceApplyPatchExecutionResult> {
  const preflight = preflightApplyPatch(input.patch);
  if (!preflight.ok) return preflight;
  const staged = await stageWorkspaceApplyPatch({
    preflight: preflight.summary,
    artifacts: input.artifacts,
    tree: input.tree,
  });
  if (!staged.ok) return staged;

  let result: WorkspaceApplyPatchExecutionResult | undefined;
  let commitAttempted = false;
  try {
    const run = await input.runner.run({ tree: staged.stage.tree, patch: input.patch });
    if (!run.ok) {
      result = run;
    } else if (!samePlan(run.report.plannedOperations, staged.stage.preflight)) {
      result = fail("runtime_corrupt", "apply_patch runtime plan did not match the preflight candidates.", false, { process: run.process, report: run.report });
    } else {
      const observed = await observedFiles(staged.stage, input.tree);
      const applied: WorkspaceApplyPatchOperationReconciliation[] = [];
      for (const [index, candidate] of staged.stage.preflight.operations.entries()) {
        if (isDeleteAddReplacement(
          staged.stage.preflight.operations,
          run.report.operationStates,
          index,
        )) {
          applied.push(replacementEffect(candidate, observed));
          continue;
        }
        if (isDeleteAddReplacement(
          staged.stage.preflight.operations,
          run.report.operationStates,
          index - 1,
        )) continue;
        const state = run.report.operationStates[index]!.state;
        const reconciliation = assertExpectedEffect(candidate, state, observed);
        if (reconciliation !== null) applied.push(reconciliation);
      }
      const allNativeOperationsApplied = run.report.operationStates.every(
        (operation) => operation.state === "applied",
      );

      let commit: WorkspaceCommitOutcome = { operations: [] };
      if (
        run.report.partial ||
        !run.report.ok ||
        !allNativeOperationsApplied
      ) {
        result = fail(
          "partial_execution",
          "Workspace apply_patch produced no authoritative changes because native execution was incomplete.",
          false,
          {
            process: run.process,
            report: run.report,
            commit,
            unifiedDiff: "",
          },
        );
      } else if (applied.length > 0) {
        commitAttempted = true;
        try {
          const raw = await input.commit.reconcileApplied(applied, {
            existingArtifactIds: [...new Set(
              staged.stage.paths.flatMap((stagedPath) =>
                stagedPath.before === null ? [] : [stagedPath.before.artifactId],
              ),
            )],
          });
          if (isCommitAdmissionRejection(raw)) {
            result = fail(raw.error.code, raw.error.message, raw.error.retryable, {
              process: run.process,
              report: run.report,
            });
          } else {
            const validated = validateCommitOutcome(raw, applied);
            if (validated === null) {
              result = fail("partial_execution", "Workspace apply_patch commit outcome was invalid.", false, {
                process: run.process,
                report: run.report,
                commit: outcomeUnknown(applied),
              });
            } else {
              commit = validated;
            }
          }
        } catch {
          result = fail("partial_execution", "Workspace apply_patch commit outcome is unknown.", false, {
            process: run.process,
            report: run.report,
            commit: outcomeUnknown(applied),
          });
        }
      }

      if (result !== undefined) {
        // An invalid/thrown port outcome is already a truth-preserving partial result.
      } else if (hasIncomplete(commit)) {
        result = fail("partial_execution", "Workspace apply_patch completed only partially.", false, {
          process: run.process,
          report: run.report,
          commit,
          unifiedDiff: buildWorkspaceUnifiedDiff(committedOperations(applied, commit)),
        });
      } else {
        result = {
          ok: true,
          process: run.process,
          report: run.report,
          commit,
          unifiedDiff: buildWorkspaceUnifiedDiff(committedOperations(applied, commit)),
        };
      }
    }
  } catch {
    result = fail(
      commitAttempted ? "partial_execution" : "runtime_corrupt",
      commitAttempted ? "Workspace apply_patch may have committed partially." : "Workspace apply_patch private-tree effects were inconsistent.",
      false,
    );
  } finally {
    try {
      await cleanupWorkspaceApplyPatchStage(staged.stage, input.tree);
    } catch {
      if (commitAttempted) {
        result = appendCleanupWarning(result!, "Workspace apply_patch temporary cleanup failed.");
      } else {
        result = fail("runtime_unavailable", "Workspace apply_patch temporary cleanup failed.", true);
      }
    }
  }
  return result;
}
