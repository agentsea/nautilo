/**
 * M054 / M072 — top-level auth gate.
 *
 * Sits below `<LogtoProvider>` and above the workbench shell. Replaces
 * the legacy PIN-at-start gate as the cold-start surface: the SDK reads
 * tokens from storage on first paint.
 *
 * Hydration: auth session recovery and Nautilo's authoritative `whoami`
 * viewer recovery are separate asynchronous steps. A recovered session must
 * not render the workbench until both canonical Human ids resolve, otherwise
 * the shell reads the initial anonymous viewer. `isVerified` remains a
 * capability/device gate and is deliberately false for resolved Guests.
 *
 * M106 (replaces D134) — when `state === "signed-out"` we render the
 * workbench `<SignInDialog />` so the user sees the M106 affordances
 * ("Sign in", "I have an invite", "Forgot password?") instead of being
 * silently bounced to Logto. The previous D134 auto-redirect made these
 * affordances unreachable because the page (or auth-window) navigated
 * before the user could click them.
 *
 * The `/auth/callback` route is registered inside `<App>`, so AuthGate
 * must let that subtree render even while `auth.session.state` says
 * "signed-out" / "signing-in" — otherwise `useHandleSignInCallback`
 * never runs. The router renders the callback before the AuthGate-wrapped
 * shell.
 */
import { useState, type ReactNode } from "react";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { SignInDialog } from "./sign-in-dialog";

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signOut = async (): Promise<void> => {
    setSignOutError(null);
    setSignOutPending(true);
    try {
      await auth.session.signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign out failed");
    } finally {
      setSignOutPending(false);
    }
  };

  if (auth.session.state === "signed-in") {
    if (isAuthenticatedHumanViewer(auth.viewer)) {
      return <>{children}</>;
    }

    return (
      <main
        className="fixed inset-0 z-40 flex items-center justify-center bg-background px-6 text-center text-foreground"
        role="status"
        aria-live="polite"
        aria-busy="true"
        data-testid="auth-reconnecting"
      >
        <div className="max-w-sm space-y-2">
          <h1 className="text-lg font-semibold">Connecting your account…</h1>
          <p className="text-sm text-foreground-muted">
            Your sign-in is saved. Nautilo is restoring your workspace.
          </p>
          <button
            type="button"
            disabled={signOutPending}
            onClick={() => void signOut()}
            className="text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {signOutPending ? "Signing out…" : "Sign out"}
          </button>
          {signOutError ? (
            <p className="text-sm text-error" role="alert">
              {signOutError}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (auth.session.state === "signed-out") {
    return <SignInDialog />;
  }

  // "unknown" or "signing-in" — render a blank veneer so the user doesn't
  // see a flash of either the workbench or the sign-in dialog while the
  // Logto SDK hydrates or the auth-window is in flight.
  return (
    <div
      className="fixed inset-0 z-40 bg-background"
      aria-hidden
      data-testid="auth-loading"
    />
  );
}
