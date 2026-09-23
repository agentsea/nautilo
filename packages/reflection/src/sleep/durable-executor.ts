import type {
  HierarchyBudget,
  HierarchyBudgetUsage,
  RecordRef,
} from "../contracts/hierarchy";
import {
  ORGANIZER_BATCH_MAX_ITEMS,
  partitionOrganizerProposal,
  projectOrganizerBatchPrompt,
  runOrganizer,
  runOrganizerBatch,
  type OrganizerChangeReason,
  type OrganizerBatchItemResult,
  type OrganizerInput,
  type OrganizerRecordInput,
  type PartitionedOrganizeProposal,
} from "../organizer/processor";
import type { DurableSleepItemLatencySample } from "./latency-diagnostics";

export const DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN = 16;

/**
 * One closed work-intent policy. Persistence stores only the reason; ordering
 * and not-before behavior are derived here instead of becoming another source
 * of truth.
 */
export const DURABLE_SLEEP_WORK_INTENT_POLICY_V1 = Object.freeze({
  version: "durable-sleep-work-intent-v1",
  promotionDelayMilliseconds: 5 * 60 * 1_000,
  reasonStrength: Object.freeze({
    scheduled_review: 0,
    created: 1,
    revised: 2,
    dependency_lost: 3,
    parent_conflict: 4,
  }),
} as const);

/** One centralized durable cooldown policy; quarantined work is never abandoned. */
export const DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1 = Object.freeze({
  version: "durable-sleep-quarantine-recovery-v1",
  initialDelayMilliseconds: 15 * 60 * 1_000,
  backoffMultiplier: 4,
  maximumDelayMilliseconds: 7 * 24 * 60 * 60 * 1_000,
} as const);

export function durableSleepQuarantineRecoveryDelayMilliseconds(
  recoveryRound: number,
): number {
  if (!Number.isSafeInteger(recoveryRound) || recoveryRound < 1) {
    throw new RangeError("quarantine recovery round must be a positive integer");
  }
  return Math.min(
    DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.maximumDelayMilliseconds,
    DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.initialDelayMilliseconds
      * DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.backoffMultiplier
        ** (recoveryRound - 1),
  );
}

/** A persisted semantic-work row resumes at exactly one of these stages. */
export type DurableSleepStage =
  | "authority_projection"
  | "search_projection"
  | "organization";

/**
 * Highest semantic stage admitted for one bounded executor run. Stages form an
 * ordered prefix: later stages may rely on every earlier checkpoint, so a
 * caller cannot admit a later stage while excluding one of its prerequisites.
 */
export interface DurableSleepStageAdmission {
  readonly maximumStage: DurableSleepStage;
}

export const DURABLE_SLEEP_ALL_STAGE_ADMISSION: DurableSleepStageAdmission =
  Object.freeze({ maximumStage: "organization" });

export interface DurableSleepClaimOptions {
  readonly maximumStage?: DurableSleepStage;
  /**
   * Data-only representation admission selected outside the Reflection family.
   * Durable work stores use only current representation-head metadata; they do
   * not resolve or interpret encryption policy.
   */
  readonly representationAdmission?: Readonly<{
    readonly ordinary: "any" | "without_protected_head" | "none";
    readonly protected: "authority_projection" | "organization" | "none";
  }>;
  /** @deprecated Use maximumStage. Retained for existing internal adapters. */
  readonly includeOrganization?: boolean;
}

/**
 * Content-free lease returned by the durable adapter. Source statements,
 * audiences, prompts, and representation details never belong in work state.
 */
export interface DurableSleepClaim {
  readonly logicalObjectRef: string;
  readonly generation: number;
  readonly recordRef: RecordRef;
  readonly changeReason: DurableSleepChangeReason;
  readonly stage: DurableSleepStage;
  readonly leaseToken: string;
  /** Durable admission and first-claim coordinates for exact queue/service time. */
  readonly timing?: Readonly<{
    readonly admittedAtEpochMs: number;
    readonly firstClaimedAtEpochMs: number;
    readonly claimedAtEpochMs: number;
    readonly claimStoreElapsedMs: number;
  }>;
  /** Ephemeral content-free fact for per-run recovery diagnostics. */
  readonly recoveredFromQuarantine?: boolean;
}

export type DurableSleepChangeReason =
  | OrganizerChangeReason
  | "parent_conflict";

export type DurableSleepFailureCode =
  | "authority_unavailable"
  | "record_unavailable"
  | "embedding_unavailable"
  | "projection_unavailable"
  | "candidate_unavailable"
  | "invalid_model_output"
  | "publication_unavailable"
  | "unexpected_failure";

export type DurableSleepOrdinaryFallbackReason =
  | "recoverable_availability"
  | "key_waiting";

/**
 * Closed, content-free refinement used for diagnostics and retry-policy
 * evidence. It must never carry Record, Room, source, prompt, or provider data.
 */
export type DurableSleepFailureDetail =
  | "candidate_projection_stale"
  | "candidate_rank_timeout"
  | "candidate_rank_storage_unavailable"
  | "candidate_topology_timeout"
  | "candidate_topology_storage_unavailable"
  | "candidate_topology_capacity_exceeded"
  | "candidate_fence_stale"
  | "candidate_fence_timeout"
  | "candidate_fence_storage_unavailable"
  | "candidate_record_changed"
  | "candidate_selection_invalid"
  | "parent_conflict_capacity_exceeded"
  | "parent_conflict_storage_unavailable"
  | "publication_source_unavailable"
  | "publication_evidence_unavailable"
  | "publication_validation_unavailable"
  | "publication_budget_exhausted"
  | "publication_integrity_unavailable"
  | "publication_repository_rejected"
  | "publication_unexpected_exception"
  | "publication_record_already_exists"
  | "publication_invalid_record_shape"
  | "publication_child_unavailable"
  | "publication_child_parent_changed"
  | "publication_height_mismatch"
  | "publication_ancestor_cycle"
  | "publication_predecessor_changed"
  | "publication_successor_changed"
  | "publication_plan_stale"
  | "publication_authority_fence_stale"
  | "publication_plan_invalid"
  | "publication_memory_fence_unavailable"
  | "publication_access_audience_unavailable"
  | "publication_legacy_leaf_unavailable"
  | "publication_input_access_audience_unavailable"
  | "publication_output_access_audience_unavailable"
  | "publication_revalidation_access_audience_unavailable"
  | "publication_source_authority_unavailable"
  | "publication_incomplete"
  | "unexpected_authority_stage_failure"
  | "unexpected_search_projection_stage_failure"
  | "unexpected_dependency_loss_stage_failure"
  | "unexpected_candidate_stage_failure"
  | "unexpected_model_invocation_failure"
  | "unexpected_proposal_validation_failure"
  | "unexpected_publication_stage_failure"
  | "unexpected_work_mutation_failure";

export type DurableSleepClaimResult =
  | { readonly status: "empty" }
  | {
      readonly status: "claimed";
      readonly claim: DurableSleepClaim;
      /** Ephemeral dispatch fact; never persisted in the semantic work row. */
      readonly executionRepresentation?: "ordinary" | "protected";
      /** Exact claim-local ceiling selected atomically with the durable lease. */
      readonly maximumStage?: DurableSleepStage;
    };

export type DurableSleepLeaseResult =
  | {
      readonly status: "accepted";
      readonly timing?: Readonly<{
        readonly completedAtEpochMs: number;
        readonly mutationElapsedMs: number;
      }>;
    }
  | { readonly status: "superseded" | "lease_lost" };

export type DurableSleepDeferralResult =
  | { readonly status: "deferred" | "quarantined" }
  | { readonly status: "superseded" | "lease_lost" };

export type DurableSleepModelLaneReadiness =
  | { readonly status: "ready" }
  | Readonly<{
      status: "cooldown";
      retryAfterMilliseconds: number;
    }>;

/** Stable, content-free signal for a transient provider-lane outage. */
export class DurableSleepModelLaneUnavailableError extends Error {
  readonly retryAfterMilliseconds: number;

  constructor(retryAfterMilliseconds: number) {
    if (
      !Number.isSafeInteger(retryAfterMilliseconds)
      || retryAfterMilliseconds < 1
    ) {
      throw new RangeError("model lane retry delay must be a positive safe integer");
    }
    super("Reflection model lane is temporarily unavailable");
    this.name = "DurableSleepModelLaneUnavailableError";
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

/**
 * The provider may have accepted a paid model operation, but the caller did
 * not receive a trustworthy terminal result. Completing the exact durable
 * generation prevents an automatic replay across later scheduler passes.
 */
export class DurableSleepProviderOutcomeUnknownError extends Error {
  constructor() {
    super("Reflection provider outcome is unknown");
    this.name = "DurableSleepProviderOutcomeUnknownError";
  }
}

export interface DurableSleepWorkPort {
  /** Claims at most one due generation and owns all lease/attempt policy. */
  claimNext(
    signal?: AbortSignal,
    options?: DurableSleepClaimOptions,
  ): Promise<DurableSleepClaimResult>;
  /** Monotonic stage checkpoint for the exact claimed generation. */
  checkpoint(input: {
    readonly claim: DurableSleepClaim;
    readonly completedStage: "authority_projection" | "search_projection";
  }): Promise<DurableSleepLeaseResult>;
  /** Return a claimed generation to due state without charging a failure attempt. */
  pause(input: {
    readonly claim: DurableSleepClaim;
    /** Absolute epoch milliseconds for a readiness wait; omission is due now. */
    readonly nextAttemptAt?: number;
  }): Promise<DurableSleepLeaseResult>;
  complete(input: {
    readonly claim: DurableSleepClaim;
    readonly ordinaryFallbackReason?: DurableSleepOrdinaryFallbackReason;
  }): Promise<DurableSleepLeaseResult>;
  defer(input: {
    readonly claim: DurableSleepClaim;
    readonly failureCode: DurableSleepFailureCode;
  }): Promise<DurableSleepDeferralResult>;
  /** Coalesced admission is adapter-owned and monotonically generation-aware. */
  enqueue(input: {
    readonly logicalObjectRef: string;
    readonly generation: number;
    readonly recordRef: RecordRef;
    readonly changeReason: OrganizerChangeReason;
  }): Promise<void>;
}

export type DurableSleepReadinessResult =
  | { readonly status: "ready" }
  | {
      /** Current authority/key material is expected to become available later. */
      readonly status: "waiting";
      /** Absolute epoch milliseconds; the durable work store owns eligibility. */
      readonly retryAt: number;
    }
  | {
      readonly status: "unavailable";
      readonly failureCode: DurableSleepFailureCode;
      readonly failureDetail?: DurableSleepFailureDetail;
    };

/**
 * One already-authorized, same-Room semantic view. Handles are call-local;
 * product IDs and source authority material remain only in dependency bindings.
 */
export interface DurableSleepOrganizerView {
  readonly changed: OrganizerRecordInput;
  readonly candidates: readonly OrganizerRecordInput[];
  readonly existingParents: readonly OrganizerRecordInput[];
  readonly maxSelectedChildren: number;
  /**
   * Opaque bridge-owned exact-plan token. Reflection neither opens nor derives
   * product authority from it; it only returns the token with the accepted
   * proposal so the bridge can revalidate the same bounded plan.
   */
  readonly applicationPlanToken?: string;
  /** Bounded content-free planning diagnostics for operator health only. */
  readonly planning?: Readonly<{
    sameRoomPlans: 0 | 1;
    crossRoomPlans: 0 | 1;
    candidatesOpened: number;
    unsupportedAuthorityShapes: number;
    authorityParentsResolved: number;
    authorityParentsSkipped: number;
    protectedExecutionUnavailable: number;
    readonly sameRoomElapsedMs?: number;
    readonly crossRoomElapsedMs?: number;
    readonly selectedOpenElapsedMs?: number;
  }>;
}

export type DurableSleepTerminalOutcome =
  | "record_lifecycle_obsolete"
  | "already_covered"
  | "unsupported_authority_shape"
  | "no_effective_audience"
  | "provider_outcome_unknown"
  | "protected_execution_unavailable";

export type DurableSleepOrganizerViewResult =
  | { readonly status: "ready"; readonly view: DurableSleepOrganizerView }
  | {
      /** A durable protected execution job is still waiting for its grant. */
      readonly status: "waiting";
      /** Absolute epoch milliseconds; the durable work store owns eligibility. */
      readonly retryAt: number;
    }
  | {
      /** Terminal for this exact generation; it must not retry or quarantine. */
      readonly status: "no_change";
      readonly reason: DurableSleepTerminalOutcome;
    }
  | {
      readonly status: "unavailable";
      readonly failureCode: DurableSleepFailureCode;
      readonly failureDetail?: DurableSleepFailureDetail;
    };

export type DurableDependencyLossResolutionResult =
  | { readonly status: "not_applicable" }
  | {
      /** Current authority/key material is expected to become available later. */
      readonly status: "waiting";
      /** Absolute epoch milliseconds; the durable work store owns eligibility. */
      readonly retryAt: number;
    }
  | {
      readonly status: "unavailable";
      readonly failureCode: DurableSleepFailureCode;
      readonly failureDetail?: DurableSleepFailureDetail;
    }
  | {
      readonly status: "applied";
      /** A grounded successor retaining all currently available support. */
      readonly outcome: "partial_replacement";
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
      readonly changedRecord: {
        readonly logicalObjectRef: string;
        readonly generation: number;
        readonly recordRef: RecordRef;
      };
    }
  | {
      readonly status: "applied";
      /** No support remains, so the derived Record is sunset in place. */
      readonly outcome: "total_sunset";
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
      readonly changedRecord: {
        readonly logicalObjectRef: string;
        readonly generation: number;
        readonly recordRef: RecordRef;
      };
    };

export type DurableParentConflictResolutionResult =
  | { readonly status: "not_applicable" }
  | {
      readonly status: "unavailable";
      readonly failureCode: DurableSleepFailureCode;
      readonly failureDetail: Extract<
        DurableSleepFailureDetail,
        "parent_conflict_capacity_exceeded" | "parent_conflict_storage_unavailable"
      >;
    }
  | {
      readonly status: "applied";
      readonly retiredParents: number;
      readonly requeuedRecords: number;
    };

export type DurableSleepOrganizationOutcome = "completed" | "failed" | "unavailable" | "cancelled";

/** One admitted organization lifetime; durable work and retries remain family-owned. */
export interface DurableSleepOrganizationAttempt {
  assertCurrent(): Promise<void>;
  publish<T>(publish: () => Promise<T>): Promise<T>;
  close(outcome: DurableSleepOrganizationOutcome): Promise<void>;
}

export class DurableSleepOrganizationUnavailableError extends Error {
  constructor() { super("reflection_organization_unavailable"); }
}

export interface DurableSleepSemanticPort {
  openOrganizationAttempt?(
    claim: DurableSleepClaim, signal?: AbortSignal,
  ): Promise<DurableSleepOrganizationAttempt>;
  /**
   * Atomically retires every current derived parent in one legacy conflict
   * and durably re-admits its surviving Record support. The adapter consumes
   * the exact claim by advancing its generation when a repair is applied.
   */
  resolveParentConflict(input: {
    readonly claim: DurableSleepClaim;
    readonly signal?: AbortSignal;
  }): Promise<DurableParentConflictResolutionResult>;
  /** Process-local lane gate; cooldown excludes only model-bearing claims. */
  modelLaneReadiness?(
    signal?: AbortSignal,
  ): Promise<DurableSleepModelLaneReadiness>;
  /** Must establish current terminal authority without opening payload bytes. */
  ensureAuthority(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult>;
  /** Runs only after authority is current; selected payload opening is adapter-owned. */
  ensureSearchProjection(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult>;
  /** Returns only eligible same-Room Records/Memories after both projections. */
  loadOrganizerView(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepOrganizerViewResult>;
  /**
   * Revalidate a dirty derived Record's exact dependencies before any ordinary
   * changed-neighbor prompt. Partial loss publishes a grounded replacement;
   * total loss sunsets. Stable identity, budget, and recursive replay handling
   * remain owned by the pure state machine.
   */
  resolveDependencyLoss(input: {
    readonly claim: DurableSleepClaim;
    readonly idempotencyKey: string;
    readonly budget: HierarchyBudget;
    readonly publication?: Pick<DurableSleepOrganizationAttempt, "publish" | "assertCurrent">;
    readonly signal?: AbortSignal;
  }): Promise<DurableDependencyLossResolutionResult>;
  /**
   * Invoke the configured Organizer lane for this already-authorized claim.
   * The adapter derives transient Room/owner usage binding; it is never stored
   * in the content-free claim.
   */
  invokeOrganizer(
    claim: DurableSleepClaim,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Optional production batching seam. Claims are already independently
   * authorized; the first claim is used only for provider usage attribution.
   */
  invokeOrganizerBatch?(
    claims: readonly DurableSleepClaim[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Publishes or replays one immutable deterministic application. */
  applyProposal(input: {
    readonly claim: DurableSleepClaim;
    readonly proposal: PartitionedOrganizeProposal;
    readonly applicationPlanToken?: string;
    readonly idempotencyKey: string;
    readonly budget: HierarchyBudget;
    readonly signal?: AbortSignal;
  }): Promise<DurableSleepApplyResult>;
}

export type DurableSleepApplyResult =
  | {
      readonly status: "applied";
      /**
       * The operation that was actually applied. A deterministic publication
       * gate may safely contract create_parent or extend_parent to no_change
       * when the proposed support is redundant or overlaps an existing
       * evidence closure. It may never substitute a different mutation.
       */
      readonly operation: PartitionedOrganizeProposal["operation"];
      readonly replayed: boolean;
      readonly usage: HierarchyBudgetUsage;
      /** Terminal authority contraction produced after the model but before publication. */
      readonly terminalOutcome?: Extract<
        DurableSleepTerminalOutcome,
        "unsupported_authority_shape" | "no_effective_audience"
      >;
      /**
       * Present when publication or lifecycle mutation changed a Record that
       * must itself receive recursively coalesced semantic work.
       */
      readonly changedRecord?: {
        readonly logicalObjectRef: string;
        readonly generation: number;
        readonly recordRef: RecordRef;
      };
      /** Content-free bridge decomposition; omitted by legacy/test adapters. */
      readonly timing?: Readonly<{
        readonly publicationPlanningElapsedMs: number;
        readonly finalAuthorityElapsedMs: number;
        readonly productPublicationElapsedMs: number;
        readonly recursiveAdmissionElapsedMs: number;
      }>;
    }
  | {
      /**
       * The prepared topology changed after the model answered. Rebuild this
       * exact generation without charging another failed semantic attempt.
       */
      readonly status: "stale";
      readonly failureDetail: Extract<
        DurableSleepFailureDetail,
        | "publication_child_unavailable"
        | "publication_child_parent_changed"
        | "publication_predecessor_changed"
        | "publication_successor_changed"
        | "publication_plan_stale"
        | "publication_authority_fence_stale"
      >;
    }
  | {
      readonly status: "unavailable";
      readonly failureCode: DurableSleepFailureCode;
      readonly failureDetail?: DurableSleepFailureDetail;
    };

export interface DurableSleepRunBudget {
  readonly hierarchy: HierarchyBudget;
  /** Bounded claims, including work that defers before model invocation. */
  readonly maxWorkItems: number;
}

export interface DurableSleepRunResult {
  readonly usage: HierarchyBudgetUsage;
  /** Scheduler delay after a transient provider-lane failure or cooldown. */
  readonly modelRetryAfterMilliseconds?: number;
  /** Bounded, content-free latency and invocation evidence for operators. */
  readonly diagnostics: Readonly<{
    readonly authorityElapsedMs: number;
    readonly searchProjectionElapsedMs: number;
    readonly candidateElapsedMs: number;
    readonly modelElapsedMs: number;
    readonly publicationElapsedMs: number;
    readonly modelAttempts: number;
    readonly modelFailures: number;
    readonly deterministicNoChanges: number;
    readonly modelBatches: number;
    readonly modelBatchItems: number;
    readonly batchStaleRescheduled: number;
  }>;
  /** Completed, identifier-free items for the bounded Runtime rolling window. */
  readonly completedItemLatencies: readonly DurableSleepItemLatencySample[];
  readonly claimed: number;
  readonly checkpointed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly paused: number;
  readonly quarantined: number;
  readonly recovered: number;
  readonly superseded: number;
  readonly leaseLost: number;
  readonly operations: Readonly<Record<PartitionedOrganizeProposal["operation"], number>>;
  readonly failures: Readonly<Partial<Record<DurableSleepFailureCode, number>>>;
  readonly failureDetails?: Readonly<Partial<Record<DurableSleepFailureDetail, number>>>;
  /** Stable terminal planning outcomes that consume no retry attempt. */
  readonly terminalOutcomes: Readonly<Partial<Record<DurableSleepTerminalOutcome, number>>>;
  readonly planning: Readonly<{
    sameRoomPlans: number;
    crossRoomPlans: number;
    sameRoomCompletions: number;
    crossRoomCompletions: number;
    candidatesOpened: number;
    unsupportedAuthorityShapes: number;
    authorityParentsResolved: number;
    authorityParentsSkipped: number;
    protectedExecutionUnavailable: number;
  }>;
  readonly budgetExhausted: boolean;
}

function zeroUsage(): HierarchyBudgetUsage {
  return { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 };
}

function addUsage(
  left: HierarchyBudgetUsage,
  right: HierarchyBudgetUsage,
): HierarchyBudgetUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    visitedRecords: left.visitedRecords + right.visitedRecords,
    createdRecords: left.createdRecords + right.createdRecords,
    traversalWork: left.traversalWork + right.traversalWork,
  };
}

function remainingBudget(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
): HierarchyBudget {
  return {
    maxModelCalls: Math.max(0, budget.maxModelCalls - usage.modelCalls),
    maxVisitedRecords: Math.max(0, budget.maxVisitedRecords - usage.visitedRecords),
    maxCreatedRecords: Math.max(0, budget.maxCreatedRecords - usage.createdRecords),
    maxTraversalWork: Math.max(0, budget.maxTraversalWork - usage.traversalWork),
    maxStatementCharacters: budget.maxStatementCharacters,
  };
}

function reserveAllowsAnotherModelOperation(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
): boolean {
  return budget.maxModelCalls - usage.modelCalls >= 2
    && budget.maxCreatedRecords - usage.createdRecords >= 1;
}

function assertRunBudget(budget: DurableSleepRunBudget): void {
  if (
    !Number.isSafeInteger(budget.maxWorkItems)
    || budget.maxWorkItems < 1
    || budget.maxWorkItems > DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN
  ) {
    throw new RangeError(
      `durable Sleep maxWorkItems must be between 1 and ${DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN}`,
    );
  }
  for (const [name, value] of Object.entries(budget.hierarchy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`durable Sleep ${name} must be a non-negative safe integer`);
    }
  }
}

const DURABLE_SLEEP_STAGE_ORDER: Readonly<Record<DurableSleepStage, number>> =
  Object.freeze({
    authority_projection: 0,
    search_projection: 1,
    organization: 2,
  });

function requireDurableSleepStage(
  value: string,
  label: string,
): asserts value is DurableSleepStage {
  if (DURABLE_SLEEP_STAGE_ORDER[value as DurableSleepStage] === undefined) {
    throw new TypeError(`durable Sleep ${label} is invalid`);
  }
}

function earlierDurableSleepStage(
  left: DurableSleepStage,
  right: DurableSleepStage,
): DurableSleepStage {
  return DURABLE_SLEEP_STAGE_ORDER[left] <= DURABLE_SLEEP_STAGE_ORDER[right]
    ? left
    : right;
}

function stageIsAdmitted(
  stage: DurableSleepStage,
  maximumStage: DurableSleepStage,
): boolean {
  return DURABLE_SLEEP_STAGE_ORDER[stage] <= DURABLE_SLEEP_STAGE_ORDER[maximumStage];
}

function requireClaim(claim: DurableSleepClaim): void {
  const refs = [claim.logicalObjectRef, claim.recordRef, claim.leaseToken];
  if (refs.some((value) => value.trim().length === 0)) {
    throw new TypeError("durable Sleep claim requires non-empty opaque references");
  }
  if (!Number.isSafeInteger(claim.generation) || claim.generation < 0) {
    throw new RangeError("durable Sleep generation must be a non-negative safe integer");
  }
  requireDurableSleepStage(claim.stage, "claim stage");
  if (claim.timing !== undefined) {
    for (const [label, value] of Object.entries(claim.timing)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`durable Sleep claim ${label} must be non-negative`);
      }
    }
    if (
      claim.timing.firstClaimedAtEpochMs < claim.timing.admittedAtEpochMs
      || claim.timing.claimedAtEpochMs < claim.timing.firstClaimedAtEpochMs
    ) {
      throw new RangeError("durable Sleep claim timing is not monotonic");
    }
  }
}

const MAXIMUM_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

function requireReadinessWaitingRetryAt(
  readiness: Readonly<{ retryAt: number }>,
  currentTime: number,
): number {
  if (
    !Number.isSafeInteger(readiness.retryAt)
    || readiness.retryAt <= currentTime
    || readiness.retryAt > MAXIMUM_DATE_EPOCH_MILLISECONDS
  ) {
    throw new RangeError(
      "durable Sleep readiness retryAt must be a future bounded timestamp",
    );
  }
  return readiness.retryAt;
}

function viewFitsWorstCaseOperation(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
  view: DurableSleepOrganizerView,
): boolean {
  const semanticVisits = 1 + view.candidates.length + view.existingParents.length;
  const maximumApplicationVisits = view.maxSelectedChildren
    + (view.existingParents.length > 0 ? 1 : 0);
  return usage.visitedRecords + semanticVisits + maximumApplicationVisits
      <= budget.maxVisitedRecords
    && usage.traversalWork + 1 + view.maxSelectedChildren <= budget.maxTraversalWork;
}

function viewWorstCaseReservation(view: DurableSleepOrganizerView): Readonly<{
  visitedRecords: number;
  traversalWork: number;
}> {
  return {
    visitedRecords:
      1
      + view.candidates.length
      + view.existingParents.length
      + view.maxSelectedChildren
      + (view.existingParents.length > 0 ? 1 : 0),
    traversalWork: 1 + view.maxSelectedChildren,
  };
}

function organizerViewTopologyRefs(view: DurableSleepOrganizerView): ReadonlySet<RecordRef> {
  const refs = new Set<RecordRef>();
  for (const entry of [view.changed, ...view.candidates, ...view.existingParents]) {
    refs.add(entry.snapshot.recordRef);
    for (const childRef of entry.snapshot.childRecordRefs) refs.add(childRef);
  }
  return refs;
}

function usageFitsBudget(
  usage: HierarchyBudgetUsage,
  budget: HierarchyBudget,
): boolean {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) return false;
  }
  return usage.modelCalls <= budget.maxModelCalls
    && usage.visitedRecords <= budget.maxVisitedRecords
    && usage.createdRecords <= budget.maxCreatedRecords
    && usage.traversalWork <= budget.maxTraversalWork;
}

function organizerInput(
  claim: DurableSleepClaim,
  view: DurableSleepOrganizerView,
): OrganizerInput {
  return {
    changed: view.changed,
    candidates: view.candidates,
    existingParents: view.existingParents,
    changeReason: organizerChangeReason(claim.changeReason),
    maxSelectedChildren: view.maxSelectedChildren,
  };
}

function organizerChangeReason(
  reason: DurableSleepChangeReason,
): OrganizerChangeReason {
  if (reason === "parent_conflict") {
    throw new TypeError("parent-conflict work cannot enter the Organizer");
  }
  return reason;
}

function operationCounts(): Record<PartitionedOrganizeProposal["operation"], number> {
  return {
    no_change: 0,
    create_parent: 0,
    extend_parent: 0,
    wrap_parent: 0,
    supersede_parent: 0,
    resolve_parent: 0,
    dissolve_parent: 0,
  };
}

type OrganizerOperationFeasibility =
  | "model_required"
  | "already_covered"
  | "no_legal_operation";

/**
 * Decide only whether the already-filtered view can express any legal model
 * operation. Candidate adapters own bounded ancestry/evidence redundancy and
 * authority filtering; this gate never guesses from wording or similarity.
 * Unknown or potentially useful views fail open to the Organizer.
 */
function organizerOperationFeasibility(
  view: DurableSleepOrganizerView,
): OrganizerOperationFeasibility {
  const alreadyCovered = view.existingParents.some((parent) =>
    parent.snapshot.posture === "derived"
    && parent.snapshot.lifecycle === "current"
    && parent.snapshot.childRecordRefs.includes(view.changed.snapshot.recordRef)
  );
  if (alreadyCovered) return "already_covered";

  // create_parent needs changed + at least one independent candidate;
  // extend_parent/wrap_parent need one current parent plus at least one
  // addition. The
  // adapters have already removed structurally redundant candidates.
  const canCreate = view.maxSelectedChildren >= 2 && view.candidates.length > 0;
  const canExtend = view.maxSelectedChildren >= 1 && view.existingParents.length > 0;
  return canCreate || canExtend ? "model_required" : "no_legal_operation";
}

function applicationMatchesProposal(
  requested: PartitionedOrganizeProposal["operation"],
  applied: PartitionedOrganizeProposal["operation"],
): boolean {
  return applied === requested
    || (applied === "no_change"
      && (
        requested === "create_parent"
        || requested === "extend_parent"
        || requested === "wrap_parent"
      ));
}

/**
 * Run bounded, change-driven semantic work over injected durable ports.
 *
 * The adapter owns persistence and representation details. This state machine
 * owns projection order, model reserve, deterministic dependency partitioning,
 * and per-claim failure isolation. Publication transactions own all successor
 * admission so a completed claim cannot double-advance the new Record's work
 * generation. Each claim performs
 * exactly one durable stage: an accepted checkpoint releases its lease and the
 * next stage must be reclaimed, which makes every stage a restart boundary.
 */
export async function runDurableHierarchySleep(input: {
  readonly work: DurableSleepWorkPort;
  readonly semantic: DurableSleepSemanticPort;
  readonly budget: DurableSleepRunBudget;
  readonly stageAdmission?: DurableSleepStageAdmission;
  readonly signal?: AbortSignal;
  /** Deterministic test seam; production uses the process clock. */
  readonly now?: () => number;
}): Promise<DurableSleepRunResult> {
  assertRunBudget(input.budget);
  const admittedMaximumStage = input.stageAdmission?.maximumStage
    ?? DURABLE_SLEEP_ALL_STAGE_ADMISSION.maximumStage;
  requireDurableSleepStage(admittedMaximumStage, "stage admission maximum");
  const now = input.now ?? Date.now;
  let usage = zeroUsage();
  const diagnostics = {
    authorityElapsedMs: 0,
    searchProjectionElapsedMs: 0,
    candidateElapsedMs: 0,
    modelElapsedMs: 0,
    publicationElapsedMs: 0,
    modelAttempts: 0,
    modelFailures: 0,
    deterministicNoChanges: 0,
    modelBatches: 0,
    modelBatchItems: 0,
    batchStaleRescheduled: 0,
  };
  const completedItemLatencies: DurableSleepItemLatencySample[] = [];
  type ItemAccumulator = {
    claimStoreElapsedMs: number;
    authorityElapsedMs: number | null;
    searchProjectionElapsedMs: number | null;
    sameRoomCandidateElapsedMs: number;
    crossRoomCandidateElapsedMs: number;
    selectedOpenElapsedMs: number;
    promptConstructionElapsedMs: number;
    promptInputCount: number;
    promptCodePoints: number;
    modelElapsedMs: number;
    modelAttempts: number;
    modelFailures: number;
    proposalValidationElapsedMs: number;
    publicationPlanningElapsedMs: number;
    finalAuthorityElapsedMs: number;
    productPublicationElapsedMs: number;
    recursiveAdmissionElapsedMs: number;
  };
  const itemAccumulators = new Map<string, ItemAccumulator>();
  const itemCoordinate = (claim: DurableSleepClaim): string =>
    `${claim.recordRef}\0${claim.generation}`;
  const accumulatorFor = (claim: DurableSleepClaim): ItemAccumulator | undefined => {
    if (claim.timing === undefined) return undefined;
    const coordinate = itemCoordinate(claim);
    const existing = itemAccumulators.get(coordinate);
    if (existing !== undefined) {
      existing.claimStoreElapsedMs += claim.timing.claimStoreElapsedMs;
      return existing;
    }
    const created: ItemAccumulator = {
      claimStoreElapsedMs: claim.timing.claimStoreElapsedMs,
      authorityElapsedMs: null,
      searchProjectionElapsedMs: null,
      sameRoomCandidateElapsedMs: 0,
      crossRoomCandidateElapsedMs: 0,
      selectedOpenElapsedMs: 0,
      promptConstructionElapsedMs: 0,
      promptInputCount: 0,
      promptCodePoints: 0,
      modelElapsedMs: 0,
      modelAttempts: 0,
      modelFailures: 0,
      proposalValidationElapsedMs: 0,
      publicationPlanningElapsedMs: 0,
      finalAuthorityElapsedMs: 0,
      productPublicationElapsedMs: 0,
      recursiveAdmissionElapsedMs: 0,
    };
    itemAccumulators.set(coordinate, created);
    return created;
  };
  const recordCompletedItem = (
    claim: DurableSleepClaim,
    completion: DurableSleepLeaseResult,
    lane: "same_room" | "cross_room",
  ): void => {
    if (
      claim.timing === undefined
      || completion.status !== "accepted"
      || completion.timing === undefined
    ) return;
    const accumulator = itemAccumulators.get(itemCoordinate(claim));
    if (accumulator === undefined) return;
    const completionElapsedMs = completion.timing.mutationElapsedMs;
    const endToEndElapsedMs = Math.max(
      0,
      completion.timing.completedAtEpochMs - claim.timing.admittedAtEpochMs,
    );
    completedItemLatencies.push(Object.freeze({
      lane,
      queueElapsedMs: Math.max(
        0,
        claim.timing.firstClaimedAtEpochMs - claim.timing.admittedAtEpochMs,
      ),
      claimStoreElapsedMs: accumulator.claimStoreElapsedMs,
      authorityElapsedMs: accumulator.authorityElapsedMs,
      searchProjectionElapsedMs: accumulator.searchProjectionElapsedMs,
      sameRoomCandidateElapsedMs: accumulator.sameRoomCandidateElapsedMs,
      crossRoomCandidateElapsedMs: accumulator.crossRoomCandidateElapsedMs,
      selectedOpenElapsedMs: accumulator.selectedOpenElapsedMs,
      promptConstructionElapsedMs: accumulator.promptConstructionElapsedMs,
      promptInputCount: accumulator.promptInputCount,
      promptCodePoints: accumulator.promptCodePoints,
      modelElapsedMs: accumulator.modelElapsedMs,
      modelAttempts: accumulator.modelAttempts,
      modelRepairs: Math.max(0, accumulator.modelAttempts - 1),
      modelFailures: accumulator.modelFailures,
      proposalValidationElapsedMs: accumulator.proposalValidationElapsedMs,
      publicationPlanningElapsedMs: accumulator.publicationPlanningElapsedMs,
      finalAuthorityElapsedMs: accumulator.finalAuthorityElapsedMs,
      productPublicationElapsedMs: accumulator.productPublicationElapsedMs,
      completionElapsedMs,
      recursiveAdmissionElapsedMs: accumulator.recursiveAdmissionElapsedMs,
      endToEndElapsedMs,
    }));
    itemAccumulators.delete(itemCoordinate(claim));
  };
  let claimed = 0;
  let checkpointed = 0;
  let completed = 0;
  let deferred = 0;
  let paused = 0;
  let quarantined = 0;
  let recovered = 0;
  let superseded = 0;
  let leaseLost = 0;
  let pausedForBudget = false;
  let modelRetryAfterMilliseconds: number | undefined;
  const operations = operationCounts();
  const failures: Partial<Record<DurableSleepFailureCode, number>> = {};
  const failureDetails: Partial<Record<DurableSleepFailureDetail, number>> = {};
  const terminalOutcomes: Partial<Record<DurableSleepTerminalOutcome, number>> = {};
  const planning = {
    sameRoomPlans: 0,
    crossRoomPlans: 0,
    sameRoomCompletions: 0,
    crossRoomCompletions: 0,
    candidatesOpened: 0,
    unsupportedAuthorityShapes: 0,
    authorityParentsResolved: 0,
    authorityParentsSkipped: 0,
    protectedExecutionUnavailable: 0,
  };
  const attemptedClaims = new Set<string>();

  const acceptLeaseResult = (result: DurableSleepLeaseResult): boolean => {
    if (result.status === "accepted") return true;
    if (result.status === "superseded") superseded += 1;
    else leaseLost += 1;
    return false;
  };
  const deferClaim = async (
    claim: DurableSleepClaim,
    failureCode: DurableSleepFailureCode,
    failureDetail?: DurableSleepFailureDetail,
  ): Promise<void> => {
    failures[failureCode] = (failures[failureCode] ?? 0) + 1;
    if (failureDetail !== undefined) {
      failureDetails[failureDetail] = (failureDetails[failureDetail] ?? 0) + 1;
    }
    try {
      const result = await input.work.defer({ claim, failureCode });
      switch (result.status) {
        case "deferred": deferred += 1; break;
        case "quarantined": quarantined += 1; break;
        case "superseded": superseded += 1; break;
        case "lease_lost": leaseLost += 1; break;
      }
    } catch {
      failures.unexpected_failure = (failures.unexpected_failure ?? 0) + 1;
      failureDetails.unexpected_work_mutation_failure =
        (failureDetails.unexpected_work_mutation_failure ?? 0) + 1;
    }
  };

  const closeAttempt = async (attempt: DurableSleepOrganizationAttempt | undefined, outcome: DurableSleepOrganizationOutcome) => {
    try { await attempt?.close(outcome); } catch { /* Teardown never changes canonical work outcomes. */ }
  };
  type PendingOrganizerItem = {
    claim: DurableSleepClaim;
    view: DurableSleepOrganizerView;
    accumulator?: ItemAccumulator;
    attempt?: DurableSleepOrganizationAttempt;
    outcome: DurableSleepOrganizationOutcome;
  };
  const pendingOrganizer: PendingOrganizerItem[] = [];
  const pauseClaim = async (
    claim: DurableSleepClaim,
    nextAttemptAt?: number,
  ): Promise<void> => {
    const result = await input.work.pause({
      claim,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    });
    if (result.status === "accepted") paused += 1;
    else if (result.status === "superseded") superseded += 1;
    else leaseLost += 1;
  };
  const completeTerminalClaim = async (
    claim: DurableSleepClaim,
    reason: DurableSleepTerminalOutcome,
    mode: "same_room" | "cross_room" = "same_room",
  ): Promise<boolean> => {
    operations.no_change += 1;
    terminalOutcomes[reason] = (terminalOutcomes[reason] ?? 0) + 1;
    const completion = await input.work.complete({ claim });
    if (!acceptLeaseResult(completion)) return false;
    completed += 1;
    recordCompletedItem(claim, completion, mode);
    return true;
  };
  const pendingFitsWorstCase = (view: DurableSleepOrganizerView): boolean => {
    const reserved = [...pendingOrganizer.map((item) => item.view), view]
      .map(viewWorstCaseReservation)
      .reduce(
        (sum, item) => ({
          visitedRecords: sum.visitedRecords + item.visitedRecords,
          traversalWork: sum.traversalWork + item.traversalWork,
        }),
        { visitedRecords: 0, traversalWork: 0 },
      );
    return usage.visitedRecords + reserved.visitedRecords
        <= input.budget.hierarchy.maxVisitedRecords
      && usage.traversalWork + reserved.traversalWork
        <= input.budget.hierarchy.maxTraversalWork
      && usage.createdRecords + pendingOrganizer.length + 1
        <= input.budget.hierarchy.maxCreatedRecords;
  };
  const flushOrganizerBatch = async (): Promise<void> => {
    if (pendingOrganizer.length === 0) return;
    const batch = pendingOrganizer.splice(0, pendingOrganizer.length);
    try {
    if (input.signal?.aborted) {
      for (const item of batch) { item.outcome = "cancelled"; await pauseClaim(item.claim); }
      return;
    }
    // A revoked sibling is removed before prompt construction, preserving the
    // remaining claim order and their independent publication opportunities.
    for (let index = batch.length - 1; index >= 0; index--) {
      const item = batch[index]!;
      try { await item.attempt?.assertCurrent(); }
      catch {
        batch.splice(index, 1);
        try { await deferClaim(item.claim, "authority_unavailable"); }
        finally { await closeAttempt(item.attempt, input.signal?.aborted ? "cancelled" : "unavailable"); }
      }
    }
    if (batch.length === 0) return;
    const usesBatchPort = input.semantic.invokeOrganizerBatch !== undefined;
    diagnostics.modelBatches += usesBatchPort ? 1 : batch.length;
    diagnostics.modelBatchItems += batch.length;
    const hasAccumulator = batch.some((item) => item.accumulator !== undefined);
    const organizerStartedAt = hasAccumulator ? now() : undefined;
    let organizerModelFinishedAt = organizerStartedAt ?? 0;
    let organized: Awaited<ReturnType<typeof runOrganizerBatch>>;
    const invokeModel = async (
      invocationItems: readonly PendingOrganizerItem[],
      prompt: string,
      signal?: AbortSignal,
    ): Promise<string> => {
      for (const item of invocationItems) await item.attempt?.assertCurrent();
      diagnostics.modelAttempts += 1;
      usage = addUsage(usage, {
        modelCalls: 1,
        visitedRecords: 0,
        createdRecords: 0,
        traversalWork: 0,
      });
      const startedAt = now();
      for (const item of invocationItems) {
        if (item.accumulator === undefined) continue;
        item.accumulator.promptConstructionElapsedMs += Math.max(
          0,
          Math.round(startedAt - organizerModelFinishedAt),
        );
        item.accumulator.promptInputCount =
          1 + item.view.candidates.length + item.view.existingParents.length;
        item.accumulator.promptCodePoints = Array.from(prompt).length;
        item.accumulator.modelAttempts += 1;
      }
      try {
        return usesBatchPort
          ? await input.semantic.invokeOrganizerBatch!(
              invocationItems.map((item) => item.claim),
              prompt,
              signal,
            )
          : await input.semantic.invokeOrganizer(
              invocationItems[0]!.claim,
              prompt,
              signal,
            );
      } catch (error) {
        diagnostics.modelFailures += 1;
        for (const item of invocationItems) {
          if (item.accumulator !== undefined) item.accumulator.modelFailures += 1;
        }
        throw error;
      } finally {
        const finishedAt = now();
        const elapsed = Math.max(0, Math.round(finishedAt - startedAt));
        diagnostics.modelElapsedMs += elapsed;
        for (const item of invocationItems) {
          if (item.accumulator !== undefined) item.accumulator.modelElapsedMs += elapsed;
        }
        organizerModelFinishedAt = finishedAt;
      }
    };
    try {
      if (usesBatchPort) {
        organized = await runOrganizerBatch({
          snapshots: batch.map((item) => organizerInput(item.claim, item.view)),
          invoke: (prompt, signal, indexes) => invokeModel(indexes.map((index) => batch[index]!), prompt, signal),
          assertRepairCurrent: (index) => batch[index]!.attempt?.assertCurrent() ?? Promise.resolve(),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } else {
        const results: OrganizerBatchItemResult[] = [];
        for (const [index, item] of batch.entries()) {
          const result = await runOrganizer({
            snapshot: organizerInput(item.claim, item.view),
            invoke: (prompt, signal) => invokeModel([item], prompt, signal),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          results.push({ question: `Q${index + 1}`, result });
        }
        organized = results;
      }
    } catch (error) {
      for (const item of batch) item.outcome = input.signal?.aborted ? "cancelled"
        : error instanceof DurableSleepOrganizationUnavailableError || error instanceof DurableSleepModelLaneUnavailableError ? "unavailable" : "failed";
      if (error instanceof DurableSleepProviderOutcomeUnknownError) {
        for (const item of batch) {
          await completeTerminalClaim(
            item.claim,
            "provider_outcome_unknown",
            item.view.applicationPlanToken === undefined ? "same_room" : "cross_room",
          );
        }
        return;
      }
      if (error instanceof DurableSleepOrganizationUnavailableError) {
        for (const item of batch) await deferClaim(item.claim, "authority_unavailable");
        return;
      }
      if (error instanceof DurableSleepModelLaneUnavailableError) {
        modelRetryAfterMilliseconds = Math.max(
          modelRetryAfterMilliseconds ?? 0,
          error.retryAfterMilliseconds,
        );
        for (const item of batch) await pauseClaim(item.claim);
        return;
      }
      if (input.signal?.aborted) {
        for (const item of batch) await pauseClaim(item.claim);
        return;
      }
      for (const item of batch) {
        await deferClaim(
          item.claim,
          "unexpected_failure",
          "unexpected_model_invocation_failure",
        );
      }
      return;
    }

    const totalOrganizerElapsedMs = organizerStartedAt === undefined
      ? 0
      : Math.max(0, Math.round(now() - organizerStartedAt));
    for (const item of batch) {
      const semanticVisits =
        1 + item.view.candidates.length + item.view.existingParents.length;
      usage = addUsage(usage, {
        modelCalls: 0,
        visitedRecords: semanticVisits,
        createdRecords: 0,
        traversalWork: 1,
      });
      if (item.accumulator !== undefined) {
        item.accumulator.proposalValidationElapsedMs += Math.max(
          0,
          totalOrganizerElapsedMs
          - item.accumulator.promptConstructionElapsedMs
          - item.accumulator.modelElapsedMs,
        );
      }
    }

    const changedTopologyRefs = new Set<RecordRef>();
    for (const [index, item] of batch.entries()) {
      const organizedItem = organized[index];
      if (organizedItem?.result.ok === false && organizedItem.result.errorCode === "invocation_failed") {
        const error = organizedItem.result.error;
        if (input.signal?.aborted) {
          item.outcome = "cancelled";
          await pauseClaim(item.claim);
        } else if (error instanceof DurableSleepOrganizationUnavailableError) {
          item.outcome = "unavailable";
          await deferClaim(item.claim, "authority_unavailable");
        } else if (error instanceof DurableSleepModelLaneUnavailableError) {
          item.outcome = "unavailable";
          modelRetryAfterMilliseconds = Math.max(modelRetryAfterMilliseconds ?? 0, error.retryAfterMilliseconds);
          await pauseClaim(item.claim);
        } else if (error instanceof DurableSleepProviderOutcomeUnknownError) {
          await completeTerminalClaim(item.claim, "provider_outcome_unknown");
        } else {
          await deferClaim(item.claim, "unexpected_failure", "unexpected_model_invocation_failure");
        }
        continue;
      }
      if (organizedItem === undefined || !organizedItem.result.ok) {
        await deferClaim(item.claim, "invalid_model_output");
        continue;
      }
      const itemRefs = organizerViewTopologyRefs(item.view);
      if ([...itemRefs].some((recordRef) => changedTopologyRefs.has(recordRef))) {
        diagnostics.batchStaleRescheduled += 1;
        item.outcome = "unavailable";
        await pauseClaim(item.claim);
        continue;
      }
      try {
        const proposalValidationStartedAt = now();
        const proposal = partitionOrganizerProposal({
          proposal: organizedItem.result.proposal,
          selectedInputs: [item.view.changed, ...item.view.candidates],
          existingParents: item.view.existingParents,
        });
        if (item.accumulator !== undefined) {
          item.accumulator.proposalValidationElapsedMs += Math.max(
            0,
            Math.round(now() - proposalValidationStartedAt),
          );
        }
        const publicationStartedAt = now();
        let publicationElapsedMs = 0;
        let application: DurableSleepApplyResult;
        try {
          const publish = () => input.semantic.applyProposal({
            claim: item.claim,
            proposal,
            ...(item.view.applicationPlanToken === undefined
              ? {}
              : { applicationPlanToken: item.view.applicationPlanToken }),
            idempotencyKey:
              `sleep:${item.claim.logicalObjectRef}:${item.claim.generation}`,
            budget: remainingBudget(input.budget.hierarchy, usage),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          application = item.attempt ? await item.attempt.publish(publish) : await publish();
        } finally {
          publicationElapsedMs = Math.max(
            0,
            Math.round(now() - publicationStartedAt),
          );
          diagnostics.publicationElapsedMs += publicationElapsedMs;
        }
        if (application.status === "stale") {
          item.outcome = "unavailable";
          diagnostics.batchStaleRescheduled += 1;
          failureDetails[application.failureDetail] =
            (failureDetails[application.failureDetail] ?? 0) + 1;
          await pauseClaim(item.claim);
          continue;
        }
        if (application.status === "unavailable") {
          item.outcome = "unavailable";
          await deferClaim(
            item.claim,
            application.failureCode,
            application.failureDetail,
          );
          continue;
        }
        if (application.operation !== "no_change") item.outcome = "completed";
        if (!applicationMatchesProposal(proposal.operation, application.operation)) {
          throw new TypeError("durable Sleep application operation mismatch");
        }
        if (application.operation === "no_change" && proposal.operation !== "no_change") {
          diagnostics.deterministicNoChanges += 1;
        }
        if (application.terminalOutcome !== undefined) {
          if (application.operation !== "no_change") {
            throw new TypeError("durable Sleep terminal application must be no_change");
          }
          terminalOutcomes[application.terminalOutcome] =
            (terminalOutcomes[application.terminalOutcome] ?? 0) + 1;
        }
        if (item.accumulator !== undefined && application.timing !== undefined) {
          item.accumulator.publicationPlanningElapsedMs +=
            application.timing.publicationPlanningElapsedMs;
          item.accumulator.finalAuthorityElapsedMs +=
            application.timing.finalAuthorityElapsedMs;
          item.accumulator.productPublicationElapsedMs +=
            application.timing.productPublicationElapsedMs;
          item.accumulator.recursiveAdmissionElapsedMs +=
            application.timing.recursiveAdmissionElapsedMs;
        } else if (item.accumulator !== undefined) {
          item.accumulator.productPublicationElapsedMs += publicationElapsedMs;
        }
        usage = addUsage(usage, application.usage);
        operations[application.operation] += 1;
        if (
          application.changedRecord !== undefined
          && application.operation !== "no_change"
        ) {
          // Publication is already durable even if completing this older work
          // lease loses a generation race. Later answers in the same batch
          // must therefore treat every inspected overlapping coordinate stale.
          for (const recordRef of itemRefs) changedTopologyRefs.add(recordRef);
          changedTopologyRefs.add(application.changedRecord.recordRef);
        }
        const completion = await input.work.complete({ claim: item.claim });
        if (!acceptLeaseResult(completion)) {
          if (item.outcome !== "completed") item.outcome = "unavailable";
          continue;
        }
        item.outcome = "completed";
        completed += 1;
        recordCompletedItem(
          item.claim,
          completion,
          item.view.applicationPlanToken === undefined ? "same_room" : "cross_room",
        );
        if (item.view.applicationPlanToken === undefined) {
          planning.sameRoomCompletions += 1;
        } else {
          planning.crossRoomCompletions += 1;
        }
      } catch (error) {
        if (item.outcome !== "completed" && error instanceof DurableSleepOrganizationUnavailableError) {
          item.outcome = "unavailable";
          await deferClaim(item.claim, "authority_unavailable");
        } else if (input.signal?.aborted) {
          await pauseClaim(item.claim);
        } else {
          await deferClaim(
            item.claim,
            "unexpected_failure",
            "unexpected_publication_stage_failure",
          );
        }
      }
    }
    } finally {
      for (const item of batch) await closeAttempt(item.attempt,
        item.outcome === "completed" ? "completed" : input.signal?.aborted ? "cancelled" : item.outcome);
    }
  };

  try {
  while (claimed < input.budget.maxWorkItems) {
    if (input.signal?.aborted) break;
    if (
      admittedMaximumStage === "organization"
      && modelRetryAfterMilliseconds === undefined
      && input.semantic.modelLaneReadiness !== undefined
    ) {
      const lane = await input.semantic.modelLaneReadiness(input.signal);
      if (lane.status === "cooldown") {
        if (
          !Number.isSafeInteger(lane.retryAfterMilliseconds)
          || lane.retryAfterMilliseconds < 1
        ) {
          throw new TypeError("invalid Reflection model lane retry delay");
        }
        modelRetryAfterMilliseconds = lane.retryAfterMilliseconds;
      }
    }
    const dynamicMaximumStage = modelRetryAfterMilliseconds === undefined
      && reserveAllowsAnotherModelOperation(input.budget.hierarchy, usage);
    const maximumStage = earlierDurableSleepStage(
      admittedMaximumStage,
      dynamicMaximumStage ? "organization" : "search_projection",
    );
    const next = await input.work.claimNext(input.signal, { maximumStage });
    if (next.status === "empty") {
      if (pendingOrganizer.length > 0) {
        await flushOrganizerBatch();
        continue;
      }
      break;
    }
    const claim = next.claim;
    requireClaim(claim);
    if (next.maximumStage !== undefined) {
      requireDurableSleepStage(next.maximumStage, "claim maximum stage");
    }
    const claimMaximumStage = next.maximumStage === undefined
      ? maximumStage
      : earlierDurableSleepStage(maximumStage, next.maximumStage);
    claimed += 1;
    if (claim.recoveredFromQuarantine === true) recovered += 1;

    // The durable adapter owns selection, but the pure executor also fences a
    // buggy adapter before any stage-specific semantic method can open data or
    // reach a provider. Pause releases the lease without charging a failure.
    if (!stageIsAdmitted(claim.stage, claimMaximumStage)) {
      const result = await input.work.pause({ claim });
      if (result.status === "accepted") paused += 1;
      else if (result.status === "superseded") superseded += 1;
      else leaseLost += 1;
      pausedForBudget = true;
      break;
    }
    const itemAccumulator = accumulatorFor(claim);

    // A short retry delay must not let one slow failed item consume all of the
    // same external poll. Return a repeated lease without charging an attempt;
    // the next scheduler poll may try it again after other due work progresses.
    const attemptCoordinate = [
      claim.recordRef,
      String(claim.generation),
      claim.stage,
    ].join("\0");
    if (attemptedClaims.has(attemptCoordinate)) {
      const result = await input.work.pause({ claim });
      if (result.status === "accepted") paused += 1;
      else if (result.status === "superseded") superseded += 1;
      else leaseLost += 1;
      pausedForBudget = true;
      break;
    }
    attemptedClaims.add(attemptCoordinate);

    let attempt: DurableSleepOrganizationAttempt | undefined;
    let attemptOutcome: DurableSleepOrganizationOutcome = "failed";
    let unexpectedFailureDetail: DurableSleepFailureDetail =
      "unexpected_work_mutation_failure";
    try {
      if (
        claim.changeReason === "parent_conflict"
        && claimMaximumStage !== "organization"
      ) {
        const result = await input.work.pause({ claim });
        if (result.status === "accepted") paused += 1;
        else if (result.status === "superseded") superseded += 1;
        else leaseLost += 1;
        pausedForBudget = true;
        break;
      }
      if (claim.changeReason === "parent_conflict") {
        unexpectedFailureDetail = "unexpected_candidate_stage_failure";
        const resolution = await input.semantic.resolveParentConflict({
          claim,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (resolution.status === "unavailable") {
          await deferClaim(
            claim,
            resolution.failureCode,
            resolution.failureDetail,
          );
          continue;
        }
        if (resolution.status === "not_applicable") {
          operations.no_change += 1;
          unexpectedFailureDetail = "unexpected_work_mutation_failure";
          const completion = await input.work.complete({ claim });
          if (!acceptLeaseResult(completion)) continue;
          completed += 1;
          itemAccumulators.delete(itemCoordinate(claim));
          continue;
        }
        operations.resolve_parent += 1;
        // An applied repair re-admits the conflict child in the same product
        // transaction. That generation supersedes this lease by design; no
        // second completion mutation is legal or necessary here.
        itemAccumulators.delete(itemCoordinate(claim));
        superseded += 1;
        continue;
      }

      if (claim.stage === "authority_projection") {
        unexpectedFailureDetail = "unexpected_authority_stage_failure";
        const startedAt = now();
        let authority: DurableSleepReadinessResult;
        try {
          authority = await input.semantic.ensureAuthority(claim, input.signal);
        } finally {
          const elapsed = Math.max(0, Math.round(now() - startedAt));
          diagnostics.authorityElapsedMs += elapsed;
          if (itemAccumulator !== undefined) itemAccumulator.authorityElapsedMs = elapsed;
        }
        if (authority.status === "unavailable") {
          await deferClaim(claim, authority.failureCode);
          continue;
        }
        if (authority.status === "waiting") {
          await pauseClaim(
            claim,
            requireReadinessWaitingRetryAt(authority, now()),
          );
          continue;
        }
        if (authority.status !== "ready") {
          throw new TypeError("Unknown durable Sleep authority readiness");
        }
        unexpectedFailureDetail = "unexpected_work_mutation_failure";
        const checkpoint = await input.work.checkpoint({
          claim,
          completedStage: "authority_projection",
        });
        if (
          itemAccumulator !== undefined
          && checkpoint.status === "accepted"
          && checkpoint.timing !== undefined
        ) {
          itemAccumulator.claimStoreElapsedMs += checkpoint.timing.mutationElapsedMs;
        }
        if (acceptLeaseResult(checkpoint)) checkpointed += 1;
        continue;
      }

      if (claim.stage === "search_projection") {
        unexpectedFailureDetail = "unexpected_search_projection_stage_failure";
        const startedAt = now();
        let projection: DurableSleepReadinessResult;
        try {
          projection = await input.semantic.ensureSearchProjection(claim, input.signal);
        } finally {
          const elapsed = Math.max(
            0,
            Math.round(now() - startedAt),
          );
          diagnostics.searchProjectionElapsedMs += elapsed;
          if (itemAccumulator !== undefined) {
            itemAccumulator.searchProjectionElapsedMs = elapsed;
          }
        }
        if (projection.status === "unavailable") {
          await deferClaim(claim, projection.failureCode);
          continue;
        }
        if (projection.status === "waiting") {
          await pauseClaim(
            claim,
            requireReadinessWaitingRetryAt(projection, now()),
          );
          continue;
        }
        if (projection.status !== "ready") {
          throw new TypeError("Unknown durable Sleep search readiness");
        }
        unexpectedFailureDetail = "unexpected_work_mutation_failure";
        const checkpoint = await input.work.checkpoint({
          claim,
          completedStage: "search_projection",
        });
        if (
          itemAccumulator !== undefined
          && checkpoint.status === "accepted"
          && checkpoint.timing !== undefined
        ) itemAccumulator.claimStoreElapsedMs += checkpoint.timing.mutationElapsedMs;
        if (acceptLeaseResult(checkpoint)) checkpointed += 1;
        continue;
      }

      if (claim.changeReason === "dependency_lost") {
        if (claimMaximumStage !== "organization") {
          const result = await input.work.pause({ claim });
          if (result.status === "accepted") paused += 1;
          else if (result.status === "superseded") superseded += 1;
          else leaseLost += 1;
          pausedForBudget = true;
          break;
        }
        attempt = await input.semantic.openOrganizationAttempt?.(claim, input.signal);
        await attempt?.assertCurrent();
        unexpectedFailureDetail = "unexpected_dependency_loss_stage_failure";
        const dependencyBudget = remainingBudget(input.budget.hierarchy, usage);
        const resolution = await input.semantic.resolveDependencyLoss({
          claim,
          idempotencyKey:
            `sleep-dependency-loss:${claim.logicalObjectRef}:${claim.generation}`,
          budget: dependencyBudget,
          ...(attempt ? { publication: attempt } : {}),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (resolution.status === "unavailable") {
          attemptOutcome = "unavailable";
          await deferClaim(claim, resolution.failureCode, resolution.failureDetail);
          continue;
        }
        if (resolution.status === "waiting") {
          attemptOutcome = "unavailable";
          await pauseClaim(
            claim,
            requireReadinessWaitingRetryAt(resolution, now()),
          );
          continue;
        }
        if (resolution.status === "not_applicable") {
          operations.no_change += 1;
          unexpectedFailureDetail = "unexpected_work_mutation_failure";
          await attempt?.assertCurrent();
          const completion = await input.work.complete({ claim });
          if (!acceptLeaseResult(completion)) { attemptOutcome = "unavailable"; continue; }
          attemptOutcome = "completed";
          completed += 1;
          recordCompletedItem(claim, completion, "same_room");
          continue;
        }
        attemptOutcome = "completed";
        if (!usageFitsBudget(resolution.usage, dependencyBudget)) {
          throw new RangeError("dependency-loss resolution exceeded its pure budget");
        }
        usage = addUsage(usage, resolution.usage);
        const operation = resolution.outcome === "partial_replacement"
          ? "supersede_parent"
          : "dissolve_parent";
        operations[operation] += 1;
        unexpectedFailureDetail = "unexpected_work_mutation_failure";
        const completion = await input.work.complete({ claim });
        if (!acceptLeaseResult(completion)) continue;
        completed += 1;
        recordCompletedItem(claim, completion, "same_room");
        continue;
      }

      if (claimMaximumStage !== "organization") {
        const result = await input.work.pause({ claim });
        if (result.status === "accepted") paused += 1;
        else if (result.status === "superseded") superseded += 1;
        else leaseLost += 1;
        pausedForBudget = true;
        break;
      }

      attempt = await input.semantic.openOrganizationAttempt?.(claim, input.signal);
      await attempt?.assertCurrent();
      unexpectedFailureDetail = "unexpected_candidate_stage_failure";
      const candidateStartedAt = now();
      let loaded: DurableSleepOrganizerViewResult;
      try {
        loaded = await input.semantic.loadOrganizerView(claim, input.signal);
      } finally {
        const elapsed = Math.max(
          0,
          Math.round(now() - candidateStartedAt),
        );
        diagnostics.candidateElapsedMs += elapsed;
        if (itemAccumulator !== undefined) {
          itemAccumulator.sameRoomCandidateElapsedMs = elapsed;
        }
      }
      if (loaded.status === "unavailable") {
        attemptOutcome = "unavailable";
        await deferClaim(claim, loaded.failureCode, loaded.failureDetail);
        continue;
      }
      if (loaded.status === "waiting") {
        attemptOutcome = "unavailable";
        await pauseClaim(
          claim,
          requireReadinessWaitingRetryAt(loaded, now()),
        );
        continue;
      }
      if (loaded.status === "no_change") {
        await attempt?.assertCurrent();
        operations.no_change += 1;
        diagnostics.deterministicNoChanges += 1;
        terminalOutcomes[loaded.reason] = (terminalOutcomes[loaded.reason] ?? 0) + 1;
        unexpectedFailureDetail = "unexpected_work_mutation_failure";
        const completion = await input.work.complete({ claim });
        if (!acceptLeaseResult(completion)) { attemptOutcome = "unavailable"; continue; }
        attemptOutcome = "completed";
        completed += 1;
        recordCompletedItem(claim, completion, "same_room");
        continue;
      }
      if (loaded.view.planning !== undefined) {
        planning.sameRoomPlans += loaded.view.planning.sameRoomPlans;
        planning.crossRoomPlans += loaded.view.planning.crossRoomPlans;
        planning.candidatesOpened += loaded.view.planning.candidatesOpened;
        planning.unsupportedAuthorityShapes +=
          loaded.view.planning.unsupportedAuthorityShapes;
        planning.authorityParentsResolved +=
          loaded.view.planning.authorityParentsResolved;
        planning.authorityParentsSkipped +=
          loaded.view.planning.authorityParentsSkipped;
        planning.protectedExecutionUnavailable +=
          loaded.view.planning.protectedExecutionUnavailable;
        if (itemAccumulator !== undefined) {
          itemAccumulator.sameRoomCandidateElapsedMs =
            loaded.view.planning.sameRoomElapsedMs
            ?? itemAccumulator.sameRoomCandidateElapsedMs;
          itemAccumulator.crossRoomCandidateElapsedMs =
            loaded.view.planning.crossRoomElapsedMs ?? 0;
          itemAccumulator.selectedOpenElapsedMs =
            loaded.view.planning.selectedOpenElapsedMs ?? 0;
        }
      }
      if (organizerOperationFeasibility(loaded.view) !== "model_required") {
        await attempt?.assertCurrent();
        operations.no_change += 1;
        diagnostics.deterministicNoChanges += 1;
        unexpectedFailureDetail = "unexpected_work_mutation_failure";
        const completion = await input.work.complete({ claim });
        if (!acceptLeaseResult(completion)) { attemptOutcome = "unavailable"; continue; }
        attemptOutcome = "completed";
        completed += 1;
        recordCompletedItem(
          claim,
          completion,
          loaded.view.applicationPlanToken === undefined ? "same_room" : "cross_room",
        );
        if (loaded.view.applicationPlanToken === undefined) {
          planning.sameRoomCompletions += 1;
        } else {
          planning.crossRoomCompletions += 1;
        }
        continue;
      }
      if (!pendingFitsWorstCase(loaded.view)) {
        if (pendingOrganizer.length > 0) {
          await flushOrganizerBatch();
        }
        if (!viewFitsWorstCaseOperation(input.budget.hierarchy, usage, loaded.view)) {
          attemptOutcome = "unavailable";
          await pauseClaim(claim);
          pausedForBudget = true;
          break;
        }
      }
      const projected = projectOrganizerBatchPrompt([
        ...pendingOrganizer.map((item) => organizerInput(item.claim, item.view)),
        organizerInput(claim, loaded.view),
      ]);
      if (!projected.ok && pendingOrganizer.length > 0) {
        await flushOrganizerBatch();
      }
      pendingOrganizer.push({
        ...(attempt ? { attempt } : {}),
        outcome: "failed",
        claim,
        view: loaded.view,
        ...(itemAccumulator === undefined ? {} : { accumulator: itemAccumulator }),
      });
      attempt = undefined; // The existing batch item now owns this lifetime.
      if (
        pendingOrganizer.length >= ORGANIZER_BATCH_MAX_ITEMS
        || input.semantic.invokeOrganizerBatch === undefined
        || !reserveAllowsAnotherModelOperation(input.budget.hierarchy, usage)
      ) {
        await flushOrganizerBatch();
      }
      continue;
    } catch (error) {
      if (error instanceof DurableSleepProviderOutcomeUnknownError) {
        await completeTerminalClaim(claim, "provider_outcome_unknown");
        attemptOutcome = "failed";
        continue;
      }
      if (input.signal?.aborted) break;
      if (error instanceof DurableSleepOrganizationUnavailableError) {
        attemptOutcome = "unavailable";
        await deferClaim(claim, "authority_unavailable");
        continue;
      }
      if (error instanceof DurableSleepModelLaneUnavailableError) {
        attemptOutcome = "unavailable";
        modelRetryAfterMilliseconds = Math.max(
          modelRetryAfterMilliseconds ?? 0,
          error.retryAfterMilliseconds,
        );
        const result = await input.work.pause({ claim });
        if (result.status === "accepted") paused += 1;
        else if (result.status === "superseded") superseded += 1;
        else leaseLost += 1;
        continue;
      }
      await deferClaim(claim, "unexpected_failure", unexpectedFailureDetail);
      void error;
    } finally {
      await closeAttempt(attempt, attemptOutcome === "completed" ? "completed"
        : input.signal?.aborted ? "cancelled" : attemptOutcome);
    }
  }

  await flushOrganizerBatch();
  } finally {
    for (const item of pendingOrganizer.splice(0)) await closeAttempt(item.attempt,
      input.signal?.aborted ? "cancelled" : "failed");
  }

  return {
    usage,
    ...(modelRetryAfterMilliseconds === undefined
      ? {}
      : { modelRetryAfterMilliseconds }),
    diagnostics,
    completedItemLatencies: Object.freeze([...completedItemLatencies]),
    claimed,
    checkpointed,
    completed,
    deferred,
    paused,
    quarantined,
    recovered,
    superseded,
    leaseLost,
    operations,
    failures,
    failureDetails,
    terminalOutcomes,
    planning,
    budgetExhausted:
      pausedForBudget
      || claimed >= input.budget.maxWorkItems
      || !reserveAllowsAnotherModelOperation(input.budget.hierarchy, usage),
  };
}
