import { createHmac } from "node:crypto";

import type {
  DurableSleepApplyResult,
  DurableSleepFailureDetail,
  HierarchyBudget,
  HierarchyBudgetUsage,
  OrganizerChangeReason,
  OrganizerEvidenceRecord,
  PartitionedOrganizeProposal,
} from "@nautilo/reflection";
import {
  deriveOrganizerEvidenceClosure,
  isStrictOrganizerEvidenceSuperset,
  organizerEvidenceClosuresArePairwiseDisjoint,
  organizerEvidenceHasDependencyPath,
  organizerEvidenceIdentityKey,
  organizerSourceEvidenceIdentity,
} from "@nautilo/reflection";
import type {
  DurableRecordAnchor,
  DurableRecordEnvelope,
  DurableRecordLifecycleMutation,
  DurableRecordLifecycleMutationResult,
  DurableRecordPublication,
  DurableRecordPublicationResult,
  DurableRecordReadRequest,
  DurableRecordReadResult,
  DurableRecordStructuralRejection,
  DurableSourceDependency,
} from "@nautilo/reflection/durable";

import {
  assertCrossRoomPublicationPlan,
  type CrossRoomInputCoordinate,
  type CrossRoomPublicationPlan,
} from "./cross-room-execution";
import type { CurrentRecordPublicationBindingPort } from "./postgres-current-record-publication-binding";

export const ORGANIZER_PUBLICATION_COMMITMENT_MAX_BYTES = 256 * 1_024;

const encoder = new TextEncoder();
const ZERO_USAGE: HierarchyBudgetUsage = {
  modelCalls: 0,
  visitedRecords: 0,
  createdRecords: 0,
  traversalWork: 0,
};

export type OrganizerPublicationCommitmentPurpose =
  | "publication_idempotency"
  | "record_identity"
  | "content_fingerprint";

/**
 * Keyed, deterministic identity boundary. Callers persist only its opaque
 * result; raw work identities and semantic commitment input stay transient.
 */
export interface KeyedOrganizerPublicationIdentityPort {
  commit(input: {
    readonly purpose: OrganizerPublicationCommitmentPurpose;
    readonly canonicalBytes: Uint8Array;
  }): string;
}

export function createHmacOrganizerPublicationIdentityPort(
  key: Uint8Array,
): KeyedOrganizerPublicationIdentityPort {
  if (key.byteLength < 32) {
    throw new TypeError("Organizer publication identity key must contain at least 32 bytes");
  }
  const ownedKey = key.slice();
  return Object.freeze({
    commit(input: {
      readonly purpose: OrganizerPublicationCommitmentPurpose;
      readonly canonicalBytes: Uint8Array;
    }): string {
      if (
        input.canonicalBytes.byteLength < 1
        || input.canonicalBytes.byteLength > ORGANIZER_PUBLICATION_COMMITMENT_MAX_BYTES
      ) {
        throw new RangeError("Organizer publication commitment bytes are out of bounds");
      }
      const hmac = createHmac("sha256", ownedKey);
      hmac.update("nautilo/reflection/organizer-publication/v1\0", "utf8");
      hmac.update(input.purpose, "utf8");
      hmac.update("\0", "utf8");
      hmac.update(input.canonicalBytes);
      const digest = hmac.digest("hex");
      switch (input.purpose) {
        case "publication_idempotency": return `organizer-publication:${digest}`;
        case "record_identity": return `organizer-record:${digest}`;
        case "content_fingerprint": return `hmac-sha256:${digest}`;
      }
      throw new TypeError("Unknown Organizer publication commitment purpose");
    },
  });
}

/** One exact invocation-Room context, resolved before proposal application. */
export interface OrganizerPublicationRoomContext {
  readonly roomAnchorRef: string;
  readonly terminalAuthorityLeafHandle: string;
  readonly readBindingRef: string;
  readonly publicationBindingRef: string;
  readonly producerPolicyVersion: string;
}

export interface OrganizerProposalRepositoryPort {
  read(input: DurableRecordReadRequest): Promise<DurableRecordReadResult>;
  readCompletedPublication(input: Readonly<{
    idempotencyKey: string;
    readBindingRef: string;
  }>): Promise<
    | { readonly status: "available"; readonly record: DurableRecordEnvelope }
    | {
        readonly status: "unavailable";
        readonly reason:
          | "not_found"
          | "incomplete"
          | "unauthorized"
          | "integrity_failure"
          | "blocked"
          | "purged";
      }
  >;
  publish(input: DurableRecordPublication): Promise<DurableRecordPublicationResult>;
  transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult>;
}

/** Exact selected-mode source validation immediately before publication. */
export interface OrganizerSourceDependencyValidationPort {
  validate(input: Readonly<{
    dependency: DurableSourceDependency;
    readBindingRef: string;
    signal?: AbortSignal;
  }>): Promise<"current" | "unavailable">;
}

export interface OrganizerProposalPublisherOptions {
  readonly repository: OrganizerProposalRepositoryPort;
  readonly sourceDependencies: OrganizerSourceDependencyValidationPort;
  readonly identity: KeyedOrganizerPublicationIdentityPort;
  readonly room: OrganizerPublicationRoomContext;
  /** Required only when an application carries a cross-Room publication plan. */
  readonly crossRoomFences?: OrganizerCrossRoomPublicationFencePort;
  /** Exact current payload location for unplanned descendants of cross-Room inputs. */
  readonly recordBindings?: CurrentRecordPublicationBindingPort;
  /** Preserve invocation provenance when an exact plan writes to another access Namespace. */
  readonly preserveExactPlanInvocationOrigin?: boolean;
}

export type OrganizerPredecessorAudienceRelation = "equal" | "different";

/**
 * Final selected-mode fence over the content-free cross-Room plan. The port
 * owns live authority/representation lookup; the publisher never infers
 * audience equality from Room or Namespace identity.
 */
export interface OrganizerCrossRoomPublicationFencePort {
  revalidate(input: Readonly<{
    plan: CrossRoomPublicationPlan;
    predecessorRecordRef?: string;
    signal?: AbortSignal;
  }>): Promise<
    | {
        readonly status: "current";
        readonly predecessorAudience?: OrganizerPredecessorAudienceRelation;
      }
    | {
        readonly status: "stale";
        readonly failureDetail: "publication_authority_fence_stale";
      }
    | {
        readonly status: "unavailable";
        readonly failureDetail:
          | "publication_plan_invalid"
          | "publication_memory_fence_unavailable"
          | "publication_revalidation_access_audience_unavailable";
      }
  >;
}

export interface OrganizerProposalApplicationInput {
  readonly proposal: PartitionedOrganizeProposal;
  /** Native Record whose durable work item caused this decision. */
  readonly changedRecordRef: string;
  /** Raw work identity is committed before it enters repository state. */
  readonly idempotencyKey: string;
  readonly budget: HierarchyBudget;
  readonly changeReason: OrganizerChangeReason;
  /** Exact post-Organizer selection; absent preserves legacy same-Room behavior. */
  readonly publicationPlan?: CrossRoomPublicationPlan;
  readonly signal?: AbortSignal;
}

function unavailable(
  failureDetail: DurableSleepFailureDetail = "publication_validation_unavailable",
): DurableSleepApplyResult {
  return {
    status: "unavailable",
    failureCode: "publication_unavailable",
    failureDetail,
  };
}

function structuralFailureDetail(
  reason: DurableRecordStructuralRejection,
): DurableSleepFailureDetail {
  switch (reason) {
    case "record_already_exists": return "publication_record_already_exists";
    case "invalid_record_shape": return "publication_invalid_record_shape";
    case "child_unavailable": return "publication_child_unavailable";
    case "child_parent_changed": return "publication_child_parent_changed";
    case "height_mismatch": return "publication_height_mismatch";
    case "ancestor_cycle": return "publication_ancestor_cycle";
    case "predecessor_changed": return "publication_predecessor_changed";
    case "successor_changed": return "publication_successor_changed";
    case "publication_incomplete": return "publication_incomplete";
  }
}

function staleStructuralRejection(
  reason: DurableRecordStructuralRejection,
): reason is Extract<
  DurableRecordStructuralRejection,
  | "child_unavailable"
  | "child_parent_changed"
  | "predecessor_changed"
  | "successor_changed"
> {
  return reason === "child_unavailable"
    || reason === "child_parent_changed"
    || reason === "predecessor_changed"
    || reason === "successor_changed";
}

function staleStructuralFailureDetail(
  reason: Extract<
    DurableRecordStructuralRejection,
    | "child_unavailable"
    | "child_parent_changed"
    | "predecessor_changed"
    | "successor_changed"
  >,
): Extract<
  DurableSleepFailureDetail,
  | "publication_child_unavailable"
  | "publication_child_parent_changed"
  | "publication_predecessor_changed"
  | "publication_successor_changed"
> {
  switch (reason) {
    case "child_unavailable": return "publication_child_unavailable";
    case "child_parent_changed": return "publication_child_parent_changed";
    case "predecessor_changed": return "publication_predecessor_changed";
    case "successor_changed": return "publication_successor_changed";
  }
}

function noChange(usage: HierarchyBudgetUsage = ZERO_USAGE): DurableSleepApplyResult {
  return {
    status: "applied",
    operation: "no_change",
    replayed: false,
    usage,
  };
}

function capacityOutcome(
  changeReason: OrganizerChangeReason,
  usage: HierarchyBudgetUsage = ZERO_USAGE,
): DurableSleepApplyResult {
  // Scheduled review is opportunistic maintenance. Replaying the same fixed
  // graph under the same proof ceiling cannot make an oversized closure
  // publishable, so finish honestly instead of manufacturing a quarantine
  // tail. Immediate evidence changes still retry rather than being dropped.
  return changeReason === "scheduled_review"
    ? noChange(usage)
    : unavailable("publication_budget_exhausted");
}

function replayedPublication(
  operation: Exclude<
    PartitionedOrganizeProposal["operation"],
    "no_change" | "dissolve_parent"
  >,
  record: DurableRecordEnvelope,
): DurableSleepApplyResult {
  return {
    status: "applied",
    operation,
    replayed: true,
    usage: ZERO_USAGE,
    changedRecord: {
      logicalObjectRef: record.recordRef,
      generation: record.processingGeneration,
      recordRef: record.recordRef,
    },
  };
}

function canonicalBytes(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength < 1 || bytes.byteLength > ORGANIZER_PUBLICATION_COMMITMENT_MAX_BYTES) {
    throw new RangeError("Organizer publication canonical bytes are out of bounds");
  }
  return bytes;
}

function validOpaque(value: string): boolean {
  return value.trim().length > 0;
}

function assertRoom(room: OrganizerPublicationRoomContext): void {
  if (
    !validOpaque(room.roomAnchorRef)
    || !validOpaque(room.terminalAuthorityLeafHandle)
    || !validOpaque(room.readBindingRef)
    || !validOpaque(room.publicationBindingRef)
    || !validOpaque(room.producerPolicyVersion)
  ) {
    throw new TypeError("Organizer publication Room context is invalid");
  }
}

function assertBudget(budget: HierarchyBudget): void {
  for (const value of Object.values(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Organizer publication budget is invalid");
    }
  }
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function orderedSources(
  dependencies: readonly DurableSourceDependency[],
): DurableSourceDependency[] {
  return [...dependencies]
    .map((dependency) => ({
      sourceKind: dependency.sourceKind,
      logicalSourceRef: dependency.logicalSourceRef,
      ...(dependency.observedRevision === undefined
        ? {}
        : { observedRevision: dependency.observedRevision }),
      ...(dependency.observedContentFingerprint === undefined
        ? {}
        : { observedContentFingerprint: dependency.observedContentFingerprint }),
      terminalAuthorityLeafHandle: dependency.terminalAuthorityLeafHandle,
      authorityBearing: dependency.authorityBearing,
    }))
    .sort(
      (left, right) =>
        organizerEvidenceIdentityKey(organizerSourceEvidenceIdentity(left)).localeCompare(
          organizerEvidenceIdentityKey(organizerSourceEvidenceIdentity(right)),
        ),
    );
}

function sourceIdentity(dependency: DurableSourceDependency): string {
  return organizerEvidenceIdentityKey(organizerSourceEvidenceIdentity(dependency));
}

function sourceLogicalIdentity(dependency: DurableSourceDependency): string {
  return `${dependency.sourceKind}\u0000${dependency.logicalSourceRef}`;
}

function unionSources(
  predecessor: readonly DurableSourceDependency[],
  additions: readonly DurableSourceDependency[],
): DurableSourceDependency[] | undefined {
  const byLogicalIdentity = new Map<string, DurableSourceDependency>();
  for (const dependency of [...predecessor, ...additions]) {
    const logicalIdentity = sourceLogicalIdentity(dependency);
    const existing = byLogicalIdentity.get(logicalIdentity);
    if (existing !== undefined && sourceIdentity(existing) !== sourceIdentity(dependency)) {
      return undefined;
    }
    byLogicalIdentity.set(logicalIdentity, dependency);
  }
  return orderedSources([...byLogicalIdentity.values()]);
}

function deriveAnchors(
  children: readonly DurableRecordEnvelope[],
  outputRoomAnchorRef: string,
): DurableRecordAnchor[] | undefined {
  const byRef = new Map<string, DurableRecordAnchor>();
  const add = (anchor: DurableRecordAnchor): boolean => {
    const existing = byRef.get(anchor.anchorRef);
    if (
      existing !== undefined
      && (existing.kind !== anchor.kind || existing.role !== anchor.role)
    ) return false;
    byRef.set(anchor.anchorRef, { ...anchor });
    return true;
  };
  if (!add({ anchorRef: outputRoomAnchorRef, kind: "room", role: "origin" })) {
    return undefined;
  }
  for (const child of children) {
    for (const anchor of child.semantic.anchors) {
      if (!add(anchor)) return undefined;
    }
  }
  return [...byRef.values()].sort(
    (left, right) =>
      left.anchorRef.localeCompare(right.anchorRef)
      || left.kind.localeCompare(right.kind)
      || left.role.localeCompare(right.role),
  );
}

function operationRelation(
  operation: PartitionedOrganizeProposal["operation"],
): "supersedes" | "resolves" | undefined {
  return operation === "extend_parent" || operation === "supersede_parent"
    ? "supersedes"
    : operation === "resolve_parent"
      ? "resolves"
      : undefined;
}


interface LoadedEvidenceGraph {
  readonly records: ReadonlyMap<string, OrganizerEvidenceRecord>;
  readonly envelopes: ReadonlyMap<string, DurableRecordEnvelope>;
  readonly visitedRecords: number;
  readonly traversalWork: number;
}

interface ExactRecordReadCoordinate {
  readonly readBindingRef: string;
  readonly processingGeneration: number;
}

interface ExactSourceReadCoordinate {
  readonly readBindingRef: string;
  readonly namespaceRef: string;
}

interface ActivePublicationBindings {
  readonly exactPlan?: CrossRoomPublicationPlan;
  readonly records: ReadonlyMap<string, ExactRecordReadCoordinate>;
  readonly sources: ReadonlyMap<string, ExactSourceReadCoordinate>;
  readonly outputRoomAnchorRef: string;
  readonly outputNamespaceRef: string;
  readonly publicationBindingRef: string;
  readonly originPublicationBindingRef?: string;
  readonly replayReadBindingRef: string;
}

function plannedSourceIdentity(input: CrossRoomInputCoordinate): string | undefined {
  return input.kind === "source"
    ? input.logicalSourceRef
    : undefined;
}

function activeBindings(
  room: OrganizerPublicationRoomContext,
  plan?: CrossRoomPublicationPlan,
  preserveExactPlanInvocationOrigin = false,
): ActivePublicationBindings {
  if (plan === undefined) {
    return {
      records: new Map(),
      sources: new Map(),
      outputRoomAnchorRef: room.roomAnchorRef,
      outputNamespaceRef: room.terminalAuthorityLeafHandle,
      publicationBindingRef: room.publicationBindingRef,
      replayReadBindingRef: room.readBindingRef,
    };
  }
  assertCrossRoomPublicationPlan(plan);
  const records = new Map<string, ExactRecordReadCoordinate>();
  const sources = new Map<string, ExactSourceReadCoordinate>();
  for (const input of plan.selectedInputs) {
    if (input.kind === "record") {
      records.set(input.recordRef, {
        readBindingRef: input.read.bindingRef,
        processingGeneration: input.processingGeneration,
      });
      continue;
    }
    const identity = plannedSourceIdentity(input);
    if (identity === undefined) throw new TypeError("Cross-Room source plan is invalid");
    sources.set(identity, {
      readBindingRef: input.read.bindingRef,
      namespaceRef: input.read.namespaceRef,
    });
  }
  return {
    exactPlan: plan,
    records,
    sources,
    outputRoomAnchorRef: preserveExactPlanInvocationOrigin
      ? room.roomAnchorRef
      : plan.output.accessRoomRef,
    outputNamespaceRef: plan.output.accessNamespaceRef,
    publicationBindingRef: plan.output.publicationBindingRef,
    ...(preserveExactPlanInvocationOrigin
      ? { originPublicationBindingRef: room.publicationBindingRef }
      : {}),
    // Canonical publication bindings are also exact read coordinates for the
    // immutable output. Avoid choosing an arbitrary input binding for replay.
    replayReadBindingRef: plan.output.publicationBindingRef,
  };
}

function exactProposalInputs(
  proposal: Exclude<
    PartitionedOrganizeProposal,
    { operation: "no_change" | "dissolve_parent" }
  >,
  bindings: ActivePublicationBindings,
): boolean {
  if (bindings.exactPlan === undefined) return true;
  const proposalRecordRefs = sortedUnique([
    ...(
      proposal.operation === "extend_parent"
      || proposal.operation === "wrap_parent"
      ? proposal.additionRecordRefs
      : proposal.childRecordRefs),
    ...("parentRecordRef" in proposal ? [proposal.parentRecordRef] : []),
  ]);
  const proposalSources = orderedSources(
    proposal.operation === "extend_parent" || proposal.operation === "wrap_parent"
      ? proposal.additionSourceDependencies
      : proposal.sourceDependencies,
  ).map((source) => source.logicalSourceRef);
  if (bindings.exactPlan.modelExposureDependencies !== undefined) {
    return proposalRecordRefs.every((recordRef) => bindings.records.has(recordRef))
      && proposalSources.every((sourceRef) => bindings.sources.has(sourceRef));
  }
  return proposalRecordRefs.length === bindings.records.size
    && proposalRecordRefs.every((recordRef) => bindings.records.has(recordRef))
    && proposalSources.length === bindings.sources.size
    && proposalSources.every((sourceRef) => bindings.sources.has(sourceRef));
}

function creationUsage(
  childCount: number,
  hasPredecessor: boolean,
): HierarchyBudgetUsage {
  const visits = childCount + (hasPredecessor ? 1 : 0);
  return {
    modelCalls: 0,
    visitedRecords: visits,
    createdRecords: 1,
    traversalWork: visits,
  };
}

function budgetAllows(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
  statement: string,
): boolean {
  return usage.modelCalls <= budget.maxModelCalls
    && usage.visitedRecords <= budget.maxVisitedRecords
    && usage.createdRecords <= budget.maxCreatedRecords
    && usage.traversalWork <= budget.maxTraversalWork
    && codePoints(statement) <= budget.maxStatementCharacters;
}

/**
 * Deterministically apply one accepted Organizer proposal through the selected
 * logical Record repository. No model output controls IDs, anchors, authority,
 * height, lifecycle generations, or successor relations.
 */
export class OrganizerProposalPublisher {
  readonly #repository: OrganizerProposalRepositoryPort;
  readonly #sourceDependencies: OrganizerSourceDependencyValidationPort;
  readonly #identity: KeyedOrganizerPublicationIdentityPort;
  readonly #room: OrganizerPublicationRoomContext;
  readonly #crossRoomFences: OrganizerCrossRoomPublicationFencePort | undefined;
  readonly #recordBindings: OrganizerProposalPublisherOptions["recordBindings"];
  readonly #preserveExactPlanInvocationOrigin: boolean;

  constructor(options: OrganizerProposalPublisherOptions) {
    assertRoom(options.room);
    this.#repository = options.repository;
    this.#sourceDependencies = options.sourceDependencies;
    this.#identity = options.identity;
    this.#room = Object.freeze({ ...options.room });
    this.#crossRoomFences = options.crossRoomFences;
    this.#recordBindings = options.recordBindings;
    this.#preserveExactPlanInvocationOrigin =
      options.preserveExactPlanInvocationOrigin === true;
  }

  async apply(
    input: OrganizerProposalApplicationInput,
  ): Promise<DurableSleepApplyResult> {
    try {
      assertBudget(input.budget);
      if (!validOpaque(input.idempotencyKey) || input.signal?.aborted) return unavailable();
      let bindings: ActivePublicationBindings;
      try {
        bindings = activeBindings(
          this.#room,
          input.publicationPlan,
          this.#preserveExactPlanInvocationOrigin,
        );
      } catch {
        return unavailable("publication_plan_invalid");
      }
      const exposureFence = await this.#revalidateModelExposures(input, bindings);
      if (exposureFence !== null) return exposureFence;
      if (input.proposal.operation === "no_change") {
        return {
          status: "applied",
          operation: "no_change",
          replayed: false,
          usage: ZERO_USAGE,
        };
      }
      if (input.proposal.operation === "dissolve_parent") {
        if (
          bindings.exactPlan !== undefined
          && bindings.exactPlan.modelExposureDependencies === undefined
        ) return unavailable();
        return this.#dissolve(input.proposal, input, bindings);
      }
      return this.#publish(input.proposal, input, bindings);
    } catch {
      return unavailable("publication_unexpected_exception");
    }
  }

  async #revalidateModelExposures(
    input: OrganizerProposalApplicationInput,
    bindings: ActivePublicationBindings,
  ): Promise<DurableSleepApplyResult | null> {
    const plan = bindings.exactPlan;
    const exposures = plan?.modelExposureDependencies;
    if (plan === undefined || exposures === undefined) return null;
    if (input.idempotencyKey !== plan.idempotencyKey) {
      return unavailable("publication_plan_invalid");
    }
    const changed = plan.selectedInputs.find((coordinate) =>
      coordinate.role === "changed"
    );
    if (
      changed?.kind !== "record"
      || changed.recordRef !== input.changedRecordRef
      || exposures.length !== plan.selectedInputs.length
      || this.#crossRoomFences === undefined
    ) return unavailable("publication_plan_invalid");
    const fenced = await this.#crossRoomFences.revalidate({
      plan,
      ...(input.proposal.operation === "dissolve_parent"
        ? { predecessorRecordRef: input.proposal.parentRecordRef }
        : {}),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (fenced.status === "stale") {
      return { status: "stale", failureDetail: fenced.failureDetail };
    }
    if (fenced.status === "unavailable") return unavailable(fenced.failureDetail);

    const identities = new Set<string>();
    for (const exposure of exposures) {
      const identity = exposure.kind === "record"
        ? `record\0${exposure.recordRef}`
        : `source\0${exposure.logicalSourceRef}`;
      if (identities.has(identity)) return unavailable("publication_plan_invalid");
      identities.add(identity);
      if (exposure.kind === "record") {
        const coordinate = bindings.records.get(exposure.recordRef);
        if (
          coordinate === undefined
          || coordinate.processingGeneration
            !== exposure.observedProcessingGeneration
        ) return unavailable("publication_plan_invalid");
        const opened = await this.#repository.read({
          recordRef: exposure.recordRef,
          readBindingRef: coordinate.readBindingRef,
        });
        if (opened.status !== "available") {
          return opened.reason === "unauthorized"
            ? {
                status: "stale",
                failureDetail: "publication_authority_fence_stale",
              }
            : unavailable("publication_validation_unavailable");
        }
        const currentLeaves = sortedUnique(
          opened.record.semantic.terminalAuthorityLeafHandles,
        );
        if (
          opened.record.processingGeneration
            !== exposure.observedProcessingGeneration
          || currentLeaves.length !== exposure.terminalAuthorityLeafHandles.length
          || currentLeaves.some((leaf, index) =>
            leaf !== exposure.terminalAuthorityLeafHandles[index]
          )
        ) {
          return {
            status: "stale",
            failureDetail: "publication_authority_fence_stale",
          };
        }
        continue;
      }
      const coordinate = bindings.sources.get(exposure.logicalSourceRef);
      if (
        coordinate === undefined
        || coordinate.namespaceRef !== exposure.terminalAuthorityLeafHandle
      ) return unavailable("publication_plan_invalid");
      const current = await this.#sourceDependencies.validate({
        dependency: {
          sourceKind: exposure.sourceKind,
          logicalSourceRef: exposure.logicalSourceRef,
          ...(exposure.observedRevision === undefined
            ? {}
            : { observedRevision: exposure.observedRevision }),
          ...(exposure.observedContentFingerprint === undefined
            ? {}
            : {
                observedContentFingerprint:
                  exposure.observedContentFingerprint,
              }),
          terminalAuthorityLeafHandle: exposure.terminalAuthorityLeafHandle,
          authorityBearing: true,
        },
        readBindingRef: coordinate.readBindingRef,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (current !== "current") {
        return unavailable("publication_source_unavailable");
      }
    }
    if (
      plan.selectedInputs.some((coordinate) => !identities.has(
        coordinate.kind === "record"
          ? `record\0${coordinate.recordRef}`
          : `source\0${coordinate.logicalSourceRef}`,
      ))
    ) return unavailable("publication_plan_invalid");
    return null;
  }

  async #read(
    recordRef: string,
    bindings: ActivePublicationBindings,
    inheritedReadBindingRef?: string,
    allowExactCrossRoomBinding = false,
  ): Promise<DurableRecordEnvelope | undefined> {
    const planned = bindings.records.get(recordRef);
    const readBindingRef = planned?.readBindingRef
      ?? inheritedReadBindingRef
      ?? (bindings.exactPlan === undefined ? this.#room.readBindingRef : undefined);
    if (readBindingRef === undefined) return undefined;
    const opened = await this.#repository.read({
      recordRef,
      readBindingRef,
    });
    if (opened.status !== "available") return undefined;
    if (planned !== undefined) {
      return opened.record.processingGeneration === planned.processingGeneration
        ? opened.record
        : undefined;
    }
    if (bindings.exactPlan !== undefined) return opened.record;
    if (
      !allowExactCrossRoomBinding
      && (
      !opened.record.semantic.anchors.some(
        (anchor) =>
          anchor.kind === "room"
          && anchor.role === "origin"
          && anchor.anchorRef === this.#room.roomAnchorRef,
      )
      || !opened.record.semantic.terminalAuthorityLeafHandles.includes(
        this.#room.terminalAuthorityLeafHandle,
      )
      || opened.record.semantic.terminalAuthorityLeafHandles.length !== 1
      || opened.record.semantic.terminalAuthorityLeafHandles.some(
        (handle) => handle !== this.#room.terminalAuthorityLeafHandle,
      )
      )
    ) return undefined;
    return opened.record;
  }

  async #loadEvidenceGraph(input: Readonly<{
    rootRecordRefs: readonly string[];
    bindings: ActivePublicationBindings;
    inheritedRootReadBindings?: ReadonlyMap<string, string>;
    seed?: ReadonlyMap<string, DurableRecordEnvelope>;
    budget: HierarchyBudget;
  }>): Promise<
    | LoadedEvidenceGraph
    | "child_unavailable"
    | "child_changed"
    | "binding_unavailable"
    | "representation_unavailable"
    | "integrity_unavailable"
    | "authority_unavailable"
    | undefined
  > {
    const envelopes = new Map<string, DurableRecordEnvelope>();
    const records = new Map<string, OrganizerEvidenceRecord>();
    const pending = input.rootRecordRefs.map((recordRef) => ({
      recordRef,
      readBindingRef: input.bindings.records.get(recordRef)?.readBindingRef
        ?? input.inheritedRootReadBindings?.get(recordRef),
    })).reverse();
    const queued = new Set(input.rootRecordRefs);
    let traversalWork = 0;
    while (pending.length > 0) {
      if (records.size >= input.budget.maxVisitedRecords) return undefined;
      const current = pending.pop()!;
      const recordRef = current.recordRef;
      queued.delete(recordRef);
      if (records.has(recordRef)) continue;
      let currentReadBindingRef = current.readBindingRef;
      if (
        currentReadBindingRef === undefined
        && input.bindings.exactPlan !== undefined
      ) {
        const resolved = await this.#recordBindings?.read(recordRef);
        currentReadBindingRef = resolved?.currentAccessBindingRefs.length === 1
          ? resolved.currentAccessBindingRefs[0]
          : undefined;
      }
      let envelope = input.seed?.get(recordRef);
      if (envelope === undefined && input.bindings.exactPlan !== undefined) {
        if (currentReadBindingRef === undefined) return "binding_unavailable";
        const opened = await this.#repository.read({
          recordRef,
          readBindingRef: currentReadBindingRef,
        });
        if (opened.status !== "available") {
          if (opened.reason === "selected_representation_missing") {
            return "representation_unavailable";
          }
          if (opened.reason === "integrity_failure") return "integrity_unavailable";
          if (opened.reason === "unauthorized") return "authority_unavailable";
          return "child_unavailable";
        }
        const planned = input.bindings.records.get(recordRef);
        if (
          planned !== undefined
          && opened.record.processingGeneration !== planned.processingGeneration
        ) return "child_changed";
        envelope = opened.record;
      }
      envelope ??= await this.#read(recordRef, input.bindings, currentReadBindingRef);
      if (envelope === undefined) return "child_unavailable";
      envelopes.set(recordRef, envelope);
      records.set(recordRef, {
        recordRef,
        terminalEvidenceIdentity:
          envelope.semantic.childRecordRefs.length === 0
          && envelope.semantic.producer.producerRef !== "organizer",
        childRecordRefs: envelope.semantic.childRecordRefs,
        sourceDependencies: envelope.semantic.sourceDependencies,
      });
      for (const childRecordRef of envelope.semantic.childRecordRefs) {
        if (traversalWork >= input.budget.maxTraversalWork) return undefined;
        traversalWork += 1;
        if (!records.has(childRecordRef) && !queued.has(childRecordRef)) {
          pending.push({
            recordRef: childRecordRef,
            readBindingRef: input.bindings.exactPlan === undefined
              ? currentReadBindingRef
              : input.bindings.records.get(childRecordRef)?.readBindingRef
                ?? (this.#recordBindings === undefined ? currentReadBindingRef : undefined),
          });
          queued.add(childRecordRef);
        }
      }
    }
    return {
      records,
      envelopes,
      visitedRecords: records.size,
      traversalWork: records.size + traversalWork,
    };
  }

  #hasAncestorDescendantPair(
    childRecordRefs: readonly string[],
    graph: LoadedEvidenceGraph,
    budget: HierarchyBudget,
  ): boolean | undefined {
    for (let leftIndex = 0; leftIndex < childRecordRefs.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < childRecordRefs.length; rightIndex += 1) {
        const left = childRecordRefs[leftIndex]!;
        const right = childRecordRefs[rightIndex]!;
        const leftToRight = organizerEvidenceHasDependencyPath({
          from: left,
          target: right,
          records: graph.records,
          maxTraversalWork: budget.maxTraversalWork,
        });
        const rightToLeft = organizerEvidenceHasDependencyPath({
          from: right,
          target: left,
          records: graph.records,
          maxTraversalWork: budget.maxTraversalWork,
        });
        if (leftToRight === "unavailable" || rightToLeft === "unavailable") return undefined;
        if (leftToRight === "yes" || rightToLeft === "yes") return true;
      }
    }
    return false;
  }

  async #dissolve(
    proposal: Extract<PartitionedOrganizeProposal, { operation: "dissolve_parent" }>,
    input: OrganizerProposalApplicationInput,
    bindings: ActivePublicationBindings,
  ): Promise<DurableSleepApplyResult> {
    const usage: HierarchyBudgetUsage = {
      modelCalls: 0,
      visitedRecords: 1,
      createdRecords: 0,
      traversalWork: 1,
    };
    if (!budgetAllows(input.budget, usage, "")) return unavailable();
    const allowCrossRoomBinding = input.changeReason === "dependency_lost"
      && input.changedRecordRef === proposal.parentRecordRef;
    const parent = await this.#read(
      proposal.parentRecordRef,
      bindings,
      undefined,
      allowCrossRoomBinding,
    );
    if (
      parent === undefined
      || parent.semantic.posture !== "derived"
    ) return unavailable();
    if (parent.lifecycle === "sunset") {
      return {
        status: "applied",
        operation: proposal.operation,
        replayed: true,
        usage,
        changedRecord: {
          logicalObjectRef: parent.recordRef,
          generation: parent.processingGeneration,
          recordRef: parent.recordRef,
        },
      };
    }
    if (parent.lifecycle !== "current" && parent.lifecycle !== "stale") return unavailable();
    const exposureFence = await this.#revalidateModelExposures(input, bindings);
    if (exposureFence !== null) return exposureFence;
    const transitioned = await this.#repository.transitionLifecycle({
      recordRef: parent.recordRef,
      expectedProcessingGeneration: parent.processingGeneration,
      from: parent.lifecycle,
      to: "sunset",
    });
    if (transitioned.status !== "transitioned") return unavailable();
    return {
      status: "applied",
      operation: proposal.operation,
      replayed: transitioned.replayed,
      usage,
      changedRecord: {
        logicalObjectRef: parent.recordRef,
        generation: parent.processingGeneration + 1,
        recordRef: parent.recordRef,
      },
    };
  }

  async #publish(
    proposal: Exclude<
      PartitionedOrganizeProposal,
      { operation: "no_change" | "dissolve_parent" }
    >,
    input: OrganizerProposalApplicationInput,
    bindings: ActivePublicationBindings,
  ): Promise<DurableSleepApplyResult> {
    if (
      bindings.exactPlan !== undefined
      && input.idempotencyKey !== bindings.exactPlan.idempotencyKey
    ) return unavailable();
    const plannedChanged = bindings.exactPlan?.selectedInputs.find(
      (coordinate) => coordinate.role === "changed",
    );
    if (
      bindings.exactPlan !== undefined
      && (plannedChanged?.kind !== "record"
        || plannedChanged.recordRef !== input.changedRecordRef)
    ) return unavailable();
    const publicationIdempotencyKey = this.#identity.commit({
      purpose: "publication_idempotency",
      canonicalBytes: canonicalBytes([
        "organizer-publication/v1",
        input.idempotencyKey,
      ]),
    });
    if (!validOpaque(publicationIdempotencyKey) || publicationIdempotencyKey.length > 128) {
      return unavailable();
    }
    const completed = await this.#repository.readCompletedPublication({
      idempotencyKey: publicationIdempotencyKey,
      readBindingRef: bindings.replayReadBindingRef,
    });
    if (completed.status === "available") {
      return replayedPublication(proposal.operation, completed.record);
    }
    if (completed.reason !== "not_found") {
      return unavailable(completed.reason === "incomplete"
        ? "publication_incomplete"
        : "publication_validation_unavailable");
    }
    if (!exactProposalInputs(proposal, bindings)) {
      return unavailable("publication_plan_invalid");
    }
    const selectedRecordRefs = proposal.operation === "extend_parent"
      || proposal.operation === "wrap_parent"
      ? [proposal.parentRecordRef, ...proposal.additionRecordRefs]
      : proposal.childRecordRefs;
    if (
      (proposal.operation === "create_parent"
        || proposal.operation === "extend_parent"
        || proposal.operation === "wrap_parent")
      && !selectedRecordRefs.includes(input.changedRecordRef)
    ) return unavailable("publication_plan_invalid");
    if (proposal.statement.trim().length === 0) {
      return unavailable("publication_invalid_record_shape");
    }
    const additionRecordRefs = proposal.operation === "extend_parent"
      || proposal.operation === "wrap_parent"
      ? proposal.additionRecordRefs
      : proposal.childRecordRefs;
    const additionSourceDependencies = orderedSources(
      proposal.operation === "extend_parent" || proposal.operation === "wrap_parent"
        ? proposal.additionSourceDependencies
        : proposal.sourceDependencies,
    );
    if (
      additionRecordRefs.length + additionSourceDependencies.length < 1
      || new Set(additionRecordRefs).size !== additionRecordRefs.length
    ) return unavailable();
    if (
      new Set(additionSourceDependencies.map(sourceLogicalIdentity)).size
        !== additionSourceDependencies.length
      || additionSourceDependencies.some((source) =>
        !validOpaque(source.sourceKind)
        || !validOpaque(source.logicalSourceRef)
        || !validOpaque(source.terminalAuthorityLeafHandle)
        || (source.observedRevision !== undefined
          && !validOpaque(source.observedRevision))
        || (source.observedContentFingerprint !== undefined
          && !validOpaque(source.observedContentFingerprint))
        || source.authorityBearing !== true
        || (bindings.exactPlan === undefined
          ? source.terminalAuthorityLeafHandle
            !== this.#room.terminalAuthorityLeafHandle
          : source.sourceKind !== "memory" && source.sourceKind !== "memory/v1"
            || bindings.sources.get(source.logicalSourceRef)?.namespaceRef
              !== source.terminalAuthorityLeafHandle)
      )
    ) return unavailable();

    const proposedRelation = operationRelation(proposal.operation);
    const predecessorRef = "parentRecordRef" in proposal
      ? proposal.parentRecordRef
      : undefined;
    if (
      predecessorRef !== undefined
      && additionRecordRefs.includes(predecessorRef)
    ) return unavailable();

    let predecessorAudience: OrganizerPredecessorAudienceRelation | undefined =
      predecessorRef === undefined ? undefined : "equal";
    if (bindings.exactPlan !== undefined) {
      if (this.#crossRoomFences === undefined) return unavailable();
      const fenced = await this.#crossRoomFences.revalidate({
        plan: bindings.exactPlan,
        ...(predecessorRef === undefined ? {} : { predecessorRecordRef: predecessorRef }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (fenced.status === "stale") {
        return { status: "stale", failureDetail: fenced.failureDetail };
      }
      if (
        fenced.status === "current"
        && (predecessorRef === undefined
          ? fenced.predecessorAudience !== undefined
          : fenced.predecessorAudience === undefined)
      ) return unavailable("publication_plan_invalid");
      if (fenced.status === "unavailable") {
        return unavailable(fenced.failureDetail);
      }
      predecessorAudience = fenced.predecessorAudience;
    }

    const predecessor = predecessorRef === undefined
      ? undefined
      : await this.#read(predecessorRef, bindings);
    if (predecessorRef !== undefined && predecessor === undefined) {
      return bindings.exactPlan === undefined
        ? unavailable()
        : {
            status: "stale",
            failureDetail: "publication_authority_fence_stale",
          };
    }
    if (predecessor !== undefined && predecessor.semantic.posture !== "derived") {
      return unavailable("publication_plan_invalid");
    }
    if (
      predecessor !== undefined
      && ((proposal.operation === "extend_parent" || proposal.operation === "wrap_parent")
        ? predecessor.lifecycle !== "current"
        : predecessor.lifecycle !== "current" && predecessor.lifecycle !== "stale")
    ) {
      return bindings.exactPlan === undefined
        ? unavailable()
        : {
            status: "stale",
            failureDetail: "publication_authority_fence_stale",
          };
    }
    // The model decides whether the evidence enriches a parent; exact
    // authority decides the lifecycle shape. Equal authority can supersede
    // and flatten the predecessor. A narrower output becomes a higher parent
    // over the predecessor plus additions, leaving the predecessor current.
    const authorityHigherParent = proposal.operation === "extend_parent"
      && predecessorAudience === "different";
    const dependencyLossReplacement = proposal.operation === "supersede_parent"
      && input.changeReason === "dependency_lost";
    const transitionsPredecessor = proposal.operation !== "wrap_parent"
      && !authorityHigherParent
      && predecessorRef !== undefined
      && proposedRelation !== undefined
      && (predecessorAudience === "equal" || dependencyLossReplacement);

    const childRecordRefs = proposal.operation === "wrap_parent" || authorityHigherParent
      ? sortedUnique([predecessorRef!, ...additionRecordRefs])
      : proposal.operation === "extend_parent"
        ? sortedUnique([
            ...predecessor!.semantic.childRecordRefs,
            ...additionRecordRefs,
          ])
        : [...additionRecordRefs];
    const sourceDependencies = proposal.operation === "extend_parent" && !authorityHigherParent
        ? unionSources(
            predecessor!.semantic.sourceDependencies,
            additionSourceDependencies,
          )
        : additionSourceDependencies;
    if (sourceDependencies === undefined) {
      return unavailable("publication_invalid_record_shape");
    }
    // Height zero is the canonical native-leaf coordinate used by semantic
    // admission. Preserve the pre-M279 invariant that a synthesized parent
    // always has at least one Record edge; authored sources may supplement
    // that support, but cannot create a derived height-zero lookalike.
    if (childRecordRefs.length < 1) {
      return unavailable("publication_invalid_record_shape");
    }
    const minimumSupport = proposal.operation === "create_parent"
      || proposal.operation === "wrap_parent"
      || authorityHigherParent ? 2 : 1;
    if (childRecordRefs.length + sourceDependencies.length < minimumSupport) {
      return unavailable("publication_invalid_record_shape");
    }
    const preliminaryUsage = creationUsage(
      childRecordRefs.length,
      predecessor !== undefined,
    );
    if (!budgetAllows(input.budget, preliminaryUsage, proposal.statement)) {
      return capacityOutcome(input.changeReason);
    }

    const predecessorReadBinding = predecessor === undefined
      ? undefined
      : bindings.records.get(predecessor.recordRef)?.readBindingRef;
    const inheritedRootReadBindings = new Map<string, string>();
    if (
      predecessorReadBinding !== undefined
      && predecessor !== undefined
      && proposal.operation !== "wrap_parent"
    ) {
      for (const childRecordRef of predecessor.semantic.childRecordRefs) {
        inheritedRootReadBindings.set(childRecordRef, predecessorReadBinding);
      }
    }
    const graph = await this.#loadEvidenceGraph({
      rootRecordRefs: childRecordRefs,
      bindings,
      inheritedRootReadBindings,
      budget: input.budget,
    });
    if (graph === "child_unavailable") return unavailable("publication_child_unavailable");
    if (graph === "child_changed") {
      return {
        status: "stale",
        failureDetail: "publication_child_parent_changed",
      };
    }
    if (graph === "binding_unavailable") return unavailable("publication_plan_invalid");
    if (graph === "representation_unavailable") return unavailable("publication_incomplete");
    if (graph === "integrity_unavailable") {
      return unavailable("publication_integrity_unavailable");
    }
    if (graph === "authority_unavailable") {
      return {
        status: "stale",
        failureDetail: "publication_authority_fence_stale",
      };
    }
    if (graph === undefined) return capacityOutcome(input.changeReason);
    const usage: HierarchyBudgetUsage = {
      modelCalls: 0,
      visitedRecords: graph.visitedRecords + (predecessor === undefined ? 0 : 1),
      createdRecords: 1,
      traversalWork: graph.traversalWork + (predecessor === undefined ? 0 : 1),
    };
    if (!budgetAllows(input.budget, usage, proposal.statement)) {
      return capacityOutcome(input.changeReason, { ...usage, createdRecords: 0 });
    }
    if (proposal.operation === "extend_parent" && !authorityHigherParent) {
      const predecessorClosure = deriveOrganizerEvidenceClosure({
        rootRecordRefs: predecessor!.semantic.childRecordRefs,
        sourceDependencies: predecessor!.semantic.sourceDependencies,
        records: graph.records,
        budget: input.budget,
      });
      const candidateClosure = deriveOrganizerEvidenceClosure({
        rootRecordRefs: childRecordRefs,
        sourceDependencies,
        records: graph.records,
        budget: input.budget,
      });
      if (
        predecessorClosure.status !== "complete"
        || candidateClosure.status !== "complete"
      ) return capacityOutcome(input.changeReason, { ...usage, createdRecords: 0 });
      if (!isStrictOrganizerEvidenceSuperset(
        candidateClosure.identityKeys,
        predecessorClosure.identityKeys,
      )) return noChange({ ...usage, createdRecords: 0 });
    }

    const ancestorPair = this.#hasAncestorDescendantPair(
      childRecordRefs,
      graph,
      input.budget,
    );
    if (ancestorPair === undefined) {
      return capacityOutcome(input.changeReason, { ...usage, createdRecords: 0 });
    }
    if (ancestorPair) return noChange({ ...usage, createdRecords: 0 });

    if (
      (proposal.operation === "create_parent"
        || proposal.operation === "extend_parent"
        || proposal.operation === "wrap_parent")
      && input.changeReason === "scheduled_review"
    ) {
      const closures: ReadonlySet<string>[] = [];
      for (const childRecordRef of childRecordRefs) {
        const closure = deriveOrganizerEvidenceClosure({
          rootRecordRefs: [childRecordRef],
          records: graph.records,
          budget: input.budget,
        });
        if (closure.status !== "complete") {
          return capacityOutcome(input.changeReason, { ...usage, createdRecords: 0 });
        }
        closures.push(closure.identityKeys);
      }
      for (const dependency of sourceDependencies) {
        closures.push(new Set([sourceIdentity(dependency)]));
      }
      if (!organizerEvidenceClosuresArePairwiseDisjoint(closures)) {
        return noChange({ ...usage, createdRecords: 0 });
      }
    }

    const children = childRecordRefs.map((recordRef) => graph.envelopes.get(recordRef));
    if (children.some((child) => child === undefined)) return unavailable();
    const openedChildren = children as DurableRecordEnvelope[];

    for (const dependency of sourceDependencies) {
      const exactSource = bindings.sources.get(dependency.logicalSourceRef);
      const inheritedFromPredecessor = bindings.exactPlan === undefined
        ? undefined
        : predecessor?.semantic.sourceDependencies.some(
          (source) => sourceIdentity(source) === sourceIdentity(dependency),
        ) === true
          ? bindings.records.get(predecessor.recordRef)?.readBindingRef
          : undefined;
      const readBindingRef = exactSource?.readBindingRef
        ?? inheritedFromPredecessor
        ?? (bindings.exactPlan === undefined ? this.#room.readBindingRef : undefined);
      if (readBindingRef === undefined) return unavailable();
      const current = await this.#sourceDependencies.validate({
        dependency,
        readBindingRef,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (current !== "current") {
        return unavailable("publication_source_unavailable");
      }
    }

    if (bindings.exactPlan !== undefined) {
      const fenced = await this.#crossRoomFences!.revalidate({
        plan: bindings.exactPlan,
        ...(predecessorRef === undefined ? {} : { predecessorRecordRef: predecessorRef }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (fenced.status === "stale") {
        return { status: "stale", failureDetail: fenced.failureDetail };
      }
      if (
        fenced.status === "current"
        && fenced.predecessorAudience !== predecessorAudience
      ) {
        return {
          status: "stale",
          failureDetail: "publication_authority_fence_stale",
        };
      }
      if (fenced.status === "unavailable") {
        return unavailable(fenced.failureDetail);
      }
    }

    const anchors = deriveAnchors(openedChildren, bindings.outputRoomAnchorRef);
    if (anchors === undefined) return unavailable();
    const terminalAuthorityLeafHandles = sortedUnique([
      ...(bindings.exactPlan === undefined
        ? [this.#room.terminalAuthorityLeafHandle]
        : []),
      ...openedChildren.flatMap((child) => child.semantic.terminalAuthorityLeafHandles),
      ...sourceDependencies.map((source) => source.terminalAuthorityLeafHandle),
      ...(bindings.exactPlan?.modelExposureDependencies ?? []).flatMap(
        (exposure) => exposure.kind === "record"
          ? exposure.terminalAuthorityLeafHandles
          : [exposure.terminalAuthorityLeafHandle],
      ),
    ]);
    const recordRef = this.#identity.commit({
      purpose: "record_identity",
      canonicalBytes: canonicalBytes([
        "organizer-record/v1",
        publicationIdempotencyKey,
        proposal.operation,
        predecessorRef ?? null,
        transitionsPredecessor ? proposedRelation : null,
        bindings.outputNamespaceRef,
      ]),
    });
    const semanticWithoutFingerprint = {
      posture: "derived" as const,
      statement: proposal.statement,
      sourceDependencies,
      anchors,
      childRecordRefs,
      producer: {
        producerRef: "organizer",
        policyVersion: bindings.exactPlan?.policyVersion
          ?? this.#room.producerPolicyVersion,
      },
      terminalAuthorityLeafHandles,
      ...(bindings.exactPlan?.modelExposureDependencies === undefined
        ? {}
        : {
            modelExposureDependencies:
              bindings.exactPlan.modelExposureDependencies,
          }),
    };
    const observedContentFingerprint = this.#identity.commit({
      purpose: "content_fingerprint",
      canonicalBytes: canonicalBytes([
        "organizer-content/v1",
        semanticWithoutFingerprint,
      ]),
    });
    if (
      !validOpaque(publicationIdempotencyKey)
      || publicationIdempotencyKey.length > 128
      || !validOpaque(recordRef)
      || recordRef.length > 128
      || !validOpaque(observedContentFingerprint)
      || observedContentFingerprint.length > 128
    ) return unavailable();
    const record: DurableRecordEnvelope = {
      recordRef,
      semantic: { observedContentFingerprint, ...semanticWithoutFingerprint },
      lifecycle: "current",
      structuralHeight: 1 + Math.max(
        ...openedChildren.map((child) => child.structuralHeight),
      ),
      processingGeneration: 1,
    };
    const publication: DurableRecordPublication = {
      record,
      ...(!transitionsPredecessor || predecessorRef === undefined || proposedRelation === undefined
        ? {}
        : { predecessor: { recordRef: predecessorRef, relation: proposedRelation } }),
      idempotencyKey: publicationIdempotencyKey,
      publicationBindingRef: bindings.publicationBindingRef,
      ...(bindings.originPublicationBindingRef === undefined
        ? {}
        : { originPublicationBindingRef: bindings.originPublicationBindingRef }),
    };
    if (input.signal?.aborted) return unavailable();
    const published = await this.#repository.publish(publication);
    // A structural conflict can be the expected loser of a concurrent
    // predecessor extension. That claim must retry from the winning current
    // head; completing it as no_change could permanently drop its new
    // evidence. Direct disposition is terminal for this exact publication,
    // while malformed/conflicting identity remains a typed failure.
    if (published.status === "rejected") {
      if (published.reason === "idempotency_conflict") {
        // A lease may expire after the preflight read while another worker
        // finishes this exact work coordinate. Resolve the durable winner
        // instead of turning a successful publication into retry churn.
        const raced = await this.#repository.readCompletedPublication({
          idempotencyKey: publicationIdempotencyKey,
          readBindingRef: bindings.replayReadBindingRef,
        });
        if (raced.status === "available") {
          return replayedPublication(proposal.operation, raced.record);
        }
      }
      if (
        published.reason === "blocked"
        || published.reason === "purged"
      ) return noChange({ ...usage, createdRecords: 0 });
      if (
        published.reason === "structural_conflict"
        && published.structuralReason !== undefined
      ) {
        if (staleStructuralRejection(published.structuralReason)) {
          return {
            status: "stale",
            failureDetail: staleStructuralFailureDetail(
              published.structuralReason,
            ),
          };
        }
        return unavailable(structuralFailureDetail(published.structuralReason));
      }
      return unavailable("publication_repository_rejected");
    }
    return {
      status: "applied",
      operation: proposal.operation,
      replayed: published.status === "replayed",
      usage,
      changedRecord: {
        logicalObjectRef: record.recordRef,
        generation: record.processingGeneration,
        recordRef: record.recordRef,
      },
    };
  }
}
