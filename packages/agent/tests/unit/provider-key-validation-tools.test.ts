import { describe, expect, mock, test } from "bun:test";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import { createCheckConfigTool } from "../../src/tools/config/check-config";
import { createOnboardingStatusTool } from "../../src/tools/config/onboarding-status";

const checkResult = {
  keys: [],
  modes: [],
  summary: {
    total: 0,
    configured: 0,
    verified: 0,
    missing: 0,
    invalid: 0,
    hasLlm: false,
    hasEmbeddings: false,
    hasVoice: false,
    hasSearch: false,
    hasConversion: false,
  },
};

describe("provider key validation tool funding", () => {
  test("check_config rejects before live provider validation without causal Human funding", async () => {
    const check = mock(async () => checkResult);
    const tool = createCheckConfigTool(
      { causalHumanUserId: "community-human" },
      {
        check,
        assertServerFunding: async (humanUserId, origin) => {
          expect(humanUserId).toBe("community-human");
          expect(origin).toBe("provider_key_health_validation");
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      },
    );

    expect(tool.invoke({ validate: true })).rejects.toThrow(
      "server_provider_credentials_required",
    );
    expect(check).not.toHaveBeenCalled();
  });

  test("onboarding_status rejects live validation before any provider call", async () => {
    const check = mock(async () => checkResult);
    const tool = createOnboardingStatusTool(
      { ownerId: "community-human", causalHumanUserId: "community-human" },
      {
        check,
        assertServerFunding: async (humanUserId, origin) => {
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      },
    );

    expect(await tool.invoke({ include_key_health: true })).toContain(
      "server_provider_credentials_required",
    );
    expect(check).not.toHaveBeenCalled();
  });
});
