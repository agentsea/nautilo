/**
 * AuthGate keeps session transport and canonical Human identity in lockstep.
 *
 * A restored session reaches `signed-in` before `useViewerAuth` finishes the
 * first authoritative whoami request. Rendering children in that interval
 * leaks the initial anonymous viewer into signed-in UI, so the reconnect
 * surface remains until both Human ids resolve. A resolved Guest is allowed
 * through even though capability verification intentionally remains false.
 */
import "../bun-dom-preload";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const signOut = mock(async () => {});
const authState = {
  session: { state: "unknown", signOut },
  viewer: {
    isVerified: false,
    sessionUserId: null as string | null,
    sessionActorId: null as string | null,
  },
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

afterEach(() => {
  cleanup();
  signOut.mockClear();
});

function renderGate(): string {
  return renderToStaticMarkup(
    <AuthGate>
      <main data-testid="workbench-child">Workspace for Guest</main>
    </AuthGate>,
  );
}

describe("AuthGate", () => {
  test("holds signed-in users on a truthful reconnect surface until Human ids resolve", () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = false;
    authState.viewer.sessionUserId = null;
    authState.viewer.sessionActorId = null;

    const html = renderGate();

    expect(html).toContain('data-testid="auth-reconnecting"');
    expect(html).toContain("Connecting your account…");
    expect(html).toContain("Your sign-in is saved. Nautilo is restoring your workspace.");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("Workspace for Guest");
    expect(html).not.toContain("sign-in-action");
  });

  test("renders workbench children for a resolved Guest without changing verification semantics", () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = false;
    authState.viewer.sessionUserId = "guest-user";
    authState.viewer.sessionActorId = "guest-actor";

    const html = renderGate();

    expect(html).toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
    expect(html).not.toContain("sign-in-action");
  });

  test("keeps reconnecting when only one canonical Human id is available", () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = true;
    authState.viewer.sessionUserId = "user-1";
    authState.viewer.sessionActorId = null;

    const html = renderGate();

    expect(html).toContain('data-testid="auth-reconnecting"');
    expect(html).not.toContain("workbench-child");
  });

  test("offers sign-out recovery when canonical identity cannot be restored", async () => {
    authState.session.state = "signed-in";
    authState.viewer.isVerified = false;
    authState.viewer.sessionUserId = null;
    authState.viewer.sessionActorId = null;

    const view = render(
      <AuthGate>
        <main>Workspace</main>
      </AuthGate>,
    );
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  test("renders the sign-in dialog only for signed-out sessions", () => {
    authState.session.state = "signed-out";
    authState.viewer.isVerified = false;
    authState.viewer.sessionUserId = null;
    authState.viewer.sessionActorId = null;

    const html = renderGate();

    expect(html).toContain("sign-in-action");
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
  });

  test.each(["unknown", "signing-in"] as const)("keeps the existing loading veneer while %s", (state) => {
    authState.session.state = state;
    authState.viewer.isVerified = false;
    authState.viewer.sessionUserId = null;
    authState.viewer.sessionActorId = null;

    const html = renderGate();

    expect(html).toContain('data-testid="auth-loading"');
    expect(html).not.toContain("workbench-child");
    expect(html).not.toContain("auth-reconnecting");
    expect(html).not.toContain("sign-in-action");
  });
});
