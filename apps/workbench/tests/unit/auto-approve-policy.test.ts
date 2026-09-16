import { describe, expect, test } from "bun:test";
import { shouldAutoResolveAsk } from "@nautilo/types";

describe("shouldAutoResolveAsk (D375 Auto-Approve boundary)", () => {
  test("auto-resolves a non-network ask when mode is enabled", () => {
    expect(
      shouldAutoResolveAsk({ enabled: true, hasNetworkContext: false }),
    ).toBe(true);
  });

  test("does NOT auto-resolve a network-egress ask even when enabled (egress stays gated)", () => {
    expect(
      shouldAutoResolveAsk({ enabled: true, hasNetworkContext: true }),
    ).toBe(false);
  });

  test("does NOT auto-resolve when mode is disabled (no network)", () => {
    expect(
      shouldAutoResolveAsk({ enabled: false, hasNetworkContext: false }),
    ).toBe(false);
  });

  test("does NOT auto-resolve when mode is disabled (network present)", () => {
    expect(
      shouldAutoResolveAsk({ enabled: false, hasNetworkContext: true }),
    ).toBe(false);
  });

  test("auto-resolves an exact structured SSH operation for an already trusted host", () => {
    expect(
      shouldAutoResolveAsk({
        enabled: true,
        hasNetworkContext: false,
        requiresExplicitReview: true,
        structuredSshHostTrust: "trusted",
      }),
    ).toBe(true);
  });

  test.each(["unknown", "changed"] as const)(
    "keeps an exact structured SSH operation manual when host trust is %s",
    (structuredSshHostTrust) => {
      expect(
        shouldAutoResolveAsk({
          enabled: true,
          hasNetworkContext: false,
          requiresExplicitReview: true,
          structuredSshHostTrust,
        }),
      ).toBe(false);
    },
  );
});
