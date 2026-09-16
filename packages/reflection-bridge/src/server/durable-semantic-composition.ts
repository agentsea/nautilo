import {
  durableEnvelopeToRecordSnapshot,
  type DurableRecordEnvelope,
  type DurableRecordReadPort,
  type DurableSourceDependency,
} from "@nautilo/reflection/durable";
import {
  CANDIDATE_POLICY_V1,
  selectSemanticNeighbors,
  type DurableSleepFailureDetail,
  type OrganizerRecordInput,
  type PartitionedOrganizeProposal,
} from "@nautilo/reflection";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";
import type {
  DurableSleepApplyResult,
  DurableSleepClaim,
  DurableDependencyLossResolutionResult,
  DurableParentConflictResolutionResult,
  DurableSleepModelLaneReadiness,
  DurableSleepOrganizerViewResult,
  DurableSleepReadinessResult,
  DurableSleepSemanticPort,
} from "@nautilo/reflection/durable";
import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";

import {
  crossRoomApplicationPlanToken,
  type CrossRoomApplicationPlanToken,
  type CrossRoomInputCoordinate,
  type CrossRoomPublicationPlan,
} from "./cross-room-execution";
import type { SameRoomOrganizerNeighborPort } from "./same-room-organizer-neighbors";

export interface SameRoomSemanticBinding {
  readonly roomAnchorRef: string;
  readonly invocationAudience: EffectiveAudienceAlternative;
  readonly readBindingRef: string;
  readonly searchBindingRef: string;
  readonly publicationBindingRef: string;
}

/** Resolves only trusted server state; model and durable work cannot select a Room. */
export interface SameRoomSemanticBindingPort {
  resolve(record: DurableRecordEnvelope): Promise<
    | { readonly status: "available"; readonly binding: SameRoomSemanticBinding }
    | { readonly status: "unavailable" }
  >;
  resolveWork(recordRef: string): Promise<Readonly<{
    readBindingRef: string;
    invocationAudience: EffectiveAudienceAlternative;
  }> | null>;
}

export interface RoomLocalMemoryCandidate {
  readonly score: number;
  readonly snapshot: OrganizerRecordInput["snapshot"];
  readonly dependency: DurableSourceDependency;
}

export interface SameRoomScoredMemoryCoordinate {
  readonly sourceKind: string;
  readonly logicalSourceRef: string;
  readonly score: number;
}

export type SelectedSameRoomOrganizerCoordinate =
  | Readonly<{
      kind: "record";
      selectionRef: string;
      coordinate: RankedRecordCoordinate;
    }>
  | Readonly<{
      kind: "authority_parent";
      selectionRef: string;
      coordinate: RankedRecordCoordinate;
    }>
  | Readonly<{
      kind: "source";
      selectionRef: string;
      sourceKind: string;
      logicalSourceRef: string;
    }>;

/** One shared same-Room top-four policy over already eligible metadata. */
export function selectSameRoomOrganizerCoordinates(input: Readonly<{
  records: readonly RankedRecordCoordinate[];
  authorityParentRecords: readonly RankedRecordCoordinate[];
  memories: readonly SameRoomScoredMemoryCoordinate[];
}>): readonly SelectedSameRoomOrganizerCoordinate[] {
  const records = new Map(input.records.map((coordinate) => [
    `record:${coordinate.recordRef}`,
    coordinate,
  ]));
  const authorityParents = new Map(input.authorityParentRecords.map(
    (coordinate) => [
      `authority-parent:${coordinate.recordRef}`,
      coordinate,
    ],
  ));
  const memories = new Map(input.memories.map((coordinate) => [
    `source:${coordinate.sourceKind}:${coordinate.logicalSourceRef}`,
    coordinate,
  ]));
  const selected = selectSemanticNeighbors("same_room", [
    ...input.records.map((coordinate) => ({
      recordRef: `record:${coordinate.recordRef}`,
      score: coordinate.score,
    })),
    ...input.authorityParentRecords.map((coordinate) => ({
      recordRef: `authority-parent:${coordinate.recordRef}`,
      score: coordinate.score,
    })),
    ...input.memories.map((coordinate) => ({
      recordRef: `source:${coordinate.sourceKind}:${coordinate.logicalSourceRef}`,
      score: coordinate.score,
    })),
  ]);
  return Object.freeze(selected.map(({ recordRef: selectionRef }) => {
    const record = records.get(selectionRef);
    if (record !== undefined) {
      return Object.freeze({
        kind: "record" as const,
        selectionRef,
        coordinate: record,
      });
    }
    const authorityParent = authorityParents.get(selectionRef);
    if (authorityParent !== undefined) {
      return Object.freeze({
        kind: "authority_parent" as const,
        selectionRef,
        coordinate: authorityParent,
      });
    }
    const source = memories.get(selectionRef);
    if (source === undefined) {
      throw new TypeError("selected same-Room Organizer coordinate disappeared");
    }
    return Object.freeze({
      kind: "source" as const,
      selectionRef,
      sourceKind: source.sourceKind,
      logicalSourceRef: source.logicalSourceRef,
    });
  }));
}

/** Selected-mode, exact-Room, read-only authored Memory adapter. */
export interface RoomLocalMemoryCandidatePort {
  search(input: Readonly<{
    roomAnchorRef: string;
    embedding: RecordEmbeddingV1;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly candidates: readonly RoomLocalMemoryCandidate[] }
    | { readonly status: "unavailable" }
  >;
}

export interface DurableSemanticReadinessPort {
  ensureAuthority(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult>;
  ensureSearchProjection(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult>;
}

export interface DurableOrganizerModelPort {
  readiness?(signal?: AbortSignal): Promise<DurableSleepModelLaneReadiness>;
  invoke(
    claim: DurableSleepClaim,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
  invokeBatch(
    claims: readonly DurableSleepClaim[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface DurableOrganizerProposalApplicationPort {
  apply(input: Readonly<{
    claim: DurableSleepClaim;
    proposal: PartitionedOrganizeProposal;
    idempotencyKey: string;
    budget: Parameters<DurableSleepSemanticPort["applyProposal"]>[0]["budget"];
    publicationPlan?: CrossRoomPublicationPlan;
    signal?: AbortSignal;
  }>): Promise<DurableSleepApplyResult>;
}

export interface DurableParentConflictPort {
  resolveParentConflict(input: Readonly<{
    claim: DurableSleepClaim;
    signal?: AbortSignal;
  }>): Promise<DurableParentConflictResolutionResult>;
}

export type CrossRoomOrganizerAugmentationResult =
  | Readonly<{
      status: "empty";
      unsupportedAuthorityShapes: number;
      authorityParentsResolved: number;
      authorityParentsSkipped: number;
      protectedExecutionUnavailable: number;
    }>
  | Readonly<{
      status: "available";
      candidates: readonly OrganizerRecordInput[];
      existingParents: readonly OrganizerRecordInput[];
      applicationPlanToken: CrossRoomApplicationPlanToken;
      unsupportedAuthorityShapes: number;
      authorityParentsResolved: number;
      authorityParentsSkipped: number;
      protectedExecutionUnavailable: number;
    }>
  | Readonly<{
      status: "no_change";
      reason:
        | "unsupported_authority_shape"
        | "no_effective_audience"
        | "protected_execution_unavailable";
    }>
  | Readonly<{
      status: "unavailable";
      failureCode: "candidate_unavailable" | "projection_unavailable";
      failureDetail?: DurableSleepFailureDetail;
    }>;

export type CrossRoomOrganizerPublicationPlanningResult =
  | Readonly<{ status: "planned"; plan: CrossRoomPublicationPlan }>
  | Readonly<{
      status: "stale";
      failureDetail:
        | "publication_plan_stale"
        | "publication_predecessor_changed"
        | "publication_child_unavailable"
        | "publication_authority_fence_stale";
    }>
  | Readonly<{
      status: "no_change";
      reason: "unsupported_authority_shape" | "no_effective_audience";
    }>
  | Readonly<{
      status: "unavailable";
      failureDetail:
        | "publication_plan_invalid"
        | "publication_memory_fence_unavailable"
        | "publication_input_access_audience_unavailable"
        | "publication_output_access_audience_unavailable"
        | "publication_source_authority_unavailable"
        | "publication_evidence_unavailable";
    }>;

/**
 * Scope-neutral partition seam. The old same-Room path remains the baseline;
 * this port contributes an independently authorized bounded partition and
 * owns the post-model exact output plan.
 */
export interface CrossRoomOrganizerPartitionPort {
  augment(input: Readonly<{
    claim: DurableSleepClaim;
    changed: DurableRecordEnvelope;
    binding: SameRoomSemanticBinding;
    queryEmbedding: RecordEmbeddingV1;
    sameRoomCandidates: readonly OrganizerRecordInput[];
    sameRoomParents: readonly OrganizerRecordInput[];
    sameRoomPlanInputs: readonly CrossRoomInputCoordinate[];
    /** Same-binding ranked seeds whose unique current parent uses another binding. */
    authorityParentSeeds: readonly Readonly<{
      recordRef: string;
      score: number;
    }>[];
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerAugmentationResult>;
  planPublication(input: Readonly<{
    applicationPlanToken: CrossRoomApplicationPlanToken;
    proposal: PartitionedOrganizeProposal;
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerPublicationPlanningResult>;
  planDependencyLoss?(input: Readonly<{
    predecessor: DurableRecordEnvelope;
    proposal: Extract<PartitionedOrganizeProposal, { operation: "supersede_parent" }>;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerPublicationPlanningResult>;
}

export type GroundedDependencyLossDecision =
  | { readonly status: "stable" }
  | { readonly status: "unavailable" }
  | { readonly status: "total_loss" }
  | Readonly<{
      status: "partial_loss";
      replacementStatement: string;
      modelCalls: 1 | 2;
      remainingChildRecordRefs: readonly string[];
      remainingSourceDependencies: readonly DurableSourceDependency[];
    }>;

/** Exact selected-mode dependency revalidation and grounded rewrite seam. */
export interface GroundedDependencyLossPort {
  resolve(input: Readonly<{
    claim: DurableSleepClaim;
    record: DurableRecordEnvelope;
    binding: SameRoomSemanticBinding;
    assertCurrent?: () => Promise<void>;
    signal?: AbortSignal;
  }>): Promise<GroundedDependencyLossDecision>;
}

function hasExactRoomAnchor(
  record: OrganizerRecordInput["snapshot"],
  roomAnchorRef: string,
): boolean {
  return record.anchors.includes(roomAnchorRef);
}

function recordInput(
  handle: string,
  record: DurableRecordEnvelope,
): OrganizerRecordInput {
  return {
    handle,
    snapshot: durableEnvelopeToRecordSnapshot(record),
    dependency: { kind: "record", recordRef: record.recordRef },
  };
}

/**
 * Production semantic adapter over the pure durable Sleep contract.
 *
 * Every payload is opened through one server-selected repository, every
 * candidate is re-opened and checked for the exact Room anchor, and authored
 * Memories remain typed source dependencies. The adapter intentionally owns
 * no provider, Room lookup, DB handle, repository mode, or scheduler.
 */
export class SameRoomDurableSemanticComposition
implements DurableSleepSemanticPort {
  readonly openOrganizationAttempt?: NonNullable<DurableSleepSemanticPort["openOrganizationAttempt"]>;
  constructor(private readonly ports: Readonly<{
    openOrganizationAttempt?: NonNullable<DurableSleepSemanticPort["openOrganizationAttempt"]>;
    repository: DurableRecordReadPort;
    readiness: DurableSemanticReadinessPort;
    bindings: SameRoomSemanticBindingPort;
    organizerNeighbors: SameRoomOrganizerNeighborPort;
    memories: RoomLocalMemoryCandidatePort;
    model: DurableOrganizerModelPort;
    proposals: DurableOrganizerProposalApplicationPort;
    dependencyLoss: GroundedDependencyLossPort;
    parentConflicts?: DurableParentConflictPort;
    crossRoom?: CrossRoomOrganizerPartitionPort;
    /** Deterministic content-free timing seam. */
    now?: () => number;
  }>) {
    if (ports.openOrganizationAttempt) this.openOrganizationAttempt = ports.openOrganizationAttempt;
  }

  resolveParentConflict(input: Readonly<{
    claim: DurableSleepClaim;
    signal?: AbortSignal;
  }>): Promise<DurableParentConflictResolutionResult> {
    return this.ports.parentConflicts?.resolveParentConflict(input)
      ?? Promise.resolve({
        status: "unavailable",
        failureCode: "candidate_unavailable",
        failureDetail: "parent_conflict_storage_unavailable",
      });
  }

  modelLaneReadiness(
    signal?: AbortSignal,
  ): Promise<DurableSleepModelLaneReadiness> {
    return this.ports.model.readiness?.(signal)
      ?? Promise.resolve({ status: "ready" });
  }

  ensureAuthority(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult> {
    return this.ports.readiness.ensureAuthority(claim, signal);
  }

  ensureSearchProjection(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult> {
    return this.ports.readiness.ensureSearchProjection(claim, signal);
  }

  async loadOrganizerView(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepOrganizerViewResult> {
    const now = this.ports.now ?? performance.now.bind(performance);
    const sameRoomStartedAt = now();
    const workBinding = await this.ports.bindings.resolveWork(
      claim.recordRef,
    );
    if (workBinding === null) {
      return { status: "unavailable", failureCode: "record_unavailable" };
    }
    const changed = await this.ports.repository.read({
      recordRef: claim.recordRef,
      readBindingRef: workBinding.readBindingRef,
    });
    if (changed.status !== "available") {
      return { status: "unavailable", failureCode: "record_unavailable" };
    }
    if (changed.record.lifecycle !== "current") {
      return { status: "no_change", reason: "record_lifecycle_obsolete" };
    }
    const resolved = await this.ports.bindings.resolve(changed.record);
    if (resolved.status !== "available") {
      return { status: "unavailable", failureCode: "authority_unavailable" };
    }
    const binding = resolved.binding;
    if (!changed.record.semantic.anchors.some((anchor) =>
      anchor.kind === "room" && anchor.anchorRef === binding.roomAnchorRef
    )) {
      return { status: "unavailable", failureCode: "candidate_unavailable" };
    }

    const promotion = claim.changeReason === "scheduled_review";
    const discovered = await this.ports.organizerNeighbors.discover({
      changed: changed.record,
      binding,
      intent: promotion ? "promotion" : "attachment",
      ...(signal === undefined ? {} : { signal }),
    });
    if (discovered.status !== "available") {
      return {
        status: "unavailable",
        failureCode: discovered.reason === "candidate_projection_stale"
          ? "projection_unavailable"
          : "candidate_unavailable",
        failureDetail: discovered.reason,
      };
    }
    if (discovered.discovery.changedAlreadyParented) {
      return { status: "no_change", reason: "already_covered" };
    }
    const searchedMemories = promotion
      ? { status: "available" as const, candidates: [] }
      : await this.ports.memories.search({
          roomAnchorRef: binding.roomAnchorRef,
          embedding: discovered.discovery.queryEmbedding,
          limit: CANDIDATE_POLICY_V1.sameRoomBound,
          ...(signal === undefined ? {} : { signal }),
        });
    if (searchedMemories.status !== "available") {
      return { status: "unavailable", failureCode: "candidate_unavailable" };
    }

    const scoredMemories: Array<{
      selectionRef: string;
      sourceKind: string;
      logicalSourceRef: string;
      score: number;
      input: OrganizerRecordInput;
    }> = [];
    for (const candidate of searchedMemories.candidates) {
      if (!hasExactRoomAnchor(candidate.snapshot, binding.roomAnchorRef)) continue;
      scoredMemories.push({
        selectionRef: `source:${candidate.dependency.sourceKind}:${candidate.dependency.logicalSourceRef}`,
        sourceKind: candidate.dependency.sourceKind,
        logicalSourceRef: candidate.dependency.logicalSourceRef,
        score: candidate.score,
        input: {
          handle: "unused",
          snapshot: candidate.snapshot,
          dependency: { kind: "source", dependency: candidate.dependency },
        },
      });
    }
    const selected = selectSameRoomOrganizerCoordinates({
      records: discovered.discovery.candidateCoordinates,
      authorityParentRecords:
        discovered.discovery.authorityParentCandidateCoordinates,
      memories: scoredMemories.map((candidate) => ({
        sourceKind: candidate.sourceKind,
        logicalSourceRef: candidate.logicalSourceRef,
        score: candidate.score,
      })),
    });
    const memoryInputs = new Map(
      scoredMemories.map((candidate) => [candidate.selectionRef, candidate.input]),
    );
    const selectedNativeCoordinates = selected.flatMap((candidate) =>
      candidate.kind === "record" ? [candidate.coordinate] : []);
    const selectedAuthorityParentCoordinates = selected.flatMap((candidate) =>
      candidate.kind === "authority_parent" ? [candidate.coordinate] : []);
    const selectedOpenStartedAt = now();
    const opened = await this.ports.organizerNeighbors.openSelected({
      binding,
      coordinates: [
        ...selectedNativeCoordinates,
        ...discovered.discovery.parentTargetCoordinates,
      ],
      ...(signal === undefined ? {} : { signal }),
    });
    if (opened.status !== "available") {
      return {
        status: "unavailable",
        failureCode: "candidate_unavailable",
        failureDetail: opened.reason,
      };
    }
    const selectedOpenElapsedMs = Math.max(
      0,
      Math.round(now() - selectedOpenStartedAt),
    );
    const openedByRef = new Map(
      opened.records.map((entry) => [entry.coordinate.recordRef, entry.snapshot]),
    );
    const candidates: OrganizerRecordInput[] = [];
    for (const selectedCandidate of selected) {
      if (selectedCandidate.kind === "record") {
        const coordinate = selectedCandidate.coordinate;
        const snapshot = openedByRef.get(coordinate.recordRef);
        if (snapshot === undefined) {
          return { status: "unavailable", failureCode: "candidate_unavailable" };
        }
        candidates.push({
          handle: `C${candidates.length + 1}`,
          snapshot,
          dependency: { kind: "record", recordRef: coordinate.recordRef },
        });
      } else if (selectedCandidate.kind === "source") {
        const memory = memoryInputs.get(selectedCandidate.selectionRef);
        if (memory === undefined) {
          return { status: "unavailable", failureCode: "candidate_unavailable" };
        }
        candidates.push({ ...memory, handle: `C${candidates.length + 1}` });
      }
    }
    const existingParents: OrganizerRecordInput[] = [];
    for (const coordinate of discovered.discovery.parentTargetCoordinates) {
      const snapshot = openedByRef.get(coordinate.recordRef);
      if (snapshot === undefined) {
        return { status: "unavailable", failureCode: "candidate_unavailable" };
      }
      existingParents.push({
        handle: `P${existingParents.length + 1}`,
        snapshot,
        dependency: { kind: "record", recordRef: coordinate.recordRef },
      });
    }

    let applicationPlanToken: CrossRoomApplicationPlanToken | undefined;
    let unsupportedAuthorityShapes = 0;
    let authorityParentsResolved = 0;
    let authorityParentsSkipped = 0;
    let protectedExecutionUnavailable = 0;
    const sameRoomElapsedMs = Math.max(
      0,
      Math.round(now() - sameRoomStartedAt) - selectedOpenElapsedMs,
    );
    let crossRoomElapsedMs = 0;
    if (this.ports.crossRoom !== undefined) {
      const crossRoomStartedAt = now();
      const namespaceFromBinding = /^journal:namespace:([^:]+):/u
        .exec(binding.readBindingRef)?.[1]
        ?? changed.record.semantic.terminalAuthorityLeafHandles[0]
        ?? binding.roomAnchorRef;
      const selectedRecordCoordinates = new Map([
        ...selectedNativeCoordinates,
        ...discovered.discovery.parentTargetCoordinates,
      ].map((coordinate) => [coordinate.recordRef, coordinate]));
      const sameRoomPlanInputs: CrossRoomInputCoordinate[] = [];
      for (const entry of [...candidates, ...existingParents]) {
        if (entry.dependency?.kind === "record") {
          const coordinate = selectedRecordCoordinates.get(entry.dependency.recordRef);
          if (coordinate === undefined) continue;
          sameRoomPlanInputs.push({
            kind: "record",
            role: "candidate",
            recordRef: coordinate.recordRef,
            processingGeneration: coordinate.recordProcessingGeneration,
            representationGeneration: coordinate.payloadRepresentationGeneration,
            authorityGeneration: coordinate.authorityProjectionGeneration,
            read: {
              namespaceRef: namespaceFromBinding,
              bindingRef: binding.readBindingRef,
            },
          });
        } else if (entry.dependency?.kind === "source") {
          const revision = Number(entry.dependency.dependency.observedRevision ?? 0);
          if (!Number.isSafeInteger(revision) || revision < 0) continue;
          sameRoomPlanInputs.push({
            kind: "source",
            sourceKind: "memory",
            role: "candidate",
            logicalSourceRef: entry.dependency.dependency.logicalSourceRef,
            contentGeneration: revision,
            representationGeneration: revision + 1,
            authorityGeneration: 1,
            read: {
              namespaceRef:
                entry.dependency.dependency.terminalAuthorityLeafHandle,
              bindingRef: binding.readBindingRef,
            },
          });
        }
      }
      const augmented = await this.ports.crossRoom.augment({
        claim,
        changed: changed.record,
        binding,
        queryEmbedding: discovered.discovery.queryEmbedding,
        sameRoomCandidates: candidates,
        sameRoomParents: existingParents,
        sameRoomPlanInputs,
        authorityParentSeeds: [
          ...selectedAuthorityParentCoordinates,
          ...discovered.discovery.authorityParentTargetCoordinates,
        ].map((coordinate) => ({
          recordRef: coordinate.recordRef,
          score: coordinate.score,
        })),
        ...(signal === undefined ? {} : { signal }),
      });
      crossRoomElapsedMs = Math.max(0, Math.round(now() - crossRoomStartedAt));
      if (augmented.status === "empty") {
        return {
          status: "ready",
          view: {
            changed: recordInput("R1", changed.record),
            candidates,
            existingParents,
            maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
            planning: {
              sameRoomPlans: 1,
              crossRoomPlans: 0,
              candidatesOpened: candidates.length + existingParents.length,
              unsupportedAuthorityShapes: augmented.unsupportedAuthorityShapes,
              authorityParentsResolved: augmented.authorityParentsResolved,
              authorityParentsSkipped: augmented.authorityParentsSkipped,
              protectedExecutionUnavailable:
                augmented.protectedExecutionUnavailable,
              sameRoomElapsedMs,
              crossRoomElapsedMs,
              selectedOpenElapsedMs,
            },
          },
        };
      }
      if (augmented.status === "no_change") {
        return { status: "no_change", reason: augmented.reason };
      }
      if (augmented.status === "unavailable") {
        return {
          status: "unavailable",
          failureCode: augmented.failureCode,
          ...(augmented.failureDetail === undefined
            ? {}
            : { failureDetail: augmented.failureDetail }),
        };
      }
      const logicalIdentity = (entry: OrganizerRecordInput): string =>
        entry.dependency === undefined
          ? `snapshot\0${entry.snapshot.recordRef}`
          : entry.dependency.kind === "record"
            ? `record\0${entry.dependency.recordRef}`
            : `source\0${entry.dependency.dependency.sourceKind}\0${entry.dependency.dependency.logicalSourceRef}`;
      // A ranked descendant can normalize to the changed parent. Treat that
      // support as already covered by R1 instead of exposing the same logical
      // dependency twice under different opaque handles.
      const seen = new Set([
        `record\0${changed.record.recordRef}`,
        ...candidates.map(logicalIdentity),
      ]);
      for (const entry of augmented.candidates) {
        if (seen.has(logicalIdentity(entry))) continue;
        seen.add(logicalIdentity(entry));
        candidates.push({ ...entry, handle: `C${candidates.length + 1}` });
      }
      const parentRefs = new Set(existingParents.flatMap((entry) =>
        entry.dependency?.kind === "record" ? [entry.dependency.recordRef] : []));
      for (const entry of augmented.existingParents) {
        if (
          entry.dependency?.kind !== "record"
          || parentRefs.has(entry.dependency.recordRef)
        ) {
          continue;
        }
        parentRefs.add(entry.dependency.recordRef);
        existingParents.push({ ...entry, handle: `P${existingParents.length + 1}` });
      }
      applicationPlanToken = augmented.applicationPlanToken;
      unsupportedAuthorityShapes = augmented.unsupportedAuthorityShapes;
      authorityParentsResolved = augmented.authorityParentsResolved;
      authorityParentsSkipped = augmented.authorityParentsSkipped;
      protectedExecutionUnavailable = augmented.protectedExecutionUnavailable;
    }

    return {
      status: "ready",
      view: {
        changed: recordInput("R1", changed.record),
        candidates,
        existingParents,
        maxSelectedChildren: applicationPlanToken === undefined
          ? CANDIDATE_POLICY_V1.sameRoomBound
          : CANDIDATE_POLICY_V1.sameRoomBound + CANDIDATE_POLICY_V1.crossRoomBound,
        ...(applicationPlanToken === undefined
          ? {}
          : { applicationPlanToken }),
        planning: {
          sameRoomPlans: 1,
          crossRoomPlans: applicationPlanToken === undefined ? 0 : 1,
          candidatesOpened: candidates.length + existingParents.length,
          unsupportedAuthorityShapes,
          authorityParentsResolved,
          authorityParentsSkipped,
          protectedExecutionUnavailable,
          sameRoomElapsedMs,
          crossRoomElapsedMs,
          selectedOpenElapsedMs,
        },
      },
    };
  }

  invokeOrganizer(
    claim: DurableSleepClaim,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.ports.model.invoke(claim, prompt, signal);
  }

  invokeOrganizerBatch(
    claims: readonly DurableSleepClaim[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.ports.model.invokeBatch(claims, prompt, signal);
  }

  async resolveDependencyLoss(
    input: Parameters<DurableSleepSemanticPort["resolveDependencyLoss"]>[0],
  ): Promise<DurableDependencyLossResolutionResult> {
    const work = await this.ports.bindings.resolveWork(input.claim.recordRef);
    if (work === null) {
      return { status: "unavailable", failureCode: "record_unavailable" };
    }
    const opened = await this.ports.repository.read({
      recordRef: input.claim.recordRef,
      readBindingRef: work.readBindingRef,
    });
    if (opened.status !== "available") {
      return { status: "unavailable", failureCode: "record_unavailable" };
    }
    if (opened.record.semantic.posture !== "derived") {
      return { status: "not_applicable" };
    }
    if (opened.record.lifecycle !== "current" && opened.record.lifecycle !== "stale") {
      return { status: "not_applicable" };
    }
    const resolved = await this.ports.bindings.resolve(opened.record);
    if (resolved.status !== "available") {
      return { status: "unavailable", failureCode: "authority_unavailable" };
    }
    await input.publication?.assertCurrent();
    const loss = await this.ports.dependencyLoss.resolve({
      claim: input.claim,
      record: opened.record,
      binding: resolved.binding,
      ...(input.publication ? { assertCurrent: () => input.publication!.assertCurrent() } : {}),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (loss.status === "stable") return { status: "not_applicable" };
    if (loss.status === "unavailable") {
      return { status: "unavailable", failureCode: "candidate_unavailable" };
    }
    const proposal = loss.status === "total_loss"
      ? {
          operation: "dissolve_parent" as const,
          parentRecordRef: opened.record.recordRef,
        }
      : {
          operation: "supersede_parent" as const,
          parentRecordRef: opened.record.recordRef,
          statement: loss.replacementStatement,
          childRecordRefs: loss.remainingChildRecordRefs,
          sourceDependencies: loss.remainingSourceDependencies,
    };
    let publicationPlan: CrossRoomPublicationPlan | undefined;
    const requiresExactDependencyLossPlan = loss.status === "partial_loss"
      && (
        loss.remainingSourceDependencies.length === 0
        || opened.record.semantic.terminalAuthorityLeafHandles.length > 1
      );
    if (requiresExactDependencyLossPlan) {
      const crossRoom = this.ports.crossRoom;
      if (crossRoom?.planDependencyLoss === undefined) {
        return {
          status: "unavailable",
          failureCode: "publication_unavailable",
          failureDetail: "publication_plan_invalid",
        };
      } else {
        const planned = await crossRoom.planDependencyLoss({
          predecessor: opened.record,
          proposal: proposal as Extract<
            PartitionedOrganizeProposal,
            { operation: "supersede_parent" }
          >,
          idempotencyKey: input.idempotencyKey,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (planned.status === "no_change") return { status: "not_applicable" };
        if (planned.status !== "planned") {
          return {
            status: "unavailable",
            failureCode: "publication_unavailable",
            failureDetail: planned.failureDetail,
          };
        }
        publicationPlan = planned.plan;
      }
    }
    const publish = () => this.ports.proposals.apply({
      claim: input.claim,
      proposal,
      idempotencyKey: input.idempotencyKey,
      budget: input.budget,
      ...(publicationPlan === undefined ? {} : { publicationPlan }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const applied = input.publication ? await input.publication.publish(publish) : await publish();
    if (applied.status !== "applied" || applied.changedRecord === undefined) {
      return {
        status: "unavailable",
        failureCode: "publication_unavailable",
        ...(applied.status === "applied" || applied.failureDetail === undefined
          ? {}
          : { failureDetail: applied.failureDetail }),
      };
    }
    return {
      status: "applied",
      outcome: loss.status === "total_loss"
        ? "total_sunset"
        : "partial_replacement",
      replayed: applied.replayed,
      usage: loss.status === "partial_loss"
        ? { ...applied.usage, modelCalls: applied.usage.modelCalls + loss.modelCalls }
        : applied.usage,
      changedRecord: applied.changedRecord,
    };
  }

  async applyProposal(
    input: Parameters<DurableSleepSemanticPort["applyProposal"]>[0],
  ): Promise<DurableSleepApplyResult> {
    if (input.applicationPlanToken === undefined || this.ports.crossRoom === undefined) {
      const startedAt = (this.ports.now ?? performance.now.bind(performance))();
      const result = await this.ports.proposals.apply(input);
      if (result.status !== "applied") return result;
      return {
        ...result,
        timing: result.timing ?? {
          publicationPlanningElapsedMs: 0,
          finalAuthorityElapsedMs: 0,
          productPublicationElapsedMs: Math.max(
            0,
            Math.round(
              (this.ports.now ?? performance.now.bind(performance))() - startedAt,
            ),
          ),
          recursiveAdmissionElapsedMs: 0,
        },
      };
    }
    return this.#applyCrossRoomProposal(input);
  }

  async #applyCrossRoomProposal(
    input: Parameters<DurableSleepSemanticPort["applyProposal"]>[0],
  ): Promise<DurableSleepApplyResult> {
    const applicationPlanToken = crossRoomApplicationPlanToken(
      input.applicationPlanToken!,
    );
    const now = this.ports.now ?? performance.now.bind(performance);
    const planningStartedAt = now();
    const planned = await this.ports.crossRoom!.planPublication({
      applicationPlanToken,
      proposal: input.proposal,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const publicationPlanningElapsedMs = Math.max(
      0,
      Math.round(now() - planningStartedAt),
    );
    if (planned.status === "unavailable") {
      if (
        input.proposal.operation === "no_change"
        && planned.failureDetail === "publication_plan_invalid"
      ) {
        return {
          status: "applied",
          operation: "no_change",
          replayed: false,
          usage: {
            modelCalls: 0,
            visitedRecords: 0,
            createdRecords: 0,
            traversalWork: 0,
          },
          timing: {
            publicationPlanningElapsedMs,
            finalAuthorityElapsedMs: 0,
            productPublicationElapsedMs: 0,
            recursiveAdmissionElapsedMs: 0,
          },
        };
      }
      return {
        status: "unavailable",
        failureCode: "publication_unavailable",
        failureDetail: planned.failureDetail,
      };
    }
    if (planned.status === "stale") {
      return { status: "stale", failureDetail: planned.failureDetail };
    }
    if (planned.status === "no_change") {
      return {
        status: "applied",
        operation: "no_change",
        replayed: false,
        terminalOutcome: planned.reason,
        usage: {
          modelCalls: 0,
          visitedRecords: 0,
          createdRecords: 0,
          traversalWork: 0,
        },
        timing: {
          publicationPlanningElapsedMs,
          finalAuthorityElapsedMs: 0,
          productPublicationElapsedMs: 0,
          recursiveAdmissionElapsedMs: 0,
        },
      };
    }
    const publicationStartedAt = now();
    const applied = await this.ports.proposals.apply({
      ...input,
      publicationPlan: planned.plan,
    });
    if (applied.status !== "applied") return applied;
    return {
      ...applied,
      timing: applied.timing ?? {
        publicationPlanningElapsedMs,
        finalAuthorityElapsedMs: 0,
        productPublicationElapsedMs: Math.max(
          0,
          Math.round(now() - publicationStartedAt),
        ),
        recursiveAdmissionElapsedMs: 0,
      },
    };
  }
}
