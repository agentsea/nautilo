/**
 * M054 — `/auth/callback` route.
 *
 * Wired as a real `<Route>` in `app.tsx` so it renders BEFORE the
 * AuthGate-wrapped shell. `useHandleSignInCallback` reads `?code=...`
 * + `?state=...` from the URL, exchanges them for tokens via the
 * @logto/react SDK, persists them, then navigates home — at which
 * point AuthGate sees `auth.session.state === "signed-in"` and renders the
 * workbench.
 *
 * Edge cases:
 *  - Bookmarked `/auth/callback` with no code: `useHandleSignInCallback`
 *    finishes immediately (no-op); we navigate home.
 *  - Error during exchange: SDK surfaces it via context.error; we
 *    show a small error card with a "Back to sign in" affordance.
 */
import { useHandleSignInCallback } from "@logto/react";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef } from "react";
import { readSession } from "../lib/invite-redeem-session";
import { readOwnerClaimHandoff } from "../lib/owner-claim-handoff";
import {
  authCallbackStartedWithCode,
  resolveAuthCallbackErrorDestination,
  resolveAuthCallbackDestination,
} from "../lib/auth-return";

export function SignInCallback() {
  const navigate = useNavigate();
  // Capture this before Logto's callback hook can scrub `?code`. The
  // no-code/bookmark fallback must never race a real callback's exact owner,
  // invite, or stored-route continuation.
  const startedWithCode = useRef(authCallbackStartedWithCode(window.location.search));
  const continuation = () => ({
    ownerClaimStage: readOwnerClaimHandoff()?.stage,
    ordinaryInvite: readSession(),
  } as const);
  const { isLoading, error } = useHandleSignInCallback(() => {
    try {
      void navigate(resolveAuthCallbackDestination(continuation()), { replace: true });
      return;
    } catch {
      /* ignore sessionStorage */
    }
    void navigate("/", { replace: true });
  });

  // No-code-on-URL fast path: SDK resolves `isLoading: false` without
  // calling our success callback. Detect that with an effect so we
  // don't loop on a bookmarked URL.
  useEffect(() => {
    if (!isLoading && !error) {
      try {
        if (!startedWithCode.current) {
          void navigate("/", { replace: true });
        }
      } catch {
        void navigate("/", { replace: true });
      }
    }
  }, [isLoading, error, navigate]);

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <div className="w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-error">Sign-in failed</h2>
          <p className="mt-2 text-sm text-foreground-muted">{error.message}</p>
          <button
            onClick={() => {
              void navigate(resolveAuthCallbackErrorDestination(continuation()), { replace: true });
            }}
            className="mt-4 w-full rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <p className="text-foreground-muted">Completing sign-in…</p>
    </div>
  );
}
