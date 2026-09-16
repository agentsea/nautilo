/**
 * D112 Phase 3 — setup surface gate for the Workbench.
 *
 * Wraps the app outside `AuthGate` so unclaimed / pre-auth states can
 * surface before Logto redirects (M071 ordering).
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import { useLocation } from "react-router-dom";
import {
  addAuthTransitionListener,
  shouldIgnoreCredentialOnlyTransition,
} from "../lib/auth-transition";
import { apiClient } from "../lib/api";
import { getShellStateOnBoot } from "../lib/desktop";
import { SetupStatusProvider } from "../contexts/setup-status-context";
import { GenieCustomizeSoftPrompt } from "./genie-customize-soft-prompt";
import { PreAuthShell } from "./pre-auth-shell";

function currentRoute(): { pathname: string; hash: string } {
  if (typeof window === "undefined") return { pathname: "", hash: "" };
  return { pathname: window.location.pathname, hash: window.location.hash };
}

function BlockingShell({
  title,
  body,
  children,
}: {
  title: string;
  body: ReactNode;
  children?: ReactNode;
}) {
  const subtitle = typeof body === "string" ? body : undefined;
  const bodyContent = typeof body === "string" ? null : body;

  return (
    <PreAuthShell
      title={title}
      subtitle={subtitle}
      scrim="page"
      testId="first-run-blocking"
    >
      {bodyContent}
      {children}
    </PreAuthShell>
  );
}

export interface FirstRunGateViewProps {
  status: SetupStatusResponse;
  children: ReactNode;
  onSetupRefresh?: () => void;
  /**
   * When true, skips the Genie soft prompt (it needs `AuthProvider` + client
   * hooks — use in SSR tests only).
   */
  omitGenieSoftPrompt?: boolean;
  /** Current route; injected by focused routing tests. */
  pathname?: string;
}

export function shouldRenderGenieSoftPrompt(
  pathname: string,
  omitGenieSoftPrompt: boolean,
): boolean {
  // The Server Guide is the ordered first-owner checklist. A competing
  // personalization prompt obscures that flow; Genie remains available from
  // Settings and continues to be offered on ordinary product routes.
  return !omitGenieSoftPrompt && pathname !== "/help/server";
}

/**
 * Pure branch on `setupState` — used by `FirstRunGate` and unit tests.
 */
export function FirstRunGateView({
  status,
  children,
  onSetupRefresh,
  omitGenieSoftPrompt = false,
  pathname,
}: FirstRunGateViewProps) {
  const route = currentRoute();
  const currentPathname = pathname ?? route.pathname;
  const content = <SetupStatusProvider status={status}>{children}</SetupStatusProvider>;

  switch (status.setupState) {
    case "fresh-unclaimed":
      return (
        <BlockingShell
          title="Finish claiming this server"
          body={
            <>
              <p>
                This browser no longer has an active first-owner claim. Return
                to the Nautilo deployment command that created this server and
                run the exact resume command it printed. If that claim has
                expired, reissue a fresh claim from that same controller.
              </p>
              <p className="mt-3 text-sm text-foreground-muted">
                This page cannot recreate a claim. Check again only after the
                owner flow has completed in another browser window.
              </p>
              {status.claimInvitePathHint ? (
                <p className="mt-3 font-mono text-xs text-foreground-muted">
                  Invite file: {status.claimInvitePathHint}
                </p>
              ) : null}
            </>
          }
        >
          <button
            type="button"
            className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
            onClick={onSetupRefresh}
          >
            Check again
          </button>
        </BlockingShell>
      );

    case "server-needs-keys":
      return content;

    case "claimed-needs-auth": {
      // Server is claimed but the caller is signed-out. AuthGate
      // (rendered inside the children tree) takes care of showing
      // <SignInDialog /> on `signed-out`, so we just pass through.
      // M106 moved the rendering into AuthGate so post-logout +
      // session-expired states get the same dialog without
      // FirstRunGate having to know about session state.
      return content;
    }

    case "ready":
    default:
      return (
        <>
          {content}
          {shouldRenderGenieSoftPrompt(
            currentPathname,
            omitGenieSoftPrompt,
          ) ? (
            <GenieCustomizeSoftPrompt
              setupStatus={status}
              onDismissed={onSetupRefresh}
            />
          ) : null}
        </>
      );
  }
}

export function FirstRunGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "done">("loading");
  const [setupFetchFailed, setSetupFetchFailed] = useState(false);
  const lastProcessedViewerGenerationRef = useRef<number | null>(null);
  /** D154 Finding B — skip setup-status GET when Electron cold-boot says server unreachable / picker states. */
  const [skipSetupStatusPreflight] = useState(() => {
    const boot = getShellStateOnBoot();
    return boot != null && boot !== "live";
  });

  const refresh = useCallback(async () => {
    try {
      const s = await apiClient.getSetupStatus();
      setStatus(s);
      setSetupFetchFailed(false);
    } catch {
      setStatus(null);
      setSetupFetchFailed(true);
    } finally {
      setLoadState("done");
    }
  }, []);

  useEffect(() => {
    // <D154-finding-B-setup-status-bypass>
    if (skipSetupStatusPreflight) {
      setLoadState("done");
      setStatus(null);
      setSetupFetchFailed(false);
      return;
    }
    // </D154-finding-B-setup-status-bypass>
    void refresh();
    const removeAuthListener = addAuthTransitionListener((detail) => {
      if (
        shouldIgnoreCredentialOnlyTransition(
          lastProcessedViewerGenerationRef.current,
          detail,
        )
      ) {
        return;
      }
      lastProcessedViewerGenerationRef.current = detail.viewerGeneration;
      void refresh();
    });
    const onProfile = () => void refresh();
    const onProviderKeysSaved = () => void refresh();
    window.addEventListener("nautilo:profile-changed", onProfile);
    window.addEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
    return () => {
      removeAuthListener();
      window.removeEventListener("nautilo:profile-changed", onProfile);
      window.removeEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
    };
  }, [refresh, skipSetupStatusPreflight]);

  if (loadState === "loading") {
    return (
      <div
        className="fixed inset-0 z-30 bg-background"
        aria-busy
        data-testid="setup-status-loading"
      />
    );
  }

  if (!status) {
    return (
      <>
        {setupFetchFailed ? (
          <div
            className="fixed top-0 left-0 right-0 z-[55] flex items-center justify-between gap-3 border-b border-amber-600/40 bg-amber-950/90 px-4 py-2 text-sm text-amber-50"
            role="status"
            data-testid="setup-status-fetch-failed"
          >
            <span>Could not load setup status from the server.</span>
            <button
              type="button"
              className="shrink-0 rounded border border-amber-400/50 px-2 py-1 text-xs font-medium hover:bg-amber-900/80"
              onClick={() => {
                setLoadState("loading");
                void refresh();
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
        <div className={setupFetchFailed ? "pt-10" : undefined}>{children}</div>
      </>
    );
  }

  return (
    <FirstRunGateView
      status={status}
      pathname={location.pathname}
      onSetupRefresh={() => void refresh()}
    >
      {children}
    </FirstRunGateView>
  );
}
