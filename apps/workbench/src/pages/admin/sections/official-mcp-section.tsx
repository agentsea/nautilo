import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "../../settings/ui";
import {
  deleteMcpServer,
  fetchMcpServers,
  fetchMcpServerTools,
  setMcpServerEnabled,
  setMcpServerToolEnabled,
  type McpServer,
  type McpTool,
} from "../../../lib/mcp-servers-api";
import {
  describeServer,
  healthDot,
  serverTier,
  transportLabel,
} from "../../connections/connections-view-model";

function Toggle({ enabled, disabled, onChange, label }: { enabled: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={enabled} aria-label={label} disabled={disabled} onClick={onChange} className={`relative inline-flex h-5 w-9 items-center rounded-full ${enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40"} ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <span className={`h-4 w-4 rounded-full bg-background shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

function OfficialTools({ server }: { server: McpServer }) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setTools(await fetchMcpServerTools(server.name, server.host)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [server.host, server.name]);
  useEffect(() => void load(), [load]);
  const toggle = async (tool: McpTool) => {
    setBusy(tool.name);
    setError(null);
    try { await setMcpServerToolEnabled(server.name, tool.name, !tool.enabled, server.host); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-background-element/40 p-3">
      {error ? <p className="text-xs text-[var(--error)]" role="alert">{error}</p> : tools === null ? <p className="text-xs text-foreground-muted">Loading tools…</p> : tools.length === 0 ? <p className="text-xs text-foreground-muted">No tools discovered.</p> : <ul className="space-y-2">{tools.map((tool) => <li key={tool.name} className="flex items-center justify-between gap-3"><span className="truncate text-xs">{tool.name}</span><Toggle enabled={tool.enabled} disabled={busy === tool.name} onChange={() => void toggle(tool)} label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`} /></li>)}</ul>}
    </div>
  );
}

export function OfficialMcpSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setServers((await fetchMcpServers()).filter((server) => serverTier(server) === "official")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  const toggle = async (server: McpServer) => {
    setBusy(server.name);
    try { await setMcpServerEnabled(server.name, !server.enabled, server.host); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const remove = async (server: McpServer) => {
    if (!window.confirm(`Delete the server MCP “${server.name}”? This changes the shared Nautilo server.`)) return;
    setBusy(server.name);
    try { await deleteMcpServer(server.name, server.host); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  return (
    <section id="official-mcps" data-testid="admin-official-mcps-section" className="scroll-mt-6 rounded-lg border border-border bg-background-panel p-5">
      <div><h2 className="text-lg font-semibold">Server MCPs</h2><p className="mt-1 text-sm text-foreground-muted">Deployment-managed MCPs that run on this Nautilo server. Provisioning requires operator access to the server environment; Nautilo does not install server dependencies from this page.</p></div>
      {error ? <p className="mt-3 text-sm text-[var(--error)]" role="alert">{error}</p> : null}
      <div className="mt-4 rounded-md border border-border">{servers.length === 0 ? <p className="px-4 py-5 text-sm text-foreground-muted">No deployment-managed server MCPs are configured.</p> : <ul className="divide-y divide-border">{servers.map((server) => { const health = healthDot(server.health); return <li key={server.id} className="px-4 py-3"><div className="flex items-center gap-2"><button type="button" aria-label={expanded === server.id ? "Hide server MCP tools" : "Show server MCP tools"} onClick={() => setExpanded((current) => current === server.id ? null : server.id)} className="text-foreground-muted">{expanded === server.id ? "▾" : "▸"}</button>{health ? <span className="h-2 w-2 rounded-full" style={{ backgroundColor: health.color }} title={health.label} /> : null}<span className="font-medium">{server.name}</span><StatusPill tone="info">{transportLabel(server.transportKind)}</StatusPill><div className="ml-auto flex items-center gap-3"><button type="button" className="text-xs text-[var(--error)] hover:underline" disabled={busy === server.name} onClick={() => void remove(server)}>Delete</button><Toggle enabled={server.enabled} disabled={busy === server.name} onChange={() => void toggle(server)} label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`} /></div></div><p className="mt-1 truncate pl-5 text-xs text-foreground-muted">{describeServer(server)}</p>{expanded === server.id ? <div className="pl-5"><OfficialTools server={server} /></div> : null}</li>; })}</ul>}</div>
    </section>
  );
}
