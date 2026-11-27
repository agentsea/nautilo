import type {
  DurableModelExposureDependency,
  DurableRecordEnvelope,
  DurableSourceDependency,
} from "@nautilo/reflection/durable";
import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";

import type { ProjectedAuthorityEligibility } from "./authority-eligibility";
import type { RecordRepositoryPort } from "./contracts";
import type {
  GroundedDependencyLossDecision,
  GroundedDependencyLossPort,
} from "./durable-semantic-composition";
import type {
  CanonicalRecordSourceReadPort,
  CanonicalRecordSourceReadResult,
  RecordSourceInvalidationPort,
} from "./record-source-evidence";
import type { CurrentRecordPublicationBindingPort } from "./postgres-current-record-publication-binding";

const SUPPORT_BODY_BYTES_MAXIMUM = 8 * 1_024;
const REPLACEMENT_STATEMENT_CODE_POINTS_MAXIMUM = 800;

async function currentReadBinding(
  bindings: CurrentRecordPublicationBindingPort | undefined,
  recordRef: string,
  fallback: string,
): Promise<string | null> {
  if (bindings === undefined) return fallback;
  const current = await bindings.read(recordRef);
  return current?.currentAccessBindingRefs.length === 1
    ? current.currentAccessBindingRefs[0]!
    : null;
}

export interface GroundedDependencyStatementPort {
  rewrite(input: Readonly<{
    remainingSupportStatements: readonly string[];
    modelExposureDependencies?: readonly DurableModelExposureDependency[];
    assertSourceEvidenceCurrent?: (
      invocationAudience: EffectiveAudienceAlternative,
    ) => Promise<boolean>;
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly statement: string; readonly modelCalls: 1 | 2 }
    | { readonly status: "unavailable" }
  >;
}

export interface DeclaredInheritedMemorySourceReadPort {
  readExactDeclaredMemory(input: Readonly<{
    dependency: DurableSourceDependency;
    owningRecordRef: string;
    evidenceBindingRef: string;
    invocationAudience: EffectiveAudienceAlternative;
    returnedBytesMaximum: number;
    signal?: AbortSignal;
  }>): Promise<
    CanonicalRecordSourceReadResult
    | Readonly<{ status: "not_applicable" }>
  >;
}

/** Payload-free lifecycle coordinate used when an obsolete protected body cannot open. */
export interface GroundedDependencyRecordStatePort {
  readState(recordRef: string): Promise<
    | Readonly<{
        status: "available";
        lifecycle: DurableRecordEnvelope["lifecycle"];
        processingGeneration: number;
        disposition: "available" | "blocked" | "purged";
      }>
    | Readonly<{ status: "unavailable" }>
  >;
  readSuccessors(input: Readonly<{ recordRef: string; limit: 2 }>): Promise<
    | Readonly<{
        status: "available";
        successorRecordRefs: readonly string[];
        complete: boolean;
      }>
    | Readonly<{ status: "unavailable" }>
  >;
  /** Content-free direct structural support only; authority exposure is not ancestry. */
  readStructuralDependencyRecordRefs?(input: Readonly<{
    recordRef: string;
    limit: number;
  }>): Promise<
    | Readonly<{
        status: "available";
        dependencyRecordRefs: readonly string[];
        complete: boolean;
      }>
    | Readonly<{ status: "unavailable" }>
  >;
}

export type CurrentDependencyInputRefResult =
  | Readonly<{
      status: "current";
      recordRef: string;
      processingGeneration: number;
    }>
  | Readonly<{ status: "lost" | "unavailable" }>;

/** Resolve a unique successor chain without opening any Record payload. */
export async function resolveCurrentDependencyInputRef(input: Readonly<{
  recordState: GroundedDependencyRecordStatePort;
  recordRef: string;
  maxVisitedRecords: number;
  signal?: AbortSignal;
}>): Promise<CurrentDependencyInputRefResult> {
  if (!Number.isSafeInteger(input.maxVisitedRecords) || input.maxVisitedRecords < 0) {
    throw new RangeError("dependency successor visit budget must be non-negative");
  }
  const visited = new Set<string>();
  let recordRef = input.recordRef;
  for (;;) {
    input.signal?.throwIfAborted();
    if (visited.has(recordRef) || visited.size >= input.maxVisitedRecords) {
      return { status: "unavailable" };
    }
    visited.add(recordRef);
    const state = await input.recordState.readState(recordRef);
    input.signal?.throwIfAborted();
    if (state.status !== "available" || state.disposition !== "available") {
      return { status: "unavailable" };
    }
    if (state.lifecycle === "current") {
      return {
        status: "current",
        recordRef,
        processingGeneration: state.processingGeneration,
      };
    }
    const successors = await input.recordState.readSuccessors({ recordRef, limit: 2 });
    input.signal?.throwIfAborted();
    if (
      successors.status !== "available"
      || !successors.complete
      || successors.successorRecordRefs.length > 1
    ) return { status: "unavailable" };
    const successorRef = successors.successorRecordRefs[0];
    if (successorRef === undefined) {
      return state.lifecycle === "stale"
        ? { status: "unavailable" }
        : { status: "lost" };
    }
    recordRef = successorRef;
  }
}

type DependencyCycleEvidence = Readonly<{ kind: "dependency_cycle" }>;

/**
 * Diagnose only from product-owned, content-free edge indices. The single
 * work counter bounds every metadata read and every returned edge considered.
 */
async function diagnoseCurrentDependencyCycle(input: Readonly<{
  recordState: GroundedDependencyRecordStatePort;
  rootRecordRef: string;
  maxWork: number;
  signal?: AbortSignal;
}>): Promise<DependencyCycleEvidence | undefined> {
  const readDependencies = input.recordState.readStructuralDependencyRecordRefs?.bind(
    input.recordState,
  );
  if (readDependencies === undefined || input.maxWork < 1) return undefined;
  let remainingWork = input.maxWork;
  let indeterminate = false;
  let cycle = false;
  const consume = (): boolean => {
    if (remainingWork < 1) return false;
    remainingWork -= 1;
    return true;
  };
  const boundedRecordState: GroundedDependencyRecordStatePort = {
    readState: async (recordRef) => consume()
      ? input.recordState.readState(recordRef)
      : { status: "unavailable" },
    readSuccessors: async (successorInput) => consume()
      ? input.recordState.readSuccessors(successorInput)
      : { status: "unavailable" },
  };
  const normalize = async (recordRef: string): Promise<string | undefined> => {
    const current = await resolveCurrentDependencyInputRef({
      recordState: boundedRecordState,
      recordRef,
      maxVisitedRecords: input.maxWork,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return current.status === "current" ? current.recordRef : undefined;
  };

  const completed = new Set<string>();
  const visiting = new Set<string>();
  const visitCurrent = async (recordRef: string): Promise<void> => {
    if (cycle || indeterminate || completed.has(recordRef)) return;
    if (visiting.has(recordRef)) {
      cycle = true;
      return;
    }
    visiting.add(recordRef);
    if (!consume()) {
      indeterminate = true;
      return;
    }
    const page = await readDependencies({
      recordRef,
      limit: Math.max(1, remainingWork),
    });
    input.signal?.throwIfAborted();
    if (page.status !== "available" || !page.complete) {
      indeterminate = true;
      return;
    }
    for (const dependencyRecordRef of page.dependencyRecordRefs) {
      if (!consume()) {
        indeterminate = true;
        return;
      }
      const current = await normalize(dependencyRecordRef);
      if (current === undefined) {
        indeterminate = true;
        return;
      }
      await visitCurrent(current);
      if (cycle || indeterminate) return;
    }
    visiting.delete(recordRef);
    completed.add(recordRef);
  };

  const root = await normalize(input.rootRecordRef);
  if (root === undefined) return undefined;
  await visitCurrent(root);
  return cycle && !indeterminate ? { kind: "dependency_cycle" } : undefined;
}

function validReplacement(statement: string): boolean {
  return statement.trim().length > 0
    && Array.from(statement).length <= REPLACEMENT_STATEMENT_CODE_POINTS_MAXIMUM;
}

function sameExactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return new Set(sortedLeft).size === sortedLeft.length
    && new Set(sortedRight).size === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * Revalidates every exact direct support before resolving dependency loss.
 * Missing bodies never enter the rewrite input; changed/missing sources are
 * admitted through the same opaque reverse-dependency lane as tool expansion.
 */
export class ExactGroundedDependencyLossResolver
implements GroundedDependencyLossPort {
  constructor(private readonly ports: Readonly<{
    repository: RecordRepositoryPort;
    recordState?: GroundedDependencyRecordStatePort;
    recordBindings?: CurrentRecordPublicationBindingPort;
    eligibility: ProjectedAuthorityEligibility;
    source: CanonicalRecordSourceReadPort;
    inheritedMemorySource?: DeclaredInheritedMemorySourceReadPort;
    invalidation: RecordSourceInvalidationPort;
    statements: GroundedDependencyStatementPort;
  }>) {}

  async resolve(
    input: Parameters<GroundedDependencyLossPort["resolve"]>[0],
  ): Promise<GroundedDependencyLossDecision> {
    const remainingChildRecordRefs: string[] = [];
    const remainingChildRecordSet = new Set<string>();
    const remainingSourceDependencies: DurableSourceDependency[] = [];
    const remainingModelExposureDependencies: DurableModelExposureDependency[] = [];
    const exposureIdentities = new Set<string>();
    const supportIdentities = new Set<string>();
    const priorExposures = new Map<string, DurableModelExposureDependency>();
    for (const exposure of input.record.semantic.modelExposureDependencies ?? []) {
      const identity = exposure.kind === "record"
        ? `record\0${exposure.recordRef}`
        : `source\0${exposure.sourceKind}\0${exposure.logicalSourceRef}`;
      if (priorExposures.has(identity)) return { status: "unavailable" };
      priorExposures.set(identity, exposure);
    }
    const support: string[] = [];
    const sourceRevalidations = new Map<
      string,
      (invocationAudience: EffectiveAudienceAlternative) => Promise<boolean>
    >();
    const inheritedSourceIdentities = new Set<string>();
    let lost = 0;
    let recomputeWithoutHistoricalExposure = false;

    const retainRecord = (
      record: DurableRecordEnvelope,
      semanticSupport: boolean,
    ): void => {
      const identity = `record\0${record.recordRef}`;
      if (semanticSupport && !remainingChildRecordSet.has(record.recordRef)) {
        remainingChildRecordSet.add(record.recordRef);
        remainingChildRecordRefs.push(record.recordRef);
      }
      if (!supportIdentities.has(identity)) {
        supportIdentities.add(identity);
        support.push(record.semantic.statement);
      }
      if (!exposureIdentities.has(identity)) {
        exposureIdentities.add(identity);
        remainingModelExposureDependencies.push({
          kind: "record",
          recordRef: record.recordRef,
          observedProcessingGeneration: record.processingGeneration,
          terminalAuthorityLeafHandles:
            record.semantic.terminalAuthorityLeafHandles,
        });
      }
    };

    const openCanonicalCurrentRecord = async (
      recordRef: string,
      expectedGeneration?: number,
    ): Promise<
      | { readonly status: "available"; readonly record: DurableRecordEnvelope; readonly replaced: boolean }
      | { readonly status: "lost" }
      | { readonly status: "unavailable" }
    > => {
      let currentRecordRef = recordRef;
      let currentProcessingGeneration: number | undefined;
      if (this.ports.recordState !== undefined) {
        const resolved = await resolveCurrentDependencyInputRef({
            recordState: this.ports.recordState,
            recordRef,
            maxVisitedRecords: input.maxVisitedRecords,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        if (resolved.status !== "current") return resolved;
        currentRecordRef = resolved.recordRef;
        currentProcessingGeneration = resolved.processingGeneration;
      }
      const readBindingRef = await currentReadBinding(
        this.ports.recordBindings,
        currentRecordRef,
        input.binding.readBindingRef,
      );
      if (readBindingRef === null) return { status: "unavailable" };
      const opened = await this.ports.repository.read({ recordRef: currentRecordRef, readBindingRef });
      if (opened.status !== "available") return { status: "unavailable" };
      if (
        currentProcessingGeneration !== undefined
        && (
          opened.record.lifecycle !== "current"
          || currentProcessingGeneration !== opened.record.processingGeneration
        )
      ) return { status: "unavailable" };
      if (opened.record.lifecycle === "current") return {
        status: "available",
        record: opened.record,
        replaced: currentRecordRef !== recordRef
          || expectedGeneration !== undefined
            && opened.record.processingGeneration !== expectedGeneration,
      };
      return resolveSuccessor(
        recordRef,
        readBindingRef,
        opened.record.lifecycle !== "stale",
      );
    };

    const resolveSuccessor = async (
      recordRef: string,
      readBindingRef: string | undefined,
      terminalWithoutSuccessor: boolean,
    ): Promise<
      | { readonly status: "available"; readonly record: DurableRecordEnvelope; readonly replaced: boolean }
      | { readonly status: "lost" }
      | { readonly status: "unavailable" }
    > => {
      if (readBindingRef === undefined) return { status: "unavailable" };
      const successors = await this.ports.repository.readSuccessors({
        recordRef,
        readBindingRef,
        limit: 2,
      });
      if (successors.status !== "available" || successors.page.continuation !== undefined) {
        return { status: "unavailable" };
      }
      const successorRefs = successors.page.items.map((item) => item.successorRecordRef);
      if (successorRefs.length === 0) {
        return terminalWithoutSuccessor ? { status: "lost" } : { status: "unavailable" };
      }
      if (successorRefs.length !== 1) return { status: "unavailable" };
      const successorRef = successorRefs[0]!;
      const successorBinding = await currentReadBinding(
        this.ports.recordBindings,
        successorRef,
        input.binding.readBindingRef,
      );
      if (successorBinding === null) return { status: "unavailable" };
      const successor = await this.ports.repository.read({
        recordRef: successorRef,
        readBindingRef: successorBinding,
      });
      if (successor.status !== "available" || successor.record.lifecycle !== "current") {
        return { status: "unavailable" };
      }
      return { status: "available", record: successor.record, replaced: true };
    };

    const openCurrentRecord = async (
      recordRef: string,
      expectedGeneration?: number,
    ): Promise<
      | { readonly status: "available"; readonly record: DurableRecordEnvelope; readonly replaced: boolean }
      | { readonly status: "lost" }
      | Extract<GroundedDependencyLossDecision, {status: "unavailable"}>
    > => {
      const opened = await openCanonicalCurrentRecord(recordRef, expectedGeneration);
      if (opened.status !== "available") return opened;
      const eligible = await this.ports.eligibility.check({
        recordRef: opened.record.recordRef,
        invocationAudience: input.binding.invocationAudience,
      });
      if (eligible.status === "eligible") return opened;
      const evidence = opened.replaced && this.ports.recordState !== undefined
        ? await diagnoseCurrentDependencyCycle({
            recordState: this.ports.recordState,
            rootRecordRef: opened.record.recordRef,
            maxWork: input.maxVisitedRecords,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : undefined;
      return evidence === undefined
        ? { status: "unavailable" }
        : { status: "unavailable", evidence };
    };

    const retainSource = async (
      dependency: DurableSourceDependency,
      semanticSupport: boolean,
    ): Promise<"available" | "lost" | "unavailable"> => {
      const identity = `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`;
      const openExact = async (
        invocationAudience: EffectiveAudienceAlternative,
      ): Promise<Readonly<{
        result: CanonicalRecordSourceReadResult;
        inherited: boolean;
      }>> => {
        const sameRoom = await this.ports.source.readExact({
          dependency,
          evidenceBindingRef: input.binding.readBindingRef,
          returnedBytesMaximum: SUPPORT_BODY_BYTES_MAXIMUM,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (
          sameRoom.status !== "unavailable"
          || this.ports.inheritedMemorySource === undefined
        ) return { result: sameRoom, inherited: false };
        if (!input.record.semantic.terminalAuthorityLeafHandles.includes(
          dependency.terminalAuthorityLeafHandle,
        )) return { result: { status: "unavailable" }, inherited: true };
        const inherited = await this.ports.inheritedMemorySource
          .readExactDeclaredMemory({
            dependency,
            owningRecordRef: input.record.recordRef,
            evidenceBindingRef: input.binding.readBindingRef,
            invocationAudience,
            returnedBytesMaximum: SUPPORT_BODY_BYTES_MAXIMUM,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        return inherited.status === "not_applicable"
          ? { result: sameRoom, inherited: false }
          : { result: inherited, inherited: true };
      };
      const opened = await openExact(input.binding.invocationAudience);
      const exact = opened.result;
      if (exact.status === "unavailable") {
        if (!opened.inherited) {
          await this.ports.invalidation.admit({ dependency, reason: "unavailable" });
        }
        return "unavailable";
      }
      if (exact.status === "changed") {
        await this.ports.invalidation.admit({ dependency, reason: "changed" });
        return "lost";
      }
      if (semanticSupport && !remainingSourceDependencies.some(
        (source) => source.sourceKind === dependency.sourceKind
          && source.logicalSourceRef === dependency.logicalSourceRef,
      )) remainingSourceDependencies.push(dependency);
      if (!supportIdentities.has(identity)) {
        supportIdentities.add(identity);
        support.push(exact.content);
        sourceRevalidations.set(identity, async (invocationAudience) => {
          const current = (await openExact(invocationAudience)).result;
          return current.status === "available" && current.content === exact.content;
        });
      }
      if (opened.inherited) inheritedSourceIdentities.add(identity);
      if (!exposureIdentities.has(identity)) {
        exposureIdentities.add(identity);
        remainingModelExposureDependencies.push({
          kind: "source",
          sourceKind: dependency.sourceKind,
          logicalSourceRef: dependency.logicalSourceRef,
          ...(dependency.observedRevision === undefined
            ? {}
            : { observedRevision: dependency.observedRevision }),
          ...(dependency.observedContentFingerprint === undefined
            ? {}
            : {
                observedContentFingerprint:
                  dependency.observedContentFingerprint,
              }),
          terminalAuthorityLeafHandle: dependency.terminalAuthorityLeafHandle,
        });
      }
      return "available";
    };

    const retainExactRecordExposure = async (
      exposure: Extract<DurableModelExposureDependency, { kind: "record" }>,
    ): Promise<
      "available" | "historical" | "excluded" | "lost" | "unavailable"
    > => {
      const readBindingRef = await currentReadBinding(
        this.ports.recordBindings,
        exposure.recordRef,
        input.binding.readBindingRef,
      );
      // Binding and eligibility unavailability intentionally remain
      // non-terminal: they may combine absence, revocation, or incomplete
      // authority materialization. We may reorganize from independently
      // verified current structural support, but never sunset on this signal.
      if (readBindingRef === null) return "excluded";
      const opened = await this.ports.repository.read({
        recordRef: exposure.recordRef,
        readBindingRef,
      });
      if (
        opened.status !== "available"
        || opened.record.recordRef !== exposure.recordRef
      ) return "unavailable";
      if (!sameExactStrings(
        opened.record.semantic.terminalAuthorityLeafHandles,
        exposure.terminalAuthorityLeafHandles,
      )) return "unavailable";
      if (this.ports.recordState !== undefined) {
        const state = await this.ports.recordState.readState(exposure.recordRef);
        if (
          state.status !== "available"
          || state.disposition !== "available"
          || state.lifecycle !== opened.record.lifecycle
          || state.processingGeneration !== opened.record.processingGeneration
        ) return "unavailable";
      }
      let historical = false;
      if (opened.record.lifecycle === "current") {
        if (
          opened.record.processingGeneration
          !== exposure.observedProcessingGeneration
        ) return "unavailable";
      } else if (
        opened.record.lifecycle === "superseded"
        || opened.record.lifecycle === "resolved"
      ) {
        historical = true;
        if (
          opened.record.processingGeneration
          !== exposure.observedProcessingGeneration + 1
        ) return "unavailable";
        const successors = await this.ports.repository.readSuccessors({
          recordRef: exposure.recordRef,
          readBindingRef,
          limit: 2,
        });
        const edge = successors.status === "available"
          && successors.page.continuation === undefined
          && successors.page.items.length === 1
          ? successors.page.items[0]
          : undefined;
        if (
          edge === undefined
          || edge.predecessorRecordRef !== exposure.recordRef
          || edge.relation !== (opened.record.lifecycle === "superseded"
            ? "supersedes"
            : "resolves")
        ) return "unavailable";
      } else {
        return "lost";
      }
      const eligible = await this.ports.eligibility.check({
        recordRef: exposure.recordRef,
        invocationAudience: input.binding.invocationAudience,
      });
      if (eligible.status !== "eligible") return "excluded";
      // Authenticated retired exposure proves that the existing summary may
      // remain stable. It is immutable provenance, not current evidence for a
      // new model input or publication, so never copy its text or coordinate
      // into a replacement proposal.
      if (historical) return "historical";
      const identity = `record\0${exposure.recordRef}`;
      if (!supportIdentities.has(identity)) {
        supportIdentities.add(identity);
        support.push(opened.record.semantic.statement);
      }
      if (!exposureIdentities.has(identity)) {
        exposureIdentities.add(identity);
        remainingModelExposureDependencies.push(exposure);
      }
      return "available";
    };

    for (const childRecordRef of input.record.semantic.childRecordRefs) {
      const priorExposure = priorExposures.get(`record\0${childRecordRef}`);
      const current = await openCurrentRecord(
        childRecordRef,
        priorExposure?.kind === "record"
          ? priorExposure.observedProcessingGeneration
          : undefined,
      );
      if (current.status === "unavailable") return current;
      if (current.status === "lost") { lost += 1; continue; }
      if (current.replaced) lost += 1;
      retainRecord(current.record, true);
    }

    for (const dependency of input.record.semantic.sourceDependencies) {
      const priorExposure = priorExposures.get(
        `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`,
      );
      const current = await retainSource(
        priorExposure?.kind === "source"
          ? { ...priorExposure, authorityBearing: true }
          : dependency,
        true,
      );
      if (current === "unavailable") return { status: "unavailable" };
      if (current === "lost") lost += 1;
    }

    for (const exposure of input.record.semantic.modelExposureDependencies ?? []) {
      const identity = exposure.kind === "record"
        ? `record\0${exposure.recordRef}`
        : `source\0${exposure.sourceKind}\0${exposure.logicalSourceRef}`;
      if (exposureIdentities.has(identity)) continue;
      if (exposure.kind === "record") {
        const current = await retainExactRecordExposure(exposure);
        if (current === "unavailable") return { status: "unavailable" };
        if (current === "lost") lost += 1;
        if (current === "excluded") recomputeWithoutHistoricalExposure = true;
        continue;
      }
      const current = await retainSource({ ...exposure, authorityBearing: true }, false);
      if (current === "unavailable") return { status: "unavailable" };
      if (current === "lost") lost += 1;
    }

    if (lost === 0 && !recomputeWithoutHistoricalExposure) {
      return { status: "stable" };
    }
    if (
      remainingChildRecordRefs.length === 0
      && remainingSourceDependencies.length === 0
    ) return recomputeWithoutHistoricalExposure
      ? { status: "unavailable" }
      : { status: "total_loss" };
    for (const revalidate of sourceRevalidations.values()) {
      if (!await revalidate(input.binding.invocationAudience)) {
        return { status: "unavailable" };
      }
    }
    const rewritten = await this.ports.statements.rewrite({
      remainingSupportStatements: support,
      ...(inheritedSourceIdentities.size === 0
        ? {}
        : {
            modelExposureDependencies: remainingModelExposureDependencies,
            assertSourceEvidenceCurrent: async (
              invocationAudience: EffectiveAudienceAlternative,
            ) => {
              for (const revalidate of sourceRevalidations.values()) {
                if (!await revalidate(invocationAudience)) return false;
              }
              return true;
            },
          }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (rewritten.status !== "available" || !validReplacement(rewritten.statement)) {
      return { status: "unavailable" };
    }
    return {
      status: "partial_loss",
      replacementStatement: rewritten.statement.trim(),
      modelCalls: rewritten.modelCalls,
      remainingChildRecordRefs,
      remainingSourceDependencies,
      remainingModelExposureDependencies,
    };
  }
}
