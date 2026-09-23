export type IdentityReconciliationDecision = {
  nextScope: string | null;
  shouldReconcile: boolean;
};

export function decideIdentityReconciliation(
  reconciledScope: string | null,
  verifiedScope: string | null,
): IdentityReconciliationDecision {
  if (verifiedScope == null) {
    return { nextScope: null, shouldReconcile: false };
  }
  return {
    nextScope: verifiedScope,
    shouldReconcile: reconciledScope !== verifiedScope,
  };
}
