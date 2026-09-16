import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createWorkbenchPortal as createPortal } from "../../components/workbench-portals";
import { ArrowLeft, Search, X } from "lucide-react";
import { Button, StatusPill } from "../settings/ui";
import { apiClient } from "../../lib/api";
import type { ConnectedAppDescriptor } from "@nautilo/types";
import { IntegrationsSection } from "../settings/sections/integrations-section";
import {
  ConnectedAppConnectionSection,
} from "./notion-connection-section";
import type {
  ConnectedAppCatalogueState,
  ConnectedAppCatalogueSummary,
} from "./connected-app-presentation";

type ConnectedAppId = string;
type ConnectedAppFilter = "all" | ConnectedAppCatalogueState;

type ConnectedAppDefinition = Readonly<{
  id: ConnectedAppId;
  displayName: string;
  shortMark: string;
  description: string;
  searchText: string;
  experimental: boolean;
  iconUrl: string | null;
}>;

const GOOGLE_APP: ConnectedAppDefinition =
  {
    id: "google",
    displayName: "Google Workspace",
    shortMark: "G",
    description: "Email, calendars, files, documents, and spreadsheets.",
    searchText:
      "google workspace gmail email calendar drive files documents docs sheets spreadsheets",
    experimental: false,
    iconUrl: null,
  };

function definition(provider: ConnectedAppDescriptor): ConnectedAppDefinition {
  return {
    id: provider.id,
    displayName: provider.displayName,
    shortMark: provider.shortMark,
    description: provider.description,
    searchText: [provider.displayName, ...provider.searchTerms,
      ...provider.capabilities.flatMap((capability) => [capability.label, capability.operationId])]
      .join(" ").toLocaleLowerCase(),
    experimental: provider.lifecycle === "pilot",
    iconUrl: provider.iconUrl,
  };
}

const CHECKING_SUMMARY: ConnectedAppCatalogueSummary = {
  state: "available",
  statusLabel: "Checking",
  tone: "muted",
};

const FILTERS: readonly Readonly<{ id: ConnectedAppFilter; label: string }>[] =
  [
    { id: "all", label: "All" },
    { id: "connected", label: "Connected" },
    { id: "attention", label: "Needs attention" },
    { id: "available", label: "Available" },
  ];

function appIdForHash(
  hash: string | undefined,
  apps: readonly ConnectedAppDefinition[],
): ConnectedAppId | null {
  const id = hash?.replace(/^#/, "");
  return id && apps.some((app) => app.id === id) ? id : null;
}

function AppIcon({ app }: { app: ConnectedAppDefinition }) {
  const [failed, setFailed] = useState(false);
  return app.iconUrl && !failed ? (
    <img
      src={app.iconUrl}
      alt=""
      className="h-6 w-6 object-contain"
      onError={() => setFailed(true)}
    />
  ) : <>{app.shortMark}</>;
}

function statusClass(summary: ConnectedAppCatalogueSummary): string {
  switch (summary.tone) {
    case "ok":
      return "text-[var(--success)]";
    case "warn":
      return "text-[var(--warning)]";
    case "error":
      return "text-[var(--error)]";
    case "info":
      return "text-accent";
    case "muted":
      return "text-foreground-muted";
  }
}

export function ConnectedAppsCatalogue({
  routeHash,
  routeKey,
  onSelectApp,
  onBackToApps,
  onTryWithGenie,
}: {
  readonly routeHash?: string;
  readonly routeKey?: string;
  readonly onSelectApp?: (appId: ConnectedAppId) => void;
  readonly onBackToApps?: () => void;
  readonly onTryWithGenie?: (
    provider: ConnectedAppDescriptor,
    scopeRoomId: string,
  ) => Promise<void>;
}) {
  const [providers, setProviders] = useState<readonly ConnectedAppDescriptor[]>([]);
  const [scopeRoomId, setScopeRoomId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<
    Record<ConnectedAppId, ConnectedAppCatalogueSummary>
  >({ google: CHECKING_SUMMARY });
  useEffect(() => {
    let active = true;
    void apiClient.listConnectedApps().then((result) => {
      if (!active) return;
      const ordered = [...result.apps].sort((left, right) =>
        left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      setProviders(ordered);
      setScopeRoomId(result.scopeRoomId);
      setSummaries((current) => Object.fromEntries([
        ["google", current["google"] ?? CHECKING_SUMMARY],
        ...ordered.map((provider) => [provider.id, current[provider.id] ?? CHECKING_SUMMARY] as const),
      ]));
    }).catch(() => {
      // Google remains usable when the remote connected-app catalogue is unavailable.
    });
    return () => { active = false; };
  }, []);
  const updateGoogleSummary = useCallback(
    (summary: ConnectedAppCatalogueSummary) => {
      setSummaries((current) =>
        current["google"] === summary ? current : { ...current, google: summary },
      );
    },
    [],
  );
  const updateProviderSummary = useCallback(
    (providerId: string, summary: ConnectedAppCatalogueSummary) => {
      setSummaries((current) =>
        current[providerId] === summary ? current : { ...current, [providerId]: summary },
      );
    },
    [],
  );
  const apps = useMemo(
    () => [GOOGLE_APP, ...providers.map(definition)],
    [providers],
  );
  const details: Readonly<Record<string, ReactNode>> = Object.fromEntries([
    ["google", (
      <IntegrationsSection
        presentation="detail"
        onCatalogueSummary={updateGoogleSummary}
      />
    )],
    ...providers.map((provider) => [provider.id, (
      <ConnectedAppConnectionSection
        provider={provider}
        presentation="detail"
        onCatalogueSummary={(summary) => updateProviderSummary(provider.id, summary)}
        onTryWithGenie={onTryWithGenie && scopeRoomId
          ? () => onTryWithGenie(provider, scopeRoomId)
          : undefined}
      />
    )] as const),
  ]);

  return (
    <ConnectedAppsCatalogueLayout
      routeHash={routeHash}
      routeKey={routeKey}
      onSelectApp={onSelectApp}
      onBackToApps={onBackToApps}
      apps={apps}
      summaries={summaries}
      details={details}
    />
  );
}

export function ConnectedAppsCatalogueLayout({
  routeHash,
  routeKey,
  onSelectApp,
  onBackToApps,
  apps,
  summaries,
  details,
}: {
  readonly routeHash?: string;
  readonly routeKey?: string;
  readonly onSelectApp?: (appId: ConnectedAppId) => void;
  readonly onBackToApps?: () => void;
  readonly apps: readonly ConnectedAppDefinition[];
  readonly summaries: Readonly<
    Record<ConnectedAppId, ConnectedAppCatalogueSummary>
  >;
  readonly details: Readonly<Record<string, ReactNode>>;
}) {
  const hashApp = appIdForHash(routeHash, apps);
  const [selected, setSelected] = useState<ConnectedAppId | null>(hashApp);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectedAppFilter>("all");
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null);
  const capturePortalTarget = useCallback(
    (node: HTMLDivElement | null) => setPortalTarget(node),
    [],
  );

  useEffect(() => {
    const next = appIdForHash(routeHash, apps);
    setSelected(next);
  }, [apps, routeHash, routeKey]);

  const visibleApps = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return apps.filter((app) => {
      const matchesQuery =
        normalized.length === 0 ||
        app.displayName.toLocaleLowerCase().includes(normalized) ||
        app.searchText.includes(normalized);
      const matchesFilter =
        filter === "all" || (summaries[app.id] ?? CHECKING_SUMMARY).state === filter;
      return matchesQuery && matchesFilter;
    });
  }, [apps, filter, query, summaries]);

  const attentionApps = visibleApps.filter(
    (app) => (summaries[app.id] ?? CHECKING_SUMMARY).state === "attention",
  );
  const remainingApps = visibleApps.filter(
    (app) => (summaries[app.id] ?? CHECKING_SUMMARY).state !== "attention",
  );
  const selectedDefinition =
    apps.find((app) => app.id === selected) ?? null;
  const selectedSummary = selected ? summaries[selected] ?? CHECKING_SUMMARY : null;

  const selectApp = (appId: ConnectedAppId) => {
    setSelected(appId);
    onSelectApp?.(appId);
  };

  const backToApps = () => {
    setSelected(null);
    onBackToApps?.();
  };

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSelected(null);
      onBackToApps?.();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onBackToApps, selected]);

  const renderTile = (app: ConnectedAppDefinition) => {
    const summary = summaries[app.id] ?? CHECKING_SUMMARY;
    return (
      <button
        key={app.id}
        id={app.id}
        type="button"
        aria-current={selected === app.id ? "true" : undefined}
        aria-label={`${app.displayName}, ${summary.statusLabel}`}
        onClick={() => selectApp(app.id)}
        className={[
          "flex min-h-20 w-full min-w-0 items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-accent",
          selected === app.id
            ? "border-accent bg-accent/10"
            : "border-border bg-background-panel hover:border-accent/70 hover:bg-background-element",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border/70 bg-background-element text-sm font-semibold text-foreground"
        >
          <AppIcon app={app} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {app.displayName}
            </span>
            {app.experimental ? (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-accent">
                Pilot
              </span>
            ) : null}
          </span>
          <span
            className={`mt-1 block truncate text-xs ${statusClass(summary)}`}
          >
            {summary.statusLabel}
          </span>
        </span>
      </button>
    );
  };

  const detailSurface = (
    <aside
      hidden={!selectedDefinition || !selectedSummary}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background-panel shadow-2xl md:bottom-6 md:top-12 md:max-w-lg"
      aria-label={
        selectedDefinition
          ? `${selectedDefinition.displayName} connection details`
          : "Connection details"
      }
    >
      <div className="shrink-0 border-b border-border px-4 py-4">
        <div className="mb-3 md:hidden">
          <Button variant="ghost" onClick={backToApps}>
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to apps
          </Button>
        </div>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border/70 bg-background-element text-sm font-semibold text-foreground"
          >
            {selectedDefinition ? <AppIcon app={selectedDefinition} /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {selectedDefinition?.displayName}
              </h3>
              {selectedSummary ? (
                <StatusPill tone={selectedSummary.tone}>
                  {selectedSummary.statusLabel}
                </StatusPill>
              ) : null}
              {selectedDefinition?.experimental ? (
                <StatusPill tone="info">Pilot</StatusPill>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-foreground-muted">
              {selectedDefinition?.description}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close connection details"
            title="Close connection details (Esc)"
            onClick={backToApps}
            className="shrink-0 rounded-md p-2 text-foreground-muted transition-colors hover:bg-background-element hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
        data-testid="connected-app-detail-scroll"
      >
        {selected ? details[selected] ?? null : null}
      </div>
    </aside>
  );

  return (
    <>
      <div
        className="overflow-hidden rounded-lg border border-border bg-background-panel"
        data-testid="connected-apps-catalogue"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search apps and capabilities…"
              aria-label="Search apps and capabilities"
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-foreground-dim focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div
            className="mt-2 flex flex-wrap gap-1"
            aria-label="Filter connected apps"
          >
            {FILTERS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={filter === candidate.id}
                onClick={() => setFilter(candidate.id)}
                className={[
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  filter === candidate.id
                    ? "bg-background-element text-foreground"
                    : "text-foreground-muted hover:bg-background-element hover:text-foreground",
                ].join(" ")}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div
            className={`${selected ? "hidden md:block" : "block"} min-w-0 p-4`}
            aria-label="Connected app catalogue"
          >
            {attentionApps.length > 0 ? (
              <section aria-labelledby="connected-apps-attention-title">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div>
                    <h3
                      id="connected-apps-attention-title"
                      className="text-xs font-semibold text-foreground"
                    >
                      Needs attention
                    </h3>
                    <p className="mt-0.5 text-xs text-foreground-dim">
                      Select an app to finish the exact recovery action.
                    </p>
                  </div>
                  <span className="text-xs text-foreground-dim">
                    {attentionApps.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {attentionApps.map(renderTile)}
                </div>
              </section>
            ) : null}

            {remainingApps.length > 0 ? (
              <section
                className={attentionApps.length > 0 ? "mt-5" : undefined}
                aria-labelledby="connected-apps-all-title"
              >
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div>
                    <h3
                      id="connected-apps-all-title"
                      className="text-xs font-semibold text-foreground"
                    >
                      {filter === "all"
                        ? "All apps"
                        : FILTERS.find((candidate) => candidate.id === filter)
                            ?.label}
                    </h3>
                    <p className="mt-0.5 text-xs text-foreground-dim">
                      Connected accounts and apps ready to add.
                    </p>
                  </div>
                  <span className="text-xs text-foreground-dim">
                    {remainingApps.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {remainingApps.map(renderTile)}
                </div>
              </section>
            ) : null}

            {visibleApps.length === 0 ? (
              <p
                className="px-3 py-10 text-center text-sm text-foreground-muted"
                role="status"
              >
                No apps match this search.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <div
        ref={capturePortalTarget}
        data-testid="connected-app-detail-portal"
      />
      {portalTarget ? createPortal(detailSurface, portalTarget) : null}
    </>
  );
}
