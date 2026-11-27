import { getExternalRoomPolicy } from "@nautilo/trust";
import { log } from "@nautilo/logger";
import { createHmac } from "node:crypto";

import {
  embedTextWithProvenance,
  markModelInvokeFailure,
  modelInvokeCooldownRemainingMs,
  type AuthoredMemorySemanticChange,
  type RecallRecordsPort,
  type RecallRecordsPortForState,
  type ForegroundChatFundingSession,
} from "@nautilo/agent";
import {
  type DirectDatabase,
  resolveModelAttemptReplaySafety,
} from "@nautilo/db";
import {
  CANDIDATE_POLICY_V1,
  DurableSleepModelLaneUnavailableError,
  DurableSleepOrganizationUnavailableError,
  DurableSleepProviderOutcomeUnknownError,
  DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN,
  ORGANIZER_BATCH_MAX_ITEMS,
  runDependencyLossRewrite,
  type DurableSleepRunBudget,
  type DurableSleepClaim,
  type DurableSleepSemanticPort,
  type DurableSleepStageAdmission,
  type DurableSleepWorkPort,
  type DurableOrganizerProposalCheckpoint,
} from "@nautilo/reflection";
import type {
  ForegroundRecordContextPort,
} from "@nautilo/reflection/foreground";
import {
  RECORD_SEARCH_POLICY_V1,
  canonicalizeRecordEmbeddingV1,
  type RecordEmbeddingPort,
  type RecordEmbeddingRequest,
  type RecordEmbeddingResult,
  type RecordEvidencePort,
  type RecordSearchPort,
} from "@nautilo/reflection/search";
import type { DurableModelExposureDependency, DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { invocationAudienceIsEligible } from "@nautilo/reflection/authority";
import type { MemoryOperationBinding } from "@nautilo/types";
import {
  BoundedRecordEvidenceTraversalCheckpoints,
  BoundedRecordSearchTraversalCheckpoints,
  CROSS_ROOM_EXECUTION_PLAN_LIMITS,
  CanonicalRecordSourceReadPort,
  DualModeAuthorityFilteredRecordSearch,
  DualModeRecordRepository,
  DualModeSyntheticRecordEvidence,
  DurableRecordSemanticReadiness,
  ExactGroundedDependencyLossResolver,
  ExactCrossRoomPublicationPlanner,
  ExactRecordSourceEvidenceReader,
  InvocationEligibleHierarchyCoordinates,
  OrganizerProposalPublisher,
  OrdinaryCrossRoomOrganizerPartition,
  PostgresAuthorityFilteredRecordSearchStore,
  PostgresAuthorityProjectionStore,
  PostgresCrossRoomOrganizerStore,
  PostgresCurrentRecordPublicationBinding,
  PostgresRecordProductStore,
  PostgresRecordSearchProjectionStore,
  PostgresSameRoomOrganizerNeighbors,
  PostgresSameRoomOrganizerStore,
  PostgresSemanticWorkStore,
  PostgresGroundedDependencyRecordState,
  ProjectedAuthorityEligibility,
  ProtectedUnavailableCrossRoomOrganizerPartition,
  SameRoomDurableSemanticComposition,
  createHmacAuthorityProjectionCheckpointPort,
  createHmacOrganizerPublicationIdentityPort,
  createHmacRecordRequestCommitmentPort,
  createHmacRecordSearchCommitmentPort,
  createHmacRecordSemanticCommitmentPort,
  createCrossRoomApplicationPlanCodec,
  createForegroundRecordContextPort,
  createRecordSearchContinuationCodec,
  verifyRecordProductPostgresHandle,
  type ProtectedAuthorityRepublisherPort,
  type DurableOrganizerProposalApplicationPort,
  type ProtectedRecordPublicationPort,
  type RecordRepositorySelection,
  type RecordSourceInvalidationPort,
  type RoomLocalMemoryCandidatePort,
} from "@nautilo/reflection-bridge/server";

import { BackgroundAttemptUnavailableError } from "../background-processing/attempt";
import { createReflectionOrganizationAttemptOpener } from "./organization-attempt";
import type { MaintenanceGate } from "../maintenance-controller";
import {
  createRoomSideModelInvoker,
  mapModelFailure,
} from "../stenographer/model-invoker";
import {
  createRecordProductPostgresConnection,
} from "../stenographer/native-record-publication";
import { createForegroundRecordRecallPort } from "./foreground-record-recall-adapter";
import {
  CanonicalRoomNamespaceSourceAuthority,
  createCanonicalRecordAccessAudience,
  createCanonicalSameRoomBindingPorts,
} from "./canonical-product-authority";
import {
  SelectedRoomLocalSourceAdapter,
  createDirectDatabaseOrdinaryRoomSourceQueries,
  createHmacOrdinarySourceFingerprintPort,
} from "./canonical-room-sources";
import {
  REFLECTION_SEMANTIC_PRESSURE_POLICY_V1,
  REFLECTION_SEMANTIC_SETTLEMENT_RESERVE_MS,
  ReflectionSemanticWorker,
} from "./semantic-sleep-worker";
import { AuthoredMemorySemanticChangeAdapter } from "./authored-memory-semantic-change-adapter";

export function resolveOrganizerPublicationLegacyLeaf(input: Readonly<{
  terminalAuthorityLeafHandles: readonly string[];
  hasExactPublicationPlan: boolean;
}>): string | null {
  const first = input.terminalAuthorityLeafHandles[0];
  if (first === undefined) return null;
  if (!input.hasExactPublicationPlan && input.terminalAuthorityLeafHandles.length !== 1) {
    return null;
  }
  return first;
}

export function resolveOrganizerPublicationLegacyLeafOutcome(
  input: Parameters<typeof resolveOrganizerPublicationLegacyLeaf>[0],
):
  | Readonly<{ status: "available"; leaf: string }>
  | Readonly<{
      status: "unavailable";
      failureDetail: "publication_legacy_leaf_unavailable";
    }> {
  const leaf = resolveOrganizerPublicationLegacyLeaf(input);
  return leaf === null
    ? {
        status: "unavailable",
        failureDetail: "publication_legacy_leaf_unavailable",
      }
    : { status: "available", leaf };
}

export const REFLECTION_SEMANTIC_RUNTIME_POLICY_V1 = Object.freeze({
  version: "reflection-semantic-runtime-v1",
  scanIntervalMilliseconds: 15_000,
  catchUpIntervalMilliseconds: 2_000,
  modelInvocation: Object.freeze({
    // Reflection has a durable retry queue. One slow provider attempt must not
    // be mistaken for a failed batch on a populated instance. The independent
    // worker watchdog fences the whole poll. Each invocation is also bounded
    // by the remaining poll time, reserving time to settle valid results.
    maximumElapsedMilliseconds: REFLECTION_SEMANTIC_PRESSURE_POLICY_V1.maxPollElapsedMs,
    modelFallbackMode: "none",
    sameModelRetryMode: "none",
  }),
  pressure: REFLECTION_SEMANTIC_PRESSURE_POLICY_V1,
  leaseMilliseconds: REFLECTION_SEMANTIC_PRESSURE_POLICY_V1.maxPollElapsedMs
    + REFLECTION_SEMANTIC_SETTLEMENT_RESERVE_MS,
  sourceRepairPageMaximum: 256,
  budget: Object.freeze({
    // Consume the executor-owned ceiling directly so production cannot drift
    // into a validation-failure loop before the first durable claim.
    maxWorkItems: DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN,
    hierarchy: Object.freeze({
      // This is a logical call ceiling. The two-minute poll watchdog remains
      // the wall-clock owner when slow calls leave no room for every repair.
      maxModelCalls: 4,
      maxVisitedRecords: 256,
      maxCreatedRecords: 8,
      maxTraversalWork: 256,
      maxStatementCharacters: 800,
    }),
  } satisfies DurableSleepRunBudget),
} as const);

type MemoryEvidenceRecordDependency = Extract<DurableModelExposureDependency, { kind: "record" }>;

function sameAuthorityLeaves(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export interface ProductionReflectionMemoryRuntime {
  readonly readMemoryEvidenceRecord: (dependency: MemoryEvidenceRecordDependency) => Promise<DurableRecordEnvelope | null>;
  readonly readHistoricalOrganizerEvidenceRecord: (dependency: MemoryEvidenceRecordDependency) => Promise<DurableRecordEnvelope | null>;
  readonly readHistoricalJournalEvidenceRecord: (dependency: MemoryEvidenceRecordDependency) => Promise<DurableRecordEnvelope | null>;
  readonly readRetiredJournalPredecessor: (dependency: MemoryEvidenceRecordDependency, roomId: string) => Promise<DurableRecordEnvelope | null>;
  readonly worker: ReflectionSemanticWorker;
  readonly recallRecordsPortForState: RecallRecordsPortForState;
  readonly foregroundRecordContextPortForRoom: (
    roomId: string,
  ) => ForegroundRecordContextPort;
  readonly semanticWork: PostgresSemanticWorkStore;
  readonly authoredMemoryChanges: Readonly<{
    admit(change: AuthoredMemorySemanticChange): Promise<
      Readonly<{ admitted: number; continuation?: string }>
    >;
  }>;
}

export interface ProductionReflectionMemoryInput {
  readonly db: DirectDatabase;
  readonly selection: RecordRepositorySelection;
  readonly commitmentKey: Uint8Array;
  readonly maintenanceGate: Pick<MaintenanceGate, "isAcceptingWork">;
  /** Lattice-owned stage ceiling. Omission preserves the existing full worker. */
  readonly resolveStageAdmission?: (
    signal?: AbortSignal,
  ) => Promise<DurableSleepStageAdmission>;
  /** Lattice-owned data-operation binding. Runtime supplies the existing
   * ordinary ports once and never selects a representation per claim. */
  readonly bindSemanticDataOperations?: (input: Readonly<{
    work: DurableSleepWorkPort;
    ordinary: DurableSleepSemanticPort;
    embedding: RecordEmbeddingPort;
    sourceInvalidation: RecordSourceInvalidationPort;
    invokePreparedOrganizerBatch: NonNullable<
      DurableSleepSemanticPort["invokeOrganizerBatch"]
    >;
  }>) => Readonly<{
    work: DurableSleepWorkPort;
    semantic: DurableSleepSemanticPort;
    maintain?(input: Readonly<{
      limit: number;
      signal?: AbortSignal;
    }>): Promise<void>;
  }>;
  readonly resolveModelId: () => string;
  readonly recoverProviderRefusals?: (input: { now: Date; limit: number; signal: AbortSignal }) => Promise<void>;
  readonly admitMemoryModel?: (
    request: AdmitReflectionMemoryModelRequest,
  ) => Promise<AdmittedReflectionMemoryModel>;
  /** Deterministic composition seam for integration qualification. Production
   * omits it and retains the canonical configured embedding provider. */
  readonly recordEmbedding?: RecordEmbeddingPort;
  readonly protectedRecordPublication?: ProtectedRecordPublicationPort;
  readonly protectedAuthorityRepublisher?: ProtectedAuthorityRepublisherPort;
  readonly protectedMemoryCandidates?: RoomLocalMemoryCandidatePort;
  readonly protectedSource?: CanonicalRecordSourceReadPort;
}

export interface AdmitReflectionMemoryModelRequest {
  readonly claims: readonly DurableSleepClaim[];
  readonly dependencies: readonly DurableModelExposureDependency[] | undefined;
  readonly assertCurrent: () => Promise<void>;
  readonly bind: (
    resolve: () => Promise<MemoryOperationBinding>,
  ) => Promise<MemoryOperationBinding>;
}

export interface AdmittedReflectionMemoryModel {
  readonly binding: MemoryOperationBinding;
  readonly modelId: string;
  readonly humanUserId: string | null;
  readonly fundingSession?: ForegroundChatFundingSession;
  readonly assertCurrent: () => Promise<void>;
  readonly assertExposure: (
    dependencies: readonly DurableModelExposureDependency[] | undefined,
  ) => Promise<void>;
}

export function reflectionModelOperationId(
  binding: MemoryOperationBinding,
  wireKind: "primary" | "repair",
): string {
  return `reflection:${binding.inputCommitment}:${wireKind}`;
}

export function selectRetainedReflectionRepair<T extends object>(
  cached: readonly (T | undefined)[],
  consumed: WeakSet<T>,
): T | null {
  const present = cached.filter((value): value is T => value !== undefined);
  if (present.length === 0) return null;
  const first = present[0]!;
  if (
    present.length !== cached.length
    || present.some((value) => value !== first)
    || consumed.has(first)
  ) throw new Error("Reflection model batch admission changed");
  return first;
}

/** Process-local model state belongs to the exact leased claim objects.
 * A replacement lease can carry the same Record generation and must not
 * inherit admission assertions or replay checks captured by its predecessor. */
export class ReflectionModelInvocationState<T extends object> {
  private readonly admitted = new WeakMap<DurableSleepClaim, T>();
  private readonly replayChecked = new WeakMap<DurableSleepClaim, Set<string>>();

  selectRepair(
    claims: readonly DurableSleepClaim[],
    consumed: WeakSet<T>,
  ): T | null {
    return selectRetainedReflectionRepair(
      claims.map((claim) => this.admitted.get(claim)),
      consumed,
    );
  }

  retain(claims: readonly DurableSleepClaim[], admission: T): void {
    for (const claim of claims) this.admitted.set(claim, admission);
  }

  admissionFor(claim: DurableSleepClaim): T | undefined {
    return this.admitted.get(claim);
  }

  delete(claim: DurableSleepClaim): void {
    this.admitted.delete(claim);
    this.replayChecked.delete(claim);
  }

  wasReplayChecked(claims: readonly DurableSleepClaim[], operationId: string): boolean {
    return claims.every((claim) => this.replayChecked.get(claim)?.has(operationId) === true);
  }

  markReplayChecked(claims: readonly DurableSleepClaim[], operationId: string): void {
    for (const claim of claims) {
      const checked = this.replayChecked.get(claim) ?? new Set<string>();
      checked.add(operationId);
      this.replayChecked.set(claim, checked);
    }
  }
}

function recordEmbedding(): RecordEmbeddingPort {
  return Object.freeze({
    async embed(input: RecordEmbeddingRequest): Promise<RecordEmbeddingResult> {
      if (input.signal?.aborted) {
        return { status: "unavailable", reason: "cancelled" };
      }
      try {
        const value = await embedTextWithProvenance(input.plaintext, input.signal);
        if (value.dimensions !== 1_536) {
          return { status: "unavailable", reason: "invalid_response" };
        }
        return {
          status: "available" as const,
          embedding: {
            provenance: {
              provider: value.provider,
              canonicalModel: value.canonicalModel,
              dimensions: 1_536,
              contractVersion: value.contractVersion,
            },
            vector: canonicalizeRecordEmbeddingV1(value.vector),
          },
        };
      } catch {
        return {
          status: "unavailable" as const,
          reason: input.signal?.aborted ? "cancelled" : "provider_unavailable",
        };
      }
    },
  });
}

function reflectionModelLaneScope(
  modelId: string,
  configuredDefaultModelId: string,
): "configured_default" | "exact_binding" {
  return modelId === configuredDefaultModelId
    ? "configured_default"
    : "exact_binding";
}

export function classifyReflectionModelInvocationFailure(
  error: unknown,
  modelId: string,
  configuredDefaultModelId: string,
): unknown {
  const failure = mapModelFailure(error);
  if (failure === "unknown") return error;
  if (failure === "provider_outcome_unknown") {
    return new DurableSleepProviderOutcomeUnknownError();
  }
  if (modelInvokeCooldownRemainingMs(modelId) === 0) {
    markModelInvokeFailure(modelId, `room_reflection_${failure}`);
  }
  return new DurableSleepModelLaneUnavailableError(
    Math.max(1, modelInvokeCooldownRemainingMs(modelId)),
    reflectionModelLaneScope(modelId, configuredDefaultModelId),
  );
}

function bindingRef(
  namespaceId: string,
  selection: RecordRepositorySelection,
): string {
  return `journal:namespace:${namespaceId}:${selection.selectedRepresentation}:v${selection.migrationGeneration}`;
}

/** Compose the one current server-selected same-Room Reflection vertical. */
export async function createProductionReflectionMemoryRuntime(
  input: ProductionReflectionMemoryInput,
): Promise<ProductionReflectionMemoryRuntime> {
  const connection = createRecordProductPostgresConnection(input.db);
  const handle = await verifyRecordProductPostgresHandle(connection);
  const semanticCommitments = createHmacRecordSemanticCommitmentPort(
    input.commitmentKey,
  );
  const semanticWork = new PostgresSemanticWorkStore({
    handle,
    commitments: semanticCommitments,
    leaseMilliseconds: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.leaseMilliseconds,
  });
  const product = new PostgresRecordProductStore(handle, semanticWork);
  const repository = new DualModeRecordRepository({
    selection: input.selection,
    product,
    commitment: createHmacRecordRequestCommitmentPort(input.commitmentKey),
    ...(input.protectedRecordPublication === undefined
      ? {}
      : { protectedPublication: input.protectedRecordPublication }),
  });
  const searchCommitments = createHmacRecordSearchCommitmentPort(
    input.commitmentKey,
  );
  const publicationBindings = new PostgresCurrentRecordPublicationBinding(
    handle,
    input.selection,
  );
  const bindings = createCanonicalSameRoomBindingPorts({
    selection: input.selection,
    publications: publicationBindings,
    searchCommitments,
  });
  const authorityProjections = new PostgresAuthorityProjectionStore(
    handle,
    input.selection,
  );
  const accessAudiences = createCanonicalRecordAccessAudience({ db: input.db });
  const sourceAuthority = new CanonicalRoomNamespaceSourceAuthority();
  const authorityReconciliation = {
    selection: input.selection,
    sourceAuthority,
    accessAudiences,
    recordBindings: publicationBindings,
    projections: authorityProjections,
    commitments: createHmacAuthorityProjectionCheckpointPort(input.commitmentKey),
    ...(input.protectedAuthorityRepublisher === undefined
      ? {}
      : { protectedRepublisher: input.protectedAuthorityRepublisher }),
  } as const;
  const eligibility = new ProjectedAuthorityEligibility({
    projections: authorityProjections,
    accessAudiences,
  });
  const embedding = input.recordEmbedding ?? recordEmbedding();
  const searchProjections = new PostgresRecordSearchProjectionStore(handle);
  const exactSearch = new PostgresAuthorityFilteredRecordSearchStore(handle);
  const organizerNeighbors = new PostgresSameRoomOrganizerNeighbors({
    commitments: searchCommitments,
    selection: input.selection,
    projections: searchProjections,
    store: new PostgresSameRoomOrganizerStore(handle),
    repository,
  });
  const continuations = createRecordSearchContinuationCodec(input.commitmentKey);
  const searchCheckpoints = new BoundedRecordSearchTraversalCheckpoints();
  const evidenceCheckpoints = new BoundedRecordEvidenceTraversalCheckpoints();

  const workerHolder: { current?: ReflectionSemanticWorker } = {};
  const invalidation: RecordSourceInvalidationPort = {
    async admit({ dependency, reason }) {
      const reserved = await semanticWork.reserveSourceRepair({
        sourceDependencyCommitment: semanticCommitments.sourceDependency(dependency),
        sourceChangeCommitment: semanticCommitments.sourceChange({
          sourceKind: dependency.sourceKind,
          logicalSourceRef: dependency.logicalSourceRef,
          changeRef: `${reason}:${dependency.observedRevision ?? "unknown"}:${dependency.observedContentFingerprint ?? "unknown"}`,
        }),
      });
      if (reserved.reserved) workerHolder.current?.wakeup(1);
    },
  };
  const sources = new SelectedRoomLocalSourceAdapter({
    selection: input.selection,
    bindings: bindings.evidence,
    ordinary: createDirectDatabaseOrdinaryRoomSourceQueries(input.db),
    fingerprints: createHmacOrdinarySourceFingerprintPort(input.commitmentKey),
    authorityBlocks: authorityProjections,
    ...(input.protectedMemoryCandidates === undefined
      ? {}
      : { protectedMemoryCandidates: input.protectedMemoryCandidates }),
    ...(input.protectedSource === undefined
      ? {}
      : { protectedSource: input.protectedSource }),
  });
  const crossRoomStore = new PostgresCrossRoomOrganizerStore(handle);
  const crossRoomPublicationPlanner = new ExactCrossRoomPublicationPlanner({
    selection: input.selection,
    repository,
    authority: authorityProjections,
    sourceAuthority,
    accessAudiences,
    recordBindings: publicationBindings,
    memoryFences: crossRoomStore,
  });
  const crossRoom = input.selection.selectedRepresentation === "ordinary"
    ? new OrdinaryCrossRoomOrganizerPartition({
        selection: input.selection,
        store: crossRoomStore,
        repository,
        memories: sources,
        codec: createCrossRoomApplicationPlanCodec(input.commitmentKey),
        publicationPlans: crossRoomPublicationPlanner,
      })
    : new ProtectedUnavailableCrossRoomOrganizerPartition({
        selection: input.selection,
        store: crossRoomStore,
      });
  const evidenceReader = new ExactRecordSourceEvidenceReader({
    source: sources,
    invalidation,
  });
  const evidence: RecordEvidencePort = new DualModeSyntheticRecordEvidence({
    selection: input.selection,
    bindings: bindings.search,
    eligibility,
    authorityProjections,
    recordBindings: publicationBindings,
    repository,
    sources: evidenceReader,
    checkpoints: evidenceCheckpoints,
    continuations,
    commitments: searchCommitments,
  });
  const recordSearchFor = async (
    request: Parameters<RecordSearchPort["search"]>[0],
  ): Promise<DualModeAuthorityFilteredRecordSearch> => {
      const resolved = await bindings.search.resolve(request.searchBindingRef);
      const eligibleGraph = new InvocationEligibleHierarchyCoordinates({
        repository,
        eligibility,
        invocationAudience: resolved?.invocationAudience ?? {
          humanRefs: [],
          includesPublicBoundary: false,
        },
        readBindingRef: resolved?.readBindingRef ?? request.searchBindingRef,
      });
      return new DualModeAuthorityFilteredRecordSearch({
        selection: input.selection,
        embedding,
        bindings: bindings.search,
        exactSearch,
        eligibility,
        authorityProjections,
        recordBindings: publicationBindings,
        repository,
        eligibleGraph,
        continuations,
        commitments: searchCommitments,
        checkpoints: searchCheckpoints,
      });
  };
  const search: RecordSearchPort = {
    async search(request) {
      return (await recordSearchFor(request)).search(request);
    },
    async searchStructural(request) {
      return (await recordSearchFor(request)).searchStructural(request);
    },
  };

  const contextForRecord = async (recordRef: string) => {
    const work = await bindings.semantic.resolveWork(recordRef);
    if (work === null) return null;
    const opened = await repository.read({
      recordRef,
      readBindingRef: work.readBindingRef,
    });
    if (opened.status !== "available") return null;
    const resolved = await bindings.semantic.resolve(opened.record);
    if (resolved.status !== "available") return null;
    return { opened: opened.record, binding: resolved.binding };
  };
  const readHistoricalJournalEvidenceRecord = async (
    dependency: MemoryEvidenceRecordDependency,
    roomId?: string,
  ): Promise<DurableRecordEnvelope | null> => {
    if (input.selection.selectedRepresentation !== "ordinary") return null;
    const blocked = await authorityProjections.isImmediatelyBlocked({
      recordRef: dependency.recordRef,
      terminalAuthorityLeafHandles: dependency.terminalAuthorityLeafHandles,
    });
    if (blocked !== null) return null;
    const context = await contextForRecord(dependency.recordRef);
    if (
      context === null
      || (roomId !== undefined && context.binding.roomAnchorRef !== roomId)
    ) return null;
    const { opened } = context;
    if (
      (opened.lifecycle !== "superseded" && opened.lifecycle !== "resolved")
      || opened.processingGeneration
        !== dependency.observedProcessingGeneration + 1
      || opened.semantic.producer.producerRef !== "stenographer"
      || !opened.semantic.sourceOwnedKind?.startsWith("journal_event:")
      || !sameAuthorityLeaves(
        opened.semantic.terminalAuthorityLeafHandles,
        dependency.terminalAuthorityLeafHandles,
      )
    ) return null;
    const successors = await repository.readSuccessors({
      recordRef: opened.recordRef,
      readBindingRef: context.binding.readBindingRef,
      limit: 2,
    });
    if (
      successors.status !== "available"
      || successors.page.continuation !== undefined
      || successors.page.items.length !== 1
      || successors.page.items[0]?.predecessorRecordRef !== opened.recordRef
      || successors.page.items[0]?.relation
        !== (opened.lifecycle === "superseded" ? "supersedes" : "resolves")
    ) return null;
    return opened;
  };
  type ModelInvocationContext = Readonly<{ roomId: string }>;
  const modelInvocationState = new ReflectionModelInvocationState<AdmittedReflectionMemoryModel>();
  const consumedRepairs = new WeakSet<AdmittedReflectionMemoryModel>();
  // Only ordinary execution is admitted to this server-keyed store. Protected
  // Reflection's output remains owned by its Namespace publication gate.
  const organizerCheckpointSeal = createHmacAuthorityProjectionCheckpointPort(
    createHmac("sha256", input.commitmentKey).update("nautilo-reflection-organizer-proposal-v1").digest(),
  );
  const organizerCheckpointMaxBytes = ORGANIZER_BATCH_MAX_ITEMS
    * CROSS_ROOM_EXECUTION_PLAN_LIMITS.applicationPlanTokenBytes
    + CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes
    + CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes;
  const checkpointIdentity = (claim: DurableSleepClaim, binding: MemoryOperationBinding) => [
    "organizer-proposal/v1", claim.recordRef, claim.generation, claim.changeReason,
    binding.modelId, binding.inputCommitment,
  ];
  const organizerCheckpoints: NonNullable<DurableSleepSemanticPort["organizerCheckpoints"]> = {
    async read(claim, signal) {
      signal?.throwIfAborted();
      const saved = await semanticWork.readOrganizerProposalCheckpoint(claim);
      if (saved === null) return null;
      if (saved.sealed.byteLength > organizerCheckpointMaxBytes) throw new Error("Organizer checkpoint exceeds its bound");
      const [identity, checkpoint] = JSON.parse(organizerCheckpointSeal.openSealedCheckpoint(saved.sealed)) as [
        ReturnType<typeof checkpointIdentity>, DurableOrganizerProposalCheckpoint,
      ];
      if (JSON.stringify(identity) !== JSON.stringify(checkpointIdentity(claim, saved.binding))) {
        throw new DurableSleepOrganizationUnavailableError();
      }
      return checkpoint;
    },
    async save(items, signal) {
      const sealed = [];
      for (const { claim, checkpoint } of items) {
        signal?.throwIfAborted();
        // A complete authenticated plan is needed to revalidate all original
        // question evidence, including uncited inputs and batch siblings.
        if (checkpoint.applicationPlanToken === undefined || checkpoint.modelExposureDependencies === undefined) continue;
        const admitted = modelInvocationState.admissionFor(claim);
        if (admitted === undefined) continue;
        await admitted.assertCurrent();
        const ciphertext = organizerCheckpointSeal.sealCheckpoint(
          JSON.stringify([checkpointIdentity(claim, admitted.binding), checkpoint]),
        );
        if (ciphertext.byteLength > organizerCheckpointMaxBytes) throw new Error("Organizer checkpoint exceeds its bound");
        sealed.push({ claim, binding: admitted.binding, sealed: ciphertext });
      }
      if (sealed.length > 0) await semanticWork.saveOrganizerProposalCheckpoints(sealed);
    },
  };
  const dispatchForRecords = async (
    claims: readonly DurableSleepClaim[],
    prompt: string,
    resolveContexts: () => Promise<readonly (ModelInvocationContext | null)[]>,
    signal?: AbortSignal,
    dependencies?: readonly DurableModelExposureDependency[],
    assertAdditionalCurrent?: () => Promise<void>,
  ): Promise<string> => {
    if (claims.length < 1) throw new TypeError("Record model batch cannot be empty");
    const contexts = await resolveContexts();
    if (contexts.length !== claims.length) {
      throw new DurableSleepOrganizationUnavailableError();
    }
    if (contexts.some((context) => context === null)) {
      throw new DurableSleepOrganizationUnavailableError();
    }
    signal?.throwIfAborted();
    const context = contexts[0]!;
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      const current = await Promise.all(
        claims.map((claim) => semanticWork.isClaimCurrent(claim)),
      );
      if (current.some((value) => !value)) {
        throw new DurableSleepOrganizationUnavailableError();
      }
    };
    let wireKind: "primary" | "repair" = "primary";
    let admitted: AdmittedReflectionMemoryModel | Readonly<{
      modelId: string;
      humanUserId: null;
      fundingSession: undefined;
      assertCurrent: () => Promise<void>;
      assertExposure: () => Promise<void>;
    }>;
    const retained = modelInvocationState.selectRepair(claims, consumedRepairs);
    if (retained !== null) {
      admitted = retained;
      wireKind = "repair";
    } else admitted = input.admitMemoryModel === undefined
      ? {
          modelId: input.resolveModelId(),
          humanUserId: null,
          fundingSession: undefined,
          assertCurrent,
          assertExposure: () => Promise.resolve(),
        }
      : await input.admitMemoryModel({
          claims,
          dependencies,
          assertCurrent,
          bind: (resolve) => semanticWork.bindAcceptedModelOperation(
            claims,
            resolve,
          ),
        });
    const modelId = admitted.modelId;
    const configuredDefaultModelId = input.resolveModelId();
    const currentCooldown = modelInvokeCooldownRemainingMs(modelId);
    if (currentCooldown > 0) {
      throw new DurableSleepModelLaneUnavailableError(
        currentCooldown,
        reflectionModelLaneScope(modelId, configuredDefaultModelId),
      );
    }
    try {
      const sortedClaims = [...claims]
        .sort((left, right) => left.recordRef.localeCompare(right.recordRef));
      const operationId = "binding" in admitted
        ? reflectionModelOperationId(admitted.binding, wireKind)
        : `reflection:${sortedClaims
            .map((claim) => `${claim.recordRef}:${claim.generation}`)
            .join(":")}`;
      const assertInvocationCurrent = async () => {
        await admitted.assertCurrent();
        await admitted.assertExposure(dependencies);
        await assertAdditionalCurrent?.();
      };
      if (!modelInvocationState.wasReplayChecked(claims, operationId)) {
        await assertInvocationCurrent();
        const replaySafety = await resolveModelAttemptReplaySafety(
          "binding" in admitted
            ? { kind: "reflection_operation", operationId }
            : { kind: "operation", roomId: context.roomId, callType: "room_reflection", operationId },
          { db: input.db },
        );
        if (replaySafety.decision === "block_unknown") {
          throw new DurableSleepProviderOutcomeUnknownError();
        }
        modelInvocationState.markReplayChecked(claims, operationId);
      }
      if (assertAdditionalCurrent !== undefined) {
        await assertInvocationCurrent();
      }
      const hasOperatorAttempt = claims.some(claim => claim.operatorAuthorizedAttempt);
      const manualAttempt = hasOperatorAttempt
        ? await semanticWork.consumeManualProviderAttempt(claims)
        : "not_applicable";
      if (
        hasOperatorAttempt
        && (
          claims.some(claim => !claim.operatorAuthorizedAttempt)
          || manualAttempt !== "consumed"
        )
      ) {
        // A prior stamp may represent an already-reached wire. Never guess by
        // dispatching it again; the durable hold requires a new operator click.
        throw new DurableSleepProviderOutcomeUnknownError();
      }
      if (wireKind === "repair" && "binding" in admitted) {
        consumedRepairs.add(admitted);
      }
      const response = await createRoomSideModelInvoker({
        modelId,
        ...(admitted.humanUserId === null
          ? {}
          : { userId: admitted.humanUserId }),
        roomId: context.roomId,
        laneKey: `room:${context.roomId}:reflection`,
        callType: "room_reflection",
        operationId,
        invocationPolicy: {
          maximumElapsedMs:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.maximumElapsedMilliseconds,
          modelFallbackMode:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.modelFallbackMode,
          sameModelRetryMode:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.sameModelRetryMode,
        },
        ...(admitted.fundingSession === undefined
          ? {}
          : { fundingSession: admitted.fundingSession }),
        assertCurrent: assertInvocationCurrent,
      })(prompt, signal);
      try {
        await assertInvocationCurrent();
      } catch {
        // The paid result cannot be published safely and is not durably
        // checkpointed, so this generation must never invoke it again.
        throw new DurableSleepProviderOutcomeUnknownError();
      }
      if ("binding" in admitted) {
        modelInvocationState.retain(claims, admitted);
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DurableSleepProviderOutcomeUnknownError) throw error;
      throw classifyReflectionModelInvocationFailure(
        error,
        modelId,
        configuredDefaultModelId,
      );
    }
  };
  const invokeForRecords = async (
    claims: readonly DurableSleepClaim[],
    prompt: string,
    signal?: AbortSignal,
    dependencies?: readonly DurableModelExposureDependency[],
    assertAdditionalCurrent?: () => Promise<void>,
  ): Promise<string> => dispatchForRecords(
    claims,
    prompt,
    async () => Promise.all(claims.map(async (claim) => {
      const context = await contextForRecord(claim.recordRef);
      return context === null
        ? null
        : {
            roomId: context.binding.roomAnchorRef,
          };
    })),
    signal,
    dependencies,
    assertAdditionalCurrent,
  );
  const invokePreparedOrganizerBatch: NonNullable<
    DurableSleepSemanticPort["invokeOrganizerBatch"]
  > = async (claims, prompt, signal, dependencies) => dispatchForRecords(
    claims,
    prompt,
    async () => Promise.all(claims.map(async (claim) => {
      if (!await semanticWork.isClaimCurrent(claim)) return null;
      const binding = await bindings.invocation.resolve(claim.recordRef);
      if (binding === null) return null;
      return { roomId: binding.roomId };
    })),
    signal,
    dependencies,
  );
  const invokeForRecord = (
    claim: DurableSleepClaim,
    prompt: string,
    signal?: AbortSignal,
    dependencies?: readonly DurableModelExposureDependency[],
    assertAdditionalCurrent?: () => Promise<void>,
  ): Promise<string> => invokeForRecords(
    [claim], prompt, signal, dependencies, assertAdditionalCurrent,
  );
  const proposals: DurableOrganizerProposalApplicationPort = {
    async apply(application) {
      if (application.claim.changeReason === "parent_conflict") {
        throw new TypeError("parent-conflict work cannot publish an Organizer proposal");
      }
      const admitted = modelInvocationState.admissionFor(application.claim);
      try {
        await admitted?.assertCurrent();
        const context = await contextForRecord(application.claim.recordRef);
        if (context === null) {
          return {
            status: "unavailable" as const,
            failureCode: "publication_unavailable" as const,
            failureDetail: "publication_evidence_unavailable" as const,
          };
        }
        const handles = context.opened.semantic.terminalAuthorityLeafHandles;
        const legacyLeaf = resolveOrganizerPublicationLegacyLeafOutcome({
          terminalAuthorityLeafHandles: handles,
          hasExactPublicationPlan: application.publicationPlan !== undefined,
        });
        const legacyTerminalAuthorityLeafHandle = legacyLeaf.status === "available"
          ? legacyLeaf.leaf
          : undefined;
        const dissolveLeaf = application.proposal.operation === "dissolve_parent"
          ? handles[0]
          : undefined;
        const publicationLeaf = legacyTerminalAuthorityLeafHandle ?? dissolveLeaf;
        if (publicationLeaf === undefined) {
          return {
            status: "unavailable" as const,
            failureCode: "publication_unavailable" as const,
            failureDetail: legacyLeaf.status === "unavailable"
              ? legacyLeaf.failureDetail
              : "publication_legacy_leaf_unavailable" as const,
          };
        }
        return await new OrganizerProposalPublisher({
          repository,
          sourceDependencies: {
            async validate({ dependency, readBindingRef, signal }) {
              const result = await sources.readExact({
                dependency,
                evidenceBindingRef: readBindingRef,
                returnedBytesMaximum: RECORD_SEARCH_POLICY_V1.returnedBytesMaximum,
                ...(signal === undefined ? {} : { signal }),
              });
              if (result.status === "available") return "current";
              await invalidation.admit({
                dependency,
                reason: result.status === "changed" ? "changed" : "unavailable",
              });
              return "unavailable";
            },
          },
          inheritedSourceBindings: {
            async resolve(dependency) {
              const resolved = await bindings.evidence.resolveNamespace(
                dependency.terminalAuthorityLeafHandle,
              );
              if (
                application.claim.changeReason === "dependency_lost"
                && input.selection.selectedRepresentation === "ordinary"
                && (
                  typeof dependency.observedRevision !== "string"
                  || dependency.observedRevision.trim().length === 0
                  || typeof dependency.observedContentFingerprint !== "string"
                  || dependency.observedContentFingerprint.trim().length === 0
                  || !context.opened.semantic.terminalAuthorityLeafHandles.includes(
                    dependency.terminalAuthorityLeafHandle,
                  )
                  || resolved === null
                  || !invocationAudienceIsEligible(
                    context.binding.invocationAudience,
                    [resolved.audience],
                  )
                  || await authorityProjections.isImmediatelyBlocked({
                    recordRef: context.opened.recordRef,
                    terminalAuthorityLeafHandles: [
                      dependency.terminalAuthorityLeafHandle,
                    ],
                  }) !== null
                )
              ) return null;
              return resolved?.bindingRef ?? null;
            },
          },
          identity: createHmacOrganizerPublicationIdentityPort(input.commitmentKey),
          crossRoomFences: crossRoomPublicationPlanner,
          recordBindings: publicationBindings,
          room: {
            roomAnchorRef: context.binding.roomAnchorRef,
            // Exact cross-Room plans carry and revalidate the complete output
            // authority. This legacy leaf is consulted only by same-Room plans.
            terminalAuthorityLeafHandle: publicationLeaf,
            readBindingRef: context.binding.readBindingRef,
            publicationBindingRef: context.binding.publicationBindingRef,
            producerPolicyVersion: CANDIDATE_POLICY_V1.version,
          },
        }).apply({
          proposal: application.proposal,
          changedRecordRef: application.claim.recordRef,
          idempotencyKey: application.idempotencyKey,
          budget: application.budget,
          changeReason: application.claim.changeReason,
          ...(application.publicationPlan === undefined
            ? {}
            : { publicationPlan: application.publicationPlan }),
          ...(application.signal === undefined ? {} : { signal: application.signal }),
        });
      } finally {
        modelInvocationState.delete(application.claim);
      }
    },
  };
  const semantic = new SameRoomDurableSemanticComposition({
    organizerCheckpoints,
    openOrganizationAttempt: createReflectionOrganizationAttemptOpener({
      checkAvailable: () => input.maintenanceGate.isAcceptingWork(),
      assertClaimCurrent: (claim) => semanticWork.isClaimCurrent(claim),
      openAccess: async (_identity, _signal, claim) => {
        // Publication binding and Room audience are metadata. Capture them before
        // opening Record/evidence bytes; canonical publishers own the final CAS.
        const initial = await bindings.semantic.resolveWork(claim.recordRef);
        if (initial === null) throw new BackgroundAttemptUnavailableError();
        return {
          assertCurrent: async () => {
            const current = await bindings.semantic.resolveWork(claim.recordRef);
            if (current === null
              || current.readBindingRef !== initial.readBindingRef
              || current.invocationAudience.includesPublicBoundary !== initial.invocationAudience.includesPublicBoundary
              || current.invocationAudience.humanRefs.join(":") !== initial.invocationAudience.humanRefs.join(":")) {
              throw new BackgroundAttemptUnavailableError();
            }
          },
          close: () => Promise.resolve(),
        };
      },
      observe: (observation) => { log("[reflection] background attempt closed", { ...observation }); },
    }),
    repository,
    readiness: new DurableRecordSemanticReadiness({
      commitments: searchCommitments,
      repository,
      bindings: bindings.semantic,
      eligibility,
      authorityProjections,
      authorityReconciliation,
      embedding,
      searchProjections,
      ...(input.selection.selectedRepresentation === "ordinary"
        ? { missingTerminalDependencies: semanticWork }
        : {}),
    }),
    bindings: bindings.semantic,
    organizerNeighbors,
    memories: sources,
    model: {
      readiness: () => {
        const remaining = modelInvokeCooldownRemainingMs(input.resolveModelId());
        return Promise.resolve(remaining > 0
          ? { status: "cooldown" as const, retryAfterMilliseconds: remaining }
          : { status: "ready" as const });
      },
      invoke: (claim, prompt, signal, dependencies) => invokeForRecord(
        claim,
        prompt,
        signal,
        dependencies,
      ),
      invokeBatch: (claims, prompt, signal, dependencies) => invokeForRecords(
        claims,
        prompt,
        signal,
        dependencies,
      ),
    },
    proposals,
    crossRoom,
    parentConflicts: semanticWork,
    dependencyLoss: {
      async resolve(lossInput) {
        return new ExactGroundedDependencyLossResolver({
          recordState: new PostgresGroundedDependencyRecordState(handle),
          repository,
          recordBindings: publicationBindings,
          eligibility,
          source: sources,
          ...(input.selection.selectedRepresentation === "ordinary"
            ? { inheritedMemorySource: sources }
            : {}),
          invalidation,
          statements: {
            async rewrite(rewriteInput) {
              const result = await runDependencyLossRewrite({
                remainingSupportStatements: rewriteInput.remainingSupportStatements,
                invoke: async (prompt, signal) => {
                  const assertSourceEvidenceCurrent =
                    rewriteInput.assertSourceEvidenceCurrent;
                  if (assertSourceEvidenceCurrent === undefined) {
                    await lossInput.assertCurrent?.();
                    return invokeForRecord(lossInput.claim, prompt, signal);
                  }
                  return invokeForRecord(
                    lossInput.claim,
                    prompt,
                    signal,
                    rewriteInput.modelExposureDependencies,
                    async () => {
                      await lossInput.assertCurrent?.();
                      const current = await contextForRecord(
                        lossInput.claim.recordRef,
                      );
                      if (
                        current === null
                        || !await assertSourceEvidenceCurrent(
                          current.binding.invocationAudience,
                        )
                      ) throw new DurableSleepOrganizationUnavailableError();
                    },
                  );
                },
                ...(rewriteInput.signal === undefined
                  ? {}
                  : { signal: rewriteInput.signal }),
              });
              return result.ok
                ? {
                    status: "available" as const,
                    statement: result.statement,
                    modelCalls: result.attempts,
                  }
                : { status: "unavailable" as const };
            },
          },
        }).resolve(lossInput);
      },
    },
  });
  const dataOperations: Readonly<{
    work: DurableSleepWorkPort;
    semantic: DurableSleepSemanticPort;
    maintain?(input: Readonly<{
      limit: number;
      signal?: AbortSignal;
    }>): Promise<void>;
  }> = input.bindSemanticDataOperations?.({
    work: semanticWork,
    ordinary: semantic,
    embedding,
    sourceInvalidation: invalidation,
    invokePreparedOrganizerBatch,
  }) ?? { work: semanticWork, semantic };
  // Persisted admissions and current projection metadata make this scan restart-safe.
  let roomProjectionContinuation: string | undefined;
  let candidateRecoveryContinuation: string | undefined;
  let candidateRecoveryComplete = false;
  const worker = new ReflectionSemanticWorker({
    maintenanceGate: input.maintenanceGate,
    ...(input.resolveStageAdmission === undefined
      ? {}
      : { resolveStageAdmission: input.resolveStageAdmission }),
    work: dataOperations.work,
    semantic: dataOperations.semantic,
    budget: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget,
    bootstrap: {
      async bootstrapPage(pageInput, signal) {
        await dataOperations.maintain?.({ limit: pageInput.limit });
        const bootstrapInput = {
          limit: pageInput.limit,
          ...(pageInput.continuation === undefined
            ? {}
            : { continuation: pageInput.continuation }),
        };
        if (pageInput.stageAdmission.maximumStage !== "organization") {
          return semanticWork.bootstrapPage(bootstrapInput);
        }
        await input.recoverProviderRefusals?.({ now: new Date(), limit: pageInput.limit, signal });
        if (!candidateRecoveryComplete && !signal.aborted) {
          const recovery = await semanticWork.recoverCandidatePolicyQuarantinesPage({
            limit: pageInput.limit,
            policyVersion: "candidate-record-changed-v1",
            undispatchedCandidateRecordChangedOnly: true,
            ...(candidateRecoveryContinuation === undefined ? {} : { continuation: candidateRecoveryContinuation }),
          });
          if (!signal.aborted) {
            candidateRecoveryContinuation = recovery.continuation;
            candidateRecoveryComplete = recovery.continuation === undefined;
          }
          if (recovery.admitted > 0) {
            return {
              admitted: recovery.admitted,
              ...(pageInput.continuation === undefined ? {} : { continuation: pageInput.continuation }),
            };
          }
        }
        const projectionRepair = await semanticWork.admitMissingRoomProjectionPage({
          limit: pageInput.limit,
          policyVersion: "semantic-room-projection-v1",
          ...(roomProjectionContinuation === undefined ? {} : {continuation: roomProjectionContinuation}),
        });
        roomProjectionContinuation = projectionRepair.continuation;
        const parentConflicts = await semanticWork.admitParentConflictsPage({
          limit: pageInput.limit,
        });
        if (parentConflicts.admitted > 0) return {...parentConflicts, admitted: parentConflicts.admitted + projectionRepair.admitted};
        const repair = await semanticWork.repairSourceDependentsPage({
          limit: pageInput.limit,
        });
        if (repair.consumed > 0) {
          return { admitted: repair.admitted + projectionRepair.admitted };
        }
        const recordRepair = await semanticWork.repairRecordDependentsPage({
          limit: pageInput.limit,
        });
        if (recordRepair.consumed > 0) {
          return { admitted: recordRepair.admitted + projectionRepair.admitted };
        }
        const bootstrap = await semanticWork.bootstrapPage(bootstrapInput);
        return {...bootstrap, admitted: bootstrap.admitted + projectionRepair.admitted};
      },
    },
    readPressure: async () => {
      const health = await semanticWork.health();
      return {
        backlog: health.backlog,
        ready: health.ready,
        oldestDueAt: health.oldestDueAt,
      };
    },
  }, {
    scanIntervalMs: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds,
    catchUpIntervalMs: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.catchUpIntervalMilliseconds,
    pressure: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.pressure,
  });
  workerHolder.current = worker;
  const authoredMemoryChanges = new AuthoredMemorySemanticChangeAdapter({
    commitments: semanticCommitments,
    semanticWork,
    wakeup: () => worker.wakeup(1),
  });

  const recallRecordsPortForState: RecallRecordsPortForState = (state) => {
    if (state.memoryAccessEnvelope?.externalContext === true) return undefined;
    if (typeof state.roomId !== "string" || state.roomId.length === 0) return undefined;
    const roomId = state.roomId;
    let resolvedPort: Promise<RecallRecordsPort | null> | undefined;
    const resolve = () => resolvedPort ??= getExternalRoomPolicy(roomId).then((policy) => policy ? null : bindings.evidence.resolveRoom(roomId)).then((room) =>
      room === null
        ? null
        : createForegroundRecordRecallPort({
            bindingRef: bindingRef(room.namespaceId, input.selection),
            search,
            evidence,
          })
    );
    return {
      async searchStructural(request) {
        const port = await resolve();
        return port === null
          ? { status: "unavailable" as const, reason: "not_ready" as const }
          : port.searchStructural!(request);
      },
      async search(request) {
        const port = await resolve();
        return port === null
          ? { status: "unavailable", reason: "not_ready" }
          : port.search(request);
      },
      async expand(request) {
        const port = await resolve();
        return port === null
          ? { status: "unavailable", reason: "not_ready" }
          : port.expand(request);
      },
    };
  };
  const foregroundRecordContextPortForRoom = (
    roomId: string,
  ): ForegroundRecordContextPort => {
    let resolvedPort: Promise<ForegroundRecordContextPort | null> | undefined;
    const resolve = () => resolvedPort ??= getExternalRoomPolicy(roomId).then((policy) => policy ? null : bindings.evidence.resolveRoom(roomId)).then((room) =>
      room === null
        ? null
        : createForegroundRecordContextPort({
            bindingRef: bindingRef(room.namespaceId, input.selection),
            representation: input.selection.selectedRepresentation,
            search,
            ...(input.selection.selectedRepresentation !== "ordinary" ? {} : {
              reopenOrdinaryRecord: async (recordRef: string) => {
                const context = await contextForRecord(recordRef);
                if (context === null || context.opened.lifecycle !== "current") return null;
                return {
                  recordRef: context.opened.recordRef,
                  statement: context.opened.semantic.statement,
                  lifecycle: context.opened.lifecycle,
                  structuralHeight: context.opened.structuralHeight,
                  modelExposureDependency: {
                    kind: "record" as const,
                    recordRef: context.opened.recordRef,
                    observedProcessingGeneration: context.opened.processingGeneration,
                    terminalAuthorityLeafHandles: context.opened.semantic.terminalAuthorityLeafHandles,
                  },
                };
              },
            }),
          })
    );
    return Object.freeze({
      representation: input.selection.selectedRepresentation,
      ...(input.selection.selectedRepresentation !== "ordinary" ? {} : {
        reopenOrdinaryRecord: async (recordRef: string) => {
          const port = await resolve();
          return port?.reopenOrdinaryRecord?.(recordRef) ?? null;
        },
      }),
      async select(
        request: Parameters<ForegroundRecordContextPort["select"]>[0],
      ) {
        const port = await resolve();
        return port === null
          ? {
              status: "unavailable" as const,
              representation: input.selection.selectedRepresentation,
              queryEmbeddingStatus: "unavailable" as const,
              reason: "binding_unavailable" as const,
            }
          : port.select(request);
      },
      async selectStructural(
        request: Parameters<NonNullable<ForegroundRecordContextPort["selectStructural"]>>[0],
      ) {
        const port = await resolve();
        if (port === null || port.selectStructural === undefined) return {
          status: "unavailable" as const,
          representation: "protected" as const,
          queryEmbeddingStatus: "unavailable" as const,
          reason: "incompatible_projection" as const,
        };
        return port.selectStructural(request);
      },
    });
  };
  return {
    async readMemoryEvidenceRecord(dependency) {
      const context = await contextForRecord(dependency.recordRef);
      if (context === null || context.opened.processingGeneration !== dependency.observedProcessingGeneration
        || !sameAuthorityLeaves(
          context.opened.semantic.terminalAuthorityLeafHandles,
          dependency.terminalAuthorityLeafHandles,
        )) return null;
      return context.opened;
    },
    async readHistoricalOrganizerEvidenceRecord(dependency) {
      if (input.selection.selectedRepresentation !== "ordinary") return null;
      const blocked = await authorityProjections.isImmediatelyBlocked({
        recordRef: dependency.recordRef,
        terminalAuthorityLeafHandles: dependency.terminalAuthorityLeafHandles,
      });
      if (blocked !== null) return null;
      const context = await contextForRecord(dependency.recordRef);
      if (context === null) return null;
      const { opened } = context;
      if (
        (opened.lifecycle !== "superseded" && opened.lifecycle !== "resolved")
        || opened.processingGeneration
          !== dependency.observedProcessingGeneration + 1
        || opened.semantic.producer.producerRef !== "organizer"
        || !sameAuthorityLeaves(
          opened.semantic.terminalAuthorityLeafHandles,
          dependency.terminalAuthorityLeafHandles,
        )
      ) return null;
      const authority = await authorityProjections.readCurrent(
        dependency.recordRef,
      );
      if (
        authority === null
        || authority.processingState !== "current"
        || authority.recordDisposition !== "available"
        || authority.recordLifecycle !== opened.lifecycle
        || !sameAuthorityLeaves(
          authority.terminalAuthorityLeafHandles,
          dependency.terminalAuthorityLeafHandles,
        )
      ) return null;
      const successors = await repository.readSuccessors({
        recordRef: opened.recordRef,
        readBindingRef: context.binding.readBindingRef,
        limit: 2,
      });
      if (
        successors.status !== "available"
        || successors.page.continuation !== undefined
        || successors.page.items.length !== 1
        || successors.page.items[0]?.predecessorRecordRef !== opened.recordRef
        || successors.page.items[0]?.relation
          !== (opened.lifecycle === "superseded" ? "supersedes" : "resolves")
      ) return null;
      return opened;
    },
    readHistoricalJournalEvidenceRecord,
    async readRetiredJournalPredecessor(dependency, roomId) {
      return readHistoricalJournalEvidenceRecord(dependency, roomId);
    },
    worker,
    recallRecordsPortForState,
    foregroundRecordContextPortForRoom,
    semanticWork,
    authoredMemoryChanges,
  };
}
