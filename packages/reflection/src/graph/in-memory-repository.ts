import type {
  HierarchyBudget,
  HierarchyBudgetUsage,
  RecordLifecycle,
  RecordRef,
  SuccessorEdge,
  SuccessorRelation,
  SyntheticAccessAudience,
  SyntheticStoredRecord,
} from "../contracts/hierarchy";
import { HierarchyError } from "../contracts/hierarchy";
import type {
  HierarchyStructuralRecord,
  HierarchyStructuralView,
} from "./structural-validation";
import {
  assertExistingSuccessorEdgeStructure,
  assertLifecycleTransition,
  assertNewRecordStructure,
  assertSuccessorStructure,
  hasDependencyPath,
  terminalLifecycleForRelation,
} from "./structural-validation";

export interface RepositoryMutationResult {
  readonly record: SyntheticStoredRecord;
  readonly replayed: boolean;
  readonly usage: HierarchyBudgetUsage;
}

export interface ApplyRecordInput {
  readonly record: SyntheticStoredRecord;
  readonly idempotencyKey: string;
  readonly mutationFingerprint: string;
  readonly budget: HierarchyBudget;
}

export interface ApplySuccessorInput extends ApplyRecordInput {
  readonly predecessorRecordRef: RecordRef;
  readonly relation: SuccessorRelation;
}

export interface TransitionLifecycleInput {
  readonly recordRef: RecordRef;
  readonly lifecycle: RecordLifecycle;
  readonly idempotencyKey: string;
  readonly mutationFingerprint: string;
  readonly budget: HierarchyBudget;
}

export interface RecordSuccessorInput {
  readonly predecessorRecordRef: RecordRef;
  readonly successorRecordRef: RecordRef;
  readonly relation: SuccessorRelation;
  readonly idempotencyKey: string;
  readonly mutationFingerprint: string;
  readonly budget: HierarchyBudget;
}

interface IdempotencyReceipt {
  readonly fingerprint: string;
  readonly recordRef: RecordRef;
}

const ZERO_USAGE: HierarchyBudgetUsage = {
  modelCalls: 0,
  visitedRecords: 0,
  createdRecords: 0,
  traversalWork: 0,
};

function cloneAudience(audience: SyntheticAccessAudience): SyntheticAccessAudience {
  return { kind: "access", humanRefs: [...audience.humanRefs] };
}

function cloneRecord(record: SyntheticStoredRecord): SyntheticStoredRecord {
  const snapshot = {
    ...record.snapshot,
    anchors: [...record.snapshot.anchors],
    sourceRefs: [...record.snapshot.sourceRefs],
    childRecordRefs: [...record.snapshot.childRecordRefs],
  };
  return {
    snapshot,
    audience: cloneAudience(record.audience),
    initialPublicationScope: cloneAudience(record.initialPublicationScope),
    ...(record.createdByIdempotencyKey === undefined
      ? {}
      : { createdByIdempotencyKey: record.createdByIdempotencyKey }),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizedAudience(audience: SyntheticAccessAudience): SyntheticAccessAudience {
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

function intersection(
  audiences: readonly SyntheticAccessAudience[],
): SyntheticAccessAudience {
  if (audiences.length === 0) return { kind: "access", humanRefs: [] };
  const [first, ...remaining] = audiences.map(normalizedAudience);
  let humans = new Set(first!.humanRefs);
  for (const audience of remaining) {
    humans = new Set(audience.humanRefs.filter((humanRef) => humans.has(humanRef)));
  }
  return { kind: "access", humanRefs: [...humans].sort((a, b) => a.localeCompare(b)) };
}

function assertFiniteNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HierarchyError("budget_exceeded", `${label} must be a non-negative safe integer`, {
      label,
      value,
    });
  }
}

function assertValidBudget(budget: HierarchyBudget): void {
  assertFiniteNonNegativeInteger("maxModelCalls", budget.maxModelCalls);
  assertFiniteNonNegativeInteger("maxVisitedRecords", budget.maxVisitedRecords);
  assertFiniteNonNegativeInteger("maxCreatedRecords", budget.maxCreatedRecords);
  assertFiniteNonNegativeInteger("maxTraversalWork", budget.maxTraversalWork);
  assertFiniteNonNegativeInteger("maxStatementCharacters", budget.maxStatementCharacters);
}

function assertWithinBudget(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
  statementCharacters: number,
): void {
  assertValidBudget(budget);
  const exceeded =
    usage.modelCalls > budget.maxModelCalls
    || usage.visitedRecords > budget.maxVisitedRecords
    || usage.createdRecords > budget.maxCreatedRecords
    || usage.traversalWork > budget.maxTraversalWork
    || statementCharacters > budget.maxStatementCharacters;
  if (exceeded) {
    throw new HierarchyError("budget_exceeded", "Hierarchy operation exceeds its explicit budget", {
      budget,
      statementCharacters,
      usage,
    });
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new HierarchyError("invalid_record", `${label} must be non-empty`, { label });
  }
}

function structuralRecord(record: SyntheticStoredRecord): HierarchyStructuralRecord {
  return {
    recordRef: record.snapshot.recordRef,
    lifecycle: record.snapshot.lifecycle,
    structuralHeight: record.snapshot.structuralHeight,
    statement: record.snapshot.statement,
    anchorRefs: record.snapshot.anchors,
    sourceRefs: record.snapshot.sourceRefs,
    childRecordRefs: record.snapshot.childRecordRefs,
  };
}

/**
 * Deterministic Wave-3 reference repository. It owns no product persistence,
 * provider, authority resolver, or durable identity scheme.
 */
export class InMemoryHierarchyRepository implements HierarchyStructuralView {
  readonly #records = new Map<RecordRef, SyntheticStoredRecord>();
  readonly #parentsByChild = new Map<RecordRef, Set<RecordRef>>();
  readonly #successorsByPredecessor = new Map<RecordRef, SuccessorEdge[]>();
  readonly #predecessorsBySuccessor = new Map<RecordRef, SuccessorEdge[]>();
  readonly #idempotency = new Map<string, IdempotencyReceipt>();

  get(recordRef: RecordRef): SyntheticStoredRecord | undefined {
    const record = this.#records.get(recordRef);
    return record === undefined ? undefined : cloneRecord(record);
  }

  getRecord(recordRef: RecordRef): HierarchyStructuralRecord | undefined {
    const record = this.#records.get(recordRef);
    return record === undefined ? undefined : structuralRecord(record);
  }

  successorEdgesFrom(recordRef: RecordRef): readonly SuccessorEdge[] {
    return (this.#successorsByPredecessor.get(recordRef) ?? []).map((edge) => ({ ...edge }));
  }

  require(recordRef: RecordRef): SyntheticStoredRecord {
    const record = this.get(recordRef);
    if (!record) {
      throw new HierarchyError("unknown_reference", "Unknown Record reference", { recordRef });
    }
    return record;
  }

  list(): readonly SyntheticStoredRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.snapshot.recordRef.localeCompare(right.snapshot.recordRef))
      .map(cloneRecord);
  }

  childrenOf(recordRef: RecordRef): readonly SyntheticStoredRecord[] {
    const record = this.#requireInternal(recordRef);
    return record.snapshot.childRecordRefs.map((childRef) => this.require(childRef));
  }

  parentsOf(recordRef: RecordRef): readonly SyntheticStoredRecord[] {
    this.#requireInternal(recordRef);
    return [...(this.#parentsByChild.get(recordRef) ?? [])]
      .sort((left, right) => left.localeCompare(right))
      .map((parentRef) => this.require(parentRef));
  }

  successorsOf(recordRef: RecordRef): readonly SuccessorEdge[] {
    this.#requireInternal(recordRef);
    return (this.#successorsByPredecessor.get(recordRef) ?? []).map((edge) => ({ ...edge }));
  }

  predecessorsOf(recordRef: RecordRef): readonly SuccessorEdge[] {
    this.#requireInternal(recordRef);
    return (this.#predecessorsBySuccessor.get(recordRef) ?? []).map((edge) => ({ ...edge }));
  }

  isAncestor(ancestorRecordRef: RecordRef, descendantRecordRef: RecordRef): boolean {
    this.#requireInternal(ancestorRecordRef);
    this.#requireInternal(descendantRecordRef);
    return hasDependencyPath(this, ancestorRecordRef, descendantRecordRef);
  }

  replayMutation(
    idempotencyKey: string,
    mutationFingerprint: string,
  ): RepositoryMutationResult | undefined {
    return this.#replay(idempotencyKey, mutationFingerprint);
  }

  seed(record: SyntheticStoredRecord, budget: HierarchyBudget): SyntheticStoredRecord {
    const usage = this.#creationUsage(record);
    assertWithinBudget(budget, usage, codePointLength(record.snapshot.statement));
    this.#validateNewRecord(record, false);
    this.#insert(record);
    return this.require(record.snapshot.recordRef);
  }

  applyRecord(input: ApplyRecordInput): RepositoryMutationResult {
    const replay = this.#replay(input.idempotencyKey, input.mutationFingerprint);
    if (replay) return replay;
    const usage = this.#creationUsage(input.record);
    assertWithinBudget(input.budget, usage, codePointLength(input.record.snapshot.statement));
    this.#validateNewRecord(input.record, true);
    this.#assertUniqueCurrentParents(input.record.snapshot.childRecordRefs);
    this.#insert(input.record);
    this.#remember(input.idempotencyKey, input.mutationFingerprint, input.record.snapshot.recordRef);
    return { record: this.require(input.record.snapshot.recordRef), replayed: false, usage };
  }

  applySuccessor(input: ApplySuccessorInput): RepositoryMutationResult {
    const replay = this.#replay(input.idempotencyKey, input.mutationFingerprint);
    if (replay) return replay;
    const usage = this.#creationUsage(input.record, 1);
    assertWithinBudget(input.budget, usage, codePointLength(input.record.snapshot.statement));
    assertSuccessorStructure({
      predecessorRecordRef: input.predecessorRecordRef,
      successor: structuralRecord(input.record),
      relation: input.relation,
      view: this,
    });
    this.#validateRecordContentAndAudience(input.record);
    this.#assertUniqueCurrentParents(
      input.record.snapshot.childRecordRefs,
      input.predecessorRecordRef,
    );

    // All checks precede these in-memory writes, making the compound mutation atomic.
    this.#insert(input.record);
    this.#setLifecycle(input.predecessorRecordRef, terminalLifecycleForRelation(input.relation));
    this.#insertSuccessorEdge({
      predecessorRecordRef: input.predecessorRecordRef,
      successorRecordRef: input.record.snapshot.recordRef,
      relation: input.relation,
    });
    this.#remember(input.idempotencyKey, input.mutationFingerprint, input.record.snapshot.recordRef);
    return { record: this.require(input.record.snapshot.recordRef), replayed: false, usage };
  }

  transitionLifecycle(input: TransitionLifecycleInput): RepositoryMutationResult {
    const replay = this.#replay(input.idempotencyKey, input.mutationFingerprint);
    if (replay) return replay;
    const current = this.#requireInternal(input.recordRef);
    const usage: HierarchyBudgetUsage = {
      modelCalls: 0,
      visitedRecords: 1,
      createdRecords: 0,
      traversalWork: 1,
    };
    assertWithinBudget(input.budget, usage, 0);
    assertLifecycleTransition(current.snapshot.lifecycle, input.lifecycle, {
      successorAttached: false,
    });
    this.#setLifecycle(input.recordRef, input.lifecycle);
    this.#remember(input.idempotencyKey, input.mutationFingerprint, input.recordRef);
    return { record: this.require(input.recordRef), replayed: false, usage };
  }

  /** Low-level edge primitive retained to prove successor-cycle rejection. */
  recordSuccessor(input: RecordSuccessorInput): RepositoryMutationResult {
    const replay = this.#replay(input.idempotencyKey, input.mutationFingerprint);
    if (replay) return replay;
    this.#requireInternal(input.predecessorRecordRef);
    this.#requireInternal(input.successorRecordRef);
    const usage: HierarchyBudgetUsage = {
      modelCalls: 0,
      visitedRecords: 2,
      createdRecords: 0,
      traversalWork: 1,
    };
    assertWithinBudget(input.budget, usage, 0);
    assertExistingSuccessorEdgeStructure({
      predecessorRecordRef: input.predecessorRecordRef,
      successorRecordRef: input.successorRecordRef,
      relation: input.relation,
      view: this,
    });
    this.#setLifecycle(input.predecessorRecordRef, terminalLifecycleForRelation(input.relation));
    this.#insertSuccessorEdge({
      predecessorRecordRef: input.predecessorRecordRef,
      successorRecordRef: input.successorRecordRef,
      relation: input.relation,
    });
    this.#remember(input.idempotencyKey, input.mutationFingerprint, input.successorRecordRef);
    return { record: this.require(input.successorRecordRef), replayed: false, usage };
  }

  #requireInternal(recordRef: RecordRef): SyntheticStoredRecord {
    const record = this.#records.get(recordRef);
    if (!record) {
      throw new HierarchyError("unknown_reference", "Unknown Record reference", { recordRef });
    }
    return record;
  }

  #creationUsage(record: SyntheticStoredRecord, additionalVisited = 0): HierarchyBudgetUsage {
    const dependencyCount = record.snapshot.childRecordRefs.length;
    return {
      modelCalls: 0,
      visitedRecords: dependencyCount + additionalVisited,
      createdRecords: 1,
      traversalWork: dependencyCount,
    };
  }

  #validateNewRecord(record: SyntheticStoredRecord, requireCurrent: boolean): void {
    assertNewRecordStructure({
      record: structuralRecord(record),
      view: this,
      requireCurrent,
    });
    this.#validateRecordContentAndAudience(record);
  }

  #validateRecordContentAndAudience(record: SyntheticStoredRecord): void {
    const { snapshot } = record;
    assertNonEmpty("observedContentFingerprint", snapshot.observedContentFingerprint);
    const children = snapshot.childRecordRefs.map((childRef) => this.#requireInternal(childRef));
    normalizedAudience(record.initialPublicationScope);
    const actualAudience = normalizedAudience(record.audience);
    if (children.length > 0) {
      const expectedAudience = intersection([
        record.initialPublicationScope,
        ...children.map((child) => child.audience),
      ]);
      if (!sameStrings(actualAudience.humanRefs, expectedAudience.humanRefs)) {
        throw new HierarchyError(
          "audience_mismatch",
          "Derived Record audience must equal dependency/scope intersection",
          { actual: actualAudience.humanRefs, expected: expectedAudience.humanRefs },
        );
      }
    }
  }

  #assertUniqueCurrentParents(
    childRecordRefs: readonly RecordRef[],
    replaceableParentRef?: RecordRef,
  ): void {
    for (const childRecordRef of childRecordRefs) {
      const currentParents = [...(this.#parentsByChild.get(childRecordRef) ?? [])]
        .filter((parentRecordRef) =>
          this.#requireInternal(parentRecordRef).snapshot.lifecycle === "current"
        );
      if (
        currentParents.length === 0
        || (currentParents.length === 1
          && currentParents[0] === replaceableParentRef)
      ) continue;
      throw new HierarchyError(
        "multiple_current_parents",
        "A current Record may have at most one current semantic parent",
      );
    }
  }

  #insert(record: SyntheticStoredRecord): void {
    const stored = cloneRecord({
      ...record,
      audience: normalizedAudience(record.audience),
      initialPublicationScope: normalizedAudience(record.initialPublicationScope),
    });
    this.#records.set(stored.snapshot.recordRef, stored);
    for (const childRef of stored.snapshot.childRecordRefs) {
      const parents = this.#parentsByChild.get(childRef) ?? new Set<RecordRef>();
      parents.add(stored.snapshot.recordRef);
      this.#parentsByChild.set(childRef, parents);
    }
  }

  #setLifecycle(recordRef: RecordRef, lifecycle: RecordLifecycle): void {
    const current = this.#requireInternal(recordRef);
    this.#records.set(recordRef, {
      ...current,
      snapshot: { ...current.snapshot, lifecycle },
    });
  }

  #insertSuccessorEdge(edge: SuccessorEdge): void {
    const successors = this.#successorsByPredecessor.get(edge.predecessorRecordRef) ?? [];
    successors.push({ ...edge });
    this.#successorsByPredecessor.set(edge.predecessorRecordRef, successors);
    const predecessors = this.#predecessorsBySuccessor.get(edge.successorRecordRef) ?? [];
    predecessors.push({ ...edge });
    this.#predecessorsBySuccessor.set(edge.successorRecordRef, predecessors);
  }

  #replay(idempotencyKey: string, fingerprint: string): RepositoryMutationResult | undefined {
    assertNonEmpty("idempotencyKey", idempotencyKey);
    assertNonEmpty("mutationFingerprint", fingerprint);
    const receipt = this.#idempotency.get(idempotencyKey);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) {
      throw new HierarchyError(
        "idempotency_conflict",
        "Idempotency key was already used for a different hierarchy mutation",
        { idempotencyKey },
      );
    }
    return { record: this.require(receipt.recordRef), replayed: true, usage: ZERO_USAGE };
  }

  #remember(idempotencyKey: string, fingerprint: string, recordRef: RecordRef): void {
    this.#idempotency.set(idempotencyKey, { fingerprint, recordRef });
  }
}
