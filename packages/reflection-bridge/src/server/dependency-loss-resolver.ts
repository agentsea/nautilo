import type { DurableSourceDependency } from "@nautilo/reflection/durable";

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
    previousStatement: string;
    remainingSupportStatements: readonly string[];
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly statement: string; readonly modelCalls: 1 | 2 }
    | { readonly status: "unavailable" }
  >;
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
    const support: string[] = [];
    let lost = 0;

    for (const childRecordRef of input.record.semantic.childRecordRefs) {
      let currentRecordRef = childRecordRef;
      let currentReadBindingRef = await currentReadBinding(
        this.ports.recordBindings,
        currentRecordRef,
        input.binding.readBindingRef,
      );
      let eligible = await this.ports.eligibility.check({
        recordRef: currentRecordRef,
        invocationAudience: input.binding.invocationAudience,
      });
      let opened = eligible.status === "eligible" && currentReadBindingRef !== null
        ? await this.ports.repository.read({
            recordRef: currentRecordRef,
            readBindingRef: currentReadBindingRef,
          })
        : { status: "unavailable" as const };
      if (opened.status !== "available" || opened.record.lifecycle !== "current") {
        const successors = currentReadBindingRef === null
          ? { status: "unavailable" as const }
          : await this.ports.repository.readSuccessors({
              recordRef: childRecordRef,
              readBindingRef: currentReadBindingRef,
              limit: 2,
            });
        const successor = successors.status === "available"
          && successors.page.continuation === undefined
          && successors.page.items.length === 1
          ? successors.page.items[0]!.successorRecordRef
          : undefined;
        if (successor !== undefined) {
          currentRecordRef = successor;
          currentReadBindingRef = await currentReadBinding(
            this.ports.recordBindings,
            currentRecordRef,
            input.binding.readBindingRef,
          );
          eligible = await this.ports.eligibility.check({
            recordRef: currentRecordRef,
            invocationAudience: input.binding.invocationAudience,
          });
          opened = eligible.status === "eligible" && currentReadBindingRef !== null
            ? await this.ports.repository.read({
                recordRef: currentRecordRef,
                readBindingRef: currentReadBindingRef,
              })
            : { status: "unavailable" as const };
        }
      }
      if (opened.status !== "available" || opened.record.lifecycle !== "current") {
        lost += 1;
        continue;
      }
      if (currentRecordRef !== childRecordRef) lost += 1;
      if (!remainingChildRecordSet.has(currentRecordRef)) {
        remainingChildRecordSet.add(currentRecordRef);
        remainingChildRecordRefs.push(currentRecordRef);
        support.push(opened.record.semantic.statement);
      }
    }

    for (const dependency of input.record.semantic.sourceDependencies) {
      const exact = await this.ports.source.readExact({
        dependency,
        evidenceBindingRef: input.binding.readBindingRef,
        returnedBytesMaximum: SUPPORT_BODY_BYTES_MAXIMUM,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (exact.status !== "available") {
        lost += 1;
        await this.ports.invalidation.admit({
          dependency,
          reason: exact.status === "changed" ? "changed" : "unavailable",
        });
        continue;
      }
      remainingSourceDependencies.push(dependency);
      support.push(exact.content);
    }

    if (lost === 0) return { status: "stable" };
    if (
      remainingChildRecordRefs.length === 0
      && remainingSourceDependencies.length === 0
    ) return { status: "total_loss" };
    const rewritten = await this.ports.statements.rewrite({
      previousStatement: input.record.semantic.statement,
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
    };
  }
}
