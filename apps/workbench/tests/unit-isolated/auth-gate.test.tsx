/**
 * AuthGate keeps session transport and Nautilo viewer identity in lockstep.
 *
 * A restored session reaches `signed-in` before `useViewerAuth` finishes the
 * first authoritative whoami request. Rendering children in that interval
 * leaks the initial Guest viewer into signed-in UI, so the reconnect surface
 * is deliberately the only signed-in + unverified frame.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const authState = {
  session: { state: "unknown" },
  viewer: { isVerified: false },
};

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

mock.module("../../src/components/sign-in-dialog", () => ({
  SignInDialog: () => (
    <button data-testid="sign-in-action" type="button">
      Sign in
    </button>
  ),
}));

const { AuthGate } = await import("../../src/components/auth-gate");

function renderGate(): string {
  return renderToStaticMarkup(
    <AuthGate>
      <main data-testid="workbench-child">Workspace for Guest</main>
    </AuthGate>,
  );
}

describe("AuthGate", () => {
  test("holds signed-in users on a truthful reconnect surface until their viewer is verified", () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = false;

    const html = renderGate();

    expect(html).toContain('data-testid="auth-reconnecting"');
    expect(html).toContain("Connecting your account…");
    expect(html).toContain("Your sign-in is saved. Nautilo is restoring your workspace.");
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("Workspace for Guest");
    expect(html).not.toContain("sign-in-action");
  });

  test("renders workbench children once the signed-in viewer is verified", () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = true;

    const html = renderGate();

    expect(html).toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
    expect(html).not.toContain("sign-in-action");
  });

  test("renders the sign-in dialog only for signed-out sessions", () => {
    authState.session.state = "signed-out";
    authState.viewer.isVerified = false;

    const html = renderGate();

    expect(html).toContain("sign-in-action");
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
  });

  test.each(["unknown", "signing-in"] as const)("keeps the existing loading veneer while %s", (state) => {
    authState.session.state = state;
    authState.viewer.isVerified = false;

    const html = renderGate();

    expect(html).toContain('data-testid="auth-loading"');
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
    expect(html).not.toContain("sign-in-action");
  });
});
