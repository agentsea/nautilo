import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let ForgotPinDialog: (typeof import("../../src/components/forgot-pin-dialog"))["ForgotPinDialog"];

beforeAll(async () => {
  mock.module("../../src/lib/api", () => ({
    apiClient: {
      recoverPin: async () => ({ codesRemaining: 9 }),
      recoverPinWithFreshJwt: async () => ({
        ok: true as const,
        codesRemaining: 7,
      }),
      setToken: () => {},
    },
  }));
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: true,
    desktopAPI: {
      auth: {
        stepUp: async () => ({
          accessToken: "fresh-jwt-token",
          issuedAt: Date.now(),
        }),
      },
    },
    // Stack 19 Phase 6.9.6 fix: partial mocks of lib/desktop omit Stack
    // 19's new runtime exports under Bun's mock-hoisting → other tests
    // importing them get `Export named 'X' not found`. Stubs MUST
    // call-through to `window.nautiloDesktop` (see forgot-password
    // sibling for full rationale).
    getShellStateOnBoot: () => {
      if (typeof window === "undefined") return null;
      const api = (window as unknown as { nautiloDesktop?: { shellStateOnBoot?: () => unknown } }).nautiloDesktop;
      if (!api?.shellStateOnBoot) return null;
      try { return api.shellStateOnBoot() ?? null; } catch { return null; }
    },
    computeInitialLastOpenAtSeed: (input: { hasEverBeenOpen: boolean; shellStateOnBoot: unknown; now: number }) => {
      const base = input.hasEverBeenOpen ? input.now : null;
      if (input.shellStateOnBoot != null && input.shellStateOnBoot !== "live" && base === null) return input.now;
      return base;
    },
  }));
  mock.module("../../src/hooks/use-auth", () => ({
    useAuth: () => ({
      latchAccessToken: () => null,
    }),
  }));
  ({ ForgotPinDialog } = await import("../../src/components/forgot-pin-dialog"));
});

afterAll(() => {
  mock.restore();
});

describe("ForgotPinDialog (desktop)", () => {
  test("shows recovery and step-up options when desktop", () => {
    const html = renderToStaticMarkup(
      <ForgotPinDialog onClose={() => {}} onSuccess={() => {}} />,
    );
    expect(html).toContain("Verify with my password");
    expect(html).toContain("I have a recovery code");
  });

  test("step-up form renders when initialPath='step-up' on desktop", async () => {
    const { ForgotPinDialog: Dialog } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    const html = renderToStaticMarkup(
      <Dialog
        initialPath="step-up"
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );
    expect(html).toContain("Re-authenticate");
    // The PIN form is gated behind step-up token state, so it should NOT
    // appear until after a successful re-auth. Verifies the step-up
    // branch starts at the right initial sub-state.
    expect(html).not.toContain("Submit");
  });
});

describe("isFreshReauth401 predicate", () => {
  test("recognises explicit fresh_reauth_required message", async () => {
    const { isFreshReauth401 } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    const { ApiError } = await import("@nautilo/api-client/browser");
    expect(
      isFreshReauth401(new ApiError(401, "fresh_reauth_required: please re-auth")),
    ).toBe(true);
  });

  test("recognises the api-client fallback message", async () => {
    const { isFreshReauth401 } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    const { ApiError } = await import("@nautilo/api-client/browser");
    expect(
      isFreshReauth401(
        new ApiError(
          401,
          "This action requires a recently-issued access token. Re-authenticate with prompt=login and retry.",
        ),
      ),
    ).toBe(true);
  });

  test("rejects 401 without the fresh-reauth marker", async () => {
    const { isFreshReauth401 } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    const { ApiError } = await import("@nautilo/api-client/browser");
    expect(isFreshReauth401(new ApiError(401, "Authentication required"))).toBe(
      false,
    );
  });

  test("rejects 400 / 403 even with the marker phrase", async () => {
    const { isFreshReauth401 } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    const { ApiError } = await import("@nautilo/api-client/browser");
    expect(
      isFreshReauth401(new ApiError(400, "fresh_reauth_required")),
    ).toBe(false);
    expect(
      isFreshReauth401(new ApiError(403, "recently-issued access token")),
    ).toBe(false);
  });

  test("rejects non-ApiError values", async () => {
    const { isFreshReauth401 } = await import(
      "../../src/components/forgot-pin-dialog"
    );
    expect(isFreshReauth401(new Error("fresh_reauth_required"))).toBe(false);
    expect(isFreshReauth401(undefined)).toBe(false);
    expect(isFreshReauth401(null)).toBe(false);
    expect(isFreshReauth401({ status: 401, message: "x" })).toBe(false);
  });
});
