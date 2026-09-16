import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConnectedAppDescriptor,
  ConnectedAppProviderId,
  ConnectedAppProviderSetup,
} from "@nautilo/types";
import { useAuth } from "../../hooks/use-auth";
import { apiClient } from "../../lib/api";
import { desktopAPI } from "../../lib/desktop";
import { GenieHandoffPartialSuccessError } from "../../lib/genie-handoff";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { Button, FieldRow, StatusPill, TextInput } from "../settings/ui";
import {
  ConnectionDisclosureControl,
  useConnectionDisclosure,
} from "./connection-disclosure";
import type {
  ConnectedAppCatalogueSummary,
  ConnectedAppPresentation,
} from "./connected-app-presentation";

type ConnectedAppSectionConfig = Readonly<{
  id: ConnectedAppProviderId;
  displayName: string;
  description: string;
  setupUrl: string;
  setupLinkLabel: string;
  tryDescription: string;
  acceptsAdminToken: boolean;
}>;

function pill(app: ConnectedAppDescriptor | null, displayName: string): {
  tone: "ok" | "warn" | "error" | "info" | "muted";
  label: string;
} {
  if (!app) return { tone: "info", label: "Checking" };
  if (app.lifecycle === "disabled" || app.lifecycle === "withdrawn") {
    return { tone: "muted", label: "Unavailable" };
  }
  if (!app.providerReady) {
    if (app.providerSetupStatus === "managed")
      return { tone: "muted", label: "Unavailable" };
    if (app.providerSetupStatus === "error")
      return { tone: "error", label: "Setup needs repair" };
    return app.canManageProviderSetup
      ? { tone: "warn", label: "Setup required" }
      : { tone: "muted", label: "Waiting for administrator" };
  }
  switch (app.status) {
    case "not_connected":
      return { tone: "muted", label: "Not connected" };
    case "connecting":
      return { tone: "info", label: `Waiting for ${displayName}` };
    case "connected":
      return { tone: "ok", label: "Connected" };
    case "reconnect_required":
      return { tone: "warn", label: "Reconnect" };
    case "error":
      return { tone: "error", label: "Needs attention" };
  }
}

function catalogueSummary(
  app: ConnectedAppDescriptor | null,
): ConnectedAppCatalogueSummary {
  const displayed = pill(app, app?.displayName ?? "app");
  if (!app)
    return {
      state: "available",
      statusLabel: displayed.label,
      tone: displayed.tone,
    };
  if (!app.providerReady) {
    return app.canManageProviderSetup
      ? {
          state: "attention",
          statusLabel: displayed.label,
          tone: displayed.tone,
        }
      : {
          state: "available",
          statusLabel: displayed.label,
          tone: displayed.tone,
        };
  }
  switch (app.status) {
    case "connected":
      return {
        state: "connected",
        statusLabel: displayed.label,
        tone: displayed.tone,
      };
    case "reconnect_required":
    case "error":
      return {
        state: "attention",
        statusLabel: displayed.label,
        tone: displayed.tone,
      };
    case "not_connected":
    case "connecting":
      return {
        state: "available",
        statusLabel: displayed.label,
        tone: displayed.tone,
      };
  }
}

function recovery(code: string | null, displayName: string): string {
  switch (code) {
    case "credential_expired":
    case "oauth_token_expired":
    case "oauth_refresh_unavailable":
    case "unauthorized":
    case "connected_account_not_found":
      return `${displayName} no longer authorizes this connection. Connect it again.`;
    case "rate_limited":
      return `${displayName} is temporarily limiting requests. Try again shortly.`;
    default:
      return `Nautilo could not verify this ${displayName} connection. Try connecting again.`;
  }
}

async function openInRealBrowser(url: string): Promise<void> {
  if (desktopAPI?.browserControl?.openExternal) {
    await desktopAPI.browserControl.openExternal({ url });
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("browser_blocked");
}

function OAuthConnectedAppSection({
  config,
  routeHash,
  routeKey,
  onTryWithGenie,
  presentation = "card",
  onCatalogueSummary,
}: {
  config: ConnectedAppSectionConfig;
  routeHash?: string;
  routeKey?: string;
  onTryWithGenie?: () => Promise<void>;
  presentation?: ConnectedAppPresentation;
  onCatalogueSummary?: (summary: ConnectedAppCatalogueSummary) => void;
}) {
  const auth = useAuth();
  const [app, setApp] = useState<ConnectedAppDescriptor | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<ConnectedAppProviderSetup | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [showSetupForm, setShowSetupForm] = useState(false);
  const [trying, setTrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const api = useMemo(() => ({
    getSetup: () => apiClient.getConnectedAppProviderSetup(config.id),
    inspect: (attemptId: string) => apiClient.inspectConnectedApp(config.id, attemptId),
    start: () => apiClient.startConnectedApp(config.id),
    cancel: (attemptId: string) => apiClient.cancelConnectedAppAttempt(config.id, attemptId),
    configure: (input: Parameters<typeof apiClient.configureConnectedAppProvider>[1]) =>
      apiClient.configureConnectedAppProvider(config.id, input),
    disconnect: () => apiClient.disconnectConnectedApp(config.id),
  }), [config.id]);
  const disclosure = useConnectionDisclosure({
    cardId: config.id,
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen:
      busy ||
      trying ||
      error !== null ||
      app?.status === "connecting" ||
      app?.status === "reconnect_required" ||
      app?.providerSetupStatus === "setup_required" ||
      app?.providerSetupStatus === "error",
    routeHash,
    routeKey,
  });

  const refresh = useCallback(async () => {
    const result = await apiClient.listConnectedApps();
    if (!mounted.current) return;
    setApp(result.apps.find((candidate) => candidate.id === config.id) ?? null);
  }, [config.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {
      if (mounted.current) setError(`${config.displayName} connection status is unavailable.`);
    });
    return () => {
      mounted.current = false;
    };
  }, [config.displayName, refresh]);

  useEffect(() => {
    if (
      app?.driverKind !== "openconnector_local" ||
      !app.canManageProviderSetup
    )
      return;
    void api
      .getSetup()
      .then((result) => {
        if (!mounted.current) return;
        setSetup(result);
        setClientId(result.clientId ?? "");
      })
      .catch(() => {
        if (mounted.current) setError(`${config.displayName} server setup is unavailable.`);
      });
  }, [api, app?.canManageProviderSetup, app?.driverKind, config.displayName]);

  useEffect(() => {
    const attemptId = app?.status === "connecting" ? app.attemptId : null;
    if (!attemptId) return;
    const inspect = async () => {
      try {
        const result = await api.inspect(attemptId);
        if (!mounted.current) return;
        if (result.status === "connected") {
          setError(null);
          await refresh();
        } else if (result.status === "failed" || result.status === "expired") {
          setError(recovery(result.errorCode, config.displayName));
          await refresh();
        }
      } catch {
        // The durable attempt remains authoritative. A later poll or page
        // reload resumes from its id instead of making the Human start over.
      }
    };
    void inspect();
    const timer = window.setInterval(() => void inspect(), 1_500);
    const onFocus = () => void inspect();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [api, app?.attemptId, app?.status, config.displayName, refresh]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.start();
      setApp((current) =>
        current
          ? { ...current, status: "connecting", attemptId: started.attemptId }
          : current,
      );
      await openInRealBrowser(started.authorizationUrl);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message === "browser_blocked"
          ? `Your browser blocked the ${config.displayName} sign-in window. Allow pop-ups and try again.`
          : `Nautilo could not start ${config.displayName} sign-in. Try again.`,
      );
      await refresh().catch(() => {});
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const startOver = async () => {
    const attemptId = app?.status === "connecting" ? app.attemptId : null;
    if (!attemptId) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancel(attemptId);
      const started = await api.start();
      setApp((current) =>
        current
          ? { ...current, status: "connecting", attemptId: started.attemptId }
          : current,
      );
      await openInRealBrowser(started.authorizationUrl);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message === "browser_blocked"
          ? `Your browser blocked the ${config.displayName} sign-in window. Allow pop-ups and try again.`
          : `Nautilo could not restart ${config.displayName} sign-in. Try again.`,
      );
      await refresh().catch(() => {});
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const status = pill(app, config.displayName);
  const summary = useMemo(() => catalogueSummary(app), [app]);
  useEffect(() => {
    onCatalogueSummary?.(summary);
  }, [onCatalogueSummary, summary]);
  const accountLabel =
    app?.account?.displayName ??
    app?.account?.username ??
    app?.account?.email ??
    null;
  const canConnect =
    app?.providerReady === true &&
    ["not_connected", "reconnect_required", "error"].includes(app.status);
  const tryWithGenie = async () => {
    if (!onTryWithGenie) return;
    setTrying(true);
    setError(null);
    try {
      await onTryWithGenie();
    } catch (reason) {
      setError(
        reason instanceof GenieHandoffPartialSuccessError
          ? `The ${config.displayName} test was sent to Genie, but the Room that owns this connection could not open. Refresh Rooms and open it; do not resend the test.`
          : `Nautilo could not start the ${config.displayName} test with Genie. Try again from this card.`,
      );
    } finally {
      if (mounted.current) setTrying(false);
    }
  };

  const saveSetup = async (useExisting = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.configure({
        ...(!useExisting ? { clientId, clientSecret } : {}),
        ...(adminToken ? { adminToken } : {}),
      });
      setSetup(result);
      setClientSecret("");
      setAdminToken("");
      await refresh();
      setShowSetupForm(false);
    } catch {
      setError(
        `Nautilo could not verify this OpenConnector and ${config.displayName} OAuth setup. Check the values and try again.`,
      );
      await refresh().catch(() => {});
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnect();
      await refresh();
    } catch {
      setError(`Nautilo could not disconnect this ${config.displayName} account. Try again.`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const personalActions = (
    <div className="flex flex-wrap gap-2">
      {canConnect ? (
        <Button variant="primary" loading={busy} onClick={() => void connect()}>
          {app?.status === "not_connected"
            ? `Connect ${config.displayName}`
            : `Reconnect ${config.displayName}`}
        </Button>
      ) : null}
      {app?.status === "connecting" ? (
        <Button loading={busy} onClick={() => void startOver()}>
          Start over
        </Button>
      ) : null}
      {app?.status === "connected" && onTryWithGenie ? (
        <Button
          variant="primary"
          loading={trying}
          onClick={() => void tryWithGenie()}
        >
          Try with Genie
        </Button>
      ) : null}
      {app?.status === "connected" &&
      app.driverKind === "openconnector_local" ? (
        <Button loading={busy} onClick={() => void disconnect()}>
          Disconnect
        </Button>
      ) : null}
    </div>
  );

  return (
    <div
      id={presentation === "card" ? config.id : undefined}
      tabIndex={presentation === "card" ? -1 : undefined}
      className={
        presentation === "card"
          ? "rounded-lg border border-border bg-background-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
          : undefined
      }
      aria-labelledby={
        presentation === "card" ? `${config.id}-connection-title` : undefined
      }
    >
      <div
        className={
          presentation === "card"
            ? "flex flex-wrap items-start justify-between gap-3 px-4 py-4"
            : "flex flex-wrap justify-end gap-2"
        }
      >
        {presentation === "card" ? (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id={`${config.id}-connection-title`}
                className="text-sm font-medium text-foreground"
              >
                {config.displayName}
              </h3>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
              {app?.experimental ? (
                <StatusPill tone="info">Pilot</StatusPill>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-foreground-muted">
              {config.description}
            </p>
            {app?.status === "connected" && accountLabel ? (
              <p className="mt-2 text-xs text-foreground-muted">
                {app.account?.workspaceName
                  ? `Connected to ${app.account.workspaceName} as ${accountLabel}`
                  : `Connected as ${accountLabel}`}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex shrink-0 gap-2">
          {presentation === "card" ? (
            <ConnectionDisclosureControl
              expanded={disclosure.expanded}
              detailsId={disclosure.detailsId}
              onToggle={disclosure.toggle}
            />
          ) : null}
          {presentation === "card" ? personalActions : null}
        </div>
      </div>
      <div
        id={presentation === "card" ? disclosure.detailsId : undefined}
        hidden={presentation === "card" && !disclosure.expanded}
        className={
          presentation === "card"
            ? "border-t border-border/60 px-4 py-4"
            : "mt-4"
        }
      >
        {!app ? (
          <p className="text-xs text-foreground-muted">
            Checking {config.displayName} availability…
          </p>
        ) : null}
        {presentation === "detail" && app ? (
          <section className="space-y-3" aria-labelledby={`${config.id}-personal-account`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id={`${config.id}-personal-account`}
                className="text-sm font-semibold text-foreground"
              >
                Your {config.displayName} account
              </h3>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            </div>
            <p className="text-sm text-foreground-muted">
              Genie uses only the {config.displayName} workspace and permissions you approve.
            </p>
            {app.status === "connected" && accountLabel ? (
              <div className="rounded-lg border border-border bg-background-element p-4">
                <p className="text-sm font-medium text-foreground">
                  {accountLabel}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {app.account?.workspaceName
                    ? `${app.account.workspaceName} · Connected to ${config.displayName}`
                    : `Connected to ${config.displayName}`}
                </p>
              </div>
            ) : null}
            {personalActions}
          </section>
        ) : null}
        {app?.status === "connecting" ? (
          <div className="mt-3 space-y-1 text-xs text-foreground-muted">
            <p>
              Finish signing in to {config.displayName} in your default browser. You can close
              or reload this page; Nautilo will resume checking this attempt.
            </p>
            <p>
              If {config.displayName} reports an error, return here and choose Start over
              immediately. You do not need to wait for this attempt to expire.
            </p>
          </div>
        ) : null}
        {app?.status === "connected" ? (
          <div className="mt-4 space-y-3">
            <ul className="grid gap-2 text-xs text-foreground-muted sm:grid-cols-3">
              {app.capabilities.map((capability) => (
                <li
                  key={capability.operationId}
                  className="rounded-md border border-border/60 bg-background px-3 py-2"
                >
                  <span className="font-medium text-foreground">
                    {capability.label}
                  </span>
                  <span className="mt-1 block text-foreground-dim">
                    {capability.requiresApproval
                      ? "Asks before writing"
                      : "Available to Genie"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-foreground-dim">{app.custodyLabel}</p>
            {app.limitation ? (
              <p className="text-xs text-foreground-dim">{app.limitation}</p>
            ) : null}
            {onTryWithGenie ? (
              <p className="text-xs text-foreground-dim">
                {config.tryDescription}
              </p>
            ) : null}
          </div>
        ) : null}
        {app &&
        !app.providerReady &&
        app.driverKind !== "openconnector_local" ? (
          <p className="text-xs text-foreground-muted">
            The managed connection service is unavailable. Contact your Nautilo
            administrator.
          </p>
        ) : null}
        {app?.driverKind === "openconnector_local" &&
        (app.canManageProviderSetup || !app.providerReady) ? (
          <section
            className="mt-5 space-y-3 border-t border-border pt-5"
            aria-labelledby={`${config.id}-server-setup`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3
                  id={`${config.id}-server-setup`}
                  className="text-sm font-semibold text-foreground"
                >
                  Server setup
                </h3>
                <StatusPill
                  tone={
                    app.providerSetupStatus === "ready"
                      ? "ok"
                      : app.providerSetupStatus === "error"
                        ? "error"
                        : app.canManageProviderSetup
                          ? "warn"
                          : "muted"
                  }
                >
                  {app.providerSetupStatus === "ready"
                    ? "Configured"
                    : app.providerSetupStatus === "error"
                      ? "Needs repair"
                      : app.canManageProviderSetup
                        ? "Setup required"
                        : "Waiting for administrator"}
                </StatusPill>
              </div>
              {app.canManageProviderSetup &&
              app.providerSetupStatus === "ready" &&
              !showSetupForm ? (
                <Button onClick={() => setShowSetupForm(true)}>
                  Repair setup
                </Button>
              ) : null}
            </div>
            {!app.canManageProviderSetup ? (
              <p className="text-xs text-foreground-muted">
                You can connect after an administrator finishes setup here.
              </p>
            ) : null}
            {app.canManageProviderSetup &&
            (app.providerSetupStatus !== "ready" || showSetupForm) ? (
              <div className="space-y-3">
                <p className="text-xs text-foreground-muted">
                  Register one {config.displayName} OAuth application for this server, paste
                  its credentials below, then save and verify. Every user
                  authorizes their own account afterward.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button loading={busy} onClick={() => void saveSetup(true)}>
                    Use existing OpenConnector setup
                  </Button>
                  <span className="text-xs text-foreground-dim">
                    If {config.displayName} is already configured in OpenConnector, Nautilo
                    can verify and adopt it without asking for the OAuth secret
                    again.
                  </span>
                </div>
                {setup?.callbackUrl ? (
                  <FieldRow
                    label="OAuth callback"
                    hint={`Add this exact redirect URI to the ${config.displayName} OAuth application.`}
                  >
                    <TextInput
                      value={setup.callbackUrl}
                      onChange={() => {}}
                      readOnly
                      ariaLabel="OAuth callback URL"
                    />
                  </FieldRow>
                ) : null}
                {setup?.oauthScopes.length ? (
                  <FieldRow
                    label="OAuth scopes"
                    hint={`These are the permissions ${config.displayName} will request for this connection.`}
                  >
                    <TextInput
                      value={setup.oauthScopes.join(" ")}
                      onChange={() => {}}
                      readOnly
                      ariaLabel="OAuth scopes"
                    />
                  </FieldRow>
                ) : null}
                <FieldRow label="Client ID" htmlFor={`${config.id}-client-id`}>
                  <TextInput
                    id={`${config.id}-client-id`}
                    value={clientId}
                    onChange={setClientId}
                    autoComplete="off"
                  />
                </FieldRow>
                <FieldRow
                  label="Client secret"
                  htmlFor={`${config.id}-client-secret`}
                  hint="Sent directly to your OpenConnector runtime; Nautilo does not retain it."
                >
                  <TextInput
                    id={`${config.id}-client-secret`}
                    type="password"
                    value={clientSecret}
                    onChange={setClientSecret}
                    autoComplete="new-password"
                  />
                </FieldRow>
                {config.acceptsAdminToken ? (
                  <FieldRow
                    label="OpenConnector admin token"
                    htmlFor={`${config.id}-openconnector-admin-token`}
                    hint={
                      setup?.adminAuthenticationConfigured
                        ? "Already stored in Nautilo's vault. Leave blank to keep it."
                        : "Only needed if your OpenConnector admin API requires one."
                    }
                  >
                    <TextInput
                      id={`${config.id}-openconnector-admin-token`}
                      type="password"
                      value={adminToken}
                      onChange={setAdminToken}
                      autoComplete="new-password"
                    />
                  </FieldRow>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!clientId || !clientSecret}
                    onClick={() => void saveSetup(false)}
                  >
                    {app.providerSetupStatus === "error"
                      ? "Repair setup"
                      : "Save and verify"}
                  </Button>
                  <a
                    className="text-xs text-accent hover:underline"
                    href={config.setupUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {config.setupLinkLabel}
                  </a>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
        {app?.lastErrorCode ? (
          <p className="text-xs text-[var(--warning)]">
            {recovery(app.lastErrorCode, config.displayName)}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-[var(--error)]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

type ConnectedAppSectionProps = Readonly<{
  routeHash?: string;
  routeKey?: string;
  onTryWithGenie?: () => Promise<void>;
  presentation?: ConnectedAppPresentation;
  onCatalogueSummary?: (summary: ConnectedAppCatalogueSummary) => void;
}>;

export function ConnectedAppConnectionSection({
  provider,
  ...props
}: ConnectedAppSectionProps & Readonly<{ provider: ConnectedAppDescriptor }>) {
  const writes = provider.capabilities.filter((capability) => capability.effect === "write");
  const config: ConnectedAppSectionConfig = {
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    setupUrl: provider.providerSetupUrl,
    setupLinkLabel: `Open ${provider.displayName} setup`,
    tryDescription: writes.length > 0
      ? `Try with Genie uses the connected ${provider.displayName} account. Read operations run directly; writes ask for approval and are never blindly retried.`
      : `Try with Genie uses the connected ${provider.displayName} account for the listed read operations.`,
    acceptsAdminToken: provider.acceptsAdminToken,
  };
  return <OAuthConnectedAppSection config={config} {...props} />;
}
