import { log } from "@nautilo/logger";

import {
  embedTextWithProvenance,
  markModelInvokeFailure,
  modelInvokeCooldownRemainingMs,
  type AuthoredMemorySemanticChange,
  type RecallRecordsPort,
  type RecallRecordsPortForState,
} from "@nautilo/agent";
import {
  findReflectionRoomOwnerIdWith,
  type DirectDatabase,
} from "@nautilo/db";
import {
  CANDIDATE_POLICY_V1,
  DurableSleepModelLaneUnavailableError,
  DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN,
  runDependencyLossRewrite,
  type DurableSleepRunBudget,
  type DurableSleepClaim,
  type DurableSleepSemanticPort,
  type DurableSleepStageAdmission,
  type DurableSleepWorkPort,
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
import {
  BoundedRecordEvidenceTraversalCheckpoints,
  BoundedRecordSearchTraversalCheckpoints,
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
    // two-minute worker watchdog still fences the whole poll and pauses any
    // repair or later batch that would exceed its lease-safe wall-clock bound.
    maximumElapsedMilliseconds: 60_000,
    modelFallbackMode: "none",
    sameModelRetryMode: "none",
  }),
  pressure: REFLECTION_SEMANTIC_PRESSURE_POLICY_V1,
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

export interface ProductionReflectionMemoryRuntime {
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
  /** Deterministic composition seam for integration qualification. Production
   * omits it and retains the canonical configured embedding provider. */
  readonly recordEmbedding?: RecordEmbeddingPort;
  readonly protectedRecordPublication?: ProtectedRecordPublicationPort;
  readonly protectedAuthorityRepublisher?: ProtectedAuthorityRepublisherPort;
  readonly protectedMemoryCandidates?: RoomLocalMemoryCandidatePort;
  readonly protectedSource?: CanonicalRecordSourceReadPort;
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
    const ownerId = await findReflectionRoomOwnerIdWith(
      input.db,
      resolved.binding.roomAnchorRef,
    );
    if (ownerId === null) return null;
    return { opened: opened.record, binding: resolved.binding, ownerId };
  };
  type ModelInvocationContext = Readonly<{ ownerId: string; roomId: string }>;
  const dispatchForRecords = async (
    claims: readonly DurableSleepClaim[],
    prompt: string,
    resolveContexts: () => Promise<readonly (ModelInvocationContext | null)[]>,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (claims.length < 1) throw new TypeError("Record model batch cannot be empty");
    const modelId = input.resolveModelId();
    const currentCooldown = modelInvokeCooldownRemainingMs(modelId);
    if (currentCooldown > 0) {
      throw new DurableSleepModelLaneUnavailableError(currentCooldown);
    }
    const contexts = await resolveContexts();
    if (contexts.length !== claims.length) {
      throw new Error("record_model_binding_unavailable");
    }
    if (contexts.some((context) => context === null) || signal?.aborted) {
      throw new Error("record_model_binding_unavailable");
    }
    const context = contexts[0]!;
    try {
      return await createRoomSideModelInvoker({
        modelId,
        userId: context.ownerId,
        roomId: context.roomId,
        laneKey: `room:${context.roomId}:reflection`,
        callType: "room_reflection",
        operationId: `reflection:${claims.map((claim) => claim.leaseToken).join(":")}`,
        invocationPolicy: {
          maximumElapsedMs:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.maximumElapsedMilliseconds,
          modelFallbackMode:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.modelFallbackMode,
          sameModelRetryMode:
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.sameModelRetryMode,
        },
      })(prompt, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = mapModelFailure(error);
      if (failure === "unknown") throw error;
      if (modelInvokeCooldownRemainingMs(modelId) === 0) {
        markModelInvokeFailure(modelId, `room_reflection_${failure}`);
      }
      throw new DurableSleepModelLaneUnavailableError(
        Math.max(1, modelInvokeCooldownRemainingMs(modelId)),
      );
    }
  };
  const invokeForRecords = async (
    claims: readonly DurableSleepClaim[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> => dispatchForRecords(
    claims,
    prompt,
    async () => Promise.all(claims.map(async (claim) => {
      const context = await contextForRecord(claim.recordRef);
      return context === null
        ? null
        : {
            ownerId: context.ownerId,
            roomId: context.binding.roomAnchorRef,
          };
    })),
    signal,
  );
  const invokePreparedOrganizerBatch: NonNullable<
    DurableSleepSemanticPort["invokeOrganizerBatch"]
  > = async (claims, prompt, signal) => dispatchForRecords(
    claims,
    prompt,
    async () => Promise.all(claims.map(async (claim) => {
      if (!await semanticWork.isClaimCurrent(claim)) return null;
      const binding = await bindings.invocation.resolve(claim.recordRef);
      if (binding === null) return null;
      const ownerId = await findReflectionRoomOwnerIdWith(input.db, binding.roomId);
      return ownerId === null ? null : { ownerId, roomId: binding.roomId };
    })),
    signal,
  );
  const invokeForRecord = (
    claim: DurableSleepClaim,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> => invokeForRecords([claim], prompt, signal);
  const proposals: DurableOrganizerProposalApplicationPort = {
    async apply(application) {
      if (application.claim.changeReason === "parent_conflict") {
        throw new TypeError("parent-conflict work cannot publish an Organizer proposal");
      }
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
      return new OrganizerProposalPublisher({
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
    },
  };
  const semantic = new SameRoomDurableSemanticComposition({
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
      repository,
      bindings: bindings.semantic,
      eligibility,
      authorityProjections,
      authorityReconciliation,
      embedding,
      searchProjections,
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
      invoke: (claim, prompt, signal) => invokeForRecord(claim, prompt, signal),
      invokeBatch: (claims, prompt, signal) => invokeForRecords(
        claims,
        prompt,
        signal,
      ),
    },
    proposals,
    crossRoom,
    parentConflicts: semanticWork,
    dependencyLoss: {
      async resolve(lossInput) {
        return new ExactGroundedDependencyLossResolver({
          repository,
          recordBindings: publicationBindings,
          eligibility,
          source: sources,
          invalidation,
          statements: {
            async rewrite(rewriteInput) {
              const result = await runDependencyLossRewrite({
                previousStatement: rewriteInput.previousStatement,
                remainingSupportStatements: rewriteInput.remainingSupportStatements,
                invoke: async (prompt, signal) => {
                  await lossInput.assertCurrent?.();
                  return invokeForRecord(lossInput.claim, prompt, signal);
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
  // Scan the obsolete-planner quarantine once per process. Durable HMAC
  // receipts keep the actual recovery exact across restarts.
  let candidatePolicyRecoveryContinuation: string | undefined;
  let candidatePolicyRecoveryComplete = false;
  const worker = new ReflectionSemanticWorker({
    maintenanceGate: input.maintenanceGate,
    ...(input.resolveStageAdmission === undefined
      ? {}
      : { resolveStageAdmission: input.resolveStageAdmission }),
    work: dataOperations.work,
    semantic: dataOperations.semantic,
    budget: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget,
    bootstrap: {
      async bootstrapPage(pageInput) {
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
        if (!candidatePolicyRecoveryComplete) {
          const recovery = await semanticWork.recoverCandidatePolicyQuarantinesPage({
            limit: pageInput.limit,
            policyVersion: "authority-aware-parent-normalization-v1",
            ...(candidatePolicyRecoveryContinuation === undefined
              ? {}
              : { continuation: candidatePolicyRecoveryContinuation }),
          });
          candidatePolicyRecoveryContinuation = recovery.continuation;
          candidatePolicyRecoveryComplete = recovery.continuation === undefined;
          if (recovery.admitted > 0 || !candidatePolicyRecoveryComplete) {
            return { admitted: recovery.admitted };
          }
        }
        const parentConflicts = await semanticWork.admitParentConflictsPage({
          limit: pageInput.limit,
        });
        if (parentConflicts.admitted > 0) return parentConflicts;
        const repair = await semanticWork.repairSourceDependentsPage({
          limit: pageInput.limit,
        });
        if (repair.consumed > 0) {
          return { admitted: repair.admitted };
        }
        const recordRepair = await semanticWork.repairRecordDependentsPage({
          limit: pageInput.limit,
        });
        if (recordRepair.consumed > 0) {
          return { admitted: recordRepair.admitted };
        }
        return semanticWork.bootstrapPage(bootstrapInput);
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
    if (typeof state.roomId !== "string" || state.roomId.length === 0) return undefined;
    const roomId = state.roomId;
    let resolvedPort: Promise<RecallRecordsPort | null> | undefined;
    const resolve = () => resolvedPort ??= bindings.evidence.resolveRoom(roomId).then((room) =>
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
    const resolve = () => resolvedPort ??= bindings.evidence.resolveRoom(roomId).then((room) =>
      room === null
        ? null
        : createForegroundRecordContextPort({
            bindingRef: bindingRef(room.namespaceId, input.selection),
            representation: input.selection.selectedRepresentation,
            search,
          })
    );
    return Object.freeze({
      representation: input.selection.selectedRepresentation,
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
    worker,
    recallRecordsPortForState,
    foregroundRecordContextPortForRoom,
    semanticWork,
    authoredMemoryChanges,
  };
}
