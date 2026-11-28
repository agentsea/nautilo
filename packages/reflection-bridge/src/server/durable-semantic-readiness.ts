import type {
  DurableRecordEnvelope,
  DurableSleepClaim,
  DurableSleepReadinessResult,
} from "@nautilo/reflection/durable";
import {
  RECORD_SEARCH_POLICY_V1,
  type RecordEmbeddingPort,
  type RecordSearchProjectionV1,
} from "@nautilo/reflection/search";

import { advanceTerminalAuthorityClosure } from "./authority-closure";
import type {
  AuthorityReconciliationPorts,
  AuthorityProjectionStorePort,
} from "./authority-contracts";
import { reconcileRecordAuthority } from "./authority-reconciliation";
import type { ProjectedAuthorityEligibility } from "./authority-eligibility";
import type { RecordRepositoryPort } from "./contracts";
import type {
  CurrentRecordSearchProjectionCoordinate,
  PostgresRecordSearchProjectionStore,
} from "./postgres-record-search-projection-store";
import type {
  DurableSemanticReadinessPort,
  SameRoomSemanticBindingPort,
} from "./durable-semantic-composition";
import type { RecordSearchCommitmentPort } from "./record-search-composition";

const AUTHORITY_WORK_MAXIMUM = 256;

export interface MissingTerminalStructuralDependencyRepairPort {
  repairMissingTerminalStructuralDependency(input: Readonly<{
    parentRecordRef: string;
    parentProcessingGeneration: number;
    childRecordRef: string;
    childProcessingGeneration: number;
  }>): Promise<"repaired" | "replayed" | "unavailable">;
}

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function unavailable(
  failureCode: Extract<DurableSleepReadinessResult, { status: "unavailable" }>["failureCode"],
): DurableSleepReadinessResult {
  return { status: "unavailable", failureCode };
}

function projectionMatches(
  current: CurrentRecordSearchProjectionCoordinate,
  desired: RecordSearchProjectionV1,
): boolean {
  return current.recordProcessingGeneration === desired.recordProcessingGeneration
    && current.projectionVersion === desired.projectionVersion
    && current.embeddingProvider === desired.embedding.provenance.provider
    && current.embeddingCanonicalModel === desired.embedding.provenance.canonicalModel
    && current.embeddingDimensions === desired.embedding.provenance.dimensions
    && current.embeddingContractVersion === desired.embedding.provenance.contractVersion;
}

/**
 * Enforces authority -> selected payload open -> compatible embedding order for
 * one durable semantic Record. A paused authority traversal is retried through
 * the durable work lease rather than storing semantic traversal bytes here.
 */
export class DurableRecordSemanticReadiness
implements DurableSemanticReadinessPort {
  constructor(private readonly ports: Readonly<{
    repository: RecordRepositoryPort;
    bindings: SameRoomSemanticBindingPort;
    eligibility: ProjectedAuthorityEligibility;
    authorityProjections: AuthorityProjectionStorePort;
    authorityReconciliation: AuthorityReconciliationPorts;
    embedding: RecordEmbeddingPort;
    searchProjections: PostgresRecordSearchProjectionStore;
    commitments: Pick<RecordSearchCommitmentPort, "roomAnchor">;
    missingTerminalDependencies?: MissingTerminalStructuralDependencyRepairPort;
  }>) {}

  async ensureAuthority(
    claim: DurableSleepClaim,
    _signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult> {
    const existing = await this.ports.authorityProjections.readCurrent(
      claim.recordRef,
    );
    if (
      existing !== null
      && existing.processingState === "current"
      && existing.recordDisposition === "available"
      && (this.ports.authorityReconciliation.selection.selectedRepresentation === "ordinary" || existing.protectedAuthorityCurrent === true)
    ) return { status: "ready" };

    // Generic encrypted Record dependencies are not public metadata. The native
    // Stenographer bootstrap is performed by its source-owned metadata adapter.
    if (existing === null && this.ports.authorityReconciliation.selection.selectedRepresentation === "protected") {
      return unavailable("authority_unavailable");
    }
    if (existing === null) {
      const expectedExposureGenerations = new Map<string, number>();
      const openedRecords = new Map<string, Awaited<ReturnType<RecordRepositoryPort["read"]>>>();
      const workBindings = new Map<string, Awaited<ReturnType<SameRoomSemanticBindingPort["resolveWork"]>>>();
      let additionalTraversalWork = 0;
      const consumeAdditionalTraversalWork = (): boolean => {
        if (additionalTraversalWork >= AUTHORITY_WORK_MAXIMUM) return false;
        additionalTraversalWork += 1;
        return true;
      };
      const workFor = async (recordRef: string) => {
        if (!workBindings.has(recordRef)) {
          workBindings.set(recordRef, await this.ports.bindings.resolveWork(recordRef));
        }
        return workBindings.get(recordRef) ?? null;
      };
      const open = async (recordRef: string) => {
        const cached = openedRecords.get(recordRef);
        if (cached !== undefined) return cached;
        if (!consumeAdditionalTraversalWork()) return null;
        const work = await workFor(recordRef);
        if (work === null) return null;
        const opened = await this.ports.repository.read({
          recordRef,
          readBindingRef: work.readBindingRef,
        });
        openedRecords.set(recordRef, opened);
        return opened;
      };
      const currentStructuralRef = async (
        parent: DurableRecordEnvelope,
        recordRef: string,
      ): Promise<string | null> => {
        const visited = new Set<string>();
        let currentRef = recordRef;
        while (visited.size < AUTHORITY_WORK_MAXIMUM) {
          if (visited.has(currentRef)) return null;
          visited.add(currentRef);
          const opened = await open(currentRef);
          if (opened === null || opened.status !== "available") return null;
          if (opened.record.lifecycle === "current") return currentRef;
          const work = await workFor(currentRef);
          if (work === null || !consumeAdditionalTraversalWork()) return null;
          const successors = await this.ports.repository.readSuccessors({
            recordRef: currentRef,
            readBindingRef: work.readBindingRef,
            limit: 2,
          });
          if (
            successors.status !== "available"
            || successors.page.continuation !== undefined
          ) return null;
          if (successors.page.items.length === 0) {
            if (
              currentRef === recordRef
              && opened.record.lifecycle === "sunset"
              && this.ports.missingTerminalDependencies !== undefined
            ) {
              await this.ports.missingTerminalDependencies
                .repairMissingTerminalStructuralDependency({
                  parentRecordRef: parent.recordRef,
                  parentProcessingGeneration: parent.processingGeneration,
                  childRecordRef: opened.record.recordRef,
                  childProcessingGeneration: opened.record.processingGeneration,
                });
            }
            return null;
          }
          if (successors.page.items.length !== 1) return null;
          const edge = successors.page.items[0]!;
          if (
            edge.predecessorRecordRef !== currentRef
            || opened.record.lifecycle === "superseded" && edge.relation !== "supersedes"
            || opened.record.lifecycle === "resolved" && edge.relation !== "resolves"
            || opened.record.lifecycle === "sunset"
          ) return null;
          currentRef = edge.successorRecordRef;
        }
        return null;
      };
      const closure = await advanceTerminalAuthorityClosure({
        rootRecordRef: claim.recordRef,
        maxVisitedRecords: AUTHORITY_WORK_MAXIMUM,
        nodes: {
          readNode: async (recordRef) => {
            const work = await workFor(recordRef);
            if (work === null) return { status: "unavailable" as const };
            const opened = await open(recordRef);
            if (opened === null || opened.status !== "available") {
              return { status: "unavailable" as const };
            }
            if (opened.record.lifecycle !== "current") {
              return { status: "unavailable" as const };
            }
            const expectedGeneration = expectedExposureGenerations.get(recordRef);
            if (
              expectedGeneration !== undefined
              && expectedGeneration !== opened.record.processingGeneration
            ) return { status: "unavailable" as const };
            const exposure = opened.record.semantic.modelExposureDependencies ?? [];
            const exposureRecordRefs: string[] = [];
            const historicalExposureLeafHandles: string[] = [];
            for (const dependency of exposure) {
              if (dependency.kind !== "record") continue;
              const existingExpectation = expectedExposureGenerations.get(
                dependency.recordRef,
              );
              if (
                (existingExpectation !== undefined
                  && existingExpectation
                    !== dependency.observedProcessingGeneration)
              ) return { status: "unavailable" as const };
              expectedExposureGenerations.set(
                dependency.recordRef,
                dependency.observedProcessingGeneration,
              );
              const exposed = await open(dependency.recordRef);
              if (exposed === null || exposed.status !== "available") {
                return { status: "unavailable" as const };
              }
              if (!sameSortedStrings(
                exposed.record.semantic.terminalAuthorityLeafHandles,
                dependency.terminalAuthorityLeafHandles,
              )) return { status: "unavailable" as const };
              if (
                exposed.record.lifecycle === "current"
                && exposed.record.processingGeneration
                  === dependency.observedProcessingGeneration
              ) {
                exposureRecordRefs.push(dependency.recordRef);
                continue;
              }
              if (
                (exposed.record.lifecycle !== "superseded"
                  && exposed.record.lifecycle !== "resolved")
                || exposed.record.processingGeneration
                  !== dependency.observedProcessingGeneration + 1
              ) return { status: "unavailable" as const };
              const exposedWork = await workFor(dependency.recordRef);
              if (
                exposedWork === null
                || !consumeAdditionalTraversalWork()
              ) return { status: "unavailable" as const };
              const successors = await this.ports.repository.readSuccessors({
                recordRef: dependency.recordRef,
                readBindingRef: exposedWork.readBindingRef,
                limit: 2,
              });
              if (
                successors.status !== "available"
                || successors.page.continuation !== undefined
                || successors.page.items.length !== 1
                || successors.page.items[0]!.predecessorRecordRef
                  !== dependency.recordRef
                || successors.page.items[0]!.relation
                  !== (exposed.record.lifecycle === "superseded"
                    ? "supersedes"
                    : "resolves")
              ) return { status: "unavailable" as const };
              const currentAuthority = await this.ports.authorityProjections.readCurrent(
                dependency.recordRef,
              );
              if (
                currentAuthority === null
                || currentAuthority.processingState !== "current"
                || currentAuthority.recordDisposition !== "available"
                || currentAuthority.recordLifecycle !== exposed.record.lifecycle
                || !sameSortedStrings(
                  currentAuthority.terminalAuthorityLeafHandles,
                  dependency.terminalAuthorityLeafHandles,
                )
              ) return { status: "unavailable" as const };
              const eligible = await this.ports.eligibility.check({
                recordRef: dependency.recordRef,
                invocationAudience: work.invocationAudience,
              });
              if (eligible.status !== "eligible") {
                return { status: "unavailable" as const };
              }
              // This is immutable provenance that the model observed, not
              // present structural support. Its current authority remains in
              // the closure, but its successor is never traversed back to the
              // owner as a dependency edge.
              historicalExposureLeafHandles.push(
                ...dependency.terminalAuthorityLeafHandles,
              );
            }
            const structuralChildRefs: string[] = [];
            for (const childRecordRef of opened.record.semantic.childRecordRefs) {
              const currentRef = await currentStructuralRef(
                opened.record,
                childRecordRef,
              );
              if (currentRef === null) return { status: "unavailable" as const };
              structuralChildRefs.push(currentRef);
            }
            const directAuthorityLeafHandles = [
              ...opened.record.semantic.sourceDependencies
                .filter((source) => source.authorityBearing)
                .map((source) => source.terminalAuthorityLeafHandle),
              ...exposure.flatMap(dependency => dependency.kind === "source"
                ? [dependency.terminalAuthorityLeafHandle] : []),
              ...historicalExposureLeafHandles,
            ];
            return {
              status: "available" as const,
              node: {
                recordRef,
                // Current exposure participates in authority closure. Retired
                // exposure is verified above as historical provenance only.
                childRecordRefs: [...new Set([
                  ...structuralChildRefs,
                  ...exposureRecordRefs,
                ])],
                directAuthorityLeafHandles,
                declaredTerminalAuthorityLeafHandles:
                  opened.record.semantic.terminalAuthorityLeafHandles,
              },
            };
          },
        },
      });
      if (closure.status !== "complete") return unavailable("authority_unavailable");
      const installed = await this.ports.authorityProjections.installInitialClosure({
        recordRef: claim.recordRef,
        closureGeneration: 1,
        terminalAuthorityLeafHandles: closure.terminalAuthorityLeafHandles,
      });
      if (installed === "conflict") return unavailable("authority_unavailable");
    }

    const current = await this.ports.authorityProjections.readCurrent(claim.recordRef);
    if (current === null) return unavailable("authority_unavailable");
    if (
      current.processingState === "current"
      && current.recordDisposition === "available"
      && (this.ports.authorityReconciliation.selection.selectedRepresentation === "ordinary" || current.protectedAuthorityCurrent === true)
    ) return { status: "ready" };
    if (
      current.processingState === "unavailable"
      || current.processingState === "purged"
      || current.recordDisposition !== "available"
    ) return unavailable("authority_unavailable");
    const reconciled = await reconcileRecordAuthority({
      recordRef: claim.recordRef,
      sourceChangeGeneration: current.sourceChangeGeneration,
      workBindingRef: `semantic:${claim.recordRef}:${claim.generation}`,
      maxOperations: AUTHORITY_WORK_MAXIMUM,
    }, this.ports.authorityReconciliation);
    return reconciled.status === "applied"
      ? { status: "ready" }
      : unavailable("authority_unavailable");
  }

  async ensureSearchProjection(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<DurableSleepReadinessResult> {
    const work = await this.ports.bindings.resolveWork(claim.recordRef);
    if (work === null) return unavailable("record_unavailable");
    const eligible = await this.ports.eligibility.check({
      recordRef: claim.recordRef,
      invocationAudience: work.invocationAudience,
    });
    if (eligible.status !== "eligible") return unavailable("authority_unavailable");
    const opened = await this.ports.repository.read({
      recordRef: claim.recordRef,
      readBindingRef: work.readBindingRef,
    });
    if (opened.status !== "available") return unavailable("record_unavailable");
    const resolved = await this.ports.bindings.resolve(opened.record);
    if (resolved.status !== "available") return unavailable("authority_unavailable");
    const roomAnchorCommitment = this.ports.commitments.roomAnchor(
      resolved.binding.roomAnchorRef,
    );
    const embedded = await this.ports.embedding.embed({
      purpose: "record.statement_embedding",
      plaintext: opened.record.semantic.statement,
      ...(signal === undefined ? {} : { signal }),
    });
    if (embedded.status !== "available") return unavailable("embedding_unavailable");
    const current = await this.ports.searchProjections.readCurrent(claim.recordRef);
    const desired: RecordSearchProjectionV1 = {
      recordRef: claim.recordRef,
      recordProcessingGeneration: opened.record.processingGeneration,
      projectionVersion: RECORD_SEARCH_POLICY_V1.projectionVersion,
      projectionGeneration: current === null ? 1 : current.projectionGeneration + 1,
      embedding: embedded.embedding,
    };
    if (
      current !== null
      && current.roomAnchorCommitment === roomAnchorCommitment
      && projectionMatches(current, desired)
    ) {
      return { status: "ready" };
    }
    const result = current === null
      ? await this.ports.searchProjections.publish(desired, roomAnchorCommitment)
      : await this.ports.searchProjections.replace({
          expectedProjectionGeneration: current.projectionGeneration,
          projection: desired,
          roomAnchorCommitment,
        });
    return result === "published" || result === "replayed" || result === "replaced"
      ? { status: "ready" }
      : unavailable("projection_unavailable");
  }
}
