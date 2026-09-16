import { createHash } from "node:crypto";

import type {
  PartitionedOrganizeProposal,
} from "@nautilo/reflection";
import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import type {
  DurableModelExposureDependency,
  DurableRecordEnvelope,
  DurableRecordReadPort,
  DurableSourceDependency,
} from "@nautilo/reflection/durable";

import type {
  AuthorityProjectionStorePort,
  CanonicalSourceAuthorityPort,
  RecordAccessAudiencePort,
} from "./authority-contracts";
import type { RecordRepositorySelection } from "./contracts";
import {
  assertCrossRoomPublicationPlan,
  crossRoomApplicationPlanToken,
  CROSS_ROOM_EXECUTION_PLAN_LIMITS,
  intersectSingleAuthorityAlternatives,
  type CrossRoomInputCoordinate,
  type CrossRoomPublicationPlan,
} from "./cross-room-execution";
import type { CurrentRecordPublicationBindingPort } from "./postgres-current-record-publication-binding";
import type {
  CrossRoomPublicationPlanBuilderPort,
} from "./cross-room-organizer-partition";
import type { OrganizerCrossRoomPublicationFencePort } from "./organizer-proposal-publisher";
import type {
  CrossRoomMemoryCandidate,
  PostgresCrossRoomOrganizerStore,
} from "./postgres-cross-room-organizer-store";

function sourceIdentity(dependency: Pick<DurableSourceDependency, "sourceKind" | "logicalSourceRef">): string {
  return `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`;
}

function coordinateIdentity(coordinate: CrossRoomInputCoordinate): string {
  return coordinate.kind === "record"
    ? `record\0${coordinate.recordRef}`
    : `source\0${coordinate.sourceKind}\0${coordinate.logicalSourceRef}`;
}

function proposalIdentities(proposal: PartitionedOrganizeProposal): readonly string[] {
  if (proposal.operation === "no_change" || proposal.operation === "dissolve_parent") {
    return [];
  }
  const records = proposal.operation === "extend_parent" || proposal.operation === "wrap_parent"
    ? [proposal.parentRecordRef, ...proposal.additionRecordRefs]
    : [
        ...(proposal.operation === "create_parent" ? [] : [proposal.parentRecordRef]),
        ...proposal.childRecordRefs,
      ];
  const sources = proposal.operation === "extend_parent" || proposal.operation === "wrap_parent"
    ? proposal.additionSourceDependencies
    : proposal.sourceDependencies;
  return [
    ...records.map((recordRef) => `record\0${recordRef}`),
    ...sources.map(sourceIdentity),
  ].sort();
}

function proposalSources(proposal: PartitionedOrganizeProposal): readonly DurableSourceDependency[] {
  if (
    proposal.operation === "no_change"
    || proposal.operation === "dissolve_parent"
  ) return [];
  return proposal.operation === "extend_parent" || proposal.operation === "wrap_parent"
    ? proposal.additionSourceDependencies
    : proposal.sourceDependencies;
}

function bindingRef(namespaceRef: string, selection: RecordRepositorySelection): string {
  return `journal:namespace:${namespaceRef}:${selection.selectedRepresentation}:v${selection.migrationGeneration}`;
}

function bindingNamespace(
  value: string,
  selection: RecordRepositorySelection,
): string | undefined {
  const prefix = "journal:namespace:";
  const suffix = `:${selection.selectedRepresentation}:v${selection.migrationGeneration}`;
  return value.startsWith(prefix) && value.endsWith(suffix)
    ? value.slice(prefix.length, -suffix.length)
    : undefined;
}

function commitment(label: string, values: readonly string[]): string {
  return createHash("sha256")
    .update(`nautilo-reflection-cross-room-${label}-v1\0`, "utf8")
    .update(values.join("\0"), "utf8")
    .digest("hex");
}

/**
 * Revalidates the model-selected subset, computes one exact audience, and
 * materializes only that hidden access Room. No model output chooses authority.
 */
export class ExactCrossRoomPublicationPlanner
implements CrossRoomPublicationPlanBuilderPort,
OrganizerCrossRoomPublicationFencePort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    repository: DurableRecordReadPort;
    authority: AuthorityProjectionStorePort;
    sourceAuthority: CanonicalSourceAuthorityPort;
    accessAudiences: RecordAccessAudiencePort;
    recordBindings: CurrentRecordPublicationBindingPort;
    memoryFences: Pick<PostgresCrossRoomOrganizerStore, "fence">;
  }>) {}

  private async dependencyLossRecordCoordinate(input: Readonly<{
    recordRef: string;
    role: "changed" | "candidate";
    expected?: DurableRecordEnvelope;
  }>): Promise<
    | Readonly<{
        status: "available";
        coordinate: Extract<CrossRoomInputCoordinate, { kind: "record" }>;
        audience: EffectiveAudienceAlternative;
      }>
    | Readonly<{
        status: "unavailable";
        failureDetail:
          | "publication_evidence_unavailable"
          | "publication_predecessor_changed"
          | "publication_child_unavailable"
          | "publication_authority_fence_stale"
          | "publication_input_access_audience_unavailable";
      }>
  > {
    const changedDetail = input.role === "changed"
      ? "publication_predecessor_changed" as const
      : "publication_child_unavailable" as const;
    const recordBinding = await this.ports.recordBindings.read(input.recordRef);
    if (recordBinding === null || recordBinding.currentAccessBindingRefs.length !== 1) {
      return { status: "unavailable", failureDetail: "publication_evidence_unavailable" };
    }
    const readBindingRef = recordBinding.currentAccessBindingRefs[0]!;
    const namespaceRef = bindingNamespace(readBindingRef, this.ports.selection);
    if (namespaceRef === undefined) {
      return { status: "unavailable", failureDetail: "publication_evidence_unavailable" };
    }
    const opened = await this.ports.repository.read({
      recordRef: input.recordRef,
      readBindingRef,
    });
    if (opened.status !== "available") {
      return { status: "unavailable", failureDetail: "publication_evidence_unavailable" };
    }
    if (
      input.expected !== undefined
      && opened.record.processingGeneration !== input.expected.processingGeneration
    ) return { status: "unavailable", failureDetail: changedDetail };
    const projection = await this.ports.authority.readCurrent(input.recordRef);
    if (
      projection === null
      || projection.processingState !== "current"
      || projection.recordDisposition !== "available"
      || projection.recordLifecycle !== opened.record.lifecycle
      || projection.alternatives.length !== 1
      || projection.representationGeneration < 1
    ) return { status: "unavailable", failureDetail: "publication_authority_fence_stale" };
    if (
      input.role === "candidate" && opened.record.lifecycle !== "current"
      || input.role === "changed"
        && opened.record.lifecycle !== "current"
        && opened.record.lifecycle !== "stale"
    ) return { status: "unavailable", failureDetail: changedDetail };
    const alternative = projection.alternatives[0]!;
    const audiences = await this.ports.accessAudiences.readExactSet([
      alternative.accessNamespaceId,
    ]);
    if (audiences.status !== "available" || audiences.audiences.length !== 1) {
      return {
        status: "unavailable",
        failureDetail: "publication_input_access_audience_unavailable",
      };
    }
    return {
      status: "available",
      coordinate: {
        kind: "record",
        role: input.role,
        recordRef: input.recordRef,
        processingGeneration: opened.record.processingGeneration,
        representationGeneration: projection.representationGeneration,
        authorityGeneration: projection.projectionGeneration,
        read: { namespaceRef, bindingRef: readBindingRef },
      },
      audience: {
        humanRefs: audiences.audiences[0]!,
        includesPublicBoundary: alternative.includesPublicBoundary,
      },
    };
  }

  async planDependencyLoss(
    input: Parameters<NonNullable<
      CrossRoomPublicationPlanBuilderPort["planDependencyLoss"]
    >>[0],
  ): ReturnType<NonNullable<
    CrossRoomPublicationPlanBuilderPort["planDependencyLoss"]
  >> {
    if (
      input.signal?.aborted
      || input.proposal.parentRecordRef !== input.predecessor.recordRef
      || input.proposal.sourceDependencies.length > 0
      || input.proposal.childRecordRefs.length < 1
    ) return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    const predecessor = await this.dependencyLossRecordCoordinate({
      recordRef: input.predecessor.recordRef,
      role: "changed",
      expected: input.predecessor,
    });
    if (predecessor.status === "unavailable") {
      return predecessor.failureDetail === "publication_evidence_unavailable"
        || predecessor.failureDetail === "publication_input_access_audience_unavailable"
        ? { status: "unavailable", failureDetail: predecessor.failureDetail }
        : { status: "stale", failureDetail: predecessor.failureDetail };
    }
    const children = await Promise.all(input.proposal.childRecordRefs.map((recordRef) =>
      this.dependencyLossRecordCoordinate({ recordRef, role: "candidate" })
    ));
    const unavailableChild = children.find((child) => child.status === "unavailable");
    if (unavailableChild?.status === "unavailable") {
      return unavailableChild.failureDetail === "publication_evidence_unavailable"
        || unavailableChild.failureDetail === "publication_input_access_audience_unavailable"
        ? { status: "unavailable", failureDetail: unavailableChild.failureDetail }
        : { status: "stale", failureDetail: unavailableChild.failureDetail };
    }
    const currentChildren = children.filter((child) => child.status === "available");
    const audience = intersectSingleAuthorityAlternatives(
      currentChildren.map((child) => [child.audience]),
    );
    if (audience.status === "unavailable") {
      return { status: "no_change", reason: audience.reason };
    }
    const access = await this.ports.accessAudiences.resolveOrCreateExact(
      audience.alternative.humanRefs,
    ).catch(() => null);
    if (access === null) {
      return {
        status: "unavailable",
        failureDetail: "publication_output_access_audience_unavailable",
      };
    }
    const selectedInputs = [
      predecessor.coordinate,
      ...currentChildren.map((child) => child.coordinate).sort((left, right) =>
        left.recordRef.localeCompare(right.recordRef)
      ),
    ];
    const token = crossRoomApplicationPlanToken(`dl1.${commitment(
      "dependency-loss-plan",
      [input.idempotencyKey, ...selectedInputs.map(coordinateIdentity)],
    )}`);
    const plan: CrossRoomPublicationPlan = {
      applicationPlanToken: token,
      policyVersion: "candidate-policy-v1",
      selectedInputs,
      predecessorOnlyRecordRef: input.predecessor.recordRef,
      output: {
        accessRoomRef: access.accessRoomId,
        accessNamespaceRef: access.accessNamespaceId,
        publicationBindingRef: bindingRef(access.accessNamespaceId, this.ports.selection),
        authorityGeneration: Math.max(
          1,
          ...currentChildren.map((child) => child.coordinate.authorityGeneration),
        ),
        includesPublicBoundary: audience.alternative.includesPublicBoundary,
      },
      commitments: {
        authority: commitment("publication-authority", [
          ...audience.alternative.humanRefs,
          String(audience.alternative.includesPublicBoundary),
        ]),
        representation:
          `${this.ports.selection.selectedRepresentation}:v${this.ports.selection.migrationGeneration}`,
      },
      budget: {
        maxInputItems: selectedInputs.length,
        maxInputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes,
        maxModelCalls: 2,
        maxOutputItems: 1,
        maxOutputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes,
      },
      idempotencyKey: input.idempotencyKey,
    };
    try {
      assertCrossRoomPublicationPlan(plan);
    } catch {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    return { status: "planned", plan };
  }

  private async fenceCrossRoomMemories(
    selectedInputs: readonly CrossRoomInputCoordinate[],
  ): Promise<"current" | "stale" | "unavailable"> {
    const candidates: CrossRoomMemoryCandidate[] = selectedInputs.flatMap((coordinate) => {
      if (coordinate.kind !== "source" || coordinate.crossRoomFence === undefined) return [];
      const fence = coordinate.crossRoomFence;
      return [{
        kind: "memory" as const,
        memoryRef: fence.memoryRef,
        logicalSourceRef: `memory:${fence.memoryRef}` as const,
        score: 0,
        contentRevision: coordinate.contentGeneration,
        embeddingRevision: fence.embeddingRevision,
        embeddingProvenance: fence.embeddingProvenance,
        updatedAtCoordinate: fence.updatedAtCoordinate,
        audience: fence.audience,
        authorityNamespaceRefs: fence.authorityNamespaceRefs,
        readNamespaceRef: coordinate.read.namespaceRef,
        readBindingRef: coordinate.read.bindingRef,
        ...(fence.protectedObjectId === undefined
          ? {}
          : {
              protectedCryptoObjectId: fence.protectedObjectId,
              protectedCryptoAccessRevision:
                fence.protectedAccessRevision,
            }),
      }];
    });
    if (candidates.length === 0) return "current";
    const result = await this.ports.memoryFences.fence({
      selection: this.ports.selection,
      candidates,
    });
    return result.status === "current"
      ? "current"
      : result.status === "stale"
        ? "stale"
        : "unavailable";
  }

  async plan(
    input: Parameters<CrossRoomPublicationPlanBuilderPort["plan"]>[0],
  ): ReturnType<CrossRoomPublicationPlanBuilderPort["plan"]> {
    if (
      input.proposal.operation === "no_change"
      || input.proposal.operation === "dissolve_parent"
      || input.signal?.aborted
    ) return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    const identities = proposalIdentities(input.proposal);
    const selectedIdentities = new Set(identities);
    if (selectedIdentities.size !== identities.length) {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    // Candidate plans are authenticated and canonically ordered with the
    // changed Record first. Preserve that order when selecting the model's
    // subset: sorting proposal identities lexicographically can put a
    // candidate before the changed Record and make our own publication plan
    // fail canonical validation for otherwise valid Record IDs.
    const selectedInputs = input.candidatePlan.inputs.filter((coordinate) =>
      selectedIdentities.has(coordinateIdentity(coordinate))
    );
    if (selectedInputs.length !== identities.length) {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    if (selectedInputs.filter((coordinate) => coordinate.role === "changed").length !== 1) {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    const sources = new Map(proposalSources(input.proposal).map((dependency) => [
      sourceIdentity(dependency),
      dependency,
    ]));
    return this.planExact({ ...input, selectedInputs, sources });
  }

  /** Fix the complete model audience before invocation, independently of citations. */
  async planExposure(input: Readonly<{
    applicationPlanToken: CrossRoomPublicationPlan["applicationPlanToken"];
    candidatePlan: Parameters<CrossRoomPublicationPlanBuilderPort["plan"]>[0]["candidatePlan"];
    modelExposureDependencies: readonly DurableModelExposureDependency[];
    signal?: AbortSignal;
  }>): Promise<Awaited<ReturnType<CrossRoomPublicationPlanBuilderPort["plan"]>>> {
    input.signal?.throwIfAborted();
    const selectedInputs = input.candidatePlan.inputs;
    const exposureIds = input.modelExposureDependencies.map(dependency => dependency.kind === "record"
      ? `record\0${dependency.recordRef}` : `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`);
    if (new Set(exposureIds).size !== exposureIds.length || exposureIds.length !== selectedInputs.length
      || selectedInputs.some(coordinate => !exposureIds.includes(coordinateIdentity(coordinate)))) {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    for (const coordinate of selectedInputs) {
      const exposure = input.modelExposureDependencies.find(dependency => dependency.kind === "record"
        ? coordinate.kind === "record" && dependency.recordRef === coordinate.recordRef
        : coordinate.kind === "source" && dependency.logicalSourceRef === coordinate.logicalSourceRef);
      if (exposure === undefined || (coordinate.kind === "record"
        ? exposure.kind !== "record" || exposure.observedProcessingGeneration !== coordinate.processingGeneration
        : exposure.kind !== "source" || exposure.observedRevision !== String(coordinate.contentGeneration))) {
        return { status: "stale", failureDetail: "publication_plan_stale" };
      }
    }
    const sources = new Map(input.modelExposureDependencies.flatMap(dependency => dependency.kind !== "source" ? [] : [
      [sourceIdentity(dependency), { ...dependency, authorityBearing: true }] as const,
    ]));
    return this.planExact({ ...input, selectedInputs, sources });
  }

  private async planExact(input: Readonly<{
    applicationPlanToken: CrossRoomPublicationPlan["applicationPlanToken"];
    candidatePlan: Parameters<CrossRoomPublicationPlanBuilderPort["plan"]>[0]["candidatePlan"];
    selectedInputs: readonly CrossRoomInputCoordinate[];
    sources: ReadonlyMap<string, DurableSourceDependency>;
    modelExposureDependencies?: readonly DurableModelExposureDependency[];
    signal?: AbortSignal;
  }>): Promise<Awaited<ReturnType<CrossRoomPublicationPlanBuilderPort["plan"]>>> {
    const {selectedInputs, sources} = input;
    const memoryFence = await this.fenceCrossRoomMemories(selectedInputs);
    if (memoryFence === "stale") {
      return { status: "stale", failureDetail: "publication_plan_stale" };
    }
    if (memoryFence === "unavailable") {
      return {
        status: "unavailable",
        failureDetail: "publication_memory_fence_unavailable",
      };
    }
    const alternatives: EffectiveAudienceAlternative[][] = [];
    for (const coordinate of selectedInputs) {
      if (coordinate.kind === "record") {
        const opened = await this.ports.repository.read({
          recordRef: coordinate.recordRef,
          readBindingRef: coordinate.read.bindingRef,
        });
        const projection = await this.ports.authority.readCurrent(coordinate.recordRef);
        if (
          opened.status !== "available"
          || (opened.record.lifecycle !== "current" && !(opened.record.lifecycle === "stale"
            && coordinate.role === "changed" && input.modelExposureDependencies !== undefined))
          || opened.record.processingGeneration !== coordinate.processingGeneration
          || projection === null
          || projection.processingState !== "current"
          || projection.recordDisposition !== "available"
          || projection.projectionGeneration !== coordinate.authorityGeneration
          || projection.alternatives.length !== 1
        ) return { status: "stale", failureDetail: "publication_plan_stale" };
        const materialized = projection.alternatives[0]!;
        const audiences = await this.ports.accessAudiences.readExactSet([
          materialized.accessNamespaceId,
        ]);
        if (audiences.status !== "available" || audiences.audiences.length !== 1) {
          return {
            status: "unavailable",
            failureDetail: "publication_input_access_audience_unavailable",
          };
        }
        alternatives.push([{
          humanRefs: audiences.audiences[0]!,
          includesPublicBoundary: materialized.includesPublicBoundary,
        }]);
      } else {
        const dependency = sources.get(coordinateIdentity(coordinate));
        if (dependency === undefined) {
          return { status: "unavailable", failureDetail: "publication_plan_invalid" };
        }
        const resolved = await this.ports.sourceAuthority.resolve(
          dependency.terminalAuthorityLeafHandle,
        );
        if (resolved.status !== "available") {
          return {
            status: "unavailable",
            failureDetail: "publication_source_authority_unavailable",
          };
        }
        if (resolved.leaf.alternatives.length !== 1) return {
          status: "no_change",
          reason: "unsupported_authority_shape",
        };
        alternatives.push([...resolved.leaf.alternatives]);
      }
    }
    const audience = intersectSingleAuthorityAlternatives(alternatives);
    if (audience.status === "unavailable") {
      return { status: "no_change", reason: audience.reason };
    }
    const access = await this.ports.accessAudiences.resolveOrCreateExact(
      audience.alternative.humanRefs,
    ).catch(() => null);
    if (access === null) {
      return {
        status: "unavailable",
        failureDetail: "publication_output_access_audience_unavailable",
      };
    }
    const plan: CrossRoomPublicationPlan = {
      applicationPlanToken: input.applicationPlanToken,
      policyVersion: input.candidatePlan.policyVersion,
      selectedInputs,
      ...(input.modelExposureDependencies === undefined ? {} : {
        modelExposureDependencies: input.modelExposureDependencies,
      }),
      output: {
        accessRoomRef: access.accessRoomId,
        accessNamespaceRef: access.accessNamespaceId,
        publicationBindingRef: bindingRef(access.accessNamespaceId, this.ports.selection),
        authorityGeneration: Math.max(
          1,
          ...selectedInputs.map((coordinate) => coordinate.authorityGeneration),
        ),
        includesPublicBoundary: audience.alternative.includesPublicBoundary,
      },
      commitments: {
        authority: commitment("publication-authority", [
          ...audience.alternative.humanRefs,
          String(audience.alternative.includesPublicBoundary),
        ]),
        representation: input.candidatePlan.commitments.representation,
      },
      budget: input.candidatePlan.budget,
      // Must match the durable executor's application coordinate exactly;
      // selected dependencies are already bound by the authenticated token
      // and the publication identity commitment below the publisher seam.
      idempotencyKey:
        `sleep:${input.candidatePlan.workRef}:${input.candidatePlan.workGeneration}`,
    };
    try {
      assertCrossRoomPublicationPlan(plan);
    } catch {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    return { status: "planned", plan };
  }

  async revalidate(
    input: Parameters<OrganizerCrossRoomPublicationFencePort["revalidate"]>[0],
  ): ReturnType<OrganizerCrossRoomPublicationFencePort["revalidate"]> {
    if (input.signal?.aborted) {
      return {
        status: "unavailable",
        failureDetail: "publication_plan_invalid",
      };
    }
    const memoryFence = await this.fenceCrossRoomMemories(input.plan.selectedInputs);
    if (memoryFence === "stale") {
      return {
        status: "stale",
        failureDetail: "publication_authority_fence_stale",
      };
    }
    if (memoryFence === "unavailable") {
      return {
        status: "unavailable",
        failureDetail: "publication_memory_fence_unavailable",
      };
    }
    for (const coordinate of input.plan.selectedInputs) {
      if (coordinate.kind !== "record") continue;
      const opened = await this.ports.repository.read({
        recordRef: coordinate.recordRef,
        readBindingRef: coordinate.read.bindingRef,
      });
      const projection = await this.ports.authority.readCurrent(coordinate.recordRef);
      if (
        opened.status !== "available"
        || (opened.record.lifecycle !== "current"
          && !(
            (input.plan.predecessorOnlyRecordRef === coordinate.recordRef
              || coordinate.role === "changed" && input.plan.modelExposureDependencies !== undefined)
            && opened.record.lifecycle === "stale"
          ))
        || opened.record.processingGeneration !== coordinate.processingGeneration
        || projection === null
        || projection.processingState !== "current"
        || projection.recordDisposition !== "available"
        || projection.projectionGeneration !== coordinate.authorityGeneration
      ) return {
        status: "stale",
        failureDetail: "publication_authority_fence_stale",
      };
    }
    if (input.predecessorRecordRef === undefined) return { status: "current" };
    const predecessor = input.plan.selectedInputs.find((coordinate) =>
      coordinate.kind === "record"
      && coordinate.recordRef === input.predecessorRecordRef
    );
    if (predecessor?.kind !== "record") {
      return { status: "unavailable", failureDetail: "publication_plan_invalid" };
    }
    const projection = await this.ports.authority.readCurrent(predecessor.recordRef);
    if (projection === null || projection.alternatives.length !== 1) {
      return {
        status: "stale",
        failureDetail: "publication_authority_fence_stale",
      };
    }
    const alternative = projection.alternatives[0]!;
    const sameAccessNamespace = alternative.accessNamespaceId
      === input.plan.output.accessNamespaceRef;
    const audiences = await this.ports.accessAudiences.readExactSet(
      sameAccessNamespace
        ? [alternative.accessNamespaceId]
        : [alternative.accessNamespaceId, input.plan.output.accessNamespaceRef],
    );
    if (
      audiences.status !== "available"
      || audiences.audiences.length !== (sameAccessNamespace ? 1 : 2)
    ) {
      return {
        status: "unavailable",
        failureDetail: "publication_revalidation_access_audience_unavailable",
      };
    }
    const predecessorHumans = audiences.audiences[0]!;
    const outputHumans = sameAccessNamespace
      ? predecessorHumans
      : audiences.audiences[1]!;
    const equal = predecessorHumans.length === outputHumans.length
      && predecessorHumans.every((humanRef, index) => outputHumans[index] === humanRef)
      && alternative.includesPublicBoundary
        === input.plan.output.includesPublicBoundary;
    return {
      status: "current",
      predecessorAudience: equal ? "equal" : "different",
    };
  }
}
