import type {
  RecordRef,
  RecordSnapshot,
  SuccessorEdge,
} from "../contracts/hierarchy";
import { HierarchyError } from "../contracts/hierarchy";
import type { InMemoryHierarchyRepository } from "../graph/in-memory-repository";

export interface SimilarityScore {
  readonly recordRef: RecordRef;
  readonly score: number;
}

/** Called only after the caller-provided eligible view has been validated. */
export type HierarchySimilarityPort = (
  query: string,
  records: readonly RecordSnapshot[],
) => Promise<readonly SimilarityScore[]> | readonly SimilarityScore[];

export interface HierarchySearchResult {
  readonly snapshot: RecordSnapshot;
  readonly score: number;
  readonly directParentRecordRefs: readonly RecordRef[];
  readonly backlinksTruncated: boolean;
}

export interface HierarchySearchResponse {
  readonly results: readonly HierarchySearchResult[];
  readonly diagnostics: {
    readonly eligibleCount: number;
    readonly scoredCount: number;
    readonly redundancySuppressedCount: number;
  };
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateEligibleView(
  repository: InMemoryHierarchyRepository,
  eligibleRecordRefs: readonly RecordRef[],
): ReadonlySet<RecordRef> {
  if (!unique(eligibleRecordRefs)) {
    throw new HierarchyError("duplicate_reference", "eligible view contains duplicates");
  }
  const eligible = new Set<RecordRef>();
  for (const recordRef of eligibleRecordRefs) {
    const record = repository.require(recordRef);
    if (record.snapshot.lifecycle === "sunset") {
      throw new HierarchyError(
        "ineligible_reference",
        "sunset Records cannot enter an eligible search view",
        { recordRef },
      );
    }
    eligible.add(recordRef);
  }
  return eligible;
}

function projectEligibleSnapshot(
  snapshot: RecordSnapshot,
  eligible: ReadonlySet<RecordRef>,
  visibleChildRecordRefs: readonly RecordRef[] = [],
): RecordSnapshot {
  const visible = new Set(visibleChildRecordRefs);
  return {
    ...snapshot,
    anchors: [...snapshot.anchors],
    sourceRefs: [...snapshot.sourceRefs],
    childRecordRefs: snapshot.childRecordRefs.filter(
      (recordRef) => eligible.has(recordRef) && visible.has(recordRef),
    ),
  };
}

/**
 * Search leaves and parents with one utility order: semantic score, then height,
 * then opaque reference. Ancestor/descendant redundancy retains the earlier,
 * therefore more useful, result under that same order.
 */
export async function searchHierarchy(input: {
  readonly query: string;
  readonly eligibleRecordRefs: readonly RecordRef[];
  readonly repository: InMemoryHierarchyRepository;
  readonly score: HierarchySimilarityPort;
  readonly limit: number;
  readonly backlinkBudget: number;
}): Promise<HierarchySearchResponse> {
  assertPositiveInteger("limit", input.limit);
  assertPositiveInteger("backlinkBudget", input.backlinkBudget);
  if (input.query.trim().length === 0) throw new TypeError("query must not be empty");

  const eligible = validateEligibleView(input.repository, input.eligibleRecordRefs);
  const snapshots = [...eligible]
    .sort((left, right) => left.localeCompare(right))
    .map((recordRef) =>
      projectEligibleSnapshot(input.repository.require(recordRef).snapshot, eligible)
    );
  const scores = await input.score(input.query, snapshots);
  if (!unique(scores.map((entry) => entry.recordRef))) {
    throw new HierarchyError("duplicate_reference", "similarity port returned duplicate Records");
  }
  for (const entry of scores) {
    if (!eligible.has(entry.recordRef)) {
      throw new HierarchyError(
        "ineligible_reference",
        "similarity port returned a Record outside the eligible view",
        { recordRef: entry.recordRef },
      );
    }
    if (!Number.isFinite(entry.score)) {
      throw new TypeError("similarity scores must be finite numbers");
    }
  }

  const ordered = scores
    .map((entry) => ({
      ...entry,
      snapshot: projectEligibleSnapshot(
        input.repository.require(entry.recordRef).snapshot,
        eligible,
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score
        || right.snapshot.structuralHeight - left.snapshot.structuralHeight
        || left.recordRef.localeCompare(right.recordRef),
    );
  const retained: typeof ordered = [];
  let redundancySuppressedCount = 0;
  for (const candidate of ordered) {
    const redundant = retained.some((selected) =>
      input.repository.isAncestor(selected.recordRef, candidate.recordRef)
      || input.repository.isAncestor(candidate.recordRef, selected.recordRef)
    );
    if (redundant) {
      redundancySuppressedCount += 1;
      continue;
    }
    retained.push(candidate);
    if (retained.length >= input.limit) break;
  }

  return {
    results: retained.map((entry) => {
      const parents = input.repository
        .parentsOf(entry.recordRef)
        .map((parent) => parent.snapshot.recordRef)
        .filter((parentRef) => eligible.has(parentRef));
      return {
        snapshot: entry.snapshot,
        score: entry.score,
        directParentRecordRefs: parents.slice(0, input.backlinkBudget),
        backlinksTruncated: parents.length > input.backlinkBudget,
      };
    }),
    diagnostics: {
      eligibleCount: eligible.size,
      scoredCount: scores.length,
      redundancySuppressedCount,
    },
  };
}

export interface ExpansionQueueEntry {
  readonly recordRef: RecordRef;
  readonly depth: number;
  readonly nextChildPosition?: number;
}

export interface EvidenceExpansionContinuation {
  readonly rootRecordRef: RecordRef;
  readonly maxDepth: number;
  readonly queue: readonly ExpansionQueueEntry[];
  readonly visitedRecordRefs: readonly RecordRef[];
}

export interface ExpandedEvidenceNode {
  readonly snapshot: RecordSnapshot;
  readonly depth: number;
  readonly successorEdges: readonly SuccessorEdge[];
  readonly predecessorEdges: readonly SuccessorEdge[];
}

export interface ExpandedEvidenceEdge {
  readonly parentRecordRef: RecordRef;
  readonly childRecordRef: RecordRef;
  readonly childPosition: number;
}

export interface EvidenceExpansionResponse {
  readonly nodes: readonly ExpandedEvidenceNode[];
  readonly edges: readonly ExpandedEvidenceEdge[];
  readonly continuation?: EvidenceExpansionContinuation;
}

function eligibleSuccessorEdges(
  edges: readonly SuccessorEdge[],
  eligible: ReadonlySet<RecordRef>,
): SuccessorEdge[] {
  return edges.filter(
    (edge) =>
      eligible.has(edge.predecessorRecordRef)
      && eligible.has(edge.successorRecordRef),
  );
}

/**
 * Expand dependency evidence in stored child order. A continuation carries only
 * opaque eligible references and traversal position; callers may request a
 * deeper maxDepth on a later root expansion.
 */
export function expandHierarchyEvidence(input: {
  readonly rootRecordRef: RecordRef;
  readonly eligibleRecordRefs: readonly RecordRef[];
  readonly repository: InMemoryHierarchyRepository;
  readonly maxDepth?: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly continuation?: EvidenceExpansionContinuation;
}): EvidenceExpansionResponse {
  assertPositiveInteger("maxNodes", input.maxNodes);
  assertPositiveInteger("maxEdges", input.maxEdges);
  const eligible = validateEligibleView(input.repository, input.eligibleRecordRefs);
  if (!eligible.has(input.rootRecordRef)) {
    throw new HierarchyError("ineligible_reference", "evidence root is not eligible");
  }
  const maxDepth = input.continuation?.maxDepth ?? input.maxDepth ?? 1;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError("maxDepth must be a non-negative safe integer");
  }
  if (
    input.continuation
    && (
      input.continuation.rootRecordRef !== input.rootRecordRef
      || input.continuation.maxDepth !== maxDepth
    )
  ) {
    throw new TypeError("evidence continuation does not match this expansion");
  }

  const queue = input.continuation
    ? input.continuation.queue.map((entry) => ({ ...entry }))
    : [{ recordRef: input.rootRecordRef, depth: 0 }];
  const visited = new Set(input.continuation?.visitedRecordRefs ?? []);
  const nodes: ExpandedEvidenceNode[] = [];
  const edges: ExpandedEvidenceEdge[] = [];

  while (queue.length > 0) {
    const next = queue.shift()!;
    const resumingChildren = next.nextChildPosition !== undefined;
    if ((!resumingChildren && visited.has(next.recordRef)) || !eligible.has(next.recordRef)) {
      continue;
    }
    const record = input.repository.require(next.recordRef);
    if (!resumingChildren && nodes.length >= input.maxNodes) {
      queue.unshift(next);
      break;
    }
    const visibleChildren = next.depth >= maxDepth
      ? []
      : record.snapshot.childRecordRefs
          .map((childRecordRef, childPosition) => ({ childRecordRef, childPosition }))
          .filter((edge) => eligible.has(edge.childRecordRef));
    const childStart = next.nextChildPosition ?? 0;
    const edgeCapacity = input.maxEdges - edges.length;
    const emittedChildren = visibleChildren.slice(childStart, childStart + edgeCapacity);
    if (!resumingChildren) {
      visited.add(next.recordRef);
      nodes.push({
        snapshot: projectEligibleSnapshot(
          record.snapshot,
          eligible,
          emittedChildren.map((edge) => edge.childRecordRef),
        ),
        depth: next.depth,
        successorEdges: eligibleSuccessorEdges(
          input.repository.successorsOf(next.recordRef),
          eligible,
        ),
        predecessorEdges: eligibleSuccessorEdges(
          input.repository.predecessorsOf(next.recordRef),
          eligible,
        ),
      });
    }
    for (const edge of emittedChildren) {
      edges.push({ parentRecordRef: next.recordRef, ...edge });
      if (!visited.has(edge.childRecordRef)) {
        queue.push({ recordRef: edge.childRecordRef, depth: next.depth + 1 });
      }
    }
    const nextChildPosition = childStart + emittedChildren.length;
    if (nextChildPosition < visibleChildren.length) {
      queue.unshift({
        recordRef: next.recordRef,
        depth: next.depth,
        nextChildPosition,
      });
      break;
    }
  }

  return {
    nodes,
    edges,
    ...(queue.length === 0
      ? {}
      : {
          continuation: {
            rootRecordRef: input.rootRecordRef,
            maxDepth,
            queue,
            visitedRecordRefs: [...visited],
          },
        }),
  };
}
