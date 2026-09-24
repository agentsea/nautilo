import { useCallback, useEffect, useState } from "react";
import type { EnrollmentReviewItem } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { Button } from "../../settings/ui";
import { moderationError } from "./moderation-person-controls";

export function EnrollmentInbox() {
  const [items, setItems] = useState<EnrollmentReviewItem[]>([]);
  const [next, setNext] = useState<{ inviteId: string; userId: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<({ inviteId: string; userId: string } | undefined)[]>([undefined]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async (history: ({ inviteId: string; userId: string } | undefined)[] = [undefined], term = "") => {
    setBusy(true); setError(null);
    try {
      const page = await apiClient.listEnrollmentReviews(history.at(-1), term || undefined);
      setItems(page.items); setNext(page.next); setCursors(history); setSearch(term);
    } catch (cause) { setError(moderationError(cause)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-medium">Joining requests</h3>
      <Button variant="secondary" disabled={busy} onClick={() => { void load(cursors, search); }}>Refresh requests</Button>
    </div>
    <p className="text-sm text-foreground-muted">Applicants cannot enter until approved. Approval belongs to this account and invite; it cannot be shared with another account.</p>
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setNotice(null); void load([undefined], draft.trim()); }}>
      <input type="search" aria-label="Search joining requests" placeholder="Name, @handle, or joining message" value={draft} disabled={busy}
        onChange={event => setDraft(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background-panel p-2" />
      <Button type="submit" variant="secondary" disabled={busy}>Search</Button>
      {search && <Button variant="secondary" disabled={busy} onClick={() => { setDraft(""); void load(); }}>Clear</Button>}
    </form>
    {busy && <p role="status" className="text-sm">Loading requests…</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!busy && !error && items.length === 0 && <p className="text-sm">{search ? "No pending requests match your search." : "No pending requests."}</p>}
    <div role="region" aria-label="Pending joining requests" aria-busy={busy} tabIndex={0} className="h-[min(24rem,55vh)] overflow-y-auto overscroll-contain space-y-3">
    {items.map(item => <article key={`${item.inviteId}:${item.userId}`} className="space-y-3 rounded border border-border p-3">
      <h4 className="font-medium">{item.displayName}{item.handle ? ` (@${item.handle})` : ""}</h4>
      <p className="whitespace-pre-wrap break-words text-sm">{item.message}</p>
      <div className="flex gap-2">{(["approved", "rejected"] as const).map(decision =>
        <Button key={decision} variant="secondary" disabled={busy} onClick={() => {
          setBusy(true); setError(null); setNotice(null);
          void apiClient.decideEnrollmentReview({ inviteId: item.inviteId, userId: item.userId, revision: item.revision, decision })
            .then(result => {
              setItems(current => current.filter(row => row.inviteId !== item.inviteId || row.userId !== item.userId));
              setNotice(`${decision === "approved" ? "Approved. The applicant can finish joining." : "Request declined."}${result.auditRecorded ? "" : " The audit log could not be written; the decision is saved."}`);
            }).catch(cause => setError(moderationError(cause))).finally(() => setBusy(false));
        }}>{decision === "approved" ? "Approve" : "Decline"}</Button>)}
      </div>
    </article>)}
    </div>
    <nav aria-label="Joining request pages" className="flex items-center justify-between gap-2 text-sm">
      <Button variant="secondary" disabled={busy || cursors.length === 1} onClick={() => { void load(cursors.slice(0, -1), search); }}>Previous</Button>
      <span>Page {cursors.length} · {items.length} pending shown</span>
      <Button variant="secondary" disabled={busy || !next} onClick={() => { if (next) void load([...cursors, next], search); }}>Next</Button>
    </nav>
  </div>;
}
