import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let ForgotPinDialog: (typeof import("../../src/components/forgot-pin-dialog"))["ForgotPinDialog"];

beforeAll(async () => {
  mock.module("../../src/lib/api", () => ({
    apiClient: {
      recoverPin: async () => ({ codesRemaining: 9 }),
      recoverPinWithFreshJwt: async () => ({ ok: true as const, codesRemaining: 9 }),
      setToken: () => {},
    },
  }));
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: null,
    // Stack 19 Phase 6.9.6 fix: partial mocks of lib/desktop omit Stack
    // 19's new runtime exports under Bun's mock-hoisting → other tests
    // importing them get `Export named 'X' not found`. Stubs MUST
    // call-through to `window.nautiloDesktop` so tests like
    // `first-run-gate-disconnected-boot.test.tsx` (which polyfills
    // `nautiloDesktop.shellStateOnBoot` after module load) still work
    // when this mock has leaked across the file boundary.
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

describe("ForgotPinDialog", () => {
  test("renders title, close control, and hides step-up option when not desktop", () => {
    const html = renderToStaticMarkup(
      <ForgotPinDialog onClose={() => {}} onSuccess={() => {}} />,
    );
    expect(html).toContain("Reset your PIN");
    expect(html).toContain("✕");
    expect(html).toContain("I have a recovery code");
    expect(html).not.toContain("Verify with my password");
  });
});
