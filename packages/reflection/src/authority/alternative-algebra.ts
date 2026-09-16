import type {
  AuthorityAlgebraBudget,
  AuthorityAlgebraMetrics,
  AuthorityAlgebraResult,
  AuthorityLeafAlternatives,
  AuthorityRepresentationDisposition,
  EffectiveAudienceAlternative,
} from "../contracts/authority";
import { AuthorityAlgebraError } from "../contracts/authority";

export const AUTHORITY_ALGEBRA_CHECKPOINT_VERSION = 1;
export const AUTHORITY_REPRESENTATION_ALTERNATIVE_LIMIT = 256;

interface MutableMetrics {
  inputLeafCount: number;
  inputAlternativeCount: number;
  normalizedLeafAlternativeCount: number;
  intermediatePeakAlternativeCount: number;
  finalAlternativeCount: number;
  dominancePrunedCount: number;
  emptyIntersectionCount: number;
  operations: number;
  checkpointBytes: number;
}

interface NormalizingState {
  readonly stage: "normalizing";
  leafIndex: number;
  alternativeIndex: number;
  normalizedLeaves: EffectiveAudienceAlternative[][];
}

interface CombiningState {
  readonly stage: "combining";
  normalizedLeaves: EffectiveAudienceAlternative[][];
  combineLeafIndex: number;
  leftIndex: number;
  rightIndex: number;
  current: EffectiveAudienceAlternative[];
  next: EffectiveAudienceAlternative[];
}

interface CheckpointV1 {
  readonly version: typeof AUTHORITY_ALGEBRA_CHECKPOINT_VERSION;
  /** Exact canonical input identity; collision-free checkpoint binding. */
  readonly inputIdentity: string;
  readonly metrics: MutableMetrics;
  state: NormalizingState | CombiningState;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAlternatives(
  a: EffectiveAudienceAlternative,
  b: EffectiveAudienceAlternative,
): number {
  const humanComparison = compareStrings(a.humanRefs.join("\u0000"), b.humanRefs.join("\u0000"));
  if (humanComparison !== 0) return humanComparison;
  return Number(a.includesPublicBoundary) - Number(b.includesPublicBoundary);
}

function canonicalizeAlternative(
  alternative: EffectiveAudienceAlternative,
): EffectiveAudienceAlternative {
  if (typeof alternative.includesPublicBoundary !== "boolean") {
    throw new AuthorityAlgebraError(
      "invalid_input",
      "authority alternative requires a public-boundary boolean",
    );
  }
  const humanRefs = [...alternative.humanRefs];
  if (humanRefs.length === 0) {
    return { humanRefs: [], includesPublicBoundary: alternative.includesPublicBoundary };
  }
  if (humanRefs.some((humanRef) => typeof humanRef !== "string" || humanRef.length === 0)) {
    throw new AuthorityAlgebraError(
      "invalid_input",
      "authority alternative contains an invalid Human reference",
    );
  }
  humanRefs.sort(compareStrings);
  for (let index = 1; index < humanRefs.length; index += 1) {
    if (humanRefs[index] === humanRefs[index - 1]) {
      throw new AuthorityAlgebraError(
        "invalid_input",
        "authority alternative contains a duplicate Human reference",
      );
    }
  }
  return { humanRefs, includesPublicBoundary: alternative.includesPublicBoundary };
}

function isSubset(
  subset: EffectiveAudienceAlternative,
  superset: EffectiveAudienceAlternative,
): boolean {
  if (subset.includesPublicBoundary && !superset.includesPublicBoundary) return false;
  let supersetIndex = 0;
  for (const humanRef of subset.humanRefs) {
    while (
      supersetIndex < superset.humanRefs.length
      && compareStrings(superset.humanRefs[supersetIndex] ?? "", humanRef) < 0
    ) {
      supersetIndex += 1;
    }
    if (superset.humanRefs[supersetIndex] !== humanRef) return false;
    supersetIndex += 1;
  }
  return true;
}

function insertMaximal(
  antichain: EffectiveAudienceAlternative[],
  candidate: EffectiveAudienceAlternative,
  metrics: MutableMetrics,
): void {
  for (const existing of antichain) {
    if (isSubset(candidate, existing)) {
      metrics.dominancePrunedCount += 1;
      return;
    }
  }
  const retained = antichain.filter((existing) => {
    const dominated = isSubset(existing, candidate);
    if (dominated) metrics.dominancePrunedCount += 1;
    return !dominated;
  });
  retained.push(candidate);
  retained.sort(compareAlternatives);
  antichain.splice(0, antichain.length, ...retained);
}

function intersectAlternatives(
  left: EffectiveAudienceAlternative,
  right: EffectiveAudienceAlternative,
): EffectiveAudienceAlternative {
  const rightHumans = new Set(right.humanRefs);
  return {
    humanRefs: left.humanRefs.filter((humanRef) => rightHumans.has(humanRef)),
    includesPublicBoundary:
      left.includesPublicBoundary && right.includesPublicBoundary,
  };
}

function canonicalInput(leaves: readonly AuthorityLeafAlternatives[]): string {
  return JSON.stringify(leaves.map((leaf) => ({
    terminalAuthorityLeafHandle: leaf.terminalAuthorityLeafHandle,
    alternatives: leaf.alternatives.map((alternative) => ({
      humanRefs: [...alternative.humanRefs],
      includesPublicBoundary: alternative.includesPublicBoundary,
    })),
  })));
}

function assertInput(leaves: readonly AuthorityLeafAlternatives[]): void {
  const handles = new Set<string>();
  for (const leaf of leaves) {
    if (
      typeof leaf.terminalAuthorityLeafHandle !== "string"
      || leaf.terminalAuthorityLeafHandle.length === 0
    ) {
      throw new AuthorityAlgebraError(
        "invalid_input",
        "authority leaf requires an opaque non-empty handle",
      );
    }
    if (handles.has(leaf.terminalAuthorityLeafHandle)) {
      throw new AuthorityAlgebraError(
        "invalid_input",
        "authority input contains a duplicate terminal leaf handle",
      );
    }
    handles.add(leaf.terminalAuthorityLeafHandle);
  }
}

function createCheckpoint(leaves: readonly AuthorityLeafAlternatives[]): CheckpointV1 {
  const inputAlternativeCount = leaves.reduce(
    (total, leaf) => total + leaf.alternatives.length,
    0,
  );
  return {
    version: AUTHORITY_ALGEBRA_CHECKPOINT_VERSION,
    inputIdentity: canonicalInput(leaves),
    metrics: {
      inputLeafCount: leaves.length,
      inputAlternativeCount,
      normalizedLeafAlternativeCount: 0,
      intermediatePeakAlternativeCount: 0,
      finalAlternativeCount: 0,
      dominancePrunedCount: 0,
      emptyIntersectionCount: 0,
      operations: 0,
      checkpointBytes: 0,
    },
    state: {
      stage: "normalizing",
      leafIndex: 0,
      alternativeIndex: 0,
      normalizedLeaves: leaves.map(() => []),
    },
  };
}

function parseCheckpoint(
  continuation: string,
  leaves: readonly AuthorityLeafAlternatives[],
): CheckpointV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(continuation);
  } catch {
    throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("version" in parsed)
    || parsed.version !== AUTHORITY_ALGEBRA_CHECKPOINT_VERSION
    || !("inputIdentity" in parsed)
    || typeof parsed.inputIdentity !== "string"
    || !("metrics" in parsed)
    || !("state" in parsed)
  ) {
    throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
  }
  if (parsed.inputIdentity !== canonicalInput(leaves)) {
    throw new AuthorityAlgebraError(
      "checkpoint_mismatch",
      "authority checkpoint does not match the supplied input",
    );
  }
  const checkpoint = parsed as CheckpointV1;
  const metrics = checkpoint.metrics;
  const metricValues = metrics === undefined ? [] : Object.values(metrics);
  const state = checkpoint.state;
  const validAlternatives = (value: unknown): value is EffectiveAudienceAlternative[] =>
    Array.isArray(value) && value.every((entry) => {
      try {
        return JSON.stringify(canonicalizeAlternative(entry as EffectiveAudienceAlternative))
          === JSON.stringify(entry);
      } catch {
        return false;
      }
    });
  const validLeaves = (value: unknown): value is EffectiveAudienceAlternative[][] =>
    Array.isArray(value) && value.every(validAlternatives);
  const validInteger = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  const commonValid = metrics !== undefined
    && metricValues.length === 9
    && metricValues.every(validInteger)
    && state !== undefined
    && typeof state === "object";
  const stateValid = commonValid && (
    (state.stage === "normalizing"
      && validInteger(state.leafIndex)
      && validInteger(state.alternativeIndex)
      && validLeaves(state.normalizedLeaves))
    || (state.stage === "combining"
      && validLeaves(state.normalizedLeaves)
      && validInteger(state.combineLeafIndex)
      && validInteger(state.leftIndex)
      && validInteger(state.rightIndex)
      && validAlternatives(state.current)
      && validAlternatives(state.next))
  );
  if (!stateValid) {
    throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
  }
  return checkpoint;
}

function metricsSnapshot(metrics: MutableMetrics): AuthorityAlgebraMetrics {
  return { ...metrics };
}

function completeUnavailable(
  checkpoint: CheckpointV1,
  reason: "no_authority_leaves" | "no_effective_audience",
): AuthorityAlgebraResult {
  checkpoint.metrics.finalAlternativeCount = 0;
  checkpoint.metrics.checkpointBytes = 0;
  return {
    status: "complete",
    outcome: { kind: "unavailable", reason },
    metrics: metricsSnapshot(checkpoint.metrics),
  };
}

function completeAvailable(
  checkpoint: CheckpointV1,
  alternatives: EffectiveAudienceAlternative[],
): AuthorityAlgebraResult {
  checkpoint.metrics.finalAlternativeCount = alternatives.length;
  checkpoint.metrics.checkpointBytes = 0;
  return {
    status: "complete",
    outcome: { kind: "available", alternatives },
    metrics: metricsSnapshot(checkpoint.metrics),
  };
}

function pause(checkpoint: CheckpointV1): AuthorityAlgebraResult {
  checkpoint.metrics.normalizedLeafAlternativeCount = checkpoint.state.normalizedLeaves.reduce(
    (total, alternatives) => total + alternatives.length,
    0,
  );
  let continuation = JSON.stringify(checkpoint);
  for (;;) {
    const checkpointBytes = new TextEncoder().encode(continuation).byteLength;
    if (checkpoint.metrics.checkpointBytes === checkpointBytes) break;
    checkpoint.metrics.checkpointBytes = checkpointBytes;
    continuation = JSON.stringify(checkpoint);
  }
  return {
    status: "paused",
    continuation,
    metrics: metricsSnapshot(checkpoint.metrics),
  };
}

function transitionToCombining(checkpoint: CheckpointV1): AuthorityAlgebraResult | undefined {
  const state = checkpoint.state;
  if (state.stage !== "normalizing") return undefined;
  checkpoint.metrics.normalizedLeafAlternativeCount = state.normalizedLeaves.reduce(
    (total, alternatives) => total + alternatives.length,
    0,
  );
  if (state.normalizedLeaves.length === 0) {
    return completeUnavailable(checkpoint, "no_authority_leaves");
  }
  if (state.normalizedLeaves.some((alternatives) => alternatives.length === 0)) {
    return completeUnavailable(checkpoint, "no_effective_audience");
  }
  const current = [...(state.normalizedLeaves[0] ?? [])];
  checkpoint.metrics.intermediatePeakAlternativeCount = Math.max(
    checkpoint.metrics.intermediatePeakAlternativeCount,
    current.length,
  );
  if (state.normalizedLeaves.length === 1) return completeAvailable(checkpoint, current);
  checkpoint.state = {
    stage: "combining",
    normalizedLeaves: state.normalizedLeaves,
    combineLeafIndex: 1,
    leftIndex: 0,
    rightIndex: 0,
    current,
    next: [],
  };
  return undefined;
}

/**
 * Computes the exact maximal alternative antichain. A budget exhaustion returns
 * a continuation; it never returns a prefix as a completed authority result.
 */
export function advanceAuthorityAlternatives(input: {
  readonly leaves: readonly AuthorityLeafAlternatives[];
  readonly budget: AuthorityAlgebraBudget;
  readonly continuation?: string;
}): AuthorityAlgebraResult {
  if (!Number.isSafeInteger(input.budget.maxOperations) || input.budget.maxOperations < 1) {
    throw new AuthorityAlgebraError(
      "invalid_budget",
      "authority algebra budget requires at least one operation",
    );
  }
  assertInput(input.leaves);
  const checkpoint = input.continuation === undefined
    ? createCheckpoint(input.leaves)
    : parseCheckpoint(input.continuation, input.leaves);
  const operationLimit = checkpoint.metrics.operations + input.budget.maxOperations;

  while (checkpoint.metrics.operations < operationLimit) {
    const state = checkpoint.state;
    if (state.stage === "normalizing") {
      if (state.leafIndex >= input.leaves.length) {
        const completed = transitionToCombining(checkpoint);
        if (completed !== undefined) return completed;
        continue;
      }
      const leaf = input.leaves[state.leafIndex];
      if (leaf === undefined) {
        throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
      }
      if (state.alternativeIndex >= leaf.alternatives.length) {
        state.leafIndex += 1;
        state.alternativeIndex = 0;
        continue;
      }
      const rawAlternative = leaf.alternatives[state.alternativeIndex];
      if (rawAlternative === undefined) {
        throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
      }
      const alternative = canonicalizeAlternative(rawAlternative);
      if (alternative.humanRefs.length === 0) {
        checkpoint.metrics.emptyIntersectionCount += 1;
      } else {
        const antichain = state.normalizedLeaves[state.leafIndex];
        if (antichain === undefined) {
          throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
        }
        insertMaximal(antichain, alternative, checkpoint.metrics);
      }
      state.alternativeIndex += 1;
      checkpoint.metrics.operations += 1;
      continue;
    }

    const rightAlternatives = state.normalizedLeaves[state.combineLeafIndex];
    if (rightAlternatives === undefined) {
      return state.current.length === 0
        ? completeUnavailable(checkpoint, "no_effective_audience")
        : completeAvailable(checkpoint, state.current);
    }
    if (state.leftIndex >= state.current.length) {
      state.current = state.next;
      state.next = [];
      state.combineLeafIndex += 1;
      state.leftIndex = 0;
      state.rightIndex = 0;
      checkpoint.metrics.intermediatePeakAlternativeCount = Math.max(
        checkpoint.metrics.intermediatePeakAlternativeCount,
        state.current.length,
      );
      if (state.current.length === 0) {
        return completeUnavailable(checkpoint, "no_effective_audience");
      }
      continue;
    }
    if (state.rightIndex >= rightAlternatives.length) {
      state.leftIndex += 1;
      state.rightIndex = 0;
      continue;
    }
    const left = state.current[state.leftIndex];
    const right = rightAlternatives[state.rightIndex];
    if (left === undefined || right === undefined) {
      throw new AuthorityAlgebraError("invalid_checkpoint", "authority checkpoint is invalid");
    }
    const candidate = intersectAlternatives(left, right);
    if (candidate.humanRefs.length === 0) {
      checkpoint.metrics.emptyIntersectionCount += 1;
    } else {
      insertMaximal(state.next, candidate, checkpoint.metrics);
    }
    state.rightIndex += 1;
    checkpoint.metrics.operations += 1;
  }

  return pause(checkpoint);
}

export function classifyAuthorityRepresentation(
  alternativeCount: number,
): AuthorityRepresentationDisposition {
  if (!Number.isSafeInteger(alternativeCount) || alternativeCount < 0) {
    throw new AuthorityAlgebraError(
      "invalid_input",
      "authority alternative count must be a non-negative safe integer",
    );
  }
  return alternativeCount <= AUTHORITY_REPRESENTATION_ALTERNATIVE_LIMIT
    ? { kind: "representable" }
    : {
        kind: "unavailable",
        reason: "representation_capacity_exceeded",
        measuredAlternativeCount: alternativeCount,
      };
}

export function invocationAudienceIsEligible(
  invocation: EffectiveAudienceAlternative,
  alternatives: readonly EffectiveAudienceAlternative[],
): boolean {
  const normalizedInvocation = canonicalizeAlternative(invocation);
  if (normalizedInvocation.humanRefs.length === 0) return false;
  return alternatives.some((alternative) =>
    isSubset(normalizedInvocation, canonicalizeAlternative(alternative))
  );
}
