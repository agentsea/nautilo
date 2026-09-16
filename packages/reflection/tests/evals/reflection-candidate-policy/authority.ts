import type {
  SyntheticInvocationNamespace,
  SyntheticRecord,
} from "./types";

export function invocationCanUseRecord(
  invocation: SyntheticInvocationNamespace,
  record: SyntheticRecord,
): boolean {
  return record.audiencePaths.some((alternative) => {
    if (invocation.includesPublicBoundary && !alternative.includesPublicBoundary) {
      return false;
    }
    const audience = new Set(alternative.humanIds);
    return invocation.humanIds.every((humanId) => audience.has(humanId));
  });
}

export function recordCanEnterCandidatePool(record: SyntheticRecord): boolean {
  return record.sourceKind !== "message"
    && (record.lifecycle === "current" || record.lifecycle === "stale");
}
