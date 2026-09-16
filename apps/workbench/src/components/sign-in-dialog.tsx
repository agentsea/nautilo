import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/use-auth";
import { apiClient } from "../lib/api";
import {
  canSwitchDesktopServer,
  canSwitchDesktopServerInProcess,
  desktopAPI,
  isDesktop,
} from "../lib/desktop";
import { InvitePasteModal } from "./invite-paste-modal";
import { ForgotPasswordDialog } from "./forgot-password-dialog";
import { PreAuthShell } from "./pre-auth-shell";
import { ServerSwitcherOverlay } from "./server-switcher-overlay";
import { captureAuthReturn } from "../lib/auth-return";
import { rememberMobileInterfaceChoice } from "../lib/interface-preference";

function activeServerOriginFallback(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export function SignInDialog() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const deviceBusy = auth.session.state === "signing-in";

  const [inviteOpen, setInviteOpen] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [passwordUpdatedBanner, setPasswordUpdatedBanner] = useState(false);
  const [staleAuthCleared, setStaleAuthCleared] = useState(false);
  const [autoClearNotice, setAutoClearNotice] = useState<{
    currentServer: string;
    previousServer: string | null;
  } | null>(null);
  const [activeServerUrl, setActiveServerUrl] = useState(activeServerOriginFallback);
  const [switchServerBusy, setSwitchServerBusy] = useState(false);
  const [switchServerError, setSwitchServerError] = useState<string | null>(null);
  const [serverSwitcherOpen, setServerSwitcherOpen] = useState(false);

  const staleAuthIssue =
    !staleAuthCleared && auth.session.issue?.kind === "scope-mismatch"
      ? auth.session.issue
      : null;
  const canSwitchServer = canSwitchDesktopServerInProcess() || canSwitchDesktopServer();
  const showChooseAnotherServer = staleAuthIssue != null && canSwitchServer;
  const showPreAuthServerSwitch = staleAuthIssue == null && canSwitchServer;

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .getHealth()
      .then((health) => {
        if (cancelled) return;
        const fromHealth = health.serverUrl?.trim();
        if (fromHealth) {
          setActiveServerUrl(fromHealth.replace(/\/+$/, ""));
        }
      })
      .catch(() => {
        // Keep window origin fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void desktopAPI?.auth.consumeNotice?.().then((notice) => {
      if (cancelled || notice?.kind !== "env-pinned-auth-cleared") return;
      setAutoClearNotice({
        currentServer: notice.expected.serverUrl,
        previousServer: notice.disk?.serverUrl ?? null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignIn = useCallback(async () => {
    captureAuthReturn({ pathname: location.pathname, hash: location.hash });
    await auth.session.signIn();
  }, [auth.session, location.hash, location.pathname]);

  const onClearStaleAuth = useCallback(async () => {
    await auth.session.signOut();
    setStaleAuthCleared(true);
  }, [auth.session]);

  const onChooseAnotherServer = useCallback(async () => {
    if (canSwitchDesktopServerInProcess()) {
      setServerSwitcherOpen(true);
      return;
    }
    const openPicker = desktopAPI?.servers?.openPicker;
    if (!openPicker) return;
    setSwitchServerError(null);
    setSwitchServerBusy(true);
    try {
      await openPicker();
    } catch (e) {
      setSwitchServerError(
        e instanceof Error ? e.message : "Could not open server picker",
      );
    } finally {
      setSwitchServerBusy(false);
    }
  }, []);

  const notices = (
    <>
      {passwordUpdatedBanner ? (
        <p className="mt-4 rounded-md border border-border bg-background-subtle px-3 py-2 text-sm text-foreground-muted">
          Password updated. Sign in with your new password.
        </p>
      ) : null}
      {staleAuthCleared ? (
        <p
          className="mt-4 rounded-md border border-border bg-background-subtle px-3 py-2 text-sm text-foreground-muted"
          data-testid="stale-auth-cleared-banner"
        >
          Local sign-in data cleared. Sign in again to continue.
        </p>
      ) : null}
    </>
  );

  return (
    <PreAuthShell
      title="Sign in to continue"
      subtitle="Sign in with your account to continue."
      scrim="page"
      testId="sign-in-dialog"
    >
      {staleAuthIssue ? (
        <div
          className="rounded-md border border-[var(--warning)] bg-background-element px-4 py-3 text-left text-sm text-foreground"
          data-testid="stale-auth-recovery"
        >
          <p className="font-medium">Saved sign-in does not match this server.</p>
          <p className="mt-2 text-foreground-muted">
            This app is connected to{" "}
            <code className="font-mono text-xs">{staleAuthIssue.expected.serverUrl}</code>
            , but your saved sign-in is for{" "}
            <code className="font-mono text-xs">
              {staleAuthIssue.disk?.serverUrl ?? "another server"}
            </code>
            .
          </p>
          <p className="mt-2 text-foreground-muted">
            Clear local sign-in data for this desktop profile and sign in again.
            This does not delete rooms, memories, server data, or your Nautilo account.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              disabled={deviceBusy || switchServerBusy}
              onClick={() => void onClearStaleAuth()}
              data-testid="clear-stale-auth"
            >
              Clear local sign-in data
            </button>
            {showChooseAnotherServer ? (
              <button
                type="button"
                className="rounded-md border border-border-strong px-4 py-2 text-sm text-foreground hover:bg-background-subtle disabled:cursor-not-allowed disabled:opacity-40"
                disabled={deviceBusy || switchServerBusy}
                onClick={() => void onChooseAnotherServer()}
                data-testid="choose-another-server"
              >
                Choose another server
              </button>
            ) : null}
          </div>
          {switchServerError ? (
            <p className="mt-2 text-xs text-[var(--error)]">{switchServerError}</p>
          ) : null}
        </div>
      ) : null}

      <div className={staleAuthIssue ? "mt-8 flex flex-col items-stretch gap-3" : "flex flex-col items-stretch gap-3"}>
          {activeServerUrl ? (
            <div className="text-center text-xs text-foreground-muted">
              <p data-testid="sign-in-active-server">
                Server:{" "}
                <code className="font-mono text-[11px]">{activeServerUrl}</code>
              </p>
              {showPreAuthServerSwitch ? (
                <button
                  type="button"
                  className="mt-1 text-xs text-foreground-muted underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={deviceBusy || switchServerBusy}
                  onClick={() => void onChooseAnotherServer()}
                  data-testid="sign-in-switch-server"
                >
                  Not the right server? Switch server…
                </button>
              ) : null}
              {autoClearNotice ? (
                <p className="mt-1" data-testid="auth-auto-clear-notice">
                  Old sign-in
                  {autoClearNotice.previousServer ? (
                    <>
                      {" "}
                      for{" "}
                      <code className="font-mono text-[11px]">
                        {autoClearNotice.previousServer}
                      </code>
                    </>
                  ) : null}
                  {" "}was cleared.
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="w-full rounded-md bg-primary px-7 py-3 text-sm font-semibold text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            disabled={deviceBusy}
            onClick={() => void onSignIn()}
            data-testid="sign-in-submit"
          >
            {deviceBusy ? "Redirecting…" : "Sign in"}
          </button>
          <button
            type="button"
            disabled={deviceBusy}
            onClick={() => {
              if (deviceBusy) return;
              setInviteOpen(true);
            }}
            className="w-full rounded-md border border-border-strong px-7 py-3 text-sm font-semibold text-foreground hover:bg-background-subtle disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-in-i-have-an-invite"
          >
            I have an invite
          </button>
          <button
            type="button"
            disabled={deviceBusy}
            onClick={() => {
              if (deviceBusy) return;
              setForgotPasswordOpen(true);
            }}
            className="text-sm text-foreground-muted underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-in-forgot-password"
          >
            Forgot password?
          </button>
          {!isDesktop ? (
            <a
              href="/mobile/"
              className="text-sm text-foreground-muted underline-offset-2 hover:underline"
              onClick={rememberMobileInterfaceChoice}
            >
              Open Mobile
            </a>
          ) : null}
      </div>
      {notices}

      {inviteOpen ? (
        <InvitePasteModal
          onClose={() => setInviteOpen(false)}
          onNavigateInvite={(token) => {
            void navigate(`/invite/${encodeURIComponent(token)}`);
          }}
        />
      ) : null}
      {forgotPasswordOpen ? (
        <ForgotPasswordDialog
          onClose={() => setForgotPasswordOpen(false)}
          onPasswordChanged={() => setPasswordUpdatedBanner(true)}
        />
      ) : null}
      {serverSwitcherOpen ? (
        <ServerSwitcherOverlay onClose={() => setServerSwitcherOpen(false)} />
      ) : null}
    </PreAuthShell>
  );
}
