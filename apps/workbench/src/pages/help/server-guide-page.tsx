import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import type { KeyReport } from "@nautilo/config-guard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DesktopConnectionGuide } from "../../components/desktop-connection-guide";
import { useCan } from "../../hooks/use-can";
import { apiClient } from "../../lib/api";
import {
  beginIncompleteServerGuideSession,
  completeServerGuide,
  endServerGuideSession,
} from "../../lib/server-guide-session";
import { ProviderKeyCoverage } from "../admin/sections/provider-key-coverage";
import { SERVER_GUIDE_ACTIONS, type ServerGuideAction } from "./server-guide-actions";

interface GuideProgress {
  readonly status: SetupStatusResponse | null;
  readonly memberCount?: number;
  readonly activeInviteCount?: number;
}

function actionProgress(
  action: ServerGuideAction,
  progress: GuideProgress,
): { label: string; complete: boolean } {
  switch (action.id) {
    case "configure-server":
      return progress.status?.serverProfile?.reviewedAt
        ? { label: "Reviewed", complete: true }
        : { label: "Review needed", complete: false };
    case "configure-providers":
      return progress.status?.providers?.hasLlm
        ? { label: "Models ready", complete: true }
        : { label: "Setup needed", complete: false };
    case "invite-team": {
      const started = (progress.memberCount ?? 0) > 1 || (progress.activeInviteCount ?? 0) > 0;
      if (started) {
        return {
          label: `${progress.memberCount ?? 0} members · ${progress.activeInviteCount ?? 0} active invites`,
          complete: true,
        };
      }
      return { label: "Optional", complete: false };
    }
    case "get-desktop":
      return { label: "Optional", complete: false };
    case "finish-setup":
      return { label: "Finish when you're ready", complete: false };
  }
}

function ServerGuideActionCard({
  action,
  index,
  progress,
  serverUrl,
  onFinishSetup,
}: {
  action: ServerGuideAction;
  index: number;
  progress: GuideProgress;
  serverUrl: string | null;
  onFinishSetup: () => void;
}) {
  const can = useCan();
  const permitted = action.requiresCapability === undefined || can(action.requiresCapability);
  const actionState = actionProgress(action, progress);

  return (
    <li
      data-testid={`server-guide-action-${action.id}`}
      className="rounded-xl border border-border bg-background-panel p-5"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background-element text-sm font-semibold text-foreground-muted"
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-foreground">{action.title}</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                actionState.complete
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-background-element text-foreground-muted"
              }`}
              data-testid={`server-guide-progress-${action.id}`}
            >
              {actionState.label}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-foreground-muted">{action.description}</p>
          {permitted ? (
            action.id === "finish-setup" ? (
              <button
                type="button"
                className="mt-4 inline-flex rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
                onClick={onFinishSetup}
              >
                {action.title}
              </button>
            ) : action.external ? (
              <a
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
              >
                {action.title}
              </a>
            ) : (
              <Link
                to={action.href}
                className="mt-4 inline-flex rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
              >
                {action.title}
              </Link>
            )
          ) : (
            <p className="mt-4 text-sm text-foreground-muted" data-testid={`server-guide-unavailable-${action.id}`}>
              {action.unavailableDescription}
            </p>
          )}
          {action.id === "get-desktop" ? (
            <DesktopConnectionGuide serverUrl={serverUrl} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

type KeyCoverageState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly keys: KeyReport[] }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-permitted" };

function GuideKeyCoverage({ state }: { state: KeyCoverageState }) {
  if (state.kind === "not-permitted") {
    return (
      <section
        className="mt-8 rounded-xl border border-border bg-background-element p-5"
        aria-labelledby="server-guide-key-coverage-title"
      >
        <h2 className="text-base font-semibold text-foreground" id="server-guide-key-coverage-title">
          API key coverage
        </h2>
        <p className="mt-2 text-sm text-foreground-muted" data-testid="server-guide-key-coverage-not-permitted">
          Ask a server administrator with permission to manage provider keys to review API key coverage.
        </p>
      </section>
    );
  }

  return (
    <div className="mt-8 rounded-xl border border-border bg-background-element p-5">
      {state.kind === "ready" ? (
        <ProviderKeyCoverage keys={state.keys} />
      ) : (
        <section aria-labelledby="server-guide-key-coverage-title" className="mb-5 border-b border-border pb-5">
          <h2 className="text-sm font-semibold" id="server-guide-key-coverage-title">
            API key coverage
          </h2>
          {state.kind === "loading" ? (
            <p className="mt-2 text-sm text-foreground-muted" data-testid="server-guide-key-coverage-loading">
              Checking API key coverage…
            </p>
          ) : (
            <p className="mt-2 text-sm text-foreground-muted" data-testid="server-guide-key-coverage-unavailable" role="status">
              API key coverage is temporarily unavailable. The setup steps above remain available.
            </p>
          )}
        </section>
      )}
      <p className="text-sm text-foreground-muted">
        Need to add or change a provider key?{" "}
        <Link className="underline hover:text-foreground" to="/admin#provider-credentials">
          Manage API keys
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * The first durable owner landing surface. It is deliberately useful with no
 * network data: all copy and destinations ship in the Workbench image.
 */
export function ServerGuidePage() {
  const navigate = useNavigate();
  const can = useCan();
  const canManageMembers = can("manage_members");
  const canManageProviderKeys = can("manage_connection_providers") || can("manage_server_settings");
  const [progress, setProgress] = useState<GuideProgress>({ status: null });
  const [keyCoverage, setKeyCoverage] = useState<KeyCoverageState>(
    canManageProviderKeys ? { kind: "loading" } : { kind: "not-permitted" },
  );
  const keyCoverageRequestRef = useRef(0);
  const applicationUrl = progress.status?.serverUrl ?? null;

  const finishSetup = useCallback(() => {
    if (progress.status?.instanceId) completeServerGuide(progress.status.instanceId);
    else endServerGuideSession();
    void navigate("/");
  }, [navigate, progress.status?.instanceId]);

  const refreshProgress = useCallback(async () => {
    try {
      const status = await apiClient.getSetupStatus();
      beginIncompleteServerGuideSession(status.instanceId);
      setProgress({ status });
      let memberCount: number | undefined;
      let activeInviteCount: number | undefined;
      if (canManageMembers) {
        try {
          const [members, inviteResult] = await Promise.all([
            apiClient.admin.users.list({ limit: 100 }),
            apiClient.listMyInvites(),
          ]);
          memberCount = members.users.length;
          const now = Date.now();
          activeInviteCount = inviteResult.invites.filter((invite) => (
            invite.revokedAt === null
            && (invite.expiresAt === null || new Date(invite.expiresAt).getTime() > now)
            && (invite.maxUses === null || invite.usedCount < invite.maxUses)
          )).length;
        } catch {
          // Team counts are helpful context, not authority for the rest of
          // the guide. Preserve the canonical setup/profile projection when
          // the narrower member directory is temporarily unavailable.
        }
      }
      setProgress({ status, memberCount, activeInviteCount });
    } catch {
      // Setup progress is optional context. Keep the checked-in guide usable
      // when the status projection is temporarily unavailable.
    }
  }, [canManageMembers]);

  const refreshKeyCoverage = useCallback(async () => {
    const request = ++keyCoverageRequestRef.current;
    if (!canManageProviderKeys) {
      setKeyCoverage({ kind: "not-permitted" });
      return;
    }
    try {
      const { keys } = await apiClient.getKeySummary();
      if (keyCoverageRequestRef.current === request) {
        setKeyCoverage({ kind: "ready", keys });
      }
    } catch {
      // An endpoint failure must not be projected as an empty key report,
      // because that would falsely mark every provider as missing.
      if (keyCoverageRequestRef.current === request) {
        setKeyCoverage({ kind: "unavailable" });
      }
    }
  }, [canManageProviderKeys]);

  useEffect(() => {
    void refreshProgress();
    void refreshKeyCoverage();
    const refresh = () => {
      void refreshProgress();
      void refreshKeyCoverage();
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onProviderKeysSaved = () => void refreshKeyCoverage();
    window.addEventListener("focus", onFocus);
    window.addEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("nautilo:provider-keys-saved", onProviderKeysSaved);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshKeyCoverage, refreshProgress]);

  return (
    <main className="h-full min-h-0 overflow-y-auto" data-testid="server-guide-page">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-10">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-foreground-dim">
          Nautilo server
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
          Finish setting up your server
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-foreground-muted">
          Your server is running. These are the next useful administrator steps;
          complete what applies to your team, then use Nautilo from Desktop or the web.
        </p>

        <ol className="mt-8 flex flex-col gap-4" aria-label="Server setup steps">
          {SERVER_GUIDE_ACTIONS.map((action, index) => (
            <ServerGuideActionCard
              action={action}
              index={index}
              key={action.id}
              progress={progress}
              serverUrl={applicationUrl}
              onFinishSetup={finishSetup}
            />
          ))}
        </ol>

        <GuideKeyCoverage
          state={canManageProviderKeys ? keyCoverage : { kind: "not-permitted" }}
        />

        <aside className="mt-8 rounded-xl border border-border bg-background-element p-5 text-sm text-foreground-muted">
          Provider keys and administrator permissions remain server-controlled.
          If an action is unavailable, ask a server administrator with that permission
          to complete it; Nautilo will not guess, copy or expose credentials here.
        </aside>
      </div>
    </main>
  );
}
