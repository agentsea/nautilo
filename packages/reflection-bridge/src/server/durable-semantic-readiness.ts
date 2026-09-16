import type {
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

const AUTHORITY_WORK_MAXIMUM = 256;

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
      const observedGenerations = new Map<string, number>();
      const closure = await advanceTerminalAuthorityClosure({
        rootRecordRef: claim.recordRef,
        maxVisitedRecords: AUTHORITY_WORK_MAXIMUM,
        nodes: {
          readNode: async (recordRef) => {
            const work = await this.ports.bindings.resolveWork(recordRef);
            if (work === null) return { status: "unavailable" as const };
            const opened = await this.ports.repository.read({
              recordRef,
              readBindingRef: work.readBindingRef,
            });
            if (opened.status !== "available") {
              return { status: "unavailable" as const };
            }
            if (opened.record.lifecycle !== "current") {
              return { status: "unavailable" as const };
            }
            observedGenerations.set(
              recordRef,
              opened.record.processingGeneration,
            );
            const expectedGeneration = expectedExposureGenerations.get(recordRef);
            if (
              expectedGeneration !== undefined
              && expectedGeneration !== opened.record.processingGeneration
            ) return { status: "unavailable" as const };
            const exposure = opened.record.semantic.modelExposureDependencies ?? [];
            for (const dependency of exposure) {
              if (dependency.kind !== "record") continue;
              const existingExpectation = expectedExposureGenerations.get(
                dependency.recordRef,
              );
              const observedGeneration = observedGenerations.get(
                dependency.recordRef,
              );
              if (
                (existingExpectation !== undefined
                  && existingExpectation
                    !== dependency.observedProcessingGeneration)
                || (observedGeneration !== undefined
                  && observedGeneration
                    !== dependency.observedProcessingGeneration)
              ) return { status: "unavailable" as const };
              expectedExposureGenerations.set(
                dependency.recordRef,
                dependency.observedProcessingGeneration,
              );
            }
            const directAuthorityLeafHandles = [
              ...opened.record.semantic.sourceDependencies
                .filter((source) => source.authorityBearing)
                .map((source) => source.terminalAuthorityLeafHandle),
              ...exposure.flatMap(dependency => dependency.kind === "source"
                ? [dependency.terminalAuthorityLeafHandle] : []),
            ];
            return {
              status: "available" as const,
              node: {
                recordRef,
                // Closure dependencies include uncited exposure; semantic graph edges do not.
                childRecordRefs: [...new Set([
                  ...opened.record.semantic.childRecordRefs,
                  ...exposure.flatMap(dependency => dependency.kind === "record" ? [dependency.recordRef] : []),
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
    if (current !== null && projectionMatches(current, desired)) {
      return { status: "ready" };
    }
    const result = current === null
      ? await this.ports.searchProjections.publish(desired)
      : await this.ports.searchProjections.replace({
          expectedProjectionGeneration: current.projectionGeneration,
          projection: desired,
        });
    return result === "published" || result === "replayed" || result === "replaced"
      ? { status: "ready" }
      : unavailable("projection_unavailable");
  }
}
