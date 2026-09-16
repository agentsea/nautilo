export type CandidatePolicyMode = "same_room" | "cross_room";

export const CANDIDATE_POLICY_V1 = Object.freeze({
  version: "candidate-policy-v1",
  sameRoomBound: 4,
  crossRoomBound: 2,
  semanticMinimumScore: 0.5,
} as const);

export interface ScoredSemanticCandidate<TRecordRef extends string = string> {
  recordRef: TRecordRef;
  score: number;
}

/**
 * Select from candidates that the caller has already proven eligible.
 * Authority and lifecycle filtering must happen before scores reach this
 * function, so rejected Records cannot affect similarity work or diagnostics.
 */
export function selectSemanticNeighbors<TRecordRef extends string>(
  mode: CandidatePolicyMode,
  candidates: readonly ScoredSemanticCandidate<TRecordRef>[],
): readonly ScoredSemanticCandidate<TRecordRef>[] {
  if (new Set(candidates.map((candidate) => candidate.recordRef)).size !== candidates.length) {
    throw new TypeError("semantic candidate references must be unique");
  }
  const bound = mode === "same_room"
    ? CANDIDATE_POLICY_V1.sameRoomBound
    : CANDIDATE_POLICY_V1.crossRoomBound;
  return Object.freeze(
    candidates
      .filter((candidate) =>
        Number.isFinite(candidate.score)
        && candidate.score >= CANDIDATE_POLICY_V1.semanticMinimumScore
      )
      .sort(
        (left, right) =>
          right.score - left.score
          || left.recordRef.localeCompare(right.recordRef),
      )
      .slice(0, bound)
      .map((candidate) => Object.freeze({ ...candidate })),
  );
}
