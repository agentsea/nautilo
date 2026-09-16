import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import {
  AgentPhotoLibraryApiError,
  type AgentPhotoLibraryFence,
  type AgentPhotoLibraryMutationOptions,
} from "@nautilo/api-client/browser";
import type {
  AgentPhotoLibraryCurrentStateDto,
  AgentPhotoLibraryEntryDto,
  AgentPhotoLibraryScopeDto,
} from "@nautilo/types";
import { apiClient } from "../../lib/api";

type Tab = "recent" | "presets" | "upload" | "generate" | "deleted";
type Selection = { kind: "entry"; entryId: string } | { kind: "preset"; presetId: string };
type Retry = { label: string; run: () => void };
type PendingGeneratedEntries = {
  scope: AgentPhotoLibraryScopeDto;
  entries: AgentPhotoLibraryEntryDto[];
};
const PRIMARY_TABS: readonly Exclude<Tab, "deleted">[] = ["recent", "presets", "upload", "generate"];

function scopesEqual(left: AgentPhotoLibraryScopeDto, right: AgentPhotoLibraryScopeDto): boolean {
  return left.serverInstanceId === right.serverInstanceId
    && left.viewerUserId === right.viewerUserId
    && left.agentId === right.agentId
    && left.selectionRevision === right.selectionRevision
    && left.libraryRevision === right.libraryRevision;
}

function uniqueEntries(entries: AgentPhotoLibraryEntryDto[]): AgentPhotoLibraryEntryDto[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function photoLabel(entry: AgentPhotoLibraryEntryDto): string {
  const source = entry.source === "generation" ? "Generated" : "Uploaded";
  const date = new Date(entry.createdAt).toLocaleDateString();
  return `${source} Agent photo from ${date}${entry.isCurrent ? ", current" : ""}`;
}

function OwnedPhoto({ entry, selected, onSelect, fence, size = "thumb", interactive = true }: {
  entry: AgentPhotoLibraryEntryDto;
  selected: boolean;
  onSelect?: () => void;
  fence: AgentPhotoLibraryFence;
  size?: "thumb" | "full";
  interactive?: boolean;
}): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const {
    serverInstanceId, viewerUserId, agentId, selectionRevision, libraryRevision,
    requestGeneration: mediaGeneration, getCurrentGeneration,
  } = fence;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setSrc(null);
    setFailure(null);
    void apiClient.getAgentPhotoLibraryMedia(entry.id, size, {
      signal: controller.signal,
      fence: {
        serverInstanceId, viewerUserId, agentId, selectionRevision, libraryRevision,
        requestGeneration: mediaGeneration, getCurrentGeneration,
      },
    })
      .then(({ blob }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setFailure(cause instanceof AgentPhotoLibraryApiError && cause.code === "offline"
          ? "Preview offline"
          : "Preview unavailable");
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, entry.id, getCurrentGeneration, libraryRevision, mediaGeneration, selectionRevision, serverInstanceId, size, viewerUserId]);

  const contents = <>
    {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : (
      <span className="flex h-full items-center justify-center bg-background-element p-2 text-xs text-foreground-muted">
        {failure ?? "Loading…"}
      </span>
    )}
    {entry.isCurrent ? <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium">Current</span> : null}
  </>;
  const className = `relative aspect-square overflow-hidden rounded-lg border-2 ${selected ? "border-accent" : "border-border"}`;
  return interactive ? (
    <button type="button" onClick={onSelect} aria-label={photoLabel(entry)} aria-pressed={selected} data-photo-entry={entry.id} className={className}>
      {contents}
    </button>
  ) : <figure aria-label={photoLabel(entry)} className={className}>{contents}</figure>;
}

export function AgentPhotoLibraryModal({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}): ReactElement | null {
  const [tab, setTab] = useState<Tab>("recent");
  const [entries, setEntries] = useState<AgentPhotoLibraryEntryDto[]>([]);
  const [presets, setPresets] = useState<Array<{ id: string; thumbnailUrl: string }>>([]);
  const [scope, setScope] = useState<AgentPhotoLibraryScopeDto | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [undoRevisionId, setUndoRevisionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  const [prompt, setPrompt] = useState("");
  const [generationCount, setGenerationCount] = useState<1 | 2 | 3 | 4>(1);
  const requestGeneration = useRef(0);
  const scopeRef = useRef<AgentPhotoLibraryScopeDto | null>(null);
  const pendingGeneratedRef = useRef<PendingGeneratedEntries | null>(null);
  const readController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const getCurrentGeneration = useCallback(() => requestGeneration.current, []);

  const makeFence = useCallback((capturedScope: AgentPhotoLibraryScopeDto, generation: number): AgentPhotoLibraryFence => ({
    ...capturedScope,
    requestGeneration: generation,
    getCurrentGeneration,
  }), [getCurrentGeneration]);

  const load = useCallback(async (append = false, cursor: string | null = null, expected?: AgentPhotoLibraryScopeDto) => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setRetry(null);
    try {
      if (append) {
        const pageScope = scopeRef.current;
        if (!pageScope || !cursor || (tab !== "recent" && tab !== "deleted")) return;
        const result = await apiClient.listAgentPhotoLibrary({
          projection: tab === "deleted" ? "deleted" : "recent",
          limit: 24,
          cursor,
          signal: controller.signal,
          fence: makeFence(pageScope, generation),
        });
        if (generation !== requestGeneration.current) return;
        setEntries((prior) => uniqueEntries([...prior, ...result.entries]));
        setNextCursor(result.nextCursor);
        return;
      }
      const current = await apiClient.getAgentPhotoLibraryCurrent(expected
        ? { signal: controller.signal, fence: makeFence(expected, generation) }
        : { signal: controller.signal });
      if (generation !== requestGeneration.current) return;
      const currentScope = current.scope;
      const fence = makeFence(currentScope, generation);
      setScope(currentScope);
      scopeRef.current = currentScope;
      const pendingGenerated = pendingGeneratedRef.current;
      const pendingMatchesScope = pendingGenerated
        && pendingGenerated.scope.serverInstanceId === currentScope.serverInstanceId
        && pendingGenerated.scope.viewerUserId === currentScope.viewerUserId
        && pendingGenerated.scope.agentId === currentScope.agentId;
      if (pendingGenerated && !pendingMatchesScope) pendingGeneratedRef.current = null;
      setCurrentEntryId(current.current.entryId);
      setCurrentPresetId(current.current.avatarRef?.kind === "preset" ? current.current.avatarRef.id : null);
      setUndoRevisionId(current.current.lastUndoableRevisionId);
      if (tab === "presets") {
        const result = await apiClient.listAgentPhotoLibraryPresets({ signal: controller.signal, fence });
        if (generation !== requestGeneration.current || !scopesEqual(result.scope, currentScope)) return;
        setPresets(result.presets);
        setEntries([]);
        setNextCursor(null);
      } else if (tab === "recent" || tab === "deleted") {
        const result = await apiClient.listAgentPhotoLibrary({
          projection: tab === "deleted" ? "deleted" : "recent",
          limit: 24,
          signal: controller.signal,
          fence,
        });
        if (generation !== requestGeneration.current || !scopesEqual(result.scope, currentScope)) return;
        const staged = tab === "recent" && pendingMatchesScope ? pendingGenerated?.entries ?? [] : [];
        setEntries(uniqueEntries([...staged, ...result.entries]));
        if (staged.length > 0) {
          const returnedIds = new Set(result.entries.map((entry) => entry.id));
          if (staged.every((entry) => returnedIds.has(entry.id))) pendingGeneratedRef.current = null;
        }
        setPresets([]);
        setNextCursor(result.nextCursor);
      } else {
        setEntries([]);
        setPresets([]);
        setNextCursor(null);
      }
    } catch (cause) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      if (cause instanceof AgentPhotoLibraryApiError && cause.code === "stale_library_revision") {
        setEntries([]);
        setNextCursor(null);
        void load(false);
        return;
      }
      const message = cause instanceof AgentPhotoLibraryApiError && cause.code === "offline"
        ? "Nautilo is offline. Your selection and draft are still here."
        : cause instanceof Error ? cause.message : "Photo library unavailable";
      setError(message);
      setRetry({ label: "Reload library", run: () => { void load(false); } });
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [makeFence, tab]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(null);
    setPendingDeleteId(null);
    setError(null);
    setNotice(null);
    setRetry(null);
    pendingGeneratedRef.current = null;
    closeRef.current?.focus();
    return () => {
      requestGeneration.current += 1;
      readController.current?.abort();
      mutationController.current?.abort();
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) void load(false);
  }, [load, open, tab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingDeleteId) setPendingDeleteId(null);
        else if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = closeRef.current?.closest<HTMLElement>("[role=dialog]");
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]") ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, open, pendingDeleteId]);

  const applyCurrent = (current: AgentPhotoLibraryCurrentStateDto, nextScope?: AgentPhotoLibraryScopeDto) => {
    if (nextScope) { setScope(nextScope); scopeRef.current = nextScope; }
    setCurrentEntryId(current.entryId);
    setCurrentPresetId(current.avatarRef?.kind === "preset" ? current.avatarRef.id : null);
  };

  const handleMutationError = (cause: unknown, retryAction: Retry) => {
    if (cause instanceof AgentPhotoLibraryApiError) {
      if (cause.code === "selection_conflict" || cause.code === "undo_conflict") {
        if (cause.current) applyCurrent(cause.current, cause.scope);
        setUndoRevisionId(null);
        setNotice("The Agent photo changed on another device. The latest choice is shown; choose again if you still want to replace it.");
        void load(false);
        return;
      }
      if (cause.code === "stale_viewer_scope" || cause.code === "stale_library_revision") {
        setNotice("The selected Server, viewer, or Agent changed. The library is refreshing.");
        void load(false);
        return;
      }
      if (cause.code === "authentication_required") {
        window.dispatchEvent(new CustomEvent("nautilo:auth-rejected", { detail: { reason: cause.message } }));
      }
      if (cause.code === "offline" || cause.retryable) setRetry(retryAction);
    }
    setError(cause instanceof Error ? cause.message : "Photo update failed");
  };

  const runMutation = (input: {
    operationId: string;
    label: string;
    work: (options: AgentPhotoLibraryMutationOptions) => Promise<AgentPhotoLibraryScopeDto>;
    after: (nextScope: AgentPhotoLibraryScopeDto) => Promise<void> | void;
  }) => {
    if (busy || !scope) return;
    const capturedScope = scope;
    const generation = requestGeneration.current;
    const retryAction = { label: `Retry ${input.label}`, run: () => runMutation(input) };
    setBusy(true);
    setError(null);
    setRetry(null);
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    void input.work({
      idempotencyKey: input.operationId,
      origin: "workbench",
      signal: controller.signal,
      fence: makeFence(capturedScope, generation),
    }).then(async (nextScope) => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setScope(nextScope);
      scopeRef.current = nextScope;
      await input.after(nextScope);
    }).catch((cause) => {
      if (!controller.signal.aborted) handleMutationError(cause, retryAction);
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
  };

  const refreshProfileProjection = async () => {
    try { await onChanged(); }
    catch { setNotice("The photo changed. The profile preview will refresh when Nautilo reconnects."); }
  };

  const usePhoto = () => {
    if (!selected || !scope) return;
    const target = selected;
    const expectedSelectionRevision = scope.selectionRevision;
    runMutation({
      operationId: crypto.randomUUID(), label: "photo change",
      work: async (options) => {
        const result = await apiClient.selectAgentPhotoLibraryEntry({ target, expectedSelectionRevision }, options);
        setCurrentEntryId(result.currentEntryId);
        setCurrentPresetId(result.currentAvatarRef?.kind === "preset" ? result.currentAvatarRef.id : null);
        setUndoRevisionId(result.changed ? result.revisionId : null);
        setNotice(result.changed ? "Agent photo changed." : "This photo is already current.");
        return result.scope;
      },
      after: async () => {
        await refreshProfileProjection();
        onClose();
      },
    });
  };

  const undo = () => {
    if (!scope || !undoRevisionId) return;
    const revisionId = undoRevisionId;
    const expectedSelectionRevision = scope.selectionRevision;
    runMutation({
      operationId: crypto.randomUUID(), label: "undo",
      work: async (options) => {
        const result = await apiClient.undoAgentPhotoLibrarySelection({ revisionId, expectedSelectionRevision }, options);
        setCurrentEntryId(result.currentEntryId);
        setCurrentPresetId(result.currentAvatarRef?.kind === "preset" ? result.currentAvatarRef.id : null);
        setUndoRevisionId(null);
        setNotice("Agent photo restored.");
        return result.scope;
      },
      after: async (nextScope) => { await refreshProfileProjection(); await load(false, null, nextScope); },
    });
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    runMutation({
      operationId: crypto.randomUUID(), label: "upload",
      work: async (options) => (await apiClient.uploadAgentPhotoLibraryEntry(file, options)).scope,
      after: (nextScope) => { setScope(nextScope); setTab("recent"); },
    });
  };

  const generate = () => {
    const capturedPrompt = prompt.trim();
    if (!capturedPrompt) return;
    let generatedEntries: AgentPhotoLibraryEntryDto[] = [];
    runMutation({
      operationId: crypto.randomUUID(), label: "generation",
      work: async (options) => {
        const result = await apiClient.generateAgentPhotoLibraryEntries(
          { prompt: capturedPrompt, count: generationCount },
          options,
        );
        generatedEntries = result.entries.map((entry) => ({
          ...entry,
          deletedAt: null,
          purgeAfter: null,
          isCurrent: false,
        }));
        return result.scope;
      },
      after: (nextScope) => {
        pendingGeneratedRef.current = { scope: nextScope, entries: generatedEntries };
        setScope(nextScope);
        setEntries(generatedEntries);
        setNextCursor(null);
        setPrompt("");
        setTab("recent");
      },
    });
  };

  const lifecycle = (entry: AgentPhotoLibraryEntryDto, operation: "delete" | "restore") => {
    runMutation({
      operationId: crypto.randomUUID(), label: operation,
      work: async (options) => (operation === "delete"
        ? await apiClient.deleteAgentPhotoLibraryEntry(entry.id, options)
        : await apiClient.restoreAgentPhotoLibraryEntry(entry.id, options)).scope,
      after: async (nextScope) => { setSelected(null); setPendingDeleteId(null); await load(false, null, nextScope); },
    });
  };

  if (!open) return null;
  const fence = scope ? makeFence(scope, requestGeneration.current) : null;
  const changeTab = (value: Tab) => {
    if (busy) return;
    setSelected(null);
    setPendingDeleteId(null);
    setTab(value);
  };
  const selectedEntry = selected?.kind === "entry"
    ? entries.find((entry) => entry.id === selected.entryId) ?? null
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <section className="flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background-panel shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="agent-photo-library-title" aria-busy={loading || busy}>
        <header className="flex items-center justify-between border-b border-border px-5 py-4"><h2 id="agent-photo-library-title" className="text-lg font-semibold">Change Agent photo</h2><button ref={closeRef} type="button" onClick={onClose} disabled={busy} aria-label="Close photo library" className="rounded px-2 py-1 hover:bg-background-element">×</button></header>
        <nav className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2" aria-label="Photo library sections">
          {PRIMARY_TABS.map((value) => <button key={value} type="button" disabled={busy} onClick={() => changeTab(value)} aria-current={tab === value ? "page" : undefined} className={`rounded px-3 py-1.5 text-sm disabled:opacity-50 ${tab === value ? "bg-background-element font-medium" : "text-foreground-muted hover:text-foreground"}`}>{value[0].toUpperCase() + value.slice(1)}</button>)}
        </nav>
        <div className="border-b border-border px-4 py-2"><button type="button" disabled={busy} onClick={() => changeTab("deleted")} aria-current={tab === "deleted" ? "page" : undefined} className="rounded px-3 py-1.5 text-sm font-medium text-foreground-muted disabled:opacity-50">Recently deleted</button></div>
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          {error ? <div role="alert" className="mb-4 rounded border border-tool-error/40 bg-tool-error/10 p-3 text-sm text-tool-error">{error}{retry ? <button type="button" onClick={retry.run} disabled={busy} className="ml-2 underline">{retry.label}</button> : null}</div> : null}
          {notice ? <div role="status" aria-live="polite" className="mb-4 flex items-center justify-between rounded border border-border bg-background-element p-3 text-sm"><span>{notice}</span>{undoRevisionId ? <button type="button" onClick={undo} disabled={busy} className="font-medium underline">Undo</button> : null}</div> : undoRevisionId ? <div role="status" className="mb-4 flex items-center justify-between rounded border border-border bg-background-element p-3 text-sm"><span>Previous photo available.</span><button type="button" onClick={undo} disabled={busy} className="font-medium underline">Undo</button></div> : null}
          {tab === "upload" ? <div className="rounded-lg border border-dashed border-border p-8 text-center"><p className="mb-4 text-sm text-foreground-muted">PNG, JPEG, or WebP, up to 5 MB. Uploading adds the photo to your library; it does not select it.</p><input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} disabled={busy} aria-label="Choose Agent photo to upload" /></div> : null}
          {tab === "generate" ? <div className="space-y-3"><label className="block text-sm font-medium" htmlFor="agent-photo-prompt">Describe the Agent photo</label><textarea id="agent-photo-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={500} rows={4} disabled={busy} className="w-full rounded-lg border border-border bg-background px-3 py-2" /><fieldset disabled={busy}><legend className="mb-2 text-sm font-medium">Number of photos</legend><div className="flex flex-wrap gap-2">{([1, 2, 3, 4] as const).map((count) => <button key={count} type="button" role="radio" aria-checked={generationCount === count} onClick={() => setGenerationCount(count)} className={`min-h-10 min-w-10 rounded-full border px-3 text-sm font-medium ${generationCount === count ? "border-accent bg-background-element text-accent" : "border-border text-foreground"}`}>{count}</button>)}</div></fieldset><button type="button" disabled={busy || !prompt.trim()} onClick={generate} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Generate {generationCount} photo{generationCount === 1 ? "" : "s"}</button><p className="text-xs text-foreground-muted">Generated photos are added first. You choose which one becomes current.</p></div> : null}
          {tab === "presets" ? <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">{presets.map((preset) => <button key={preset.id} type="button" disabled={busy} onClick={() => setSelected({ kind: "preset", presetId: preset.id })} aria-label={`Preset ${preset.id}${currentPresetId === preset.id ? ", current" : ""}`} aria-pressed={selected?.kind === "preset" && selected.presetId === preset.id} className={`relative aspect-square overflow-hidden rounded-lg border-2 disabled:opacity-50 ${selected?.kind === "preset" && selected.presetId === preset.id ? "border-accent" : "border-border"}`}><img src={preset.thumbnailUrl} alt="" className="h-full w-full object-cover" />{currentPresetId === preset.id ? <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium">Current</span> : null}</button>)}</div> : null}
          {(tab === "recent" || tab === "deleted") && fence ? <><div className="grid grid-cols-3 gap-3 sm:grid-cols-4">{entries.map((entry) => <div key={entry.id} className="space-y-1"><OwnedPhoto entry={entry} selected={selected?.kind === "entry" && selected.entryId === entry.id} fence={fence} onSelect={() => { if (!busy && tab === "recent") setSelected({ kind: "entry", entryId: entry.id }); }} interactive={tab === "recent"} />{tab === "deleted" ? <><p className="text-center text-[10px] text-foreground-muted">Recoverable until {entry.purgeAfter ? new Date(entry.purgeAfter).toLocaleDateString() : "expiration"}</p><button type="button" aria-label={`Restore ${photoLabel(entry)}`} onClick={() => lifecycle(entry, "restore")} disabled={busy} className="w-full text-xs font-medium underline">Restore</button></> : null}</div>)}</div>{!loading && entries.length === 0 ? <p className="py-12 text-center text-sm text-foreground-muted">{tab === "deleted" ? "Recently deleted is empty." : "No saved photos yet."}</p> : null}{nextCursor ? <button type="button" onClick={() => void load(true, nextCursor)} disabled={loading || busy} className="mx-auto mt-5 block rounded border border-border px-3 py-2 text-sm">{loading ? "Loading…" : "Load more"}</button> : null}</> : null}
          {loading && entries.length === 0 && presets.length === 0 ? <div className="grid grid-cols-3 gap-3" role="status" aria-label="Loading photo library">{Array.from({ length: 6 }, (_, index) => <div key={index} className="aspect-square animate-pulse rounded-lg bg-background-element" />)}</div> : null}
        </main>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{selectedEntry && pendingDeleteId === selectedEntry.id ? <><span className="mr-auto text-sm">Move this photo to Recently deleted?</span><button type="button" onClick={() => setPendingDeleteId(null)} disabled={busy} className="rounded border border-border px-4 py-2 text-sm">Keep photo</button><button autoFocus type="button" aria-label={`Delete ${photoLabel(selectedEntry)}`} onClick={() => lifecycle(selectedEntry, "delete")} disabled={busy} className="rounded border border-tool-error px-4 py-2 text-sm font-medium text-tool-error">Delete photo</button></> : <><button type="button" onClick={onClose} disabled={busy} className="rounded border border-border px-4 py-2 text-sm">Cancel</button>{selectedEntry && selectedEntry.id !== currentEntryId && tab === "recent" ? <button type="button" onClick={() => setPendingDeleteId(selectedEntry.id)} disabled={busy} className="rounded border border-tool-error px-4 py-2 text-sm font-medium text-tool-error">Delete</button> : null}<button type="button" onClick={usePhoto} disabled={busy || !selected || tab === "deleted"} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Working…" : "Use this photo"}</button></>}</footer>
      </section>
    </div>
  );
}
