import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useAuth } from "../../../hooks/use-auth";
import { workbenchFetch } from "../../../lib/admission-fetch";
import {
  desktopAPI,
  isDesktop,
  type GoogleWorkspaceAuthStatus,
} from "../../../lib/desktop";
import { stableViewerKeyForStorage } from "../../../rooms/room-navigation-storage";
import { Button, FieldRow, SectionCard, StatusPill, TextInput } from "../ui";
import {
  ConnectionDisclosureControl,
  useConnectionDisclosure,
} from "../../connections/connection-disclosure";
import type {
  ConnectedAppCatalogueSummary,
  ConnectedAppPresentation,
} from "../../connections/connected-app-presentation";

type ServerGoogleStatus = {
  configured: boolean;
  providerSetupStatus: "managed" | "setup_required" | "ready";
  canManageProviderSetup: boolean;
  clientId?: string;
};

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      server: ServerGoogleStatus;
      desktop: GoogleWorkspaceAuthStatus | null;
    }
  | { kind: "error"; message: string };

function googleConnectFailureMessage(reason?: string): string {
  switch (reason) {
    case "google_auth_cancelled":
      return "Google connection was cancelled. Nothing was changed.";
    case "google_auth_timed_out":
      return "Google sign-in timed out. Try connecting again.";
    case "not_configured_on_server":
      return "An administrator must configure Google Workspace first.";
    case "capability_missing":
      return "Your Nautilo account is not allowed to use Google Workspace.";
    case "not_signed_in":
      return "Sign in to Nautilo again, then retry the Google connection.";
    case "gog_missing":
      return "This Nautilo Desktop build does not include Google Workspace support.";
    case "gog_credentials_set_failed":
    case "fetch_failed":
      return "Nautilo could not prepare the Google connection. Try again.";
    case "invalid_email":
      return "Enter a valid Google account email.";
    default:
      return "Google account connection failed. Try again.";
  }
}

export function IntegrationsSection({
  routeHash,
  routeKey,
  presentation = "card",
  onCatalogueSummary,
}: {
  routeHash?: string;
  routeKey?: string;
  presentation?: ConnectedAppPresentation;
  onCatalogueSummary?: (summary: ConnectedAppCatalogueSummary) => void;
} = {}) {
  const auth = useAuth();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const canConfigureServer =
    state.kind === "ready" && state.server.canManageProviderSetup;
  const [email, setEmail] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState(false);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const disclosure = useConnectionDisclosure({
    cardId: "google",
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen:
      state.kind === "error" ||
      connectBusy ||
      disconnectBusy ||
      connectError !== null ||
      uploadBusy ||
      uploadError !== null,
    routeHash,
    routeKey,
  });

  const load = useCallback(async () => {
    try {
      const token = await auth.session?.getAccessToken();
      if (!token) {
        setState({ kind: "error", message: "Not signed in." });
        return;
      }

      const res = await workbenchFetch("/api/integrations/google/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Server status failed (${res.status}).`);
      }
      const server = (await res.json()) as ServerGoogleStatus;

      let desktop: GoogleWorkspaceAuthStatus | null = null;
      if (isDesktop && desktopAPI?.googleWorkspace?.authStatus) {
        desktop = await desktopAPI.googleWorkspace.authStatus();
      }

      setState({ kind: "ready", server, desktop });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to load integration status.",
      });
    }
  }, [auth.session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onConnect(accountEmail?: string) {
    const trimmed = (accountEmail ?? email).trim();
    if (!trimmed) {
      setConnectError("Enter your Google account email.");
      return;
    }
    if (!isDesktop || !desktopAPI?.googleWorkspace?.connect) {
      setConnectError(
        "Open the Nautilo desktop app to connect Google Workspace.",
      );
      return;
    }
    setConnectBusy(true);
    setConnectError(null);
    setConnectSuccess(false);
    try {
      const result = await desktopAPI.googleWorkspace.connect({
        email: trimmed,
      });
      if (!result.ok) {
        setConnectError(googleConnectFailureMessage(result.reason));
        return;
      }
      setConnectSuccess(true);
      setEmail("");
      setShowAccountForm(false);
      await load();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Connect failed.");
    } finally {
      setConnectBusy(false);
    }
  }

  async function onDisconnect(accountEmail: string) {
    if (!isDesktop || !desktopAPI?.googleWorkspace?.disconnect) {
      setConnectError(
        "Open the Nautilo desktop app to disconnect Google Workspace.",
      );
      return;
    }
    setDisconnectBusy(true);
    setConnectError(null);
    setConnectSuccess(false);
    try {
      const result = await desktopAPI.googleWorkspace.disconnect({
        email: accountEmail,
      });
      if (!result.ok) {
        setConnectError(result.reason || "Disconnect failed.");
        return;
      }
      setEmail("");
      setShowAccountForm(false);
      await load();
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : "Disconnect failed.",
      );
    } finally {
      setDisconnectBusy(false);
    }
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".json") && file.type !== "application/json") {
      setUploadError("Upload a Google OAuth client JSON file (.json).");
      event.target.value = "";
      return;
    }

    setUploadBusy(true);
    setUploadError(null);
    try {
      const token = await auth.session.getAccessToken();
      if (!token) throw new Error("Not signed in.");
      const form = new FormData();
      form.append("file", file);
      const response = await workbenchFetch("/api/integrations/google/oauth-client", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!response.ok) {
        let message = `Upload failed (${response.status}).`;
        try {
          const body = (await response.json()) as {
            error?: string;
            detail?: string;
          };
          if (body.detail) message = body.detail;
          else if (body.error) message = body.error;
        } catch {
          // Preserve the stable status-based fallback for non-JSON failures.
        }
        throw new Error(message);
      }
      await load();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploadBusy(false);
      event.target.value = "";
    }
  }

  function renderUploadButton(label: string) {
    return (
      <Button
        variant="secondary"
        loading={uploadBusy}
        disabled={uploadBusy}
        onClick={() => fileInputRef.current?.click()}
      >
        {label}
      </Button>
    );
  }

  function renderGoogleStatus() {
    if (state.kind === "loading") {
      return <p className="text-sm text-foreground-muted">Loading…</p>;
    }
    if (state.kind === "error") {
      return <p className="text-sm text-[var(--error)]">{state.message}</p>;
    }

    const { server, desktop } = state;

    if (!server.configured) {
      const managed = server.providerSetupStatus === "managed";
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">
                {canConfigureServer
                  ? "Set up Google Workspace for this server"
                  : managed
                    ? "Google Workspace is unavailable"
                    : "Google Workspace is not available yet"}
              </h3>
              <p className="max-w-2xl text-sm text-foreground-muted">
                {canConfigureServer
                  ? "Upload the OAuth client created for this Nautilo deployment. This is shared server configuration—not a person's Google login."
                  : managed
                    ? "The managed Google Workspace connection is not currently available. Contact your Nautilo administrator."
                    : "You can connect after an administrator finishes setup here."}
              </p>
            </div>
            {canConfigureServer ? (
              <span className="text-xs font-medium text-foreground-muted">
                Administrator only
              </span>
            ) : null}
          </div>
          {canConfigureServer ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-element p-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Google OAuth client JSON
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Created in Google Cloud for this organization or deployment.
                </p>
              </div>
              {renderUploadButton("Choose JSON")}
            </div>
          ) : null}
          {canConfigureServer ? (
            <p className="text-xs text-foreground-muted">
              Who may connect is controlled in Google Cloud through an Internal
              organization audience, test-user list, or published External app.
              The JSON itself does not contain email addresses.
            </p>
          ) : null}
          {uploadError ? (
            <p className="text-sm text-[var(--error)]">{uploadError}</p>
          ) : null}
        </div>
      );
    }

    const accounts = desktop?.connectedAccounts ?? [];
    const healthy = desktop?.healthy === true;
    const needsReconnect = accounts.length > 0 && !healthy;
    const account = accounts[0];

    const connectForm = (
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Connect your Google account
          </h3>
          <p className="text-sm text-foreground-muted">
            Use a Google account permitted by your organization&apos;s Google
            OAuth configuration. It does not need to match your Nautilo name or
            login.
          </p>
        </div>
        <FieldRow
          label="Google email to connect"
          hint="Used only to begin Google's sign-in and consent flow."
          htmlFor="google-workspace-email"
        >
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              id="google-workspace-email"
              value={email}
              onChange={setEmail}
              placeholder="name@company.com"
              disabled={connectBusy}
              type="text"
              inputMode="email"
              autoComplete="email"
            />
            <Button
              variant="primary"
              onClick={() => void onConnect()}
              loading={connectBusy}
              disabled={connectBusy}
            >
              Continue with Google
            </Button>
            {account ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setEmail("");
                  setConnectError(null);
                  setShowAccountForm(false);
                }}
                disabled={connectBusy}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </FieldRow>
      </div>
    );

    let personalConnection: ReactNode;
    if (!isDesktop || !desktopAPI?.googleWorkspace) {
      personalConnection = (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Connect in the desktop app
          </h3>
          <p className="text-sm text-foreground-muted">
            Open the Nautilo desktop app to connect your Google account on this
            device.
          </p>
        </div>
      );
    } else if (showAccountForm || accounts.length === 0) {
      personalConnection = connectForm;
    } else if (needsReconnect && account) {
      personalConnection = (
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              Reconnect your Google account
            </h3>
            <p className="text-sm text-foreground-muted">
              Your previous authorization expired. Reconnect the same account to
              restore Google access.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-element p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{account}</p>
              <p className="mt-1 text-xs text-foreground-muted">
                Authorization expired · No Google access until reconnected
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => void onConnect(account)}
              loading={connectBusy}
              disabled={connectBusy || disconnectBusy}
            >
              Reconnect
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEmail("");
                setConnectError(null);
                setShowAccountForm(true);
              }}
              disabled={connectBusy || disconnectBusy}
            >
              Use a different Google account
            </Button>
            <Button
              variant="ghost"
              onClick={() => void onDisconnect(account)}
              loading={disconnectBusy}
              disabled={connectBusy || disconnectBusy}
            >
              Remove account
            </Button>
          </div>
        </div>
      );
    } else if (healthy && account) {
      personalConnection = (
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              Your Google account
            </h3>
            <p className="text-sm text-foreground-muted">
              Genie can use the Google services you approved on this device.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background-element p-4">
            <p className="text-sm font-medium text-foreground">{account}</p>
            <p className="mt-1 text-xs text-foreground-muted">
              Google Workspace · Connected on this device
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEmail("");
                setConnectError(null);
                setShowAccountForm(true);
              }}
              disabled={connectBusy || disconnectBusy}
            >
              Change account
            </Button>
            <Button
              variant="ghost"
              onClick={() => void onDisconnect(account)}
              loading={disconnectBusy}
              disabled={connectBusy || disconnectBusy}
            >
              Disconnect
            </Button>
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-dim">
              Available to Genie
            </h4>
            <ul className="grid gap-2 text-xs text-foreground-muted sm:grid-cols-3">
              <li className="rounded-md border border-border/60 bg-background px-3 py-2">
                <span className="font-medium text-foreground">
                  Docs, Sheets, Drive, and Slides
                </span>
                <span className="mt-1 block text-foreground-dim">
                  Read files and presentation structure; make supported Docs
                  and Sheets edits with confirmation.
                </span>
              </li>
              <li className="rounded-md border border-border/60 bg-background px-3 py-2">
                <span className="font-medium text-foreground">Gmail</span>
                <span className="mt-1 block text-foreground-dim">
                  Search and read only. Sending is not exposed.
                </span>
              </li>
              <li className="rounded-md border border-border/60 bg-background px-3 py-2">
                <span className="font-medium text-foreground">Calendar</span>
                <span className="mt-1 block text-foreground-dim">
                  Read events and preview new events without creating them.
                </span>
              </li>
            </ul>
            <p className="text-xs text-foreground-dim">
              Your Google account authorization stays in this desktop runtime
              and is scoped to the connected account.
            </p>
          </div>
        </div>
      );
    } else {
      personalConnection = connectForm;
    }

    return (
      <div className="space-y-6">
        {personalConnection}

        {connectError ? (
          <p className="text-sm text-[var(--error)]">{connectError}</p>
        ) : null}
        {connectSuccess ? (
          <p className="text-sm text-[var(--success)]">
            Google Workspace connected.
          </p>
        ) : null}

        {canConfigureServer ? (
          <div className="space-y-3 border-t border-border pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Server setup
                  </h3>
                  <StatusPill tone="ok">Configured</StatusPill>
                </div>
                <p className="text-sm text-foreground-muted">
                  This deployment-wide OAuth client lets each authorized person
                  connect their own Google account.
                </p>
                {server.clientId ? (
                  <p className="text-xs text-foreground-muted">
                    OAuth client {server.clientId}
                  </p>
                ) : null}
              </div>
              {renderUploadButton("Replace JSON")}
            </div>
            {uploadError ? (
              <p className="text-sm text-[var(--error)]">{uploadError}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const catalogueSummary = useMemo<ConnectedAppCatalogueSummary>(() => {
    if (state.kind === "loading")
      return { state: "available", statusLabel: "Checking", tone: "muted" };
    if (state.kind === "error")
      return { state: "attention", statusLabel: "Unavailable", tone: "error" };
    if (!state.server.configured) {
      if (state.server.providerSetupStatus === "managed") {
        return {
          state: "attention",
          statusLabel: "Unavailable",
          tone: "error",
        };
      }
      return canConfigureServer
        ? { state: "attention", statusLabel: "Setup required", tone: "warn" }
        : {
            state: "available",
            statusLabel: "Waiting for administrator",
            tone: "muted",
          };
    }
    if (state.desktop?.healthy && state.desktop.connectedAccounts.length > 0) {
      return { state: "connected", statusLabel: "Connected", tone: "ok" };
    }
    if (state.desktop && state.desktop.connectedAccounts.length > 0) {
      return {
        state: "attention",
        statusLabel: "Reconnect required",
        tone: "warn",
      };
    }
    return { state: "available", statusLabel: "Not connected", tone: "muted" };
  }, [canConfigureServer, state]);

  useEffect(() => {
    onCatalogueSummary?.(catalogueSummary);
  }, [catalogueSummary, onCatalogueSummary]);

  const cardStatus =
    state.kind === "loading" ? (
      <StatusPill tone="muted">Loading</StatusPill>
    ) : state.kind === "error" ? (
      <StatusPill tone="warn">Unavailable</StatusPill>
    ) : !state.server.configured ? (
      <StatusPill tone={catalogueSummary.tone}>
        {catalogueSummary.statusLabel}
      </StatusPill>
    ) : (
      <StatusPill tone={catalogueSummary.tone}>
        {catalogueSummary.statusLabel}
      </StatusPill>
    );

  const contents = (
    <>
      {canConfigureServer ? (
        <input
          ref={fileInputRef}
          data-testid="google-oauth-client-input"
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => void onUpload(event)}
        />
      ) : null}
      <div>{renderGoogleStatus()}</div>
    </>
  );

  if (presentation === "detail") {
    return <div className="space-y-6">{contents}</div>;
  }

  return (
    <SectionCard
      id="integrations"
      title="Google Workspace"
      description="Connect Google services used by your Genie on this device."
      actions={
        <div className="flex items-center gap-2">
          {cardStatus}
          <ConnectionDisclosureControl
            expanded={disclosure.expanded}
            detailsId={disclosure.detailsId}
            onToggle={disclosure.toggle}
          />
        </div>
      }
    >
      <div
        id={disclosure.detailsId}
        hidden={!disclosure.expanded}
        className="space-y-6"
      >
        {contents}
      </div>
    </SectionCard>
  );
}
