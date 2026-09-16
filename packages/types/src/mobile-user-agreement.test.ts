import { describe, expect, test } from "bun:test";

import {
  MOBILE_EXTERNAL_RECIPIENTS,
  MOBILE_USER_AGREEMENT_VERSION,
  MOBILE_USER_AGREEMENT_VERSIONS,
  MOBILE_USER_POLICY_SECTIONS,
  isCurrentMobileUserAgreementState,
} from "./mobile-user-agreement";

describe("Mobile user agreement contract", () => {
  test("keeps the v1 disclosure bounded and complete", () => {
    expect(MOBILE_EXTERNAL_RECIPIENTS.map((recipient) => recipient.name)).toEqual([
      "OpenAI",
      "Anthropic",
      "Google Gemini",
      "xAI",
      "OpenRouter",
      "Fireworks AI",
      "Together AI",
      "Venice AI",
      "Tavily",
      "DuckDuckGo",
      "CloudConvert",
      "ElevenLabs",
      "Groq",
      "Administrator-configured external AI gateways and remote tools",
    ]);
    expect(MOBILE_USER_POLICY_SECTIONS.flatMap((section) => section.bullets ?? []).join(" "))
      .toContain("sexually abusive");
  });

  test("accepts only the complete current version tuple", () => {
    const acceptedAt = "2026-08-27T12:00:00.000Z";
    const current = {
      current: MOBILE_USER_AGREEMENT_VERSIONS,
      accepted: true,
      acceptance: {
        ...MOBILE_USER_AGREEMENT_VERSIONS,
        acceptedAt,
        withdrawnAt: null,
      },
    };
    expect(isCurrentMobileUserAgreementState(current)).toBe(true);
    expect(isCurrentMobileUserAgreementState({ ...current, accepted: false })).toBe(false);
    expect(isCurrentMobileUserAgreementState({
      ...current,
      acceptance: { ...current.acceptance, withdrawnAt: acceptedAt },
    })).toBe(false);
    expect(isCurrentMobileUserAgreementState({
      ...current,
      current: { ...current.current, agreementVersion: `${MOBILE_USER_AGREEMENT_VERSION}-new` },
    })).toBe(false);
  });
});
