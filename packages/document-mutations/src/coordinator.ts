import {
  applyAnchoredTextPatch,
  documentVersionSchema,
  type DocumentCommitPlan,
  type DocumentIdentity,
  type DocumentMutationActor,
  type DocumentMutationCommittedEvent,
  type DocumentMutationPath,
  type DocumentMutationResult,
  type DocumentVersion,
} from "@nautilo/types";
import type {
  BackendConflictEvidence,
  BackendConflictSnapshot,
  BackendCommitPlan,
  BackendCommitReceipt,
  BackendCompensationOutcome,
  BackendRestoredEntryReceipt,
  DocumentMutationBackend,
  DocumentMutationBackendKind,
} from "./backend";
import {
  buildAtomicDocumentMutationEventBatch,
  validateAtomicDocumentMutationEventBatch,
  type AtomicDocumentMutationEventBatch,
} from "./committed-events";
import type {
  DocumentMutationDiagnosticEmitter,
  DocumentMutationDiagnosticInput,
} from "./diagnostics";
import type { DocumentMutationLane } from "./lane-cutover";
import type {
  HumanEditAdmission,
  HumanEditAdmissionOutcome,
  HumanEditAdmissionSnapshot,
} from "./human-edit-admission";
import {
  deriveDocumentLockKeys,
  type DocumentLockLease,
  type DocumentLockManager,
} from "./lock-manager";
import {
  validateDocumentCommitPlan,
  type DocumentCommitPlanValidationOutcome,
  type HashBytes,
} from "./plan-validation";
import { rebaseStaleTextPlan } from "./stale-text-plan-rebase";

export type EventPublicationOutcome =
  | { readonly kind: "published" }
  | { readonly kind: "not_published" }
  | { readonly kind: "unknown" };

export type { AtomicDocumentMutationEventBatch } from "./committed-events";

export interface DocumentMutationEventPublisher {
  /** Publishes the complete ordered batch atomically and idempotently. */
  publishAtomic(
    batch: AtomicDocumentMutationEventBatch,
  ): Promise<EventPublicationOutcome>;
}

type SuccessfulMutationResult = Extract<
  DocumentMutationResult,
  { kind: "applied" | "rebased" }
>;
type RejectedMutationResult = Extract<
  DocumentMutationResult,
  { kind: "conflict" | "failed" }
>;
type SuccessfulMutationOutcome = SuccessfulMutationResult["kind"];

export type DocumentMutationCoordinatorOutcome =
  | {
      readonly kind: "completed";
      readonly commitState: "committed";
      readonly result: SuccessfulMutationResult;
      readonly events: readonly DocumentMutationCommittedEvent[];
    }
  | {
      readonly kind: "rejected";
      readonly result: RejectedMutationResult;
    }
  | {
      readonly kind: "recovery_required";
      readonly commitState: "committed" | "unknown";
      readonly operationId: string;
      readonly revisionGroupId?: string;
      readonly code: "inconsistent_outcome";
      readonly paths: readonly DocumentMutationPath[];
      readonly events: readonly DocumentMutationCommittedEvent[];
    };

export type DocumentMutationPreviewResult =
  | {
      readonly kind: "prepared";
      readonly operationId: string;
      readonly backend: DocumentMutationBackendKind;
      readonly paths: readonly DocumentMutationPath[];
    }
  | RejectedMutationResult;

export interface DocumentMutationCoordinatorInput {
  /** Trusted, prevalidated nonempty operation identity for result correlation. */
  readonly operationId: string;
  readonly plan: unknown;
  readonly lane: DocumentMutationLane;
}

export interface DocumentMutationCoordinatorDependencies<
  K extends DocumentMutationBackendKind,
  Prepared,
  Receipt extends BackendCommitReceipt<K>,
> {
  readonly backend: DocumentMutationBackend<K, Prepared, Receipt>;
  readonly hashBytes: HashBytes;
  readonly lockManager: DocumentLockManager;
  readonly allocateRevisionGroupId: (input: {
    readonly backend: K;
    readonly lane: DocumentMutationLane;
    readonly operationId: string;
    readonly actor: DocumentMutationActor;
    readonly turnId?: string;
  }) => string | Promise<string>;
  readonly eventPublisher: DocumentMutationEventPublisher;
  /** Optional best-effort consumer; outside commit and never called for replay. */
  readonly onFreshCommit?: (events: readonly DocumentMutationCommittedEvent[]) => void | Promise<void>;
  /**
   * Optional human-priority admission. It is invoked only after the shared
   * document locks are held, before prepare and immediately before commit.
   */
  readonly humanEditAdmission?: HumanEditAdmission;
  readonly diagnostics?: DocumentMutationDiagnosticEmitter;
}

export interface DocumentMutationCoordinator {
  preview(input: DocumentMutationCoordinatorInput): Promise<DocumentMutationPreviewResult>;
  execute(
    input: DocumentMutationCoordinatorInput,
  ): Promise<DocumentMutationCoordinatorOutcome>;
}

function expectedPaths(plan: DocumentCommitPlan): readonly DocumentMutationPath[] {
  return plan.entries.map((entry): DocumentMutationPath => {
    switch (entry.kind) {
      case "create":
        return { kind: "create", after: entry.after.identity };
      case "update":
        return {
          kind: "update",
          before: entry.before.identity,
          after: entry.after.identity,
        };
      case "move":
        return entry.destinationBefore === undefined
          ? {
              kind: "move",
              overwrite: false,
              before: entry.source.identity,
              after: entry.after.identity,
            }
          : {
              kind: "move",
              overwrite: true,
              before: entry.source.identity,
              destinationBefore: entry.destinationBefore.identity,
              after: entry.after.identity,
            };
      case "delete":
        return { kind: "delete", before: entry.before.identity };
    }
  });
}

function identityEquals(left: DocumentIdentity, right: DocumentIdentity): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace_artifact"
    ? right.kind === "workspace_artifact" &&
        left.artifactId === right.artifactId &&
        left.logicalPath === right.logicalPath
    : right.kind === "local_file" &&
        left.relayId === right.relayId &&
        left.canonicalPath === right.canonicalPath;
}

function pathEquals(
  left: DocumentMutationPath,
  right: DocumentMutationPath,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "create":
      return right.kind === "create" && identityEquals(left.after, right.after);
    case "update":
      return (
        right.kind === "update" &&
        identityEquals(left.before, right.before) &&
        identityEquals(left.after, right.after)
      );
    case "move":
      return (
        right.kind === "move" &&
        left.overwrite === right.overwrite &&
        identityEquals(left.before, right.before) &&
        identityEquals(left.after, right.after) &&
        (left.overwrite
          ? right.overwrite &&
            identityEquals(left.destinationBefore, right.destinationBefore)
          : !right.overwrite)
      );
    case "delete":
      return right.kind === "delete" && identityEquals(left.before, right.before);
  }
}

function conflictPathsMatchPlan(
  plan: DocumentCommitPlan,
  paths: readonly DocumentMutationPath[],
): boolean {
  if (paths.length === 0) return false;
  const allowed = expectedPaths(plan);
  return paths.every(
    (path, index) =>
      allowed.some((candidate) => pathEquals(path, candidate)) &&
      paths.findIndex((candidate) => pathEquals(path, candidate)) === index,
  );
}

function identitiesForPath(path: DocumentMutationPath): readonly DocumentIdentity[] {
  switch (path.kind) {
    case "create":
      return [path.after];
    case "update":
      return [path.before, path.after];
    case "move":
      return path.overwrite
        ? [path.before, path.destinationBefore, path.after]
        : [path.before, path.after];
    case "delete":
      return [path.before];
  }
}

function versionMatchesBackend(
  backend: DocumentMutationBackendKind,
  version: DocumentVersion,
): boolean {
  return backend === "workspace"
    ? version.identity.kind === "workspace_artifact" &&
        version.backendVersion.kind === "artifact_revision"
    : version.identity.kind === "local_file" &&
        version.backendVersion.kind === "local_sha";
}

function conflictEvidenceMatchesPlan<K extends DocumentMutationBackendKind>(
  backend: K,
  plan: DocumentCommitPlan,
  evidence: readonly BackendConflictEvidence<K>[],
): boolean {
  if (evidence.length === 0) return false;
  const paths = evidence.map((item) => item.path);
  if (!conflictPathsMatchPlan(plan, paths)) return false;
  const seenVersions = new Set<string>();
  return evidence.every((item) => {
    const parsed = documentVersionSchema.safeParse(item.currentVersion);
    if (!parsed.success || !versionMatchesBackend(backend, parsed.data)) {
      return false;
    }
    if (
      !identitiesForPath(item.path).some((identity) =>
        identityEquals(identity, parsed.data.identity),
      )
    ) {
      return false;
    }
    const identity = parsed.data.identity;
    const key =
      identity.kind === "workspace_artifact"
        ? `workspace:${identity.artifactId}:${identity.logicalPath}`
        : `local:${identity.relayId}:${identity.canonicalPath}`;
    if (seenVersions.has(key)) return false;
    seenVersions.add(key);
    return true;
  });
}

function conflictResult<K extends DocumentMutationBackendKind>(
  backend: K,
  plan: DocumentCommitPlan,
  outcome: {
    readonly code: "stale_version" | "human_edit_conflict" | "reapply_required";
    readonly evidence: readonly BackendConflictEvidence<K>[];
  },
): Extract<DocumentMutationResult, { kind: "conflict" }> | undefined {
  if (!conflictEvidenceMatchesPlan(backend, plan, outcome.evidence)) {
    return undefined;
  }
  return {
    kind: "conflict",
    operationId: plan.operationId,
    code: outcome.code,
    evidence: outcome.evidence,
  };
}

function versionEquals(left: DocumentVersion, right: DocumentVersion): boolean {
  const parsedLeft = documentVersionSchema.safeParse(left);
  const parsedRight = documentVersionSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) return false;
  left = parsedLeft.data;
  right = parsedRight.data;
  if (
    !identityEquals(left.identity, right.identity) ||
    left.sha256 !== right.sha256 ||
    left.backendVersion.kind !== right.backendVersion.kind
  ) {
    return false;
  }
  return left.backendVersion.kind === "artifact_revision"
    ? right.backendVersion.kind === "artifact_revision" &&
        left.backendVersion.revision === right.backendVersion.revision
    : right.backendVersion.kind === "local_sha" &&
        left.backendVersion.sha256 === right.backendVersion.sha256;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function deriveSuccessfulOutcome(
  input: DocumentMutationCoordinatorInput,
  plan: DocumentCommitPlan,
): SuccessfulMutationOutcome | undefined {
  if (input.lane !== "editor_save") {
    return plan.editorSave === undefined ? "applied" : undefined;
  }
  const intent = plan.editorSave;
  const entry = plan.entries[0];
  if (
    intent === undefined ||
    plan.entries.length !== 1 ||
    plan.actor.kind !== "human" ||
    entry?.kind !== "update"
  ) {
    return undefined;
  }

  const rebased = !versionEquals(
    intent.baseVersion,
    entry.before.expectedVersion,
  );
  if (intent.anchoredPatch === undefined) {
    return rebased ? undefined : "applied";
  }

  let beforeText: string;
  try {
    beforeText = new TextDecoder("utf-8", { fatal: true }).decode(
      entry.before.bytes,
    );
  } catch {
    return undefined;
  }
  const applied = applyAnchoredTextPatch(beforeText, intent.anchoredPatch);
  if (!applied.ok) return undefined;
  const provenAfter = new TextEncoder().encode(applied.text);
  if (!bytesEqual(provenAfter, entry.after.bytes)) return undefined;
  return rebased ? "rebased" : "applied";
}

function restoredVersionMatchesSnapshot(
  restored: DocumentVersion,
  expected: DocumentVersion,
): boolean {
  const parsedRestored = documentVersionSchema.safeParse(restored);
  const parsedExpected = documentVersionSchema.safeParse(expected);
  if (!parsedRestored.success || !parsedExpected.success) return false;
  const restoredVersion = parsedRestored.data;
  const expectedVersion = parsedExpected.data;
  return (
    identityEquals(restoredVersion.identity, expectedVersion.identity) &&
    restoredVersion.sha256 === expectedVersion.sha256 &&
    restoredVersion.backendVersion.kind === expectedVersion.backendVersion.kind &&
    (restoredVersion.backendVersion.kind === "artifact_revision"
      ? restoredVersion.identity.kind === "workspace_artifact"
      : restoredVersion.identity.kind === "local_file" &&
        restoredVersion.backendVersion.sha256 === restoredVersion.sha256)
  );
}

function restorationMatchesPlan(
  plan: DocumentCommitPlan,
  revisionGroupId: string,
  outcome: BackendCompensationOutcome,
): boolean {
  if (
    outcome.kind !== "compensated" ||
    outcome.operationId !== plan.operationId ||
    outcome.revisionGroupId !== revisionGroupId ||
    outcome.disposition !== "rolled_back" ||
    outcome.entries.length !== plan.entries.length
  ) {
    return false;
  }
  return outcome.entries.every((restored, entryIndex) => {
    const entry = plan.entries[entryIndex]!;
    if (restored.entryIndex !== entryIndex || restored.kind !== entry.kind) {
      return false;
    }
    switch (entry.kind) {
      case "create":
        return (
          restored.kind === "create" &&
          restored.absent &&
          identityEquals(restored.identity, entry.after.identity)
        );
      case "update":
        return (
          restored.kind === "update" &&
          restoredVersionMatchesSnapshot(
            restored.restored,
            entry.before.expectedVersion,
          )
        );
      case "move":
        return (
          restored.kind === "move" &&
          restoredVersionMatchesSnapshot(
            restored.sourceRestored,
            entry.source.expectedVersion,
          ) &&
          (entry.destinationBefore === undefined
            ? restored.destination.kind === "absent" &&
              identityEquals(restored.destination.identity, entry.after.identity)
            : restored.destination.kind === "restored" &&
              restoredVersionMatchesSnapshot(
                restored.destination.version,
                entry.destinationBefore.expectedVersion,
              ))
        );
      case "delete":
        return (
          restored.kind === "delete" &&
          restoredVersionMatchesSnapshot(
            restored.restored,
            entry.before.expectedVersion,
          )
        );
    }
  });
}

function failed(
  operationId: string,
  code: RejectedMutationResult extends infer _T
    ? Extract<DocumentMutationResult, { kind: "failed" }>["code"]
    : never,
): Extract<DocumentMutationResult, { kind: "failed" }> {
  return { kind: "failed", operationId, code };
}

async function safeEmit(
  emitter: DocumentMutationDiagnosticEmitter | undefined,
  diagnostic: DocumentMutationDiagnosticInput,
): Promise<void> {
  try {
    await emitter?.emit(diagnostic);
  } catch {
    // Observation only.
  }
}

export function createDocumentMutationCoordinator<
  K extends DocumentMutationBackendKind,
  Prepared,
  Receipt extends BackendCommitReceipt<K>,
>(
  dependencies: DocumentMutationCoordinatorDependencies<K, Prepared, Receipt>,
): DocumentMutationCoordinator {
  const { backend } = dependencies;
  const emit = (
    input: DocumentMutationCoordinatorInput,
    operationId: string,
    phase: DocumentMutationDiagnosticInput["phase"],
    outcome: DocumentMutationDiagnosticInput["outcome"],
    severity: DocumentMutationDiagnosticInput["severity"],
  ) =>
    safeEmit(dependencies.diagnostics, {
      operationId,
      backend: backend.kind,
      lane: input.lane,
      phase,
      outcome,
      severity,
    });

  type CoordinatorValidationOutcome =
    | Extract<DocumentCommitPlanValidationOutcome, { kind: "invalid" }>
    | {
        readonly kind: "valid";
        readonly plan: DocumentCommitPlan;
        readonly successfulOutcome: SuccessfulMutationOutcome;
      };

  const validate = async (
    input: DocumentMutationCoordinatorInput,
  ): Promise<CoordinatorValidationOutcome> => {
    await emit(input, input.operationId, "validate", "started", "debug");
    try {
      const result = await validateDocumentCommitPlan(
        input.plan,
        backend.kind,
        dependencies.hashBytes,
      );
      const correlatedPlan: DocumentCommitPlanValidationOutcome =
        result.kind === "valid" && result.plan.operationId !== input.operationId
          ? {
              kind: "invalid" as const,
              code: "invalid_plan" as const,
              diagnostics: [
                {
                  code: "schema_invalid" as const,
                  message: "plan operationId must equal the trusted operationId",
                  path: ["operationId"],
                },
              ],
            }
          : result;
      let correlated: CoordinatorValidationOutcome;
      if (correlatedPlan.kind === "valid") {
        const successfulOutcome = deriveSuccessfulOutcome(
          input,
          correlatedPlan.plan,
        );
        correlated =
          successfulOutcome === undefined
            ? {
                kind: "invalid",
                code: "invalid_plan",
                diagnostics: [
                  {
                    code: "schema_invalid",
                    message:
                      "editor-save intent, lane, base version, and exact patch postimage must agree",
                    path: ["editorSave"],
                  },
                ],
              }
            : {
                ...correlatedPlan,
                successfulOutcome,
              };
      } else {
        correlated = correlatedPlan;
      }
      await emit(
        input,
        input.operationId,
        "validate",
        correlated.kind === "valid" ? "succeeded" : "rejected",
        correlated.kind === "valid" ? "debug" : "warning",
      );
      return correlated;
    } catch {
      await emit(input, input.operationId, "validate", "failed", "error");
      return {
        kind: "invalid",
        code: "hash_failure",
        diagnostics: [
          { code: "hash_failure", message: "plan validation failed", path: [] },
        ],
      };
    }
  };

  const acquire = async (
    input: DocumentMutationCoordinatorInput,
    plan: DocumentCommitPlan,
  ): Promise<DocumentLockLease | undefined> => {
    await emit(input, plan.operationId, "lock", "started", "debug");
    try {
      const lease = await dependencies.lockManager.acquire(
        deriveDocumentLockKeys(plan),
      );
      await emit(input, plan.operationId, "lock", "succeeded", "debug");
      return lease;
    } catch {
      await emit(input, plan.operationId, "lock", "failed", "error");
      return undefined;
    }
  };

  const dispose = async (prepared: Prepared): Promise<void> => {
    try {
      await backend.disposePrepared(prepared);
    } catch {
      // Disposal is idempotent resource cleanup and cannot alter mutation truth.
    }
  };

  const release = async (lease: DocumentLockLease): Promise<void> => {
    try {
      await lease.release();
    } catch {
      // Lock cleanup failure cannot rewrite an already-classified mutation.
    }
  };

  const reject = (
    result: RejectedMutationResult,
  ): DocumentMutationCoordinatorOutcome => ({ kind: "rejected", result });

  const admissionResult = (
    plan: BackendCommitPlan<K>,
    outcome: HumanEditAdmissionOutcome<K>,
  ): RejectedMutationResult | undefined => {
    if (outcome.kind === "blocked") {
      return failed(plan.operationId, "backend_failure");
    }
    return outcome.kind === "conflict"
      ? conflictResult(backend.kind, plan, outcome)
      : undefined;
  };

  const normalizeCommitConflict = (
    plan: BackendCommitPlan<K>,
    code: "stale_version" | "human_edit_conflict" | "reapply_required",
  ): "stale_version" | "human_edit_conflict" | "reapply_required" =>
    plan.actor.kind === "agent" && code === "stale_version"
      ? "reapply_required"
      : code;

  const canRebaseAgentText = (
    plan: BackendCommitPlan<K>,
    lane: DocumentMutationLane,
    code: "stale_version" | "human_edit_conflict" | "reapply_required",
  ): boolean =>
    code === "stale_version" &&
    plan.actor.kind === "agent" &&
    (lane === "apply_patch" || lane === "file_tool");

  const conflictVersionKey = (
    outcome: { readonly evidence: readonly BackendConflictEvidence<K>[] },
  ): string =>
    JSON.stringify(
      outcome.evidence.map(({ currentVersion }) => currentVersion),
    );

  const rebaseFromConflict = async (
    input: DocumentMutationCoordinatorInput,
    plan: BackendCommitPlan<K>,
    outcome: {
      readonly code: "stale_version" | "human_edit_conflict" | "reapply_required";
      readonly evidence: readonly BackendConflictEvidence<K>[];
      readonly currentSnapshots?:
        | readonly BackendConflictSnapshot<K>[]
        | undefined;
    },
  ): Promise<
    | {
        readonly kind: "rebased";
        readonly plan: BackendCommitPlan<K>;
      }
    | { readonly kind: "rejected"; readonly result: RejectedMutationResult }
  > => {
    const publicConflict = conflictResult(backend.kind, plan, outcome);
    if (publicConflict === undefined) {
      return {
        kind: "rejected",
        result: failed(plan.operationId, "backend_failure"),
      };
    }
    if (!canRebaseAgentText(plan, input.lane, outcome.code)) {
      return { kind: "rejected", result: publicConflict };
    }
    const rebased = await rebaseStaleTextPlan({
      plan,
      evidence: outcome.evidence,
      currentSnapshots: outcome.currentSnapshots,
      hashBytes: dependencies.hashBytes,
    });
    if (rebased.kind === "conflict") {
      return {
        kind: "rejected",
        result: {
          ...publicConflict,
          code: rebased.code,
        },
      };
    }
    const validation = await validateDocumentCommitPlan(
      rebased.plan,
      backend.kind,
      dependencies.hashBytes,
    );
    if (
      validation.kind !== "valid" ||
      validation.plan.operationId !== input.operationId
    ) {
      return {
        kind: "rejected",
        result: failed(plan.operationId, "backend_failure"),
      };
    }
    return {
      kind: "rebased",
      plan: validation.plan as BackendCommitPlan<K>,
    };
  };

  return {
    preview: async (input) => {
      const validation = await validate(input);
      if (validation.kind === "invalid") {
        return failed(input.operationId, "invalid_plan");
      }
      const plan = validation.plan as BackendCommitPlan<K>;
      const lease = await acquire(input, plan);
      if (lease === undefined) return failed(plan.operationId, "backend_failure");
      let prepared: Prepared | undefined;
      let hasPrepared = false;
      try {
        const admission = dependencies.humanEditAdmission?.prepare({
          plan,
          lane: input.lane,
        });
        if (admission !== undefined && admission.kind !== "admitted") {
          return (
            admissionResult(plan, admission) ??
            failed(plan.operationId, "backend_failure")
          );
        }
        await emit(input, plan.operationId, "prepare", "started", "debug");
        try {
          const outcome = await backend.prepare(plan);
          if (outcome.kind === "prepared") {
            prepared = outcome.prepared;
            hasPrepared = true;
            await emit(input, plan.operationId, "prepare", "succeeded", "debug");
            return {
              kind: "prepared",
              operationId: plan.operationId,
              backend: backend.kind,
              paths: expectedPaths(plan),
            };
          }
          await emit(input, plan.operationId, "prepare", "rejected", "warning");
          const conflict =
            outcome.kind === "conflict"
              ? conflictResult(backend.kind, plan, outcome)
              : undefined;
          return conflict ?? failed(
                plan.operationId,
                outcome.kind === "conflict" ? "backend_failure" : outcome.code,
              );
        } catch {
          await emit(input, plan.operationId, "prepare", "failed", "error");
          return failed(plan.operationId, "backend_failure");
        }
      } finally {
        if (hasPrepared) await dispose(prepared as Prepared);
        await release(lease);
      }
    },

    execute: async (input) => {
      const validation = await validate(input);
      if (validation.kind === "invalid") {
        return reject(failed(input.operationId, "invalid_plan"));
      }
      let plan = validation.plan as BackendCommitPlan<K>;
      let successfulOutcome = validation.successfulOutcome;
      const paths = expectedPaths(plan);
      const lease = await acquire(input, plan);
      if (lease === undefined) {
        return reject(failed(plan.operationId, "backend_failure"));
      }

      let prepared: Prepared | undefined;
      let hasPrepared = false;
      let revisionGroupIdHint: string | undefined;
      let admissionSnapshot: HumanEditAdmissionSnapshot = [];
      type RebaseableConflict = Extract<
        | Awaited<ReturnType<typeof backend.prepare>>
        | Awaited<ReturnType<typeof backend.commitPrepared>>,
        { readonly kind: "conflict" }
      >;
      type PrepareAttempt =
        | {
            readonly kind: "prepared";
            readonly prepared: Prepared;
            readonly revisionGroupIdHint?: string;
          }
        | {
            readonly kind: "rejected";
            readonly result: RejectedMutationResult;
          };
      const prepareWithRebases = async (
        initialConflict?: RebaseableConflict,
        observedStaleVersions = new Set<string>(),
      ): Promise<PrepareAttempt> => {
        let outcome: Awaited<ReturnType<typeof backend.prepare>>;
        try {
          outcome = initialConflict ?? await backend.prepare(plan);
        } catch {
          return {
            kind: "rejected",
            result: failed(plan.operationId, "backend_failure"),
          };
        }
        while (outcome.kind === "conflict") {
          const staleVersionKey = conflictVersionKey(outcome);
          if (observedStaleVersions.has(staleVersionKey)) {
            return {
              kind: "rejected",
              result:
                conflictResult(backend.kind, plan, {
                  ...outcome,
                  code: normalizeCommitConflict(plan, outcome.code),
                }) ?? failed(plan.operationId, "backend_failure"),
            };
          }
          observedStaleVersions.add(staleVersionKey);
          const staleRebase = await rebaseFromConflict(input, plan, outcome);
          if (staleRebase.kind === "rejected") return staleRebase;

          plan = staleRebase.plan;
          successfulOutcome = "rebased";
          const admission = dependencies.humanEditAdmission?.prepare({
            plan,
            lane: input.lane,
          });
          if (admission !== undefined && admission.kind !== "admitted") {
            return {
              kind: "rejected",
              result:
                admissionResult(plan, admission) ??
                failed(plan.operationId, "backend_failure"),
            };
          }
          admissionSnapshot = admission?.snapshot ?? [];
          try {
            outcome = await backend.prepare(plan);
          } catch {
            return {
              kind: "rejected",
              result: failed(plan.operationId, "backend_failure"),
            };
          }
        }
        return outcome.kind === "prepared"
          ? {
              kind: "prepared",
              prepared: outcome.prepared,
              ...(outcome.revisionGroupIdHint === undefined
                ? {}
                : { revisionGroupIdHint: outcome.revisionGroupIdHint }),
            }
          : {
              kind: "rejected",
              result: failed(plan.operationId, outcome.code),
            };
      };
      try {
        const admission = dependencies.humanEditAdmission?.prepare({
          plan,
          lane: input.lane,
        });
        if (admission !== undefined && admission.kind !== "admitted") {
          return reject(
            admissionResult(plan, admission) ??
              failed(plan.operationId, "backend_failure"),
          );
        }
        admissionSnapshot = admission?.snapshot ?? [];
        await emit(input, plan.operationId, "prepare", "started", "debug");
        const preparation = await prepareWithRebases();
        if (preparation.kind === "rejected") {
          await emit(input, plan.operationId, "prepare", "rejected", "warning");
          return reject(preparation.result);
        }
        prepared = preparation.prepared;
        hasPrepared = true;
        revisionGroupIdHint = preparation.revisionGroupIdHint;
        await emit(input, plan.operationId, "prepare", "succeeded", "debug");

        let revisionGroupId: string;
        await emit(input, plan.operationId, "history", "started", "debug");
        try {
          if (revisionGroupIdHint !== undefined) {
            if (
              typeof revisionGroupIdHint !== "string" ||
              revisionGroupIdHint.trim().length === 0
            ) {
              await emit(input, plan.operationId, "history", "failed", "error");
              return reject(failed(plan.operationId, "backend_failure"));
            }
            revisionGroupId = revisionGroupIdHint;
          } else {
            revisionGroupId = await dependencies.allocateRevisionGroupId({
              backend: backend.kind,
              lane: input.lane,
              operationId: plan.operationId,
              actor: plan.actor,
              ...(plan.turnId === undefined ? {} : { turnId: plan.turnId }),
            });
          }
          if (typeof revisionGroupId !== "string" || revisionGroupId.trim().length === 0) {
            await emit(input, plan.operationId, "history", "failed", "error");
            return reject(failed(plan.operationId, "backend_failure"));
          }
        } catch {
          await emit(input, plan.operationId, "history", "failed", "error");
          return reject(failed(plan.operationId, "backend_failure"));
        }
        await emit(input, plan.operationId, "history", "succeeded", "debug");

        const compensate = async (receipt?: Receipt): Promise<boolean> => {
          await emit(input, plan.operationId, "compensate", "started", "warning");
          try {
            const outcome = await backend.compensate({
              plan,
              prepared: prepared as Prepared,
              revisionGroupId,
              ...(receipt === undefined ? {} : { receipt }),
            });
            const restored = restorationMatchesPlan(
              plan,
              revisionGroupId,
              outcome,
            );
            await emit(
              input,
              plan.operationId,
              "compensate",
              restored ? "succeeded" : "failed",
              restored ? "info" : "error",
            );
            return restored;
          } catch {
            await emit(input, plan.operationId, "compensate", "failed", "error");
            return false;
          }
        };

        await emit(input, plan.operationId, "commit", "started", "debug");
        let commit: Awaited<ReturnType<typeof backend.commitPrepared>>;
        const observedCommitStaleVersions = new Set<string>();
        while (true) {
          const finalAdmission = dependencies.humanEditAdmission?.verify({
            plan,
            lane: input.lane,
            snapshot: admissionSnapshot,
          });
          if (finalAdmission !== undefined && finalAdmission.kind !== "admitted") {
            await emit(input, plan.operationId, "commit", "rejected", "warning");
            return reject(
              admissionResult(plan, finalAdmission) ??
                failed(plan.operationId, "backend_failure"),
            );
          }
          try {
            commit = await backend.commitPrepared({
              plan,
              prepared,
              revisionGroupId,
              buildCommittedEventBatch: (receipt) =>
                buildAtomicDocumentMutationEventBatch({
                  backend: backend.kind,
                  plan,
                  receipt,
                  revisionGroupId,
                  outcome: successfulOutcome,
                }),
            });
          } catch {
            await emit(input, plan.operationId, "commit", "failed", "error");
            return (await compensate())
              ? reject(failed(plan.operationId, "backend_failure"))
              : {
                  kind: "recovery_required",
                  commitState: "unknown",
                  operationId: plan.operationId,
                  revisionGroupId,
                  code: "inconsistent_outcome",
                  paths,
                  events: [],
                };
          }
          if (commit.kind !== "conflict") break;

          await dispose(prepared);
          hasPrepared = false;
          prepared = undefined;
          await emit(input, plan.operationId, "prepare", "started", "debug");
          const retryPreparation = await prepareWithRebases(
            commit,
            observedCommitStaleVersions,
          );
          if (retryPreparation.kind === "rejected") {
            await emit(input, plan.operationId, "prepare", "rejected", "warning");
            return reject(retryPreparation.result);
          }
          if (
            retryPreparation.revisionGroupIdHint !== undefined &&
            retryPreparation.revisionGroupIdHint !== revisionGroupId
          ) {
            await dispose(retryPreparation.prepared);
            await emit(input, plan.operationId, "prepare", "failed", "error");
            return reject(failed(plan.operationId, "backend_failure"));
          }
          prepared = retryPreparation.prepared;
          hasPrepared = true;
          await emit(input, plan.operationId, "prepare", "succeeded", "debug");
        }
        if (commit.kind === "failed") {
          await emit(input, plan.operationId, "commit", "failed", "error");
          if (!commit.requiresCompensation) {
            return reject(failed(plan.operationId, commit.code));
          }
          return (await compensate())
            ? reject(failed(plan.operationId, "backend_failure"))
            : {
                kind: "recovery_required",
                commitState: "unknown",
                operationId: plan.operationId,
                revisionGroupId,
                code: "inconsistent_outcome",
                paths,
                events: [],
              };
        }
        await emit(input, plan.operationId, "commit", "succeeded", "info");

        const validEnlistment = validateAtomicDocumentMutationEventBatch({
          backend: backend.kind,
          plan,
          receipt: commit.receipt,
          revisionGroupId,
          outcome: successfulOutcome,
          batch: commit.enlistedEventBatch,
        });
        if (!validEnlistment) {
          await emit(input, plan.operationId, "event", "failed", "error");
          // A malformed/missing batch means the committed transaction may
          // contain unknown durable event truth. Byte restoration alone cannot
          // prove that outbox truth was cancelled, so ordinary compensation is
          // insufficient and would misclassify the outcome.
          return {
            kind: "recovery_required",
            commitState: "committed",
            operationId: plan.operationId,
            revisionGroupId,
            code: "inconsistent_outcome",
            paths,
            events: [],
          };
        }

        const eventBatch = commit.enlistedEventBatch;
        const events = eventBatch.events;
        if (commit.freshlyCommitted === true) {
          try { await dependencies.onFreshCommit?.(events); } catch { /* Business success is independent. */ }
        }
        await emit(input, plan.operationId, "event", "started", "debug");
        let publication: EventPublicationOutcome;
        try {
          publication =
            await dependencies.eventPublisher.publishAtomic(eventBatch);
        } catch {
          publication = { kind: "unknown" };
        }

        if (publication.kind === "published") {
          await emit(input, plan.operationId, "event", "succeeded", "info");
        } else {
          // The exact batch is already durable. Its outbox owns retry; live
          // delivery uncertainty can never roll back or obscure commit truth.
          await emit(input, plan.operationId, "event", "pending", "warning");
        }

        return {
          kind: "completed",
          commitState: "committed",
          result: {
            kind: successfulOutcome,
            operationId: plan.operationId,
            revisionGroupId,
            paths,
          },
          events,
        };
      } catch {
        return {
          kind: "recovery_required",
          commitState: "unknown",
          operationId: plan.operationId,
          code: "inconsistent_outcome",
          paths,
          events: [],
        };
      } finally {
        if (hasPrepared) await dispose(prepared as Prepared);
        await release(lease);
      }
    },
  };
}

export type { BackendRestoredEntryReceipt };
