import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  localMcpInstallFailure,
  type ConnectedAppDescriptor,
  type LocalMcpInstallFailureCode,
} from "@nautilo/types";
import { useAuth } from "../../hooks/use-auth";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { apiClient } from "../../lib/api";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import {
  Button,
  GuestPlaceholder,
  StatusPill,
  TextInput,
} from "../settings/ui";
import { GitHubCliConnectionSection } from "./github-cli-connection-section";
import { CodexConnectionSection } from "./codex-connection-section";
import { ClaudeConnectionSection } from "./claude-connection-section";
import { StructuredSshConnectionSection } from "./structured-ssh-connection-section";
import { HermesConnectionSection } from "./hermes-connection-section";
import { ConnectionGroup } from "./connection-group";
import {
  ConnectionDisclosureControl,
  useConnectionDisclosure,
} from "./connection-disclosure";
import { ComputerUseConnectionSection } from "./computer-use-connection-section";
import { ConnectedAppsCatalogue } from "./connected-apps-catalogue";
import { WebsiteAccountCatalogueSection } from "./website-account-catalogue-section";
import { isDesktop } from "../../lib/desktop";
import {
  deleteMcpServer,
  checkLocalMcpServer,
  fetchMcpServers,
  fetchMcpServerTools,
  setMcpServerEnabled,
  setMcpServerToolEnabled,
  type McpServer,
  type McpTool,
} from "../../lib/mcp-servers-api";
import {
  describeServer,
  healthDot,
  rowDisplay,
  serverTier,
} from "./connections-view-model";
import {
  advancedMcpSetupHandoffInput,
  defaultMcpSetupHandoffInput,
  fixLocalMcpHandoffInput,
  normalizeMcpConfigJson,
  sendMcpSetupToGenie,
} from "./genie-mcp-setup";
import {
  GenieHandoffPartialSuccessError,
  type LocalMcpHandoffInput,
} from "../../lib/genie-handoff";
import { sendOrdinaryRoomMessage } from "../../lib/ordinary-room-message";
import { useWorkbenchUiTargetReveal } from "../../lib/genie-application-targets";
import {
  CONNECTIONS_SECTIONS,
  connectionSectionForHash,
  type ConnectionCardId,
  isConnectionCardVisible,
  type ConnectionsSectionId,
} from "./connections-sections";

const LOCAL_MCP_FAILURE_CODES = new Set<LocalMcpInstallFailureCode>([
  "invalid_request",
  "approval_stale",
  "relay_unavailable",
  "relay_protocol_unsupported",
  "missing_launcher",
  "missing_environment",
  "install_in_progress",
  "spawn_failed",
  "protocol_failed",
  "discovery_timeout",
  "empty_toolset",
  "rollback_unconfirmed",
  "internal",
]);

function localMcpRecovery(code: string | null | undefined): string {
  return code && LOCAL_MCP_FAILURE_CODES.has(code as LocalMcpInstallFailureCode)
    ? localMcpInstallFailure(code as LocalMcpInstallFailureCode).recovery
    : "Ask Genie to check this MCP and help reconnect it.";
}

function checkTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function mcpSummary(
  servers: readonly McpServer[],
  loading: boolean,
  unavailable: boolean,
): string | null {
  if (loading) return "Loading MCPs…";
  if (unavailable) return "MCPs unavailable";
  if (servers.length === 0) return "No MCPs";
  const enabled = servers.filter((server) => server.enabled).length;
  const attention = servers.filter(
    (server) =>
      server.lastCheckStatus === "failed" ||
      server.lastCheckStatus === "needs_attention",
  ).length;
  return attention > 0
    ? `${enabled} enabled · ${attention} need attention`
    : `${enabled} enabled`;
}

export async function sendConnectedAppTestToGenie(input: {
  provider: ConnectedAppDescriptor;
  scopeRoomId: string;
  sendMessage: (roomId: string, body: { content: string }) => Promise<unknown>;
  roomNavigation: Pick<
    ReturnType<typeof useRoomNavigation>,
    "refreshRooms" | "setActiveRoom"
  >;
}): Promise<void> {
  const reads = input.provider.capabilities
    .filter((capability) => capability.effect === "read")
    .map((capability) => `${capability.label} (${capability.operationId})`);
  const writes = input.provider.capabilities
    .filter((capability) => capability.effect === "write")
    .map((capability) => `${capability.label} (${capability.operationId})`);
  await input.sendMessage(input.scopeRoomId, {
    content:
      `Use my connected ${input.provider.displayName} account. Discover and activate only its curated connected-app tools. ` +
      `The admitted read operations are: ${reads.length ? reads.join(", ") : "none"}. ` +
      `The admitted write operations are: ${writes.length ? writes.join(", ") : "none"}. ` +
      "Start with a useful read-only demonstration and ask me for any missing target or choice. " +
      (writes.length
        ? "If a write would demonstrate value, propose one harmless, narrowly scoped action and obtain my explicit approval before executing it once. Report the execution and reconciliation receipts, and never repeat a write when reconciliation is unconfirmed. "
        : "Do not attempt a write. ") +
      "Do not use unlisted operations or change anything else.",
  });
  try {
    await input.roomNavigation.refreshRooms();
    input.roomNavigation.setActiveRoom(input.scopeRoomId);
  } catch {
    throw new GenieHandoffPartialSuccessError(input.scopeRoomId);
  }
}

function ToggleSwitch({
  enabled,
  disabled,
  onChange,
  label,
  size = "md",
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: "sm" | "md";
}) {
  const track = size === "sm" ? "h-4 w-7" : "h-5 w-9";
  const knob = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  const knobOn = size === "sm" ? "translate-x-3.5" : "translate-x-4";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors ${track} ${enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block rounded-full bg-background shadow transition-transform ${knob} ${enabled ? knobOn : "translate-x-0.5"}`}
      />
    </button>
  );
}

function ToolList({
  server,
  onChanged,
}: {
  server: McpServer;
  onChanged: () => void;
}) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTools(await fetchMcpServerTools(server.name, server.host));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [server.host, server.name]);

  useEffect(() => void load(), [load]);

  const toggle = async (tool: McpTool, enabled: boolean) => {
    setBusyTool(tool.name);
    try {
      await setMcpServerToolEnabled(
        server.name,
        tool.name,
        enabled,
        server.host,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyTool(null);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-background-element/40 px-3 py-2">
      {error ? (
        <p className="text-xs text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : tools === null ? (
        <p className="text-xs text-foreground-muted">Loading tools…</p>
      ) : tools.length === 0 ? (
        <p className="text-xs text-foreground-dim">No tools discovered.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tools.map((tool) => (
            <li
              key={tool.name}
              className="flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                  {tool.name}
                </div>
                {tool.description ? (
                  <div className="truncate text-xs text-foreground-dim">
                    {tool.description}
                  </div>
                ) : null}
              </div>
              <ToggleSwitch
                size="sm"
                enabled={tool.enabled}
                disabled={busyTool === tool.name}
                onChange={(next) => void toggle(tool, next)}
                label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LocalMcpRow({
  server,
  busy,
  onToggle,
  onRemove,
  onCheck,
  onFix,
  onChanged,
}: {
  server: McpServer;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onCheck: () => void;
  onFix: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = rowDisplay(server);
  const health = healthDot(server.health);
  const checked = checkTime(server.lastCheckedAt);
  const needsRecovery =
    server.lastCheckStatus === "needs_attention" ||
    server.lastCheckStatus === "failed" ||
    server.lastCheckStatus === "ready";
  const missingEnvironment = server.lastCheckMissingEnvironment ?? [];
  const recoveryTitle =
    server.lastCheckStatus === "needs_attention"
      ? "Needs attention"
      : server.lastCheckStatus === "ready"
        ? "Prerequisites ready"
        : "Setup failed";
  const recoveryText =
    server.lastCheckStatus === "ready"
      ? "This machine has the required launcher and environment. Retry with Genie to reconnect and verify its tools."
      : missingEnvironment.length > 0
        ? `Missing environment variables on this machine: ${missingEnvironment.join(", ")}.`
        : localMcpRecovery(server.lastCheckFailureCode);
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded px-1 text-foreground-muted hover:text-foreground"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide MCP details" : "Show MCP details"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▾" : "▸"}
        </button>
        {health ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: health.color }}
            title={health.label}
          />
        ) : null}
        <span className="truncate text-sm font-semibold">{server.name}</span>
        <StatusPill tone="info">{display.transportLabel}</StatusPill>
        {typeof server.toolCount === "number" ? (
          <span className="text-xs text-foreground-muted">
            {server.toolCount} tools
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="text-xs text-[var(--error)] hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
          <ToggleSwitch
            enabled={server.enabled}
            disabled={busy}
            onChange={onToggle}
            label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          />
        </div>
      </div>
      <p className="mt-1 truncate pl-7 text-xs text-foreground-muted">
        {describeServer(server)}
      </p>
      {needsRecovery ? (
        <div
          className={`ml-7 mt-3 rounded-md border p-3 ${server.lastCheckStatus === "failed" ? "border-[var(--error)]/40 bg-[var(--error)]/5" : "border-[var(--warning)]/40 bg-[var(--warning)]/5"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={server.lastCheckStatus === "failed" ? "error" : "warn"}
            >
              {recoveryTitle}
            </StatusPill>
            {checked ? (
              <span className="text-xs text-foreground-dim">
                Checked {checked}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-foreground-muted">{recoveryText}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={onCheck}
            >
              Check again
            </button>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={onFix}
            >
              Fix with Genie
            </button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        <div className="pl-7">
          <p className="mt-2 text-xs text-foreground-dim">
            Runs on this machine through the Nautilo relay. Removing it deletes
            the Nautilo connection only; it does not uninstall packages or
            delete files.
          </p>
          {server.lastCheckStatus === "connected" && checked ? (
            <p className="mt-1 text-xs text-foreground-dim">
              Last successful check: {checked}.
            </p>
          ) : null}
          <ToolList server={server} onChanged={onChanged} />
        </div>
      ) : null}
    </li>
  );
}

function AdvancedJsonDialog({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (input: LocalMcpHandoffInput) => void;
  busy: boolean;
}) {
  const [json, setJson] = useState(
    '{\n  "mcpServers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "@scope/server"]\n    }\n  }\n}',
  );
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    try {
      setError(null);
      onSubmit(advancedMcpSetupHandoffInput(normalizeMcpConfigJson(json)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-background-panel p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-mcp-title"
      >
        <h2 id="advanced-mcp-title" className="text-lg font-semibold">
          Advanced MCP setup
        </h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Paste standard MCP configuration JSON. It will be validated, stripped
          down to safe setup data, and sent to Genie for the same exact install
          approval.
        </p>
        <textarea
          className="mt-4 h-72 w-full rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          spellCheck={false}
          aria-label="MCP configuration JSON"
        />
        <p className="mt-2 text-xs text-foreground-dim">
          Use environment placeholders such as <code>{"${GITHUB_TOKEN}"}</code>.
          Literal secrets and HTTP headers are rejected.
        </p>
        {error ? (
          <p className="mt-2 text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Continue with Genie
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectionsPage() {
  const auth = useAuth();
  const roomNavigation = useRoomNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ name?: string }>();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [mcpLoadError, setMcpLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(params.name === "new");
  const [launching, setLaunching] = useState(false);
  const launchingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeSection, setActiveSection] =
    useState<ConnectionsSectionId>("agent-harnesses");
  useWorkbenchUiTargetReveal("connections.google", true, undefined, {
    scroll: false,
  });
  useWorkbenchUiTargetReveal("connections.local_mcp");
  useWorkbenchUiTargetReveal("connections.github_cli");

  const refresh = useCallback(async () => {
    const list = await fetchMcpServers();
    setServers(list.filter((server) => serverTier(server) === "local"));
    setMcpLoadError(null);
  }, []);

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh()
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setMcpLoadError(message);
        setError(message);
      })
      .finally(() => setLoading(false));
  }, [auth.viewer.isVerified, refresh]);

  const launchGenie = async (input: LocalMcpHandoffInput) => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    setLaunching(true);
    setError(null);
    try {
      await sendMcpSetupToGenie({ apiClient, roomNavigation, input });
    } catch (cause) {
      setError(
        cause instanceof GenieHandoffPartialSuccessError
          ? "Message sent to Genie, but the Room could not open. Refresh your Rooms list to find it; do not resend."
          : "Could not start Genie setup. Try again.",
      );
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  const tryConnectedAppWithGenie = async (
    provider: ConnectedAppDescriptor,
    scopeRoomId: string,
  ) => {
    await sendConnectedAppTestToGenie({
      provider,
      scopeRoomId,
      sendMessage: (roomId, body) => sendOrdinaryRoomMessage(apiClient, roomId, body),
      roomNavigation,
    });
  };

  const toggle = async (server: McpServer) => {
    setBusy(server.name);
    setError(null);
    try {
      await setMcpServerEnabled(server.name, !server.enabled, server.host);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const check = async (server: McpServer) => {
    setBusy(server.name);
    setError(null);
    try {
      await checkLocalMcpServer(server.name, server.host);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const fixWithGenie = (server: McpServer) => {
    try {
      void launchGenie(
        fixLocalMcpHandoffInput({
          name: server.name,
          failureCode: server.lastCheckFailureCode,
          missingEnvironment: server.lastCheckMissingEnvironment,
        }),
      );
    } catch {
      setError("Could not start Genie setup. Try again.");
    }
  };

  const remove = async (server: McpServer) => {
    if (
      !window.confirm(
        `Remove “${server.name}” from Nautilo on this Mac? Packages and files will not be deleted.`,
      )
    )
      return;
    setBusy(server.name);
    setError(null);
    try {
      await deleteMcpServer(server.name, server.host);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const visibleServers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? servers.filter((server) =>
          server.name.toLowerCase().includes(normalized),
        )
      : servers;
  }, [query, servers]);

  const summary = mcpSummary(servers, loading, mcpLoadError !== null);
  const localMcpDisclosure = useConnectionDisclosure({
    cardId: "local-mcp",
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen: error !== null || busy !== null || launching || showAdvanced,
    routeHash: location.hash,
    routeKey: location.key,
  });

  // Category and preserved card hashes share one resolver. Card-specific
  // reveal hooks still own their focus/spotlight behavior; this settles the
  // sidebar's active category for every history navigation.
  useEffect(() => {
    const section = connectionSectionForHash(location.hash);
    if (!section) return;
    const targetId = location.hash.replace(/^#/, "");
    const shellOwnsFocus =
      targetId === section ||
      targetId === "hermes-acp" ||
      targetId === "computer-use";
    setActiveSection(section);
    if (!shellOwnsFocus) return;
    const timer = window.setTimeout(() => {
      const root = rootRef.current;
      const target = root?.querySelector(`#${targetId}`) as HTMLElement | null;
      const category = root?.querySelector(`#${section}`) as HTMLElement | null;
      (target ?? category)?.scrollIntoView({
        behavior: "auto",
        block: "start",
      });
      (target ?? category)?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location.hash, location.key]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0])
          setActiveSection(visible[0].target.id as ConnectionsSectionId);
      },
      { root, rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    for (const section of CONNECTIONS_SECTIONS) {
      const element = root.querySelector(`#${section.id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const scrollToSection = useCallback(
    (id: ConnectionsSectionId) => {
      setActiveSection(id);
      void navigate({
        pathname: location.pathname,
        search: location.search,
        hash: `#${id}`,
      });
    },
    [location.pathname, location.search, navigate],
  );

  const selectConnectedApp = useCallback(
    (appId: string) => {
      void navigate({
        pathname: location.pathname,
        search: location.search,
        hash: `#${appId}`,
      });
    },
    [location.pathname, location.search, navigate],
  );

  const returnToConnectedApps = useCallback(() => {
    void navigate({
      pathname: location.pathname,
      search: location.search,
      hash: "#apps-and-accounts",
    });
  }, [location.pathname, location.search, navigate]);

  const renderConnectionCard = (cardId: ConnectionCardId) => {
    switch (cardId) {
      case "codex":
        return <CodexConnectionSection key={cardId} />;
      case "claude":
        return <ClaudeConnectionSection key={cardId} />;
      case "hermes-acp":
        return <HermesConnectionSection key={cardId} />;
      case "google":
        return null;
      case "computer-use":
        return (
          <ComputerUseConnectionSection
            key={cardId}
            routeHash={location.hash}
            routeKey={location.key}
          />
        );
      case "github-cli":
        return (
          <GitHubCliConnectionSection
            key={cardId}
            routeHash={location.hash}
            routeKey={location.key}
          />
        );
      case "ssh":
        return (
          <StructuredSshConnectionSection
            key={cardId}
            routeHash={location.hash}
            routeKey={location.key}
          />
        );
      case "local-mcp":
        return (
          <div
            key={cardId}
            id="local-mcp"
            tabIndex={-1}
            className="scroll-mt-6 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <div className="flex flex-wrap justify-end gap-2 px-1">
              <Button variant="secondary" onClick={() => setShowAdvanced(true)}>
                Advanced JSON
              </Button>
              <Button
                variant="primary"
                loading={launching}
                onClick={() => void launchGenie(defaultMcpSetupHandoffInput())}
              >
                Set up with Genie
              </Button>
            </div>
            <div
              id={localMcpDisclosure.detailsId}
              hidden={!localMcpDisclosure.expanded}
              className="mt-3 space-y-3"
            >
              {error ? (
                <p className="text-sm text-[var(--error)]" role="alert">
                  {error}
                </p>
              ) : null}
              <TextInput
                id="mcp-search"
                value={query}
                onChange={setQuery}
                placeholder="Search MCP servers…"
                ariaLabel="Search MCP servers"
              />
              <div className="rounded-lg border border-border bg-background-panel">
                {loading ? (
                  <div className="px-5 py-6 text-center text-sm text-foreground-muted">
                    Loading local MCPs…
                  </div>
                ) : visibleServers.length === 0 ? (
                  <div className="px-5 py-6 text-center">
                    <p className="text-sm text-foreground-muted">
                      {servers.length === 0
                        ? "No local MCPs yet."
                        : "No MCPs match your search."}
                    </p>
                    {servers.length === 0 ? (
                      <p className="mt-1 text-xs text-foreground-dim">
                        Tell Genie what you want to connect—even a rough name or
                        URL is enough to start.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {visibleServers.map((server) => (
                      <LocalMcpRow
                        key={`${server.host}:${server.name}`}
                        server={server}
                        busy={busy === server.name || launching}
                        onToggle={() => void toggle(server)}
                        onRemove={() => void remove(server)}
                        onCheck={() => void check(server)}
                        onFix={() => void fixWithGenie(server)}
                        onChanged={() => void refresh()}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        );
    }
  };

  if (!auth.viewer.isVerified)
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <GuestPlaceholder what="Connections" />
      </div>
    );

  return (
    <div className="flex h-full min-h-0" data-testid="connections-page">
      <nav
        aria-label="Connections sections"
        className="hidden w-48 shrink-0 border-r border-border px-3 py-4 md:block"
      >
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-foreground-dim">
          Connections
        </div>
        <ul className="flex flex-col gap-0.5">
          {CONNECTIONS_SECTIONS.map((section) => {
            const active = activeSection === section.id;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => scrollToSection(section.id)}
                  aria-current={active ? "true" : undefined}
                  className={[
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-background-element font-medium text-foreground"
                      : "text-foreground-muted hover:bg-background-element hover:text-foreground",
                  ].join(" ")}
                >
                  {section.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div ref={rootRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">
              Connections
            </h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Agent harnesses, apps, MCPs, and accounts available to your Genie.
            </p>
          </header>
          {CONNECTIONS_SECTIONS.map((section) => (
            <ConnectionGroup
              key={section.id}
              id={section.id}
              title={section.label}
              description={section.description}
              summary={section.id === "mcp-servers" ? summary : null}
              actions={
                section.id === "mcp-servers" ? (
                  <ConnectionDisclosureControl
                    expanded={localMcpDisclosure.expanded}
                    detailsId={localMcpDisclosure.detailsId}
                    onToggle={localMcpDisclosure.toggle}
                  />
                ) : null
              }
            >
              {section.id === "apps-and-accounts" ? (
                <ConnectedAppsCatalogue
                  routeHash={location.hash}
                  routeKey={location.key}
                  onSelectApp={selectConnectedApp}
                  onBackToApps={returnToConnectedApps}
                  onTryWithGenie={tryConnectedAppWithGenie}
                />
              ) : section.id === "websites" ? (
                <WebsiteAccountCatalogueSection />
              ) : (
                section.cards
                  .filter((card) => isConnectionCardVisible(card.id, isDesktop))
                  .map((card) => renderConnectionCard(card.id))
              )}
            </ConnectionGroup>
          ))}

          {showAdvanced ? (
            <AdvancedJsonDialog
              busy={launching}
              onClose={() => {
                setShowAdvanced(false);
                if (params.name === "new")
                  void navigate("/connections", { replace: true });
              }}
              onSubmit={(request) => void launchGenie(request)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
