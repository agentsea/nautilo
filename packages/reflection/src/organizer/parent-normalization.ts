import type { RecordRef } from "../contracts/hierarchy";

export interface OrganizerCurrentParentEdge {
  readonly childRecordRef: RecordRef;
  readonly parentRecordRef: RecordRef;
}

export type OrganizerParentNormalizationResult =
  | Readonly<{
      status: "complete";
      representatives: ReadonlyMap<RecordRef, RecordRef>;
      traversalWork: number;
      maximumDepth: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "invalid_input"
        | "multiple_current_parents"
        | "dependency_cycle"
        | "budget_exceeded";
      traversalWork: number;
    }>;

function validRef(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Resolve each seed to the unique highest current semantic representative.
 *
 * The input contains only current, authority-qualified edges selected by the
 * product bridge. Historical/superseded edges never enter this pure view.
 */
export function normalizeOrganizerCurrentParents(input: Readonly<{
  seedRecordRefs: readonly RecordRef[];
  currentParentEdges: readonly OrganizerCurrentParentEdge[];
  maxTraversalWork: number;
}>): OrganizerParentNormalizationResult {
  if (
    !Number.isSafeInteger(input.maxTraversalWork)
    || input.maxTraversalWork < 0
    || input.seedRecordRefs.some((recordRef) => !validRef(recordRef))
    || new Set(input.seedRecordRefs).size !== input.seedRecordRefs.length
    || input.currentParentEdges.some((edge) =>
      !validRef(edge.childRecordRef)
      || !validRef(edge.parentRecordRef)
      || edge.childRecordRef === edge.parentRecordRef
    )
  ) {
    return { status: "unavailable", reason: "invalid_input", traversalWork: 0 };
  }

  const parents = new Map<RecordRef, RecordRef>();
  for (const edge of input.currentParentEdges) {
    const existing = parents.get(edge.childRecordRef);
    if (existing !== undefined && existing !== edge.parentRecordRef) {
      return {
        status: "unavailable",
        reason: "multiple_current_parents",
        traversalWork: 0,
      };
    }
    parents.set(edge.childRecordRef, edge.parentRecordRef);
  }

  const representatives = new Map<RecordRef, RecordRef>();
  let traversalWork = 0;
  let maximumDepth = 0;
  for (const seed of input.seedRecordRefs) {
    let current = seed;
    let depth = 0;
    const path = new Set<RecordRef>([seed]);
    for (;;) {
      const parent = parents.get(current);
      if (parent === undefined) break;
      if (traversalWork >= input.maxTraversalWork) {
        return { status: "unavailable", reason: "budget_exceeded", traversalWork };
      }
      traversalWork += 1;
      depth += 1;
      if (path.has(parent)) {
        return { status: "unavailable", reason: "dependency_cycle", traversalWork };
      }
      path.add(parent);
      current = parent;
    }
    maximumDepth = Math.max(maximumDepth, depth);
    representatives.set(seed, current);
  }
  return {
    status: "complete",
    representatives,
    traversalWork,
    maximumDepth,
  };
}
