import { describe, expect, test } from "bun:test";
import { shouldIgnoreCredentialOnlyTransition } from "../../src/lib/auth-transition";

describe("PostureProvider auth listener contract (M214)", () => {
  test("credential-only refresh for the same viewer generation is ignored", () => {
    const lastProcessed = 5;
    const detail = {
      credentialGeneration: 9,
      viewerGeneration: 5,
      reason: "credential-refreshed" as const,
    };
    expect(shouldIgnoreCredentialOnlyTransition(lastProcessed, detail)).toBe(true);
  });

  test("viewer generation change always refreshes posture", () => {
    expect(
      shouldIgnoreCredentialOnlyTransition(5, {
        credentialGeneration: 9,
        viewerGeneration: 6,
        reason: "user-switched",
      }),
    ).toBe(false);
  });
});
