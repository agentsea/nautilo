import type {
  RecordLifecycle,
  RecordRef,
  SuccessorEdge,
  SuccessorRelation,
} from "../contracts/hierarchy";
import { HierarchyError } from "../contracts/hierarchy";

/**
 * The semantic and topological facts needed to validate a graph mutation.
 * Durable adapters may project this from decoded payload plus relational
 * metadata; no persistence or representation concern enters this contract.
 */
export interface HierarchyStructuralRecord {
  readonly recordRef: RecordRef;
  readonly lifecycle: RecordLifecycle;
  readonly structuralHeight: number;
  readonly statement: string;
  readonly anchorRefs: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly childRecordRefs: readonly RecordRef[];
}

export interface HierarchyStructuralView {
  getRecord(recordRef: RecordRef): HierarchyStructuralRecord | undefined;
  successorEdgesFrom(recordRef: RecordRef): readonly SuccessorEdge[];
}

export interface NewRecordStructuralValidationInput {
  readonly record: HierarchyStructuralRecord;
  readonly view: HierarchyStructuralView;
  readonly requireCurrent: boolean;
}

export interface SuccessorStructuralValidationInput {
  readonly predecessorRecordRef: RecordRef;
  readonly successor: HierarchyStructuralRecord;
  readonly relation: SuccessorRelation;
  readonly view: HierarchyStructuralView;
}

export interface ExistingSuccessorEdgeValidationInput {
  readonly predecessorRecordRef: RecordRef;
  readonly successorRecordRef: RecordRef;
  readonly relation: SuccessorRelation;
  readonly view: HierarchyStructuralView;
}

function requireRecord(
  view: HierarchyStructuralView,
  recordRef: RecordRef,
): HierarchyStructuralRecord {
  const record = view.getRecord(recordRef);
  if (!record) {
    throw new HierarchyError("unknown_reference", "Unknown Record reference", { recordRef });
  }
  return record;
}

function requireNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new HierarchyError("invalid_record", `${label} must be non-empty`, { label });
  }
}

function requireUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new HierarchyError("duplicate_reference", `${label} contains duplicate references`, {
      label,
    });
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function terminalLifecycleForRelation(
  relation: SuccessorRelation,
): "superseded" | "resolved" {
  return relation === "supersedes" ? "superseded" : "resolved";
}

export function assertLifecycleTransition(
  from: RecordLifecycle,
  to: RecordLifecycle,
  options: { readonly successorAttached: boolean },
): void {
  const validSource = from === "current" || from === "stale";
  const validTarget = from === "current"
    ? to === "stale" || to === "superseded" || to === "resolved" || to === "sunset"
    : from === "stale"
      ? to === "current" || to === "superseded" || to === "resolved" || to === "sunset"
      : false;
  const successorRequired = to === "superseded" || to === "resolved";
  if (
    !validSource
    || !validTarget
    || (successorRequired && !options.successorAttached)
  ) {
    throw new HierarchyError("invalid_lifecycle_transition", "Invalid Record lifecycle transition", {
      from,
      successorAttached: options.successorAttached,
      to,
    });
  }
}

export function hasDependencyPath(
  view: HierarchyStructuralView,
  from: RecordRef,
  target: RecordRef,
): boolean {
  const pending = [from];
  const seen = new Set<RecordRef>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = view.getRecord(current);
    if (record) pending.push(...record.childRecordRefs);
  }
  return false;
}

export function hasSuccessorPath(
  view: HierarchyStructuralView,
  from: RecordRef,
  target: RecordRef,
): boolean {
  const pending = [from];
  const seen = new Set<RecordRef>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...view.successorEdgesFrom(current).map((edge) => edge.successorRecordRef));
  }
  return false;
}

export function deriveStructuralHeight(
  children: readonly HierarchyStructuralRecord[],
): number {
  return children.length === 0
    ? 0
    : 1 + Math.max(...children.map((child) => child.structuralHeight));
}

function assertNoAncestorDescendantPair(
  view: HierarchyStructuralView,
  recordRefs: readonly RecordRef[],
): void {
  for (let leftIndex = 0; leftIndex < recordRefs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < recordRefs.length; rightIndex += 1) {
      const left = recordRefs[leftIndex]!;
      const right = recordRefs[rightIndex]!;
      if (hasDependencyPath(view, left, right) || hasDependencyPath(view, right, left)) {
        throw new HierarchyError(
          "ancestor_descendant_duplication",
          "One dependency set cannot contain an ancestor and its descendant",
          { left, right },
        );
      }
    }
  }
}

export function assertNewRecordStructure(
  input: NewRecordStructuralValidationInput,
): readonly HierarchyStructuralRecord[] {
  const { record, view } = input;
  requireNonEmpty("recordRef", record.recordRef);
  requireNonEmpty("statement", record.statement);
  if (!Number.isSafeInteger(record.structuralHeight) || record.structuralHeight < 0) {
    throw new HierarchyError("invalid_record", "Structural height must be a non-negative integer");
  }
  if (input.requireCurrent && record.lifecycle !== "current") {
    throw new HierarchyError("invalid_record", "A newly applied Record must start current");
  }
  if (view.getRecord(record.recordRef)) {
    throw new HierarchyError("duplicate_reference", "Record reference already exists", {
      recordRef: record.recordRef,
    });
  }
  requireUnique("anchors", record.anchorRefs);
  requireUnique("sourceRefs", record.sourceRefs);
  requireUnique("childRecordRefs", record.childRecordRefs);
  if (record.childRecordRefs.includes(record.recordRef)) {
    throw new HierarchyError("self_dependency", "A Record cannot depend on itself", {
      recordRef: record.recordRef,
    });
  }
  const children = record.childRecordRefs.map((childRef) => requireRecord(view, childRef));
  assertNoAncestorDescendantPair(view, record.childRecordRefs);
  for (const childRef of record.childRecordRefs) {
    if (hasDependencyPath(view, childRef, record.recordRef)) {
      throw new HierarchyError("dependency_cycle", "Dependency edge would create a cycle", {
        childRecordRef: childRef,
        recordRef: record.recordRef,
      });
    }
  }
  const expectedHeight = deriveStructuralHeight(children);
  if (record.structuralHeight !== expectedHeight) {
    throw new HierarchyError("invalid_record", "Structural height does not match dependencies", {
      actual: record.structuralHeight,
      expected: expectedHeight,
    });
  }
  return children;
}

export function assertChangedRecordSupport(
  predecessor: HierarchyStructuralRecord,
  successor: HierarchyStructuralRecord,
): void {
  if (
    predecessor.statement === successor.statement
    && sameSet(predecessor.childRecordRefs, successor.childRecordRefs)
    && sameSet(predecessor.sourceRefs, successor.sourceRefs)
  ) {
    throw new HierarchyError(
      "unchanged_successor",
      "A successor must change its statement or effective support",
    );
  }
}

function assertSuccessorEdgeAcyclic(
  view: HierarchyStructuralView,
  predecessorRecordRef: RecordRef,
  successorRecordRef: RecordRef,
): void {
  if (
    predecessorRecordRef === successorRecordRef
    || hasSuccessorPath(view, successorRecordRef, predecessorRecordRef)
  ) {
    throw new HierarchyError("successor_cycle", "Successor edge would create a cycle", {
      predecessorRecordRef,
      successorRecordRef,
    });
  }
}

export function assertSuccessorStructure(
  input: SuccessorStructuralValidationInput,
): readonly HierarchyStructuralRecord[] {
  const predecessor = requireRecord(input.view, input.predecessorRecordRef);
  assertLifecycleTransition(
    predecessor.lifecycle,
    terminalLifecycleForRelation(input.relation),
    { successorAttached: true },
  );
  const children = assertNewRecordStructure({
    record: input.successor,
    view: input.view,
    requireCurrent: true,
  });
  assertChangedRecordSupport(predecessor, input.successor);
  assertSuccessorEdgeAcyclic(
    input.view,
    input.predecessorRecordRef,
    input.successor.recordRef,
  );
  return children;
}

export function assertExistingSuccessorEdgeStructure(
  input: ExistingSuccessorEdgeValidationInput,
): void {
  const predecessor = requireRecord(input.view, input.predecessorRecordRef);
  const successor = requireRecord(input.view, input.successorRecordRef);
  assertChangedRecordSupport(predecessor, successor);
  assertSuccessorEdgeAcyclic(
    input.view,
    input.predecessorRecordRef,
    input.successorRecordRef,
  );
  assertLifecycleTransition(
    predecessor.lifecycle,
    terminalLifecycleForRelation(input.relation),
    { successorAttached: true },
  );
}
