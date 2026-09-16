import { describe, expect, test } from "bun:test";
import { compatibilityToFeatureGates } from "../../src/features";

describe("compatibilityToFeatureGates", () => {
  test("maps the compatibility features to the native relay gates", () => {
    expect(compatibilityToFeatureGates({ features: {
      core: true, steer: false, approvals: false, request_user_input: true, collaboration_modes: true,
    } })).toEqual({
      stableConversation: true,
      explicitSteer: false,
      codexApprovals: false,
      requestUserInput: true,
      collaborationMode: true,
    });
  });
});
