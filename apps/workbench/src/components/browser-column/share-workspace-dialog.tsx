import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { SelectablePicker, memberKey, toSelectableCandidate, type SelectableCandidate } from "../../modes/rooms/new-conversation/SelectablePicker";

export interface ShareWorkspaceFile { id: string; path: string }
const NO_AGENTS: ReadonlySet<string> = new Set();
type Delivery = { file: ShareWorkspaceFile; person: SelectableCandidate; error?: string };

export function ShareWorkspaceDialog({ files, roomId, onClose }: {
  files: readonly ShareWorkspaceFile[];
  roomId?: string;
  onClose: () => void;
}) {
  const auth = useAuth();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [people, setPeople] = useState<ReadonlyMap<string, SelectableCandidate>>(new Map());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Delivery[]>([]);
  const [completed, setCompleted] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const search = useCallback(async (q: string) => (await apiClient.searchDirectory({ q, kind: "user" })).map(toSelectableCandidate), []);
  const selectedIds = new Set([...people.values()].map((p) => p.id));
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { alive.current = false; previous?.focus(); };
  }, []);
  async function deliver() {
    if (busyRef.current) return;
    const pending = attempted ? failures : files.flatMap((file) => [...people.values()].map((person) => ({ file, person })));
    if (!pending.length) return;
    busyRef.current = true; setBusy(true); setAttempted(true);
    const failed: Delivery[] = [];
    let succeeded = completed;
    for (const delivery of pending) {
      // Navigating away stops undispatched work; already-committed shares remain idempotent.
      if (!alive.current) break;
      try {
        await apiClient.shareWorkspaceArtifact(delivery.file.id, delivery.person.id, { roomId });
        succeeded += 1;
        if (alive.current) setCompleted(succeeded);
      } catch (error) {
        failed.push({ ...delivery, error: error instanceof Error ? error.message : "Could not add file" });
      }
    }
    busyRef.current = false;
    if (alive.current) { setFailures(failed); setBusy(false); }
  }
  const total = files.length * people.size;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); }
        if (event.key !== "Tab") return;
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("summary, button:not(:disabled), input:not(:disabled)") ?? [])
          .filter((el) => !el.closest("[hidden], [inert]"));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background-panel p-5 shadow-xl">
        <h2 id={titleId} className="text-base font-semibold">{files.length === 1 ? "Add file to workspace" : `Add ${files.length} files to workspace`}</h2>
        <details className="text-xs text-foreground-muted" open={files.length === 1}>
          <summary>{files.length === 1 ? files[0]?.path : `${files.length} selected files`}</summary>
          {files.length > 1 && <ul>{files.map((file) => <li key={file.id} className="break-words py-0.5">{file.path}</li>)}</ul>}
        </details>
        {!attempted && <SelectablePicker search={search} searchLabel="Search people by name or @handle"
          viewerUserId={auth.viewer.sessionUserId ?? undefined} selectedUserIds={selectedIds}
          selectedAgentIds={NO_AGENTS} selectedMeta={people}
          onToggle={(person) => setPeople((current) => { const next = new Map(current); const key = memberKey("user", person.id);
            if (next.has(key)) next.delete(key); else next.set(key, person); return next; })} />}
        <p className="border-t border-border pt-3 text-xs text-foreground-muted">
          Makes {files.length === 1 ? "this file" : "these files"} available in each person’s <strong>Workspace → Shared with me</strong>.
          <br />No DM or message is sent. These are shared files, not separate copies.
        </p>
        {attempted && <div role="status" className="text-sm">{completed} of {total} file deliveries complete.{busy ? " Adding files…" : failures.length === 0 ? " No DM or message sent." : " Some files could not be added."}</div>}
        {failures.length > 0 && <ul className="text-xs text-foreground-muted">{failures.map((item) => <li key={`${item.file.id}:${item.person.id}`} className="py-1">{item.file.path} → {item.person.displayName}: {item.error}</li>)}</ul>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{attempted ? "Done" : "Cancel"}</button>
          {(!attempted || failures.length > 0 || busy) && <button type="button" disabled={busy || people.size === 0} onClick={() => void deliver()}
            className="rounded bg-primary px-3 py-2 text-xs text-[var(--on-primary)] disabled:opacity-50">
            {busy ? "Adding…" : attempted ? "Retry failed deliveries" : people.size === 1 ? `Add to ${[...people.values()][0]?.displayName}’s workspace` : "Add to workspaces"}
          </button>}
        </div>
      </div>
    </div>, document.body,
  );
}
