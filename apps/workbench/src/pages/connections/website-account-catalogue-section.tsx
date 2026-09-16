import type {
  ConnectedWebAccount,
  ConnectedWebAccountProviderSetupStatus,
} from "@nautilo/types";
import { Globe2, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../../components/workbench-portals";
import { Link } from "react-router-dom";
import {
  publishConnectedWebAccountRefresh,
  subscribeConnectedWebAccountRefresh,
} from "../../adapters/connected-web-account-refresh";
import { requestWebsiteConnection } from "../../adapters/website-connection-intent";
import { apiClient } from "../../lib/api";
import {
  searchWebsiteCatalogue,
  WEBSITE_CATALOGUE,
  type WebsiteCatalogueEntry,
} from "../../lib/website-catalogue";

type AccountPresentation = Readonly<{
  label: string;
  action: string | null;
  tone: "ok" | "warn" | "error" | "muted";
}>;

type WebsiteAccountGroup = Readonly<{
  key: string;
  website: WebsiteCatalogueEntry | null;
  displayName: string;
  icon: string;
  subtitle: string;
  startUrl: string;
  accounts: readonly ConnectedWebAccount[];
}>;

const ACCOUNT_PRESENTATION: Record<ConnectedWebAccount["status"], AccountPresentation> = {
  connecting: { label: "Sign-in in progress", action: "Continue sign-in", tone: "warn" },
  connected: { label: "Connected", action: "Reconnect", tone: "ok" },
  busy: { label: "In use", action: null, tone: "ok" },
  attention_needed: { label: "Attention needed", action: "Continue sign-in", tone: "warn" },
  expired: { label: "Sign-in expired", action: "Continue sign-in", tone: "warn" },
  revoked: { label: "Disconnected", action: null, tone: "muted" },
  provider_unavailable: { label: "Temporarily unavailable", action: "Try again", tone: "error" },
  error: { label: "Could not connect", action: "Try again", tone: "error" },
};

const STATUS_RANK: Record<ConnectedWebAccount["status"], number> = {
  connected: 8,
  busy: 7,
  connecting: 6,
  attention_needed: 5,
  expired: 4,
  provider_unavailable: 3,
  error: 2,
  revoked: 1,
};

function hasHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function hostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function catalogueEntryForAccount(account: ConnectedWebAccount): WebsiteCatalogueEntry | null {
  const service = account.service.toLocaleLowerCase();
  const exactService = WEBSITE_CATALOGUE.find(
    (website) => website.displayName.toLocaleLowerCase() === service,
  );
  if (exactService) return exactService;
  const accountHost = hostname(account.origin);
  if (!accountHost) return null;
  return WEBSITE_CATALOGUE.find((website) => {
    if (hostname(website.startUrl) === accountHost) return true;
    return website.relatedDomains.some(
      (domain) => domain.toLocaleLowerCase().replace(/^www\./, "") === accountHost,
    );
  }) ?? null;
}

function summaryForAccounts(accounts: readonly ConnectedWebAccount[]): AccountPresentation {
  const connectedCount = accounts.filter(
    (account) => account.status === "connected" || account.status === "busy",
  ).length;
  if (connectedCount > 0) {
    return {
      label: `${connectedCount} connected`,
      action: null,
      tone: "ok",
    };
  }
  const leading = [...accounts].sort(
    (left, right) => STATUS_RANK[right.status] - STATUS_RANK[left.status],
  )[0];
  return leading
    ? ACCOUNT_PRESENTATION[leading.status]
    : { label: "Ready to connect", action: null, tone: "muted" };
}

function toneClass(tone: AccountPresentation["tone"]): string {
  switch (tone) {
    case "ok": return "text-[var(--success)]";
    case "warn": return "text-[var(--warning)]";
    case "error": return "text-[var(--error)]";
    case "muted": return "text-foreground-muted";
  }
}

function connectedTileClass(summary: AccountPresentation): string {
  if (summary.tone === "ok") {
    return "border-[var(--success)]/60 bg-[var(--success)]/10 hover:border-[var(--success)]";
  }
  if (summary.tone === "warn") {
    return "border-[var(--warning)]/60 bg-[var(--warning)]/10 hover:border-[var(--warning)]";
  }
  return "border-border bg-background-element hover:border-accent/70";
}

/** Website discovery stays flat; account detail expands only for the selected site. */
export function WebsiteAccountCatalogueSection() {
  const [query, setQuery] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customUrlError, setCustomUrlError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly ConnectedWebAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState(false);
  const [providerSetupStatus, setProviderSetupStatus] = useState<ConnectedWebAccountProviderSetupStatus | null>(null);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [actionErrorAccountId, setActionErrorAccountId] = useState<string | null>(null);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const websites = useMemo(() => searchWebsiteCatalogue(query), [query]);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await apiClient.listConnectedWebAccounts();
      setAccounts(response.accounts);
      setProviderSetupStatus(response.providerSetupStatus);
      setAccountsError(false);
    } catch {
      setAccountsError(true);
      setProviderSetupStatus(null);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    return subscribeConnectedWebAccountRefresh(() => void loadAccounts());
  }, [loadAccounts]);

  const providerReady = providerSetupStatus === "ready";
  const providerNotice = providerSetupStatus === "api_key_required"
    ? "Browser Use API key required. Add one in API settings before connecting a website."
    : providerSetupStatus === "api_key_invalid"
      ? "Browser Use API key needs attention. Check it in API settings before connecting a website."
      : null;

  const groups = useMemo(() => {
    const visibleAccounts = accounts?.filter((account) => account.status !== "revoked") ?? [];
    const accountsByWebsite = new Map<string, ConnectedWebAccount[]>();
    const customByOrigin = new Map<string, ConnectedWebAccount[]>();
    for (const account of visibleAccounts) {
      const website = catalogueEntryForAccount(account);
      if (website) {
        const grouped = accountsByWebsite.get(website.id) ?? [];
        grouped.push(account);
        accountsByWebsite.set(website.id, grouped);
      } else {
        const grouped = customByOrigin.get(account.origin) ?? [];
        grouped.push(account);
        customByOrigin.set(account.origin, grouped);
      }
    }
    const websiteGroups = new Map<string, WebsiteAccountGroup>(
      WEBSITE_CATALOGUE.map((website) => [website.id, {
        key: `catalogue:${website.id}`,
        website,
        displayName: website.displayName,
        icon: website.icon,
        subtitle: website.category,
        startUrl: website.startUrl,
        accounts: accountsByWebsite.get(website.id) ?? [],
      }]),
    );
    const customGroups = [...customByOrigin.entries()].map(([origin, grouped]) => ({
      key: `custom:${origin}`,
      website: null,
      displayName: grouped[0]?.label ?? hostname(origin) ?? "Website",
      icon: (grouped[0]?.label ?? hostname(origin) ?? "W").slice(0, 1).toLocaleUpperCase(),
      subtitle: hostname(origin) ?? grouped[0]?.service ?? "website",
      startUrl: origin,
      accounts: grouped,
    } satisfies WebsiteAccountGroup));
    return { websiteGroups, customGroups };
  }, [accounts]);

  const visibleCustomGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return groups.customGroups;
    return groups.customGroups.filter((group) =>
      `${group.displayName} ${group.subtitle} ${group.startUrl}`.toLocaleLowerCase().includes(normalized),
    );
  }, [groups.customGroups, query]);

  const selectedGroup = useMemo(() => {
    if (!selectedGroupKey) return null;
    if (selectedGroupKey.startsWith("catalogue:")) {
      return groups.websiteGroups.get(selectedGroupKey.slice("catalogue:".length)) ?? null;
    }
    return groups.customGroups.find((group) => group.key === selectedGroupKey) ?? null;
  }, [groups, selectedGroupKey]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedGroupKey(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedGroupKey]);

  const connectCustomUrl = () => {
    if (!providerReady) return;
    const url = customUrl.trim();
    if (!hasHttpUrl(url)) {
      setCustomUrlError("Enter a complete http or https website address.");
      return;
    }
    setCustomUrlError(null);
    requestWebsiteConnection({ kind: "custom", url });
  };

  const disconnect = useCallback(async (account: ConnectedWebAccount) => {
    if (!window.confirm("Disconnecting Nautilo does not sign you out of the website. Use the website’s sign out other sessions control if needed. Continue?")) return;
    setBusyAccountId(account.id);
    setActionErrorAccountId(null);
    try {
      await apiClient.disconnectConnectedWebAccount(account.id);
      publishConnectedWebAccountRefresh();
    } catch {
      setActionErrorAccountId(account.id);
    } finally {
      setBusyAccountId(null);
      void loadAccounts();
    }
  }, [loadAccounts]);

  const connectAnother = (group: WebsiteAccountGroup) => {
    if (!providerReady) return;
    setSelectedGroupKey(null);
    if (group.website) {
      requestWebsiteConnection({
        kind: "catalogue",
        websiteId: group.website.id,
        createAnother: true,
      });
    } else {
      requestWebsiteConnection({ kind: "custom", url: group.startUrl, createAnother: true });
    }
  };

  const renderGroupTile = (group: WebsiteAccountGroup) => {
    const connected = group.accounts.length > 0;
    const summary = summaryForAccounts(group.accounts);
    const testId = group.website
      ? `website-catalogue-${group.website.id}`
      : `connected-website-${group.accounts[0]?.id ?? group.key}`;
    const onClick = () => {
      if (connected) setSelectedGroupKey(group.key);
      else if (providerReady && group.website) {
        requestWebsiteConnection({ kind: "catalogue", websiteId: group.website.id });
      }
    };
    return (
      <li key={group.key}>
        <button
          type="button"
          data-testid={testId}
          data-connection-count={group.accounts.length}
          aria-label={`${group.displayName}, ${summary.label}`}
          aria-describedby={!connected && providerNotice ? "browser-use-provider-notice" : undefined}
          disabled={!connected && !providerReady}
          onClick={onClick}
          className={`w-full rounded-md border px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-55 ${connected ? connectedTileClass(summary) : "border-border bg-background-element enabled:hover:bg-[var(--primary-muted)]"}`}
        >
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded bg-background-panel text-[11px] font-semibold">{group.icon}</span>
            <span className="text-sm font-medium text-foreground">{group.displayName}</span>
          </span>
          <span className="mt-1 flex items-center justify-between gap-2 text-xs">
            <span className="text-foreground-muted">{group.subtitle}</span>
            {connected ? <span className={`font-medium ${toneClass(summary.tone)}`}>{summary.label}</span> : null}
          </span>
        </button>
      </li>
    );
  };

  const accountDrawer = selectedGroup ? (
    <aside
      className="fixed inset-y-0 right-0 z-[90] flex w-full flex-col border-l border-border bg-background-panel shadow-2xl md:bottom-6 md:top-12 md:max-w-lg"
      aria-label={`${selectedGroup.displayName} connected accounts`}
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-background-element text-sm font-semibold">{selectedGroup.icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">{selectedGroup.displayName}</h3>
          <p className={`mt-1 text-xs font-medium ${toneClass(summaryForAccounts(selectedGroup.accounts).tone)}`}>{summaryForAccounts(selectedGroup.accounts).label}</p>
        </div>
        <button type="button" aria-label="Close website accounts" onClick={() => setSelectedGroupKey(null)} className="rounded p-2 text-foreground-muted hover:bg-background-element hover:text-foreground"><X aria-hidden="true" className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="space-y-2" aria-label={`${selectedGroup.displayName} accounts`}>
          {selectedGroup.accounts.map((account, index) => {
            const presentation = ACCOUNT_PRESENTATION[account.status];
            const accountName = selectedGroup.accounts.length > 1
              ? `${account.label} ${index + 1}`
              : account.label;
            return (
              <li key={account.id} className="rounded-lg border border-border bg-background-element p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{accountName}</p>
                    <p className={`mt-1 text-xs font-medium ${toneClass(presentation.tone)}`}>{presentation.label}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {presentation.action ? <button type="button" disabled={!providerReady || busyAccountId === account.id} onClick={() => requestWebsiteConnection({ kind: "reconnect", accountId: account.id })} aria-label={`${presentation.action} ${accountName}`} className="rounded border border-border px-2 py-1 text-xs font-medium text-foreground enabled:hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-60">{presentation.action}</button> : null}
                    <button type="button" disabled={busyAccountId === account.id} onClick={() => void disconnect(account)} aria-label={`Disconnect ${accountName}`} className="rounded border border-border px-2 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] disabled:opacity-60">{busyAccountId === account.id ? "Disconnecting…" : "Disconnect"}</button>
                  </div>
                </div>
                {actionErrorAccountId === account.id ? <p role="alert" className="mt-2 text-xs text-[var(--error)]">We couldn’t disconnect this website. Try again.</p> : null}
              </li>
            );
          })}
        </ul>
      </div>
      <footer className="border-t border-border p-4">
        <button type="button" disabled={!providerReady} onClick={() => connectAnother(selectedGroup)} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-55">Connect another account</button>
      </footer>
    </aside>
  ) : null;

  return (
    <section id="website-accounts" tabIndex={-1} className="scroll-mt-6 rounded-lg border border-border bg-background-panel p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-labelledby="website-accounts-title">
      <div>
        <h3 id="website-accounts-title" className="text-sm font-semibold text-foreground">Connect a website</h3>
        <div className="mt-3 flex gap-3 rounded-lg border border-primary/35 bg-primary/10 px-3 py-3">
          <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <Globe2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Browse with your Genie</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
              Nautilo uses Browser Use for protected website sessions. Connect a site once, then simply ask your Genie to use it; the Genie works through your saved signed-in account without asking for your password in chat.
            </p>
          </div>
        </div>
      </div>
      {providerNotice ? (
        <p id="browser-use-provider-notice" role="status" className="mt-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 px-3 py-2 text-xs text-foreground-muted">
          {providerNotice}{" "}
          <Link to="/admin#provider-credentials" className="font-medium text-primary hover:underline">
            Open API settings
          </Link>
        </p>
      ) : null}
      <label className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background-element px-2 py-1.5">
        <Search aria-hidden="true" className="h-3.5 w-3.5 text-foreground-muted" />
        <input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search websites…" aria-label="Search websites" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-muted" />
      </label>
      <form noValidate className="mt-3" onSubmit={(event) => { event.preventDefault(); connectCustomUrl(); }}>
        <label htmlFor="connect-another-website" className="text-sm font-medium text-foreground">Connect another website</label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input id="connect-another-website" type="url" inputMode="url" disabled={!providerReady} value={customUrl} onInput={(event) => setCustomUrl(event.currentTarget.value)} placeholder="https://example.com" aria-describedby={customUrlError ? "connect-another-website-error" : providerNotice ? "browser-use-provider-notice" : undefined} className="min-w-0 flex-1 rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-55" />
          <button type="submit" disabled={!providerReady} className="rounded-md border border-border bg-background-element px-3 py-2 text-sm font-medium text-foreground enabled:hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-55">Connect website</button>
        </div>
        {customUrlError ? <p id="connect-another-website-error" role="alert" className="mt-2 text-xs text-[var(--error)]">{customUrlError}</p> : null}
      </form>
      {websites.length === 0 && visibleCustomGroups.length === 0 ? <p className="mt-3 text-sm text-foreground-muted" role="status">No websites match that search.</p> : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Website presets">
          {websites.map((website) => renderGroupTile(groups.websiteGroups.get(website.id)!))}
          {visibleCustomGroups.map(renderGroupTile)}
        </ul>
      )}
      {accountsError ? <p className="mt-3 text-xs text-foreground-muted" role="status">Connected website status is unavailable right now.</p> : null}
      {accountDrawer ? createPortal(accountDrawer, document.body) : null}
    </section>
  );
}
