import type { CompatibilityResult } from "./compatibility-contract";

export interface CodexFeatureGates {
  readonly stableConversation: boolean;
  readonly explicitSteer: boolean;
  readonly codexApprovals: boolean;
  readonly requestUserInput: boolean;
  /** Experimental generated turn setting; false means Plan is unavailable. */
  readonly collaborationMode: boolean;
}

export function compatibilityToFeatureGates(
  compatibility: Pick<CompatibilityResult, "features">,
): CodexFeatureGates {
  const { features } = compatibility;
  return Object.freeze({
    stableConversation: features.core,
    explicitSteer: features.steer,
    codexApprovals: features.approvals,
    requestUserInput: features.request_user_input,
    collaborationMode: features.collaboration_modes,
  });
}
