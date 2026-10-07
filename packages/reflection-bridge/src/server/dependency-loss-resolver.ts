import type {
  DurableModelExposureDependency,
  DurableRecordEnvelope,
  DurableSourceDependency,
} from "@nautilo/reflection/durable";

import type { ProjectedAuthorityEligibility } from "./authority-eligibility";
import type { RecordRepositoryPort } from "./contracts";
import type {
  GroundedDependencyLossDecision,
  GroundedDependencyLossPort,
} from "./durable-semantic-composition";
import type {
  CanonicalRecordSourceReadPort,
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
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly statement: string; readonly modelCalls: 1 | 2 }
    | { readonly status: "unavailable" }
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

function validReplacement(statement: string): boolean {
  return statement.trim().length > 0
    && Array.from(statement).length <= REPLACEMENT_STATEMENT_CODE_POINTS_MAXIMUM;
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
    let lost = 0;

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

    const openCurrentRecord = async (
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
      if (opened.record.lifecycle === "current") {
        const eligible = await this.ports.eligibility.check({
          recordRef: currentRecordRef,
          invocationAudience: input.binding.invocationAudience,
        });
        return eligible.status === "eligible"
          ? {
              status: "available",
              record: opened.record,
              replaced: currentRecordRef !== recordRef
                || expectedGeneration !== undefined
                  && opened.record.processingGeneration !== expectedGeneration,
            }
          : { status: "unavailable" };
      }
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
      const eligible = await this.ports.eligibility.check({
        recordRef: successorRef,
        invocationAudience: input.binding.invocationAudience,
      });
      return eligible.status === "eligible"
        ? { status: "available", record: successor.record, replaced: true }
        : { status: "unavailable" };
    };

    const retainSource = async (
      dependency: DurableSourceDependency,
      semanticSupport: boolean,
    ): Promise<"available" | "lost" | "unavailable"> => {
      const identity = `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`;
      const exact = await this.ports.source.readExact({
        dependency,
        evidenceBindingRef: input.binding.readBindingRef,
        returnedBytesMaximum: SUPPORT_BODY_BYTES_MAXIMUM,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (exact.status === "unavailable") {
        await this.ports.invalidation.admit({ dependency, reason: "unavailable" });
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
      }
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

    for (const childRecordRef of input.record.semantic.childRecordRefs) {
      const priorExposure = priorExposures.get(`record\0${childRecordRef}`);
      const current = await openCurrentRecord(
        childRecordRef,
        priorExposure?.kind === "record"
          ? priorExposure.observedProcessingGeneration
          : undefined,
      );
      if (current.status === "unavailable") return { status: "unavailable" };
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
        const current = await openCurrentRecord(
          exposure.recordRef,
          exposure.observedProcessingGeneration,
        );
        if (current.status === "unavailable") return { status: "unavailable" };
        if (current.status === "lost") { lost += 1; continue; }
        if (current.replaced) lost += 1;
        retainRecord(current.record, false);
        continue;
      }
      const current = await retainSource({ ...exposure, authorityBearing: true }, false);
      if (current === "unavailable") return { status: "unavailable" };
      if (current === "lost") lost += 1;
    }

    if (lost === 0) return { status: "stable" };
    if (
      remainingChildRecordRefs.length === 0
      && remainingSourceDependencies.length === 0
    ) return { status: "total_loss" };
    const rewritten = await this.ports.statements.rewrite({
      remainingSupportStatements: support,
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
