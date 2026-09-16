import type { AuthRouteDeps } from "../../src/routes/auth";

// HTTP/approval tests own transport and dispatch; policy persistence has
// separate integration coverage. Keep both policy seams explicitly in memory.
export const fallbackResumePolicy: Required<Pick<
  AuthRouteDeps,
  "strictShadowPolicyReader" | "strictShadowBoundaryEnforcer"
>> = {
  strictShadowPolicyReader: () => Promise.resolve({
    mode: "shadow_encryption",
    shadowBehavior: "fallback",
    revision: 1,
    shadowEncryptionStartedAt: null,
    updatedAt: new Date(0),
  }),
  strictShadowBoundaryEnforcer: async (input) => ({
    policy: await fallbackResumePolicy.strictShadowPolicyReader(),
    result: {
      disposition: "ordinary",
      decision: {
        boundaryId: input.boundaryId,
        family: "checkpoint",
        operation: "write",
        actorClass: "agent",
        state: input.state,
        reason: input.reason,
        retryable: input.retryable,
        policyRevision: 1,
      },
    },
  }),
};
