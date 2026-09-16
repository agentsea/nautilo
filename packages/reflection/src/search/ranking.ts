import type { RecordRef } from "../contracts/hierarchy";
import { RECORD_SEARCH_POLICY_V1 } from "./policy";
import {
  assertOpaqueCommitment,
  assertPortableRecordSearchIdentifier,
  assertPositiveSafeInteger,
  strictUtf8ByteLength,
} from "./validation";

export interface RankedRecordCoordinate {
  readonly recordRef: RecordRef;
  readonly score: number;
  readonly structuralHeight: number;
  readonly recordProcessingGeneration: number;
  readonly projectionGeneration: number;
  readonly payloadRepresentationGeneration: number;
  readonly authorityProjectionGeneration: number;
}

export interface EligibleHierarchyCoordinatePort {
  /** Returns one bounded page of direct currently eligible children. */
  childrenOf(input: EligibleHierarchyChildrenRequest): Promise<EligibleHierarchyChildrenPage>;
  /** Exact current authority eligibility for result and intermediate coordinates. */
  isEligible(recordRef: RecordRef): Promise<boolean>;
}

export interface EligibleHierarchyChildrenRequest {
  readonly recordRef: RecordRef;
  readonly limit: number;
  readonly continuation?: string;
}

export interface EligibleHierarchyChildrenPage {
  readonly recordRefs: readonly RecordRef[];
  readonly continuation?: string;
}

export interface RecordChildPageCheckpoint {
  readonly recordRef: RecordRef;
  readonly continuation?: string;
}

export interface RedundancyPathState {
  readonly fromRecordRef: RecordRef;
  readonly targetRecordRef: RecordRef;
  readonly pendingRecordRefs: readonly RecordRef[];
  readonly visitedRecordRefs: readonly RecordRef[];
  readonly pendingChildPages: readonly RecordChildPageCheckpoint[];
  readonly readChildPages: readonly RecordChildPageCheckpoint[];
}

export interface RecordRedundancyContinuationStateV1 {
  readonly policyVersion: typeof RECORD_SEARCH_POLICY_V1.policyVersion;
  readonly rankCommitment: string;
  readonly resumeKind: "next_rank_page" | "traversal";
  readonly rankPageCommitment: string;
  readonly lastProcessedCoordinate?: RankedRecordCoordinate;
  readonly nextCandidateIndex: number;
  readonly retained: readonly RankedRecordCoordinate[];
  readonly comparisonIndex: number;
  readonly direction: "retained_to_candidate" | "candidate_to_retained";
  readonly redundancySuppressedCount: number;
  readonly cumulativeVisitedCoordinates: number;
  readonly path?: RedundancyPathState;
}

export interface RecordRedundancyResult {
  /** Finalized non-redundant prefix accumulated so far. */
  readonly results: readonly RankedRecordCoordinate[];
  readonly redundancySuppressedCount: number;
  /** Work used by this invocation. */
  readonly visitedCoordinates: number;
  /** Work accumulated across an internal search-page continuation chain. */
  readonly cumulativeVisitedCoordinates: number;
  readonly continuation?: RecordRedundancyContinuationStateV1;
}

/**
 * Starts a new external call after the bridge authenticates/unseals a prior
 * checkpoint. Internal rank-page loops must use the continuation unchanged so
 * their total visited-coordinate work remains bounded by one call budget.
 */
export function resetRecordRedundancyCallBudget(
  continuation: RecordRedundancyContinuationStateV1,
): RecordRedundancyContinuationStateV1 {
  return Object.freeze({ ...continuation, cumulativeVisitedCoordinates: 0 });
}

export function canonicalizeCosineScore(score: number): number {
  if (!Number.isFinite(score)) throw new TypeError("Record cosine score must be finite");
  const tolerance = RECORD_SEARCH_POLICY_V1.cosineScoreTolerance;
  if (score < -1 - tolerance || score > 1 + tolerance) {
    throw new RangeError("Record cosine score lies outside the V1 range");
  }
  return Math.fround(Math.min(1, Math.max(-1, score)));
}

export function assertRankedRecordCoordinate(coordinate: RankedRecordCoordinate): void {
  assertPortableRecordSearchIdentifier("ranked Record reference", coordinate.recordRef);
  canonicalizeCosineScore(coordinate.score);
  if (!Number.isSafeInteger(coordinate.structuralHeight) || coordinate.structuralHeight < 0) {
    throw new RangeError("Record structural height must be a non-negative safe integer");
  }
  for (const [label, value] of [
    ["Record processing generation", coordinate.recordProcessingGeneration],
    ["projection generation", coordinate.projectionGeneration],
    ["payload representation generation", coordinate.payloadRepresentationGeneration],
    ["authority projection generation", coordinate.authorityProjectionGeneration],
  ] as const) assertPositiveSafeInteger(label, value);
}

export function compareRecordSearchRanks(
  left: RankedRecordCoordinate,
  right: RankedRecordCoordinate,
): number {
  const scoreOrder = canonicalizeCosineScore(right.score) - canonicalizeCosineScore(left.score);
  return scoreOrder
    || right.structuralHeight - left.structuralHeight
    || left.recordRef.localeCompare(right.recordRef);
}

export function rankRecordSearchCoordinates(
  coordinates: readonly RankedRecordCoordinate[],
): readonly RankedRecordCoordinate[] {
  const seen = new Set<RecordRef>();
  const canonical = coordinates.map((coordinate) => {
    assertRankedRecordCoordinate(coordinate);
    if (seen.has(coordinate.recordRef)) {
      throw new TypeError("ranked Record coordinates contain duplicate references");
    }
    seen.add(coordinate.recordRef);
    return Object.freeze({
      ...coordinate,
      score: canonicalizeCosineScore(coordinate.score),
    });
  });
  return Object.freeze(canonical.sort(compareRecordSearchRanks));
}

function assertSorted(coordinates: readonly RankedRecordCoordinate[]): void {
  for (let index = 0; index < coordinates.length; index += 1) {
    assertRankedRecordCoordinate(coordinates[index]!);
    if (index > 0 && compareRecordSearchRanks(coordinates[index - 1]!, coordinates[index]!) > 0) {
      throw new TypeError("Record coordinates must use stable V1 rank order");
    }
  }
  if (new Set(coordinates.map((entry) => entry.recordRef)).size !== coordinates.length) {
    throw new TypeError("ranked Record coordinates contain duplicate references");
  }
}

async function validatePathState(
  path: RedundancyPathState,
  graph: EligibleHierarchyCoordinatePort,
): Promise<void> {
  for (const ref of [
    path.fromRecordRef,
    path.targetRecordRef,
    ...path.pendingRecordRefs,
    ...path.visitedRecordRefs,
  ]) {
    assertPortableRecordSearchIdentifier("redundancy traversal reference", ref);
    if (!(await graph.isEligible(ref))) {
      throw new TypeError("redundancy continuation contains a hidden reference");
    }
  }
  if (new Set(path.visitedRecordRefs).size !== path.visitedRecordRefs.length) {
    throw new TypeError("redundancy continuation contains duplicate visited references");
  }
  const pageKeys = new Set<string>();
  for (const page of [...path.pendingChildPages, ...path.readChildPages]) {
    assertPortableRecordSearchIdentifier("redundancy child-page Record", page.recordRef);
    if (!(await graph.isEligible(page.recordRef))) {
      throw new TypeError("redundancy continuation contains a hidden child-page reference");
    }
    if (page.continuation !== undefined) {
      const bytes = strictUtf8ByteLength(page.continuation);
      if (
        bytes < 1
        || bytes > RECORD_SEARCH_POLICY_V1.searchContinuationBytesMaximum
      ) throw new RangeError("redundancy child-page continuation is outside the V1 byte contract");
    }
    const key = `${page.recordRef}\u0000${page.continuation ?? ""}`;
    if (pageKeys.has(key)) {
      throw new TypeError("redundancy continuation repeats a child page");
    }
    pageKeys.add(key);
  }
}

async function readEligibleChildPage(input: {
  readonly checkpoint: RecordChildPageCheckpoint;
  readonly graph: EligibleHierarchyCoordinatePort;
  readonly alreadyRead: ReadonlySet<string>;
}): Promise<{
  readonly visibleRecordRefs: readonly RecordRef[];
  readonly next?: RecordChildPageCheckpoint;
}> {
  const key = `${input.checkpoint.recordRef}\u0000${input.checkpoint.continuation ?? ""}`;
  if (input.alreadyRead.has(key)) throw new TypeError("redundancy traversal repeated a child page");
  const page = await input.graph.childrenOf({
    recordRef: input.checkpoint.recordRef,
    limit: RECORD_SEARCH_POLICY_V1.graphPageMaximum,
    ...(input.checkpoint.continuation === undefined
      ? {}
      : { continuation: input.checkpoint.continuation }),
  });
  if (page.recordRefs.length > RECORD_SEARCH_POLICY_V1.graphPageMaximum) {
    throw new RangeError("eligible hierarchy child page exceeds the V1 policy");
  }
  if (page.continuation !== undefined) {
    const bytes = strictUtf8ByteLength(page.continuation);
    if (
      bytes < 1
      || bytes > RECORD_SEARCH_POLICY_V1.searchContinuationBytesMaximum
      || page.continuation === input.checkpoint.continuation
      || page.recordRefs.length === 0
    ) throw new TypeError("eligible hierarchy child page does not make bounded progress");
  }
  const visible: RecordRef[] = [];
  const seen = new Set<RecordRef>();
  for (const childRef of page.recordRefs) {
    assertPortableRecordSearchIdentifier("redundancy child reference", childRef);
    if (seen.has(childRef)) throw new TypeError("eligible hierarchy child page contains duplicates");
    seen.add(childRef);
    if (await input.graph.isEligible(childRef)) visible.push(childRef);
  }
  return {
    visibleRecordRefs: visible,
    ...(page.continuation === undefined
      ? {}
      : {
          next: {
            recordRef: input.checkpoint.recordRef,
            continuation: page.continuation,
          },
        }),
  };
}

export async function assertRecordRedundancyContinuationStateV1(
  continuation: RecordRedundancyContinuationStateV1,
  rankedCoordinates: readonly RankedRecordCoordinate[],
  rankCommitment: string,
  rankPageCommitment: string,
  graph: EligibleHierarchyCoordinatePort,
): Promise<void> {
  assertOpaqueCommitment("rank commitment", continuation.rankCommitment);
  assertOpaqueCommitment("rank page commitment", continuation.rankPageCommitment);
  assertOpaqueCommitment("current rank page commitment", rankPageCommitment);
  if (
    continuation.policyVersion !== RECORD_SEARCH_POLICY_V1.policyVersion
    || continuation.rankCommitment !== rankCommitment
  ) throw new TypeError("redundancy continuation is stale or mismatched");
  if (
    continuation.resumeKind !== "next_rank_page"
    && continuation.resumeKind !== "traversal"
  ) throw new TypeError("redundancy continuation kind is invalid");
  if (
    continuation.resumeKind === "traversal"
    && continuation.rankPageCommitment !== rankPageCommitment
  ) throw new TypeError("redundancy traversal continuation changed rank pages");
  if (
    !Number.isSafeInteger(continuation.nextCandidateIndex)
    || continuation.nextCandidateIndex < 0
    || continuation.nextCandidateIndex > rankedCoordinates.length
    || !Number.isSafeInteger(continuation.comparisonIndex)
    || continuation.comparisonIndex < 0
    || continuation.comparisonIndex > continuation.retained.length
  ) throw new RangeError("redundancy continuation position is invalid");
  for (const retained of continuation.retained) {
    assertRankedRecordCoordinate(retained);
    if (!(await graph.isEligible(retained.recordRef))) {
      throw new TypeError("redundancy continuation contains a hidden reference");
    }
  }
  if (new Set(continuation.retained.map((entry) => entry.recordRef)).size !== continuation.retained.length) {
    throw new TypeError("redundancy continuation retained duplicate references");
  }
  if (
    !Number.isSafeInteger(continuation.redundancySuppressedCount)
    || continuation.redundancySuppressedCount < 0
    || !Number.isSafeInteger(continuation.cumulativeVisitedCoordinates)
    || continuation.cumulativeVisitedCoordinates < 0
    || continuation.retained.some((entry, index, retained) =>
      index > 0
      && compareRecordSearchRanks(retained[index - 1]!, entry) > 0
    )
  ) throw new RangeError("redundancy continuation summary is invalid");
  if (continuation.lastProcessedCoordinate !== undefined) {
    assertRankedRecordCoordinate(continuation.lastProcessedCoordinate);
  }
  if (continuation.resumeKind === "next_rank_page") {
    if (
      continuation.path !== undefined
      || continuation.nextCandidateIndex !== 0
      || continuation.comparisonIndex !== 0
      || continuation.direction !== "retained_to_candidate"
      || continuation.lastProcessedCoordinate === undefined
    ) throw new TypeError("next-rank-page continuation is malformed");
    const first = rankedCoordinates[0];
    if (
      first !== undefined
      && compareRecordSearchRanks(continuation.lastProcessedCoordinate, first) >= 0
    ) throw new TypeError("next rank page does not start after the last processed coordinate");
  }
  if (continuation.path) {
    const candidate = rankedCoordinates[continuation.nextCandidateIndex];
    const selected = continuation.retained[continuation.comparisonIndex];
    if (candidate === undefined || selected === undefined) {
      throw new RangeError("redundancy continuation path position is invalid");
    }
    const expectedFrom = continuation.direction === "retained_to_candidate"
      ? selected.recordRef
      : candidate.recordRef;
    const expectedTarget = continuation.direction === "retained_to_candidate"
      ? candidate.recordRef
      : selected.recordRef;
    if (
      continuation.path.fromRecordRef !== expectedFrom
      || continuation.path.targetRecordRef !== expectedTarget
    ) throw new TypeError("redundancy continuation path is mismatched");
  }
  if (continuation.path) await validatePathState(continuation.path, graph);
}

async function continuePath(input: {
  readonly path: RedundancyPathState;
  readonly graph: EligibleHierarchyCoordinatePort;
  readonly remainingWork: number;
}): Promise<{
  readonly found: boolean;
  readonly complete: boolean;
  readonly work: number;
  readonly path: RedundancyPathState;
}> {
  const pending = [...input.path.pendingRecordRefs];
  const visited = new Set(input.path.visitedRecordRefs);
  const pendingChildPages = [...input.path.pendingChildPages];
  const readChildPages = [...input.path.readChildPages];
  const readChildPageKeys = new Set(readChildPages.map(
    (page) => `${page.recordRef}\u0000${page.continuation ?? ""}`,
  ));
  let work = 0;
  while ((pending.length > 0 || pendingChildPages.length > 0) && work < input.remainingWork) {
    if (pending.length === 0) {
      const checkpoint = pendingChildPages.pop()!;
      const page = await readEligibleChildPage({
        checkpoint,
        graph: input.graph,
        alreadyRead: readChildPageKeys,
      });
      if (checkpoint.continuation !== undefined) {
        readChildPages.push(checkpoint);
        readChildPageKeys.add(`${checkpoint.recordRef}\u0000${checkpoint.continuation}`);
      }
      if (page.next) pendingChildPages.push(page.next);
      for (let index = page.visibleRecordRefs.length - 1; index >= 0; index -= 1) {
        const childRef = page.visibleRecordRefs[index]!;
        if (!visited.has(childRef)) pending.push(childRef);
      }
      continue;
    }
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    if (!(await input.graph.isEligible(current))) {
      throw new TypeError("redundancy traversal encountered a hidden reference");
    }
    visited.add(current);
    work += 1;
    if (current === input.path.targetRecordRef) {
      return {
        found: true,
        complete: true,
        work,
        path: {
          ...input.path,
          pendingRecordRefs: [],
          visitedRecordRefs: [...visited],
          pendingChildPages: [],
          readChildPages,
        },
      };
    }
    const checkpoint = { recordRef: current } as const;
    const page = await readEligibleChildPage({
      checkpoint,
      graph: input.graph,
      alreadyRead: readChildPageKeys,
    });
    if (page.next) pendingChildPages.push(page.next);
    for (let index = page.visibleRecordRefs.length - 1; index >= 0; index -= 1) {
      const childRef = page.visibleRecordRefs[index]!;
      if (!visited.has(childRef)) pending.push(childRef);
    }
  }
  return {
    found: false,
    complete: pending.length === 0 && pendingChildPages.length === 0,
    work,
    path: {
      ...input.path,
      pendingRecordRefs: pending,
      visitedRecordRefs: [...visited],
      pendingChildPages,
      readChildPages,
    },
  };
}

/**
 * Retains the earlier (therefore more useful) ranked result when it is an
 * ancestor or descendant of a later result. Traversal sees eligible references
 * only and pauses rather than silently dropping a candidate when work expires.
 */
export async function suppressRedundantHierarchyResults(input: {
  readonly rankedCoordinates: readonly RankedRecordCoordinate[];
  readonly graph: EligibleHierarchyCoordinatePort;
  readonly resultLimit: number;
  readonly traversalWorkLimit: number;
  readonly rankCommitment: string;
  readonly rankPageCommitment: string;
  readonly hasMoreRankedCoordinates: boolean;
  readonly continuation?: RecordRedundancyContinuationStateV1;
}): Promise<RecordRedundancyResult> {
  assertSorted(input.rankedCoordinates);
  assertOpaqueCommitment("rank commitment", input.rankCommitment);
  assertOpaqueCommitment("rank page commitment", input.rankPageCommitment);
  if (typeof input.hasMoreRankedCoordinates !== "boolean") {
    throw new TypeError("rank-page availability must be explicit");
  }
  if (
    !Number.isSafeInteger(input.resultLimit)
    || input.resultLimit < RECORD_SEARCH_POLICY_V1.resultPageMinimum
    || input.resultLimit > RECORD_SEARCH_POLICY_V1.resultPageMaximum
  ) throw new RangeError("result limit is outside the V1 policy");
  if (
    !Number.isSafeInteger(input.traversalWorkLimit)
    || input.traversalWorkLimit < 1
    || input.traversalWorkLimit > RECORD_SEARCH_POLICY_V1.traversalWorkMaximum
  ) throw new RangeError("traversal work limit is outside the V1 policy");
  if (input.continuation) {
    await assertRecordRedundancyContinuationStateV1(
      input.continuation,
      input.rankedCoordinates,
      input.rankCommitment,
      input.rankPageCommitment,
      input.graph,
    );
  }
  const eligible = new Set(input.rankedCoordinates.map((entry) => entry.recordRef));
  for (const recordRef of eligible) {
    if (!(await input.graph.isEligible(recordRef))) {
      throw new TypeError("ranked Record coordinates contain a hidden reference");
    }
  }
  const retained = [...(input.continuation?.retained ?? [])];
  const traversalContinuation = input.continuation?.resumeKind === "traversal"
    ? input.continuation
    : undefined;
  let candidateIndex = traversalContinuation?.nextCandidateIndex ?? 0;
  let comparisonIndex = traversalContinuation?.comparisonIndex ?? 0;
  let direction = traversalContinuation?.direction ?? "retained_to_candidate";
  let path = traversalContinuation?.path;
  let work = 0;
  let suppressed = input.continuation?.redundancySuppressedCount ?? 0;
  const priorCumulativeWork = input.continuation?.cumulativeVisitedCoordinates ?? 0;
  if (priorCumulativeWork > input.traversalWorkLimit) {
    throw new RangeError("redundancy continuation exceeds the call traversal budget");
  }

  while (candidateIndex < input.rankedCoordinates.length && retained.length < input.resultLimit) {
    const candidate = input.rankedCoordinates[candidateIndex]!;
    if (comparisonIndex >= retained.length) {
      retained.push(candidate);
      candidateIndex += 1;
      comparisonIndex = 0;
      direction = "retained_to_candidate";
      path = undefined;
      continue;
    }
    const selected = retained[comparisonIndex]!;
    const from = direction === "retained_to_candidate" ? selected.recordRef : candidate.recordRef;
    const target = direction === "retained_to_candidate" ? candidate.recordRef : selected.recordRef;
    path ??= {
      fromRecordRef: from,
      targetRecordRef: target,
      pendingRecordRefs: [from],
      visitedRecordRefs: [],
      pendingChildPages: [],
      readChildPages: [],
    };
    const outcome = await continuePath({
      path,
      graph: input.graph,
      remainingWork: input.traversalWorkLimit - priorCumulativeWork - work,
    });
    work += outcome.work;
    path = outcome.path;
    if (outcome.found) {
      suppressed += 1;
      candidateIndex += 1;
      comparisonIndex = 0;
      direction = "retained_to_candidate";
      path = undefined;
      continue;
    }
    if (!outcome.complete) break;
    path = undefined;
    if (direction === "retained_to_candidate") {
      direction = "candidate_to_retained";
    } else {
      direction = "retained_to_candidate";
      comparisonIndex += 1;
    }
  }

  const pausedTraversal = candidateIndex < input.rankedCoordinates.length
    && retained.length < input.resultLimit;
  const needsNextRankPage = !pausedTraversal
    && retained.length < input.resultLimit
    && input.hasMoreRankedCoordinates;
  let continuation: RecordRedundancyContinuationStateV1 | undefined;
  if (pausedTraversal) {
    continuation = {
        policyVersion: RECORD_SEARCH_POLICY_V1.policyVersion,
        rankCommitment: input.rankCommitment,
        resumeKind: "traversal",
        rankPageCommitment: input.rankPageCommitment,
        ...(input.continuation?.lastProcessedCoordinate === undefined
          ? {}
          : { lastProcessedCoordinate: input.continuation.lastProcessedCoordinate }),
        nextCandidateIndex: candidateIndex,
        retained: retained.map((entry) => ({ ...entry })),
        comparisonIndex,
        direction,
        redundancySuppressedCount: suppressed,
        cumulativeVisitedCoordinates: priorCumulativeWork + work,
        ...(path === undefined ? {} : { path }),
    };
  } else if (needsNextRankPage) {
    const lastProcessedCoordinate = input.rankedCoordinates.at(-1);
    if (lastProcessedCoordinate === undefined) {
      throw new TypeError("an empty rank page cannot claim more ranked coordinates");
    }
    continuation = {
      policyVersion: RECORD_SEARCH_POLICY_V1.policyVersion,
      rankCommitment: input.rankCommitment,
      resumeKind: "next_rank_page",
      rankPageCommitment: input.rankPageCommitment,
      lastProcessedCoordinate,
      nextCandidateIndex: 0,
      retained: retained.map((entry) => ({ ...entry })),
      comparisonIndex: 0,
      direction: "retained_to_candidate",
      redundancySuppressedCount: suppressed,
      cumulativeVisitedCoordinates: priorCumulativeWork + work,
    };
  }
  return {
    results: Object.freeze(retained.map((entry) => Object.freeze({ ...entry }))),
    redundancySuppressedCount: suppressed,
    visitedCoordinates: work,
    cumulativeVisitedCoordinates: priorCumulativeWork + work,
    ...(continuation === undefined ? {} : { continuation }),
  };
}
