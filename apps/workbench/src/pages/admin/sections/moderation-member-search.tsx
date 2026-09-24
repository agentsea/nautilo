import { useState } from "react";
import { apiClient } from "../../../lib/api";
import { Button } from "../../settings/ui";

export type ModerationMember = Page["items"][number];
type Page = Awaited<ReturnType<typeof apiClient.searchModerationPeople>>;

export function ModerationMemberSearch({ disabled, onSelect, selectedIds = [], activeOnly = false, excludedIds = [] }: {
  disabled: boolean; onSelect: (person: ModerationMember) => void; selectedIds?: readonly string[];
  activeOnly?: boolean; excludedIds?: readonly string[];
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearSearch = () => {
    setDraft(""); setSearch(""); setPage(null); setCursors([undefined]); setError(null);
  };
  const load = async (term: string, history: (string | undefined)[]) => {
    setBusy(true); setError(null);
    try {
      const result = activeOnly
        ? await apiClient.searchModerationPeople(term, history.at(-1), true)
        : await apiClient.searchModerationPeople(term, history.at(-1));
      setPage(result); setSearch(term); setCursors(history);
    } catch { setError("Could not search members. Try again."); }
    finally { setBusy(false); }
  };
  const locked = disabled || busy;
  const visibleItems = page?.items.filter(person => !excludedIds.includes(person.userId)) ?? [];
  return <div className="space-y-3">
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (draft.trim()) void load(draft.trim(), [undefined]); }}>
      <input type="search" aria-label="Search members" placeholder="Name or @handle" value={draft} disabled={locked}
        onChange={event => { const value = event.target.value; if (!value.trim()) clearSearch(); else setDraft(value); }} className="min-w-0 flex-1 rounded border border-border bg-background-panel p-2" />
      <Button type="submit" variant="secondary" disabled={locked || !draft.trim()}>Search</Button>
      {(draft || page) && <Button disabled={locked} onClick={clearSearch}>Clear search</Button>}
    </form>
    {busy && <p role="status" className="text-sm">Searching members…</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
    {page && <>
      <div role="region" aria-label="Member search results" aria-busy={busy} tabIndex={0} className="max-h-[min(24rem,55vh)] overflow-y-auto overscroll-contain rounded border border-border divide-y divide-border">
        {visibleItems.length === 0 && <p className="p-3 text-sm">{page.items.length ? "No members remaining on this page." : `No members match “${search}”. Try a different name or handle.`}</p>}
        {visibleItems.map(person => <div key={person.userId} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0 break-words"><p className="font-medium">{person.displayName}</p>
            {person.handle && <p className="text-sm text-foreground-muted">@{person.handle}</p>}</div>
          <div className="flex shrink-0 items-center gap-2">
            <Button disabled={locked} ariaLabel={`Cancel ${person.displayName} search result`} onClick={() => {
              if (visibleItems.length === 1) clearSearch();
              else setPage({ ...page, items: page.items.filter(item => item.userId !== person.userId) });
            }}>Cancel</Button>
            <Button variant="secondary" disabled={locked || selectedIds.includes(person.userId)} onClick={() => onSelect(person)} ariaLabel={`Select ${person.displayName}${person.handle ? ` (@${person.handle})` : ""}`}>{selectedIds.includes(person.userId) ? "Added" : "Add"}</Button>
          </div>
        </div>)}
      </div>
      <nav aria-label="Member result pages" className="flex items-center justify-between gap-2 text-sm">
        <Button variant="secondary" disabled={locked || cursors.length === 1} onClick={() => { void load(search, cursors.slice(0, -1)); }}>Previous</Button>
        <span>Page {cursors.length} · {visibleItems.length} shown</span>
        <Button variant="secondary" disabled={locked || !page.next} onClick={() => { if (page.next) void load(search, [...cursors, page.next]); }}>Next</Button>
      </nav>
    </>}
  </div>;
}
