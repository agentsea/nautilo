import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { SharedWorkspaceArtifactDto } from "@nautilo/api-client/browser";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { artifactOpenFileTarget, type OpenFileTarget } from "./open-file-target";

export function SharedWorkspaceFiles({ onOpenFile }: { onOpenFile?: (target: OpenFileTarget) => void }) {
  const auth = useAuth();
  const [version, setVersion] = useState(0);
  const [rows, setRows] = useState<SharedWorkspaceArtifactDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(null);
    void apiClient.listWorkspaceShares().then((result) => { if (current) setRows(result.artifacts); })
      .catch((err: unknown) => { if (current) setError(err instanceof Error ? err.message : "Could not load shared files"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [auth.viewerGeneration, version]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const visible = rows.filter((row) => `${row.path} ${row.sharedBy}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-border p-3">
      <input aria-label="Search shared files" placeholder="Search shared files…" value={query} onChange={(event) => setQuery(event.target.value)}
        className="min-w-0 flex-1 rounded border border-border bg-background-element px-2 py-1 text-xs" />
      <button type="button" aria-label="Refresh shared files" onClick={refresh} className="rounded p-1 text-foreground-muted"><RefreshCw size={14} /></button>
    </div>
    {error && <div role="alert" className="p-3 text-xs">{error} <button type="button" onClick={refresh} className="underline">Retry</button></div>}
    {loading && <p role="status" className="p-3 text-xs text-foreground-muted">Loading shared files…</p>}
    {!loading && !error && visible.length === 0 && <p className="p-4 text-xs text-foreground-muted">{query ? "No shared files match this search." : "Files people add to your workspace will appear here."}</p>}
    <ul className="min-h-0 flex-1 overflow-y-auto p-2">{visible.map((row) => <li key={`${row.roomId}:${row.id}`}>
      <button type="button" disabled={!onOpenFile} onClick={() => onOpenFile?.(artifactOpenFileTarget({ id: row.id, path: row.path, mimeType: row.mimeType, sizeBytes: row.size, roomId: row.roomId }))}
        className="flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs hover:bg-background-element disabled:opacity-50">
        <FileText size={14} className="mt-0.5 shrink-0" /><span className="min-w-0"><span className="block break-words">{row.path.split("/").pop()}</span>
          <span className="block text-[11px] text-foreground-muted">Shared by {row.sharedBy} · {new Date(row.sharedAt).toLocaleDateString()}</span></span>
      </button>
    </li>)}</ul>
  </div>;
}
