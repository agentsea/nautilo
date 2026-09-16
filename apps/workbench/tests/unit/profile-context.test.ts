import { describe, expect, test } from "bun:test";
import { shouldDeferShellProfileOnMissingToken } from "../../src/contexts/profile-context";

describe("ProfileProvider missing-token shell fallback guard", () => {
  test("verified cached viewer + loading session defers instead of showing shell Genie", () => {
    expect(
      shouldDeferShellProfileOnMissingToken({
        viewerIsVerified: true,
        sessionState: "unknown",
      }),
    ).toBe(true);
  });

  test("verified cached viewer + signed-in session still defers when token is temporarily unavailable", () => {
    expect(
      shouldDeferShellProfileOnMissingToken({
        viewerIsVerified: true,
        sessionState: "signed-in",
      }),
    ).toBe(true);
  });

  test("verified cached viewer + signing-in session also defers", () => {
    expect(
      shouldDeferShellProfileOnMissingToken({
        viewerIsVerified: true,
        sessionState: "signing-in",
      }),
    ).toBe(true);
  });

  test("explicit signed-out state can show guest shell", () => {
    expect(
      shouldDeferShellProfileOnMissingToken({
        viewerIsVerified: true,
        sessionState: "signed-out",
      }),
    ).toBe(false);
  });

  test("unverified viewer can show guest shell", () => {
    expect(
      shouldDeferShellProfileOnMissingToken({
        viewerIsVerified: false,
        sessionState: "unknown",
      }),
    ).toBe(false);
  });
});
