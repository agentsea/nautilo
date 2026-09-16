import { createHash } from "node:crypto";

import type {
  AnchorRef,
  ApplyProposalInput,
  ApplyProposalResult,
  DependencyLossInput,
  DependencyLossResult,
  HierarchyBudget,
  HierarchyIdGenerator,
  HierarchyIdContext,
  RecordRef,
  SyntheticAccessAudience,
  SyntheticEligibleRecord,
  SyntheticStoredRecord,
} from "../contracts/hierarchy";
import { HierarchyError } from "../contracts/hierarchy";
import {
  deriveOrganizerEvidenceClosure,
  isStrictOrganizerEvidenceSuperset,
  type OrganizerEvidenceRecord,
} from "../organizer/evidence-closure";
import type { RepositoryMutationResult } from "./in-memory-repository";
import { InMemoryHierarchyRepository } from "./in-memory-repository";

const ZERO_USAGE = {
  modelCalls: 0,
  visitedRecords: 0,
  createdRecords: 0,
  traversalWork: 0,
} as const;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeAudience(audience: SyntheticAccessAudience): SyntheticAccessAudience {
  if (audience.kind !== "access") {
    throw new HierarchyError("audience_mismatch", "Synthetic audience must use kind=access");
  }
  if (audience.humanRefs.some((humanRef) => humanRef.length === 0)) {
    throw new HierarchyError("audience_mismatch", "Audience references must be non-empty");
  }
  if (new Set(audience.humanRefs).size !== audience.humanRefs.length) {
    throw new HierarchyError("duplicate_reference", "Audience contains duplicate Human references");
  }
  return { kind: "access", humanRefs: uniqueSorted(audience.humanRefs) };
}

export function intersectSyntheticAudiences(
  audiences: readonly SyntheticAccessAudience[],
): SyntheticAccessAudience {
  if (audiences.length === 0) return { kind: "access", humanRefs: [] };
  const [first, ...remaining] = audiences.map(normalizeAudience);
  let humans = new Set(first!.humanRefs);
  for (const audience of remaining) {
    humans = new Set(audience.humanRefs.filter((humanRef) => humans.has(humanRef)));
  }
  return { kind: "access", humanRefs: [...humans].sort((a, b) => a.localeCompare(b)) };
}

export function deriveSyntheticAnchors(
  children: readonly SyntheticStoredRecord[],
): readonly AnchorRef[] {
  return uniqueSorted(children.flatMap((child) => child.snapshot.anchors));
}

export function deriveStructuralHeight(
  children: readonly SyntheticStoredRecord[],
): number {
  return children.length === 0
    ? 0
    : 1 + Math.max(...children.map((child) => child.snapshot.structuralHeight));
}

function deriveSyntheticContentFingerprint(
  statement: string,
  childRecordRefs: readonly RecordRef[],
): string {
  return `synthetic-sha256:${createHash("sha256")
    .update(JSON.stringify({ statement, childRecordRefs }))
    .digest("hex")}`;
}

function mutationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new HierarchyError("duplicate_reference", `${label} contains duplicate references`, {
      label,
    });
  }
}

function assertCreationBudget(
  budget: HierarchyBudget,
  dependencyCount: number,
  statementCharacters: number,
): void {
  const values = Object.values(budget);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new HierarchyError("budget_exceeded", "Hierarchy budget values must be non-negative integers");
  }
  if (
    budget.maxModelCalls < 0
    || budget.maxVisitedRecords < dependencyCount
    || budget.maxCreatedRecords < 1
    || budget.maxTraversalWork < dependencyCount
    || budget.maxStatementCharacters < statementCharacters
  ) {
    throw new HierarchyError("budget_exceeded", "Hierarchy creation exceeds its explicit budget", {
      budget,
      dependencyCount,
      statementCharacters,
    });
  }
}

function audienceContains(
  audience: SyntheticAccessAudience,
  required: SyntheticAccessAudience,
): boolean {
  const available = new Set(audience.humanRefs);
  return required.humanRefs.every((humanRef) => available.has(humanRef));
}

export interface SyntheticHierarchyBridgeOptions {
  readonly repository: InMemoryHierarchyRepository;
  readonly idGenerator: HierarchyIdGenerator;
}

export class SyntheticHierarchyBridge {
  readonly #repository: InMemoryHierarchyRepository;
  readonly #idGenerator: HierarchyIdGenerator;

  constructor(options: SyntheticHierarchyBridgeOptions) {
    this.#repository = options.repository;
    this.#idGenerator = options.idGenerator;
  }

  seedEligibleRecord(
    eligible: SyntheticEligibleRecord,
    budget: HierarchyBudget,
  ): SyntheticStoredRecord {
    return this.#repository.seed(eligible, budget);
  }

  applyProposal(input: ApplyProposalInput): ApplyProposalResult {
    const scope = normalizeAudience(input.initialPublicationScope);

    switch (input.proposal.operation) {
      case "no_change":
        return { operation: "no_change", replayed: false, usage: ZERO_USAGE };
      case "dissolve_parent": {
        const fingerprint = mutationFingerprint({
          operation: input.proposal.operation,
          parentRecordRef: input.proposal.parentRecordRef,
        });
        const eligible = this.#resolveEligible(
          input.eligibleRecordRefs,
          scope,
          new Set([input.proposal.parentRecordRef]),
        );
        this.#requireDerivedParent(input.proposal.parentRecordRef, eligible);
        const replay = this.#repository.replayMutation(input.idempotencyKey, fingerprint);
        if (replay) {
          return {
            operation: "dissolve_parent",
            record: replay.record,
            replayed: true,
            usage: replay.usage,
          };
        }
        const result = this.#repository.transitionLifecycle({
          recordRef: input.proposal.parentRecordRef,
          lifecycle: "sunset",
          idempotencyKey: input.idempotencyKey,
          mutationFingerprint: fingerprint,
          budget: input.budget,
        });
        return {
          operation: "dissolve_parent",
          record: result.record,
          replayed: result.replayed,
          usage: result.usage,
        };
      }
      case "create_parent": {
        const eligible = this.#resolveEligible(input.eligibleRecordRefs, scope);
        return this.#applyCreation({
          operation: input.proposal.operation,
          statement: input.proposal.statement,
          childRecordRefs: input.proposal.childRecordRefs,
          eligible,
          scope,
          idempotencyKey: input.idempotencyKey,
          budget: input.budget,
        });
      }
      case "wrap_parent": {
        const eligible = this.#resolveEligible(input.eligibleRecordRefs, scope);
        this.#requireDerivedParent(input.proposal.parentRecordRef, eligible);
        return this.#applyCreation({
          operation: input.proposal.operation,
          statement: input.proposal.statement,
          childRecordRefs: uniqueSorted([
            input.proposal.parentRecordRef,
            ...input.proposal.additionRefs,
          ]),
          eligible,
          scope,
          idempotencyKey: input.idempotencyKey,
          budget: input.budget,
        });
      }
      case "extend_parent": {
        const eligible = this.#resolveEligible(input.eligibleRecordRefs, scope);
        const predecessor = this.#requireDerivedParent(
          input.proposal.parentRecordRef,
          eligible,
        );
        const childRecordRefs = uniqueSorted([
          ...predecessor.snapshot.childRecordRefs,
          ...input.proposal.additionRefs,
        ]);
        const records = new Map<RecordRef, OrganizerEvidenceRecord>(
          this.#repository.list().map((record) => [
            record.snapshot.recordRef,
            {
              recordRef: record.snapshot.recordRef,
              terminalEvidenceIdentity:
                record.snapshot.childRecordRefs.length === 0
                && record.createdByIdempotencyKey === undefined,
              childRecordRefs: record.snapshot.childRecordRefs,
              sourceDependencies: [],
            },
          ]),
        );
        const predecessorClosure = deriveOrganizerEvidenceClosure({
          rootRecordRefs: predecessor.snapshot.childRecordRefs,
          records,
          budget: input.budget,
        });
        const candidateClosure = deriveOrganizerEvidenceClosure({
          rootRecordRefs: childRecordRefs,
          records,
          budget: input.budget,
        });
        if (
          predecessorClosure.status !== "complete"
          || candidateClosure.status !== "complete"
        ) {
          throw new HierarchyError("budget_exceeded", "Evidence closure is unavailable");
        }
        if (!isStrictOrganizerEvidenceSuperset(
          candidateClosure.identityKeys,
          predecessorClosure.identityKeys,
        )) {
          return { operation: "no_change", replayed: false, usage: ZERO_USAGE };
        }
        return this.#applyCreation({
          operation: input.proposal.operation,
          predecessorRecordRef: input.proposal.parentRecordRef,
          statement: input.proposal.statement,
          childRecordRefs,
          eligible,
          scope,
          idempotencyKey: input.idempotencyKey,
          budget: input.budget,
        });
      }
      case "supersede_parent":
      case "resolve_parent": {
        const eligible = this.#resolveEligible(input.eligibleRecordRefs, scope);
        this.#requireDerivedParent(input.proposal.parentRecordRef, eligible);
        return this.#applyCreation({
          operation: input.proposal.operation,
          predecessorRecordRef: input.proposal.parentRecordRef,
          statement: input.proposal.statement,
          childRecordRefs: input.proposal.childRecordRefs,
          eligible,
          scope,
          idempotencyKey: input.idempotencyKey,
          budget: input.budget,
        });
      }
    }
  }

  applyDependencyLoss(input: DependencyLossInput): DependencyLossResult {
    assertUnique("unavailableChildRecordRefs", input.unavailableChildRecordRefs);
    const scope = normalizeAudience(input.initialPublicationScope);
    const eligible = this.#resolveEligible(
      input.eligibleRecordRefs,
      scope,
      new Set([input.parentRecordRef]),
    );
    const before = this.#requireDerivedParent(input.parentRecordRef, eligible);
    if (before.snapshot.posture !== "derived" || before.snapshot.childRecordRefs.length === 0) {
      throw new HierarchyError(
        "invalid_record",
        "Only a derived parent can lose Record dependencies",
        { parentRecordRef: input.parentRecordRef },
      );
    }
    if (input.unavailableChildRecordRefs.length === 0) {
      throw new HierarchyError("invalid_record", "Dependency loss requires at least one lost dependency");
    }
    const directDependencies = new Set(before.snapshot.childRecordRefs);
    for (const unavailableRef of input.unavailableChildRecordRefs) {
      if (!directDependencies.has(unavailableRef)) {
        throw new HierarchyError(
          "unknown_reference",
          "Unavailable reference is not a direct dependency of the parent",
          { parentRecordRef: input.parentRecordRef, unavailableRef },
        );
      }
    }
    const unavailable = new Set(input.unavailableChildRecordRefs);
    const remaining = before.snapshot.childRecordRefs.filter(
      (childRef) => !unavailable.has(childRef),
    );

    if (remaining.length === 0) {
      const fingerprint = mutationFingerprint({
        operation: "total_dependency_loss",
        parentRecordRef: input.parentRecordRef,
        unavailableChildRecordRefs: [...input.unavailableChildRecordRefs].sort(),
      });
      const result = this.#repository.transitionLifecycle({
        recordRef: input.parentRecordRef,
        lifecycle: "sunset",
        idempotencyKey: input.idempotencyKey,
        mutationFingerprint: fingerprint,
        budget: input.budget,
      });
      return {
        kind: "total_sunset",
        record: result.record,
        replayed: result.replayed,
        usage: result.usage,
      };
    }

    if (input.replacementStatement === undefined || input.replacementStatement.trim().length === 0) {
      throw new HierarchyError(
        "invalid_record",
        "Partial dependency loss requires a grounded replacement statement",
        { parentRecordRef: input.parentRecordRef },
      );
    }
    const result = this.applyProposal({
      proposal: {
        operation: "supersede_parent",
        parentRecordRef: input.parentRecordRef,
        statement: input.replacementStatement,
        childRecordRefs: remaining,
      },
      eligibleRecordRefs: input.eligibleRecordRefs,
      initialPublicationScope: input.initialPublicationScope,
      idempotencyKey: input.idempotencyKey,
      budget: input.budget,
    });
    if (result.operation !== "supersede_parent") {
      throw new HierarchyError("invalid_record", "Dependency replacement did not supersede its parent");
    }
    return {
      kind: "partial_replacement",
      predecessor: this.#repository.require(input.parentRecordRef),
      successor: result.record,
      remainingChildRecordRefs: remaining,
      replayed: result.replayed,
      usage: result.usage,
    };
  }

  #resolveEligible(
    eligibleRecordRefs: readonly RecordRef[],
    scope: SyntheticAccessAudience,
    allowedSunsetRecordRefs: ReadonlySet<RecordRef> = new Set(),
  ): ReadonlyMap<RecordRef, SyntheticStoredRecord> {
    assertUnique("eligibleRecordRefs", eligibleRecordRefs);
    const eligible = new Map<RecordRef, SyntheticStoredRecord>();
    for (const recordRef of eligibleRecordRefs) {
      const record = this.#repository.require(recordRef);
      if (
        (record.snapshot.lifecycle === "sunset" && !allowedSunsetRecordRefs.has(recordRef))
        || !audienceContains(record.audience, scope)
      ) {
        throw new HierarchyError(
          "ineligible_reference",
          "Supplied eligible view contains an unavailable Record",
          { recordRef },
        );
      }
      eligible.set(recordRef, record);
    }
    return eligible;
  }

  #requireEligible(
    recordRef: RecordRef,
    eligible: ReadonlyMap<RecordRef, SyntheticStoredRecord>,
  ): SyntheticStoredRecord {
    const record = eligible.get(recordRef);
    if (record) return record;
    if (this.#repository.get(recordRef)) {
      throw new HierarchyError("ineligible_reference", "Proposal references an ineligible Record", {
        recordRef,
      });
    }
    throw new HierarchyError("unknown_reference", "Proposal references an unknown Record", {
      recordRef,
    });
  }

  #requireDerivedParent(
    recordRef: RecordRef,
    eligible: ReadonlyMap<RecordRef, SyntheticStoredRecord>,
  ): SyntheticStoredRecord {
    const record = this.#requireEligible(recordRef, eligible);
    if (record.snapshot.posture !== "derived" || record.snapshot.childRecordRefs.length === 0) {
      throw new HierarchyError("invalid_record", "Organizer parent operation requires a derived parent", {
        recordRef,
      });
    }
    return record;
  }

  #applyCreation(input: {
    readonly operation:
      | "create_parent"
      | "extend_parent"
      | "wrap_parent"
      | "supersede_parent"
      | "resolve_parent";
    readonly predecessorRecordRef?: RecordRef;
    readonly statement: string;
    readonly childRecordRefs: readonly RecordRef[];
    readonly eligible: ReadonlyMap<RecordRef, SyntheticStoredRecord>;
    readonly scope: SyntheticAccessAudience;
    readonly idempotencyKey: string;
    readonly budget: HierarchyBudget;
  }): ApplyProposalResult {
    if (input.statement.trim().length === 0) {
      throw new HierarchyError("invalid_record", "Organizer statement must be non-empty");
    }
    if (input.childRecordRefs.length === 0) {
      throw new HierarchyError("invalid_record", "A derived parent requires supporting Records");
    }
    assertUnique("childRecordRefs", input.childRecordRefs);
    const children = input.childRecordRefs.map((childRef) =>
      this.#requireEligible(childRef, input.eligible)
    );
    const fingerprint = mutationFingerprint({
      operation: input.operation,
      predecessorRecordRef: input.predecessorRecordRef,
      statement: input.statement,
      childRecordRefs: input.childRecordRefs,
      initialPublicationScope: input.scope.humanRefs,
    });
    const replay = this.#repository.replayMutation(input.idempotencyKey, fingerprint);
    if (replay) return this.#creationResult(input, replay);

    assertCreationBudget(input.budget, children.length, Array.from(input.statement).length);

    const idContext: HierarchyIdContext = {
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      ...(input.predecessorRecordRef === undefined
        ? {}
        : { predecessorRecordRef: input.predecessorRecordRef }),
    };
    const recordRef = this.#idGenerator(idContext);
    const record: SyntheticStoredRecord = {
      snapshot: {
        recordRef,
        observedContentFingerprint: deriveSyntheticContentFingerprint(
          input.statement,
          input.childRecordRefs,
        ),
        posture: "derived",
        anchors: deriveSyntheticAnchors(children),
        statement: input.statement,
        sourceRefs: [],
        childRecordRefs: [...input.childRecordRefs],
        structuralHeight: deriveStructuralHeight(children),
        lifecycle: "current",
      },
      audience: intersectSyntheticAudiences([
        input.scope,
        ...children.map((child) => child.audience),
      ]),
      initialPublicationScope: input.scope,
      createdByIdempotencyKey: input.idempotencyKey,
    };
    const mutationInput = {
      record,
      idempotencyKey: input.idempotencyKey,
      mutationFingerprint: fingerprint,
      budget: input.budget,
    };
    const result = input.predecessorRecordRef === undefined
      ? this.#repository.applyRecord(mutationInput)
      : this.#repository.applySuccessor({
          ...mutationInput,
          predecessorRecordRef: input.predecessorRecordRef,
          relation: input.operation === "resolve_parent" ? "resolves" : "supersedes",
        });
    return this.#creationResult(input, result);
  }

  #creationResult(
    input: {
      readonly operation:
        | "create_parent"
        | "extend_parent"
        | "wrap_parent"
        | "supersede_parent"
        | "resolve_parent";
      readonly predecessorRecordRef?: RecordRef;
    },
    result: RepositoryMutationResult,
  ): ApplyProposalResult {
    return {
      operation: input.operation,
      record: result.record,
      ...(input.predecessorRecordRef === undefined
        ? {}
        : { predecessorRecordRef: input.predecessorRecordRef }),
      replayed: result.replayed,
      usage: result.usage,
    };
  }
}
