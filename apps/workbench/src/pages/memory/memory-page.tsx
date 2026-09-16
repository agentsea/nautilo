import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import { GuestPlaceholder } from "../settings/ui";
import { Button, TextInput } from "../settings/ui";
import {
  archiveMemory,
  fetchMemories,
  fetchMemory,
  fetchPromptBriefReadOnly,
  grantMemory,
  hardDeleteMemory,
  makeMemoryPrivate,
  MemoryHardDeleteConflictError,
  revokeMemory,
  searchMemories,
  updateMemory,
  type MemoryDetail,
  type MemoryDetailResponse,
  type MemoryListItem,
  type MemoryMode,
} from "../../lib/memory-api";
import {
  audienceBadgeLabel,
  audienceState,
  audienceStateFromAccessList,
  canManageAccess,
  filterMemories,
  formatAccessList,
  formatAudienceFaces,
  formatImportanceStars,
  formatRelativeTime,
  rowAffordances,
  rowKind,
  truncateContent,
  type MemoryKindFilter,
} from "./memory-view-model";
import { apiClient } from "../../lib/api";
import { deploymentSafeLazy } from "../../lib/deployment-safe-lazy";
import { createBrowserHumanMemoryClient } from
  "@nautilo/lattice-bridge/client/browser";
import { ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import { readOrCreateBrowserCryptoInstallationId } from
  "../../lib/browser-crypto-installation";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import {
  createWorkbenchProtectedHumanMemoryController,
  withCryptoAdmissionForProtectedMemoryController,
  type WorkbenchProtectedHumanMemoryController,
} from "../../lib/protected-human-memory-controller";
import { createWorkbenchDataOperationOwner } from "../../lib/encryption-data-operation-policy";
import {
  createWorkbenchMemoryReadOperations,
  type MemoryActionPresentation,
  type WorkbenchMemoryReadOperations,
} from "../../lib/memory-read-operations";
import { ContentAccessDialog } from "../../components/content-access/content-access-dialog";
import { useConversationEncryptionPolicyMode } from "../../adapters/runtime-contexts";
import { useToast } from "../../components/toast";

type ProtectedHumanMemoryOperations = Omit<
  ReturnType<typeof createWorkbenchProtectedHumanMemoryController>,
  "dispose"
>;

type DirectoryHuman = { userId: string; handle: string; displayName: string };

/** Sentinel value for the "Just me" (private-only) option in the audience picker. */
const PRIVATE_FILTER = "__private__";
import {
  loadAmbience,
  prefersReducedMotion,
  saveAmbience,
  settingsForPreset,
  type AmbiencePreset,
  type AmbienceSettings,
} from "./memory-ambience";

const MemoryField = deploymentSafeLazy(() =>
  import("./memory-field").then((m) => ({ default: m.MemoryField })),
);

function MemoryBadge({ badge }: { badge: string }) {
  return <span className="shrink-0 text-xs text-foreground-dim">{badge}</span>;
}

const AMBIENCE_LABELS: Record<AmbiencePreset, string> = {
  calm: "Calm",
  standard: "Standard",
  lush: "Lush",
  off: "Off",
};

const CUSTOM_SLIDERS: Array<{
  key: keyof AmbienceSettings;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "density", label: "density", min: 30, max: 400, step: 1 },
  { key: "drift", label: "drift", min: 0, max: 1.2, step: 0.01 },
  { key: "links", label: "links", min: 5, max: 80, step: 1 },
  { key: "glow", label: "glow", min: 0, max: 3, step: 0.05 },
  { key: "hubPct", label: "hubs", min: 2, max: 30, step: 1 },
  { key: "hubSize", label: "hub size", min: 1.5, max: 6, step: 0.1 },
];

function AmbienceControl({
  userId,
  preset,
  settings,
  reducedMotion,
  onPresetChange,
  onSettingsChange,
}: {
  userId: string;
  preset: AmbiencePreset;
  settings: AmbienceSettings;
  reducedMotion: boolean;
  onPresetChange: (next: AmbiencePreset) => void;
  onSettingsChange: (next: AmbienceSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const pickPreset = (next: AmbiencePreset) => {
    onPresetChange(next);
    if (next !== "off") {
      onSettingsChange(settingsForPreset(next));
    }
    saveAmbience(userId, next);
  };

  return (
    <div ref={panelRef} className="relative shrink-0">
      <button
        type="button"
        className="rounded border border-border/60 bg-background-panel/80 px-2 py-1 text-xs text-foreground-muted backdrop-blur-sm hover:text-foreground"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        ✦ Ambience ▾
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-border bg-background-panel p-3 text-xs shadow-lg"
          role="menu"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold text-foreground">Ambience</span>
            <button
              type="button"
              className="text-foreground-muted hover:text-foreground"
              aria-label="Close ambience menu"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {(["standard", "calm", "lush", "off"] as const).map((key) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 py-0.5">
                <input
                  type="radio"
                  name="ambience-preset"
                  checked={preset === key}
                  onChange={() => pickPreset(key)}
                />
                {AMBIENCE_LABELS[key]}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-1 text-left text-foreground-muted hover:text-foreground"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
          >
            {customOpen ? "▾" : "▸"} Custom
          </button>
          {customOpen ? (
            <div className="mt-2 space-y-2 border-t border-border pt-2">
              {CUSTOM_SLIDERS.map(({ key, label, min, max, step }) => (
                <label key={key} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-foreground-dim">{label}</span>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={settings[key]}
                    disabled={preset === "off"}
                    onChange={(e) =>
                      onSettingsChange({
                        ...settings,
                        [key]: Number.parseFloat(e.target.value),
                      })
                    }
                    className="min-w-0 flex-1"
                  />
                  <span className="w-10 shrink-0 text-right tabular-nums text-foreground-muted">
                    {key === "hubPct" ? `${settings[key]}%` : settings[key].toFixed(key === "density" || key === "links" ? 0 : 2)}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {reducedMotion ? (
            <p className="mt-2 border-t border-border pt-2 text-foreground-dim">
              Respects reduced-motion
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DeleteConfirmModal({
  sharedWarning,
  onCancel,
  onConfirm,
  busy,
}: {
  sharedWarning: { namespaceCount: number; namespaceIds: string[]; hint?: string } | null;
  onCancel: () => void;
  onConfirm: (confirmShared: boolean) => void;
  busy: boolean;
}) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim().toUpperCase() === "DELETE";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-memory-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background-panel p-4 shadow-lg">
        <h2 id="delete-memory-title" className="text-lg font-semibold">
          Delete memory permanently?
        </h2>
        <p className="mt-2 text-sm text-foreground-muted">
          This removes the memory and its embedding. Archive instead if you only want to hide it
          from the agent.
        </p>
        {sharedWarning ? (
          <p className="mt-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-sm text-foreground">
            Shared with {Math.max(0, sharedWarning.namespaceCount - 1)} other{" "}
            {Math.max(0, sharedWarning.namespaceCount - 1) === 1 ? "person" : "people"}.{" "}
            {sharedWarning.hint ?? "Confirm to detach from your view only."}
          </p>
        ) : null}
        <p className="mt-3 text-sm">
          Type <code className="text-xs">DELETE</code> to confirm.
        </p>
        <TextInput
          value={typed}
          onChange={setTyped}
          ariaLabel="Type DELETE to confirm"
          placeholder="DELETE"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={() => onConfirm(sharedWarning !== null)}
          >
            Delete permanently
          </Button>
        </div>
      </div>
    </div>
  );
}

function PromptBriefPanel({
  brief,
  loading,
  error,
  onClose,
}: {
  brief: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background-panel p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Active memory — what Jeannie's using now (read-only)</h2>
        <button
          type="button"
          className="text-xs text-foreground-muted hover:text-foreground"
          onClick={onClose}
        >
          Hide
        </button>
      </div>
      {loading ? (
        <p className="text-sm text-foreground-muted">Loading brief…</p>
      ) : error ? (
        <p className="text-sm text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground-muted">
          {brief?.trim() ? brief : "(empty brief)"}
        </pre>
      )}
    </div>
  );
}

function MemoryRow({
  item,
  memoryMode,
  canEdit,
  busy,
  reverseLensHandle,
  onEdit,
  onArchive,
  onRevoke,
  allowAccessMutations,
  allowArchive,
}: {
  item: MemoryListItem;
  memoryMode: MemoryMode;
  canEdit: boolean;
  busy: string | null;
  reverseLensHandle: string | null;
  onEdit: (id: string) => void;
  onArchive: (id: string) => void;
  onRevoke: (id: string) => void;
  allowAccessMutations: boolean;
  allowArchive: boolean;
}) {
  const kind = rowKind(item, memoryMode);
  const affordances = rowAffordances(kind);
  const isBusy = busy === item.id;
  // Prefer the server-supplied people list (D328 list accessList); fall back to
  // the coarse namespace-count state when it's absent (older server / no field).
  const audience =
    kind === "namespace"
      ? item.accessList !== undefined
        ? audienceStateFromAccessList(item.accessList)
        : audienceState(item)
      : null;
  const audienceLabel =
    audience === "shared" && item.accessList && item.accessList.length > 0
      ? `👥 ${formatAudienceFaces(item.accessList)}`
      : audience !== null
        ? audienceBadgeLabel(audience)
        : "";
  const inReverseLens = reverseLensHandle !== null;

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm" aria-hidden="true">
              {formatImportanceStars(item.importance)}
            </span>
            <button
              type="button"
              className="truncate text-left text-sm font-semibold hover:text-primary"
              onClick={() => onEdit(item.id)}
            >
              {truncateContent(item.content)}
            </button>
            <MemoryBadge badge={affordances.badge} />
            {item.tier >= 2 ? <MemoryBadge badge={`tier ${item.tier}`} /> : null}
          </div>
          <p className="mt-1 text-xs text-foreground-dim">
            {item.type}
            {audienceLabel ? ` · ${audienceLabel}` : ""}
            {kind === "scope-seed" ? " · seed" : ""}
            {" · "}
            {formatRelativeTime(item.updatedAt)}
          </p>
        </div>
        {inReverseLens ? (
          allowAccessMutations && canEdit && kind === "namespace" ? (
            <div className="flex shrink-0 gap-2 text-xs">
              <button
                type="button"
                className="text-foreground-muted hover:text-[var(--error)]"
                disabled={isBusy}
                onClick={() => onRevoke(item.id)}
              >
                Revoke
              </button>
            </div>
          ) : null
        ) : canEdit ? (
          <div className="flex shrink-0 gap-2 text-xs">
            {affordances.canEdit ? (
              <button
                type="button"
                className="text-foreground-muted hover:text-foreground"
                onClick={() => onEdit(item.id)}
              >
                Edit
              </button>
            ) : affordances.isReadOnly ? (
              <button
                type="button"
                className="text-foreground-muted hover:text-foreground"
                onClick={() => onEdit(item.id)}
              >
                View
              </button>
            ) : null}
            {allowArchive && affordances.canArchive ? (
              <button
                type="button"
                className="text-foreground-muted hover:text-foreground"
                disabled={isBusy}
                onClick={() => onArchive(item.id)}
              >
                Archive
              </button>
            ) : affordances.isReadOnly ? (
              <span className="text-foreground-dim">read-only</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemoryListView({
  items,
  memoryMode,
  nextCursor,
  canEdit,
  showArchived,
  userId,
  directoryHumans,
  personFilter,
  privateFilter,
  total,
  onPersonFilterChange,
  onPrivateFilterChange,
  onShowArchivedChange,
  onRefresh,
  onLoadMore,
  memoryReads,
}: {
  items: MemoryListItem[];
  memoryMode: MemoryMode;
  nextCursor: string | null;
  canEdit: boolean;
  showArchived: boolean;
  userId: string;
  directoryHumans: DirectoryHuman[];
  personFilter: string | null;
  privateFilter: boolean;
  total: number | null;
  onPersonFilterChange: (handle: string | null) => void;
  onPrivateFilterChange: (next: boolean) => void;
  onShowArchivedChange: (next: boolean) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  memoryReads: WorkbenchMemoryReadOperations;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKindFilter>("all");
  const [personHandleDraft, setPersonHandleDraft] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBrief, setShowBrief] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [ambiencePreset, setAmbiencePreset] = useState<AmbiencePreset>(() => loadAmbience(userId));
  const [ambienceSettings, setAmbienceSettings] = useState<AmbienceSettings>(() => {
    const loaded = loadAmbience(userId);
    return settingsForPreset(loaded === "off" ? "standard" : loaded);
  });
  const [reducedMotion] = useState(() => prefersReducedMotion());

  useEffect(() => {
    const loaded = loadAmbience(userId);
    setAmbiencePreset(loaded);
    if (loaded !== "off") {
      setAmbienceSettings(settingsForPreset(loaded));
    }
  }, [userId]);

  const fieldAnimate = ambiencePreset !== "off" && !reducedMotion;
  const showField = ambiencePreset !== "off";
  const importances = useMemo(() => items.map((item) => item.importance), [items]);

  const displayItems = searchResults ?? items;

  // "Just me" is now a server-side filter (?audience=private), so no local
  // private filtering here — the server returns exactly the private rows.
  const filtered = useMemo(
    () =>
      filterMemories(displayItems, memoryMode, {
        query: searchResults ? "" : query,
        kind: kindFilter,
        namespaceId: "all",
      }),
    [displayItems, memoryMode, searchResults, query, kindFilter],
  );

  const personDisplayName = useMemo(() => {
    if (!personFilter) return null;
    const match = directoryHumans.find((h) => h.handle === personFilter);
    return match?.displayName?.trim() || `@${personFilter}`;
  }, [personFilter, directoryHumans]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (index) => filtered[index]?.id ?? index,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  // Infinite scroll: observe a sentinel at the bottom of the list. Using an
  // IntersectionObserver (vs. the virtualizer's last-row index) makes this work
  // regardless of which ancestor actually scrolls — the prior index heuristic
  // never fired when the page, not the inner list div, was the scroll container.
  // Guarded on nextCursor so a settled cursor can't re-trigger in a loop.
  const requestedCursorRef = useRef<string | null>(null);
  const loadMoreRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || searchResults || !nextCursor) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && requestedCursorRef.current !== nextCursor) {
          requestedCursorRef.current = nextCursor;
          onLoadMore();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, searchResults, onLoadMore]);

  const goToMemory = useCallback(
    (id: string) => {
      void navigate(`/memory/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const runSearch = async () => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setSearchResults([...(await memoryReads.search({ q, includeArchive: showArchived }))]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const archive = async (id: string) => {
    if (!canEdit) return;
    if (!window.confirm("Archive this memory? It will be hidden from the agent.")) return;
    setBusy(id);
    setError(null);
    try {
      await memoryReads.archive(id);
      setSearchResults(null);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const revokePerson = async (id: string) => {
    if (!canEdit || !personFilter) return;
    if (
      !window.confirm(
        `Revoke ${personDisplayName ?? `@${personFilter}`}'s access to this memory from now on?`,
      )
    ) {
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await memoryReads.revokeUser(id, personFilter);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyPersonDraft = () => {
    const handle = personHandleDraft.trim().replace(/^@/, "");
    if (handle) onPrivateFilterChange(false);
    onPersonFilterChange(handle ? handle : null);
  };

  const loadBrief = async () => {
    setShowBrief(true);
    setBriefLoading(true);
    setBriefError(null);
    try {
      setBrief(await memoryReads.brief());
    } catch (e) {
      setBriefError(e instanceof Error ? e.message : String(e));
    } finally {
      setBriefLoading(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <div className="relative min-h-[150px] shrink-0">
        {/* Field + scrim are clipped to the rounded band; the header/controls
            live in a sibling that is NOT clipped, so the Ambience dropdown can
            overflow the band without being cut off. */}
        <div className="absolute inset-0 overflow-hidden rounded-lg border border-border bg-background-panel">
          {showField ? (
            <Suspense fallback={null}>
              <MemoryField
                className="absolute inset-0"
                settings={ambienceSettings}
                itemCount={items.length}
                importances={importances}
                animate={fieldAnimate}
              />
            </Suspense>
          ) : null}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-background-panel/90 via-background-panel/40 to-transparent" />
        </div>
        <header className="relative z-10 flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="[text-shadow:0_1px_10px_rgb(0_0_0_/_60%)]">
            <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              What your Genie remembers about you
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AmbienceControl
              userId={userId}
              preset={ambiencePreset}
              settings={ambienceSettings}
              reducedMotion={reducedMotion}
              onPresetChange={setAmbiencePreset}
              onSettingsChange={setAmbienceSettings}
            />
            <Button variant="secondary" onClick={() => void loadBrief()}>
              Active Memory
            </Button>
          </div>
        </header>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[12rem] flex-1">
          <TextInput
            value={query}
            onChange={setQuery}
            placeholder="Search memories…"
            ariaLabel="Search memories"
          />
        </div>
        <Button
          variant="secondary"
          loading={searching}
          onClick={() => void runSearch()}
        >
          Search
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <label className="flex items-center gap-1 text-foreground-muted">
          Kind
          <select
            className="rounded border border-border bg-background-element px-2 py-1 text-foreground"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as MemoryKindFilter)}
          >
            <option value="all">All</option>
            <option value="namespace">Namespace</option>
            <option value="scope">Scope</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-foreground-muted">
          Who can see
          <select
            className="rounded border border-border bg-background-element px-2 py-1 text-foreground"
            value={privateFilter ? PRIVATE_FILTER : (personFilter ?? "anyone")}
            onChange={(e) => {
              const v = e.target.value;
              setPersonHandleDraft("");
              if (v === PRIVATE_FILTER) {
                onPrivateFilterChange(true);
                onPersonFilterChange(null);
              } else {
                onPrivateFilterChange(false);
                onPersonFilterChange(v === "anyone" ? null : v);
              }
            }}
          >
            <option value="anyone">Anyone</option>
            <option value={PRIVATE_FILTER}>Just me</option>
            {directoryHumans.map((h) => (
              <option key={h.userId} value={h.handle}>
                {h.displayName?.trim() || `@${h.handle}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-foreground-muted">
          or @handle
          <input
            className="w-28 rounded border border-border bg-background-element px-2 py-1 text-foreground"
            value={personHandleDraft}
            placeholder="@handle"
            aria-label="Filter by a person's handle"
            onChange={(e) => setPersonHandleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyPersonDraft();
            }}
            onBlur={applyPersonDraft}
          />
        </label>
        <label className="flex items-center gap-2 text-foreground-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => onShowArchivedChange(e.target.checked)}
            className="rounded border-border"
          />
          Show archived
        </label>
        {searchResults ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => {
              setSearchResults(null);
              setQuery("");
            }}
          >
            Clear search
          </button>
        ) : null}
      </div>

      {showBrief ? (
        <PromptBriefPanel
          brief={brief}
          loading={briefLoading}
          error={briefError}
          onClose={() => setShowBrief(false)}
        />
      ) : null}

      {error ? (
        <p className="text-sm text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : null}

      {personFilter ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background-panel px-4 py-2 text-sm">
          <span className="text-foreground-muted">
            <span className="font-medium text-foreground">{personDisplayName}</span> can see{" "}
            {total === null ? "…" : total} {total === 1 ? "memory" : "memories"} about you
          </span>
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => {
              setPersonHandleDraft("");
              onPersonFilterChange(null);
            }}
          >
            Clear ✕
          </button>
        </div>
      ) : privateFilter ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background-panel px-4 py-2 text-sm">
          <span className="text-foreground-muted">
            🔒 {total === null ? "…" : total} {total === 1 ? "memory" : "memories"} only you can see
          </span>
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => onPrivateFilterChange(false)}
          >
            Clear ✕
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background-panel"
      >
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-foreground-muted">
            {items.length === 0
              ? "No memories yet — your Genie will save facts as you chat."
              : "No memories match your filters."}
          </p>
        ) : (
          <div
            style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            {virtualRows.map((vrow) => {
              const item = filtered[vrow.index];
              if (!item) return null;
              return (
                <div
                  key={vrow.key}
                  data-index={vrow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vrow.start}px)`,
                  }}
                >
                  <MemoryRow
                    item={item}
                    memoryMode={memoryMode}
                    canEdit={canEdit}
                    busy={busy}
                    reverseLensHandle={personFilter}
                    onEdit={goToMemory}
                    onArchive={(id) => void archive(id)}
                    onRevoke={(id) => void revokePerson(id)}
                    allowAccessMutations
                    allowArchive
                  />
                </div>
              );
            })}
          </div>
        )}
        {nextCursor && !searchResults ? (
          <p
            ref={loadMoreRef}
            className="px-4 py-2 text-center text-xs text-foreground-dim"
          >
            Loading more…
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MemoryEditorView({
  initial,
  memoryMode,
  canEdit,
  directoryHumans,
  onSaved,
  onArchived,
  onDeleted,
  operations,
  actions,
  ordinaryAccess,
}: {
  initial: MemoryDetail;
  memoryMode: MemoryMode;
  canEdit: boolean;
  directoryHumans: DirectoryHuman[];
  onSaved: () => void;
  onArchived: () => void;
  onDeleted: () => void;
  operations: WorkbenchMemoryReadOperations;
  actions: MemoryActionPresentation;
  ordinaryAccess?: { context: MemoryDetailResponse["accessContext"] | null; onChanged: () => void; onAccessLost: (message: string) => void };
}) {
  const navigate = useNavigate();
  const kind = rowKind(initial, memoryMode);
  const affordances = rowAffordances(kind);
  const readOnly = affordances.isReadOnly || !canEdit || !actions.canEditContent;

  const [content, setContent] = useState(initial.content);
  const [importance, setImportance] = useState(initial.importance);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUpPending, setFollowUpPending] = useState(false);
  const [ordinaryFallback, setOrdinaryFallback] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteShared, setDeleteShared] = useState<{
    namespaceCount: number;
    namespaceIds: string[];
    hint?: string;
  } | null>(null);
  const [grantHandle, setGrantHandle] = useState("");
  const [showManageAccess, setShowManageAccess] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);

  const recordProtectedReceipt = (receipt: unknown) => {
    if (typeof receipt !== "object" || receipt === null) return;
    setFollowUpPending("followUpPending" in receipt && receipt.followUpPending === true);
    setOrdinaryFallback("status" in receipt && receipt.status === "ordinary_fallback");
  };

  useEffect(() => {
    setContent(initial.content);
    setImportance(initial.importance);
  }, [initial]);

  const audience = audienceStateFromAccessList(initial.accessList);

  const submit = async () => {
    if (readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const receipt = await operations.update(initial.id, {
        type: initial.type, content: content.trim(), importance,
      });
      recordProtectedReceipt(receipt);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!canEdit || !affordances.canArchive) return;
    if (!window.confirm("Archive this memory? It will be hidden from the agent.")) return;
    setBusy(true);
    setError(null);
    try {
      await operations.archive(initial.id);
      onArchived();
      void navigate("/memory");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeTier = async (action: "promote" | "demote") => {
    if (!canEdit || !actions.canChangeTier) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await operations.transitionTier(initial.id, action);
      setFollowUpPending(
        typeof receipt === "object" && receipt !== null
        && "followUpPending" in receipt && receipt.followUpPending === true,
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!canEdit || !actions.canChangeTier) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await operations.restore(initial.id);
      setFollowUpPending(
        typeof receipt === "object" && receipt !== null
        && "followUpPending" in receipt && receipt.followUpPending === true,
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const attemptDelete = async (confirmShared: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await operations.delete(initial.id, confirmShared);
      onDeleted();
      void navigate("/memory");
    } catch (e) {
      if (e instanceof MemoryHardDeleteConflictError) {
        setDeleteShared({
          namespaceCount: e.namespaceCount,
          namespaceIds: e.namespaceIds,
          ...(e.hint !== undefined ? { hint: e.hint } : {}),
        });
        setShowDelete(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const grantAccess = async () => {
    const handle = grantHandle.trim().replace(/^@/, "");
    if (!handle) return;
    setAccessBusy(true);
    setError(null);
    try {
      recordProtectedReceipt(await operations.grantUser(initial.id, handle));
      setGrantHandle("");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccessBusy(false);
    }
  };

  const revokeAccess = async (userHandle: string) => {
    setAccessBusy(true);
    setError(null);
    try {
      recordProtectedReceipt(await operations.revokeUser(initial.id, userHandle));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccessBusy(false);
    }
  };

  const makePrivate = async () => {
    setAccessBusy(true);
    setError(null);
    try {
      recordProtectedReceipt(await operations.makePrivate(initial.id));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccessBusy(false);
    }
  };

  const deleteAuthorizedView = async () => {
    if (!window.confirm("Remove this memory from your library? Other authorized people may still retain access.")) return;
    setBusy(true);
    setError(null);
    try {
      await operations.delete(initial.id);
      onDeleted();
      void navigate("/memory");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <header>
        <button
          type="button"
          className="text-sm text-foreground-muted hover:text-foreground"
          onClick={() => void navigate("/memory")}
        >
          ← Memory
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {truncateContent(initial.content, 48)}
          </h1>
          <MemoryBadge badge={affordances.badge} />
          {readOnly ? (
            <span className="text-xs text-foreground-dim">read-only</span>
          ) : null}
        </div>
      </header>

      {kind === "scope-seed" ? (
        <div className="rounded-lg border border-border bg-background-panel px-4 py-3 text-sm text-foreground-muted">
          This memory was attached as scope context (seed) and cannot be edited here. Ask the
          parent agent to update room memory instead.
        </div>
      ) : null}

      {memoryMode === "namespace" ? (
        <div className="rounded-lg border border-border bg-background-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-dim">
            Who can see this
          </h2>
          {ordinaryAccess ? <>
            <p className="mt-2 text-sm text-foreground-muted">
              Review or change who can use this Memory.
            </p>
            {ordinaryAccess.context ? <p className="mt-2 text-sm text-foreground-muted">
              Access context: {ordinaryAccess.context.label}
            </p> : null}
            {actions.canManageAccess && canManageAccess(canEdit) && ordinaryAccess.context ? <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => setShowManageAccess(true)}
              >Manage access…</Button>
            </div> : null}
            {!ordinaryAccess.context ? <p role="status" className="mt-2 text-xs">Reload this Memory to resolve its access context.</p> : null}
            {showManageAccess && ordinaryAccess.context ? <ContentAccessDialog
              subjects={[{ object: { kind: "memory", id: initial.id }, label: truncateContent(initial.content, 48) }]}
              roomId={ordinaryAccess.context.roomId}
              onChanged={ordinaryAccess.onChanged}
              onAccessLost={ordinaryAccess.onAccessLost}
              onClose={() => setShowManageAccess(false)}
            /> : null}
          </> : <><p className="mt-2 text-sm font-medium">
            {audience === "shared" ? (
              <span>👥 Shared · {formatAccessList(initial.accessList)}</span>
            ) : (
              <span>🔒 Private — only you ↔ 🧞 Jeannie</span>
            )}
          </p>
          {actions.canManageAccess && canManageAccess(canEdit) ? (
            <div className="mt-3 space-y-3">
              {initial.accessList && initial.accessList.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {initial.accessList.map((entry) => (
                    <li key={entry.userHandle} className="flex items-center justify-between gap-2">
                      <span>
                        {entry.displayName?.trim() || `@${entry.userHandle}`}
                      </span>
                      <Button
                        variant="secondary"
                        loading={accessBusy}
                        onClick={() => void revokeAccess(entry.userHandle)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex items-center gap-1 text-sm text-foreground-muted">
                  Grant to
                  <select
                    className="rounded border border-border bg-background-element px-2 py-1 text-foreground"
                    value=""
                    aria-label="Grant access to a person from your directory"
                    onChange={(e) => {
                      if (e.target.value) setGrantHandle(e.target.value);
                    }}
                  >
                    <option value="">a person…</option>
                    {directoryHumans.map((h) => (
                      <option key={h.userId} value={h.handle}>
                        {h.displayName?.trim() || `@${h.handle}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="min-w-[10rem] flex-1">
                  <TextInput
                    value={grantHandle}
                    onChange={setGrantHandle}
                    placeholder="or @handle"
                    ariaLabel="User handle to grant access"
                  />
                </div>
                <Button
                  variant="secondary"
                  loading={accessBusy}
                  onClick={() => void grantAccess()}
                >
                  Grant
                </Button>
              </div>
              {audience === "shared" ? (
                <Button
                  variant="secondary"
                  loading={accessBusy}
                  onClick={() => void makePrivate()}
                >
                  Make fully private (you ↔ 🧞)
                </Button>
              ) : null}
            </div>
          ) : null}
          </>}
        </div>
      ) : null}

      <div className="space-y-4 rounded-lg border border-border bg-background-panel p-4">
        <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
          <label htmlFor="memory-content" className="text-sm font-medium sm:pt-2">
            Content
          </label>
          <div>
            <textarea
              id="memory-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={readOnly}
              rows={6}
              className="w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground placeholder:text-foreground-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-foreground-dim">Re-embeds on save when content changes</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[140px_1fr] sm:items-center">
          <label htmlFor="memory-importance" className="text-sm font-medium">
            Importance
          </label>
          <div className="flex items-center gap-2">
            <input
              id="memory-importance"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(e) => setImportance(Number.parseFloat(e.target.value))}
              disabled={readOnly}
              className="flex-1"
            />
            <span className="text-sm" aria-hidden="true">
              {formatImportanceStars(importance)}
            </span>
          </div>
        </div>

        <p className="text-xs text-foreground-muted">
          {initial.type} · tier {initial.tier} · updated {formatRelativeTime(initial.updatedAt)}
        </p>
        <p className="text-xs text-[var(--warning)]">
          {actions.retentionNotice}
        </p>

        {error ? (
          <p className="text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}
        {ordinaryFallback ? (
          <p className="text-sm text-[var(--warning)]" role="status">
            Memory saved without encryption. Protected verification is still pending.
          </p>
        ) : null}
        {followUpPending ? (
          <p className="text-sm text-[var(--warning)]" role="status">
            Memory saved; follow-up processing pending
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {canEdit && affordances.canArchive ? (
            <Button variant="secondary" loading={busy} onClick={() => void archive()}>
              Archive
            </Button>
          ) : null}
          {actions.canChangeTier && canEdit && initial.tier === 2 ? (
            <Button variant="secondary" loading={busy} onClick={() => void changeTier("promote")}>
              Promote
            </Button>
          ) : null}
          {actions.canChangeTier && canEdit && initial.tier === 1 ? (
            <Button variant="secondary" loading={busy} onClick={() => void changeTier("demote")}>
              Demote
            </Button>
          ) : null}
          {actions.canChangeTier && canEdit && initial.tier === 3 ? (
            <Button variant="secondary" loading={busy} onClick={() => void restore()}>
              Restore
            </Button>
          ) : null}
          {actions.deletion === "permanent" && canEdit && affordances.canDelete ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => {
                setDeleteShared(null);
                setShowDelete(true);
              }}
            >
              Delete…
            </Button>
          ) : null}
          {actions.deletion === "authorized_view" && canEdit && affordances.canDelete ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void deleteAuthorizedView()}
            >
              Remove from my library…
            </Button>
          ) : null}
          {canEdit && !readOnly ? (
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              Save
            </Button>
          ) : null}
        </div>
      </div>

      {showDelete ? (
        <DeleteConfirmModal
          sharedWarning={deleteShared}
          onCancel={() => setShowDelete(false)}
          onConfirm={(confirmShared) => void attemptDelete(confirmShared)}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

export function MemoryPage() {
  const auth = useAuth();
  const can = useCan();
  const encryptionPolicyMode = useConversationEncryptionPolicyMode();
  const navigate = useNavigate();
  const toast = useToast();
  const params = useParams<{ id?: string }>();
  const memoryId = params.id;

  const canEdit = auth.viewer.isVerified && can("manage_memories");
  const dataOperationOwner = useMemo(() => createWorkbenchDataOperationOwner(), []);
  const protectedComposition = useMemo(() => {
    let controller: WorkbenchProtectedHumanMemoryController | undefined;
    const get = () => {
      if (controller !== undefined) return controller;
      if (
      typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.staleWhoami
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null
      ) return undefined;
    if (isDesktop) {
      const memory = desktopAPI?.foregroundShadow?.memory;
      if (memory !== undefined) {
        const admitted = withCryptoAdmissionForProtectedMemoryController(memory as ProtectedHumanMemoryOperations);
        controller = Object.freeze({
          ...admitted,
          brief: () => Promise.reject(
            new ClassifiedDataOperationError(
              "key_waiting",
              "Protected Memory brief is unavailable in this Desktop build",
            ),
          ),
          dispose: async () => {},
        }) as WorkbenchProtectedHumanMemoryController;
      }
      return controller;
    }
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    controller = createWorkbenchProtectedHumanMemoryController(
      createBrowserHumanMemoryClient({
        dataOperationOwner,
        api: apiClient,
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
        installationId,
        resolveDeviceAdmissionStatus: () => apiClient.deviceAdmission.status(),
      }),
    );
    return controller;
    };
    return Object.freeze({
      get,
      async dispose() { await controller?.dispose(); },
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    auth.viewer.staleWhoami,
    dataOperationOwner,
  ]);

  const memoryReads = useMemo(() => createWorkbenchMemoryReadOperations({
    owner: dataOperationOwner,
    ordinary: {
      list: fetchMemories,
      detail: fetchMemory,
      search: searchMemories,
      brief: fetchPromptBriefReadOnly,
      archive: archiveMemory,
      revokeUser: revokeMemory,
      update: updateMemory,
      delete: hardDeleteMemory,
      grantUser: (memoryId, userHandle) => grantMemory(memoryId, { userHandle }),
      makePrivate: makeMemoryPrivate,
    },
    protected: protectedComposition.get,
    disposeProtected: protectedComposition.dispose,
    resolveEmbedding: async () => {
      const recipient = await apiClient.getMemoryProcessorRecipient();
      if (recipient.embedding === undefined) {
        throw new Error("Memory embedding is unavailable");
      }
      return recipient.embedding;
    },
  }), [dataOperationOwner, protectedComposition]);

  useEffect(() => () => {
    void memoryReads.dispose();
  }, [memoryReads]);

  const [showArchived, setShowArchived] = useState(false);
  const [items, setItems] = useState<MemoryListItem[]>([]);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("namespace");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailMode, setDetailMode] = useState<MemoryMode>("namespace");
  const [detailActions, setDetailActions] = useState<MemoryActionPresentation | null>(null);
  const [detailAccessContext, setDetailAccessContext] = useState<{
    admissionKey: string; memoryId: string; context: MemoryDetailResponse["accessContext"];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [directoryHumans, setDirectoryHumans] = useState<DirectoryHuman[]>([]);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [privateFilter, setPrivateFilter] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const accountKey = `${auth.viewer.sessionUserId ?? ""}:${auth.viewer.sessionActorId ?? ""}`;
  const contextAdmissionKey = `${accountKey}:${auth.viewerGeneration}:${memoryId ?? ""}`;
  const contextAdmissionKeyRef = useRef(contextAdmissionKey);
  contextAdmissionKeyRef.current = contextAdmissionKey;
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;

  useEffect(() => {
    setItems([]);
    setDetail(null);
    setDetailActions(null);
    setDetailAccessContext(null);
    setNextCursor(null);
    setTotal(null);
    setError(null);
  }, [accountKey]);

  const showArchivedRef = useRef(showArchived);
  const personFilterRef = useRef(personFilter);
  const privateFilterRef = useRef(privateFilter);
  const refreshList = useCallback(async (cursor?: string) => {
    const requestedAccount = accountKeyRef.current;
    const options = {
      ...(cursor ? { cursor } : {}),
      ...(showArchivedRef.current ? { includeArchive: true } : {}),
      // private + person are mutually exclusive (single audience picker).
      ...(privateFilterRef.current
        ? { audience: "private" as const }
        : personFilterRef.current
          ? { person: personFilterRef.current }
          : {}),
    };
    const data = await memoryReads.list(options);
    const nextItems = [...data.items];
    if (accountKeyRef.current !== requestedAccount) return;
    if (cursor) {
      setItems((prev) => [...prev, ...nextItems]);
    } else {
      setItems(nextItems);
    }
    setMemoryMode(data.memoryMode);
    setNextCursor(data.nextCursor);
    setTotal(data.total ?? null);
  }, [memoryReads]);

  const refreshDetail = useCallback(async () => {
    if (!memoryId) return;
    const requestedAccount = accountKeyRef.current;
    const requestedContextAdmission = contextAdmissionKeyRef.current;
    const data = await memoryReads.detail(memoryId);
    if (accountKeyRef.current !== requestedAccount) return;
    if (contextAdmissionKeyRef.current !== requestedContextAdmission) return;
    setDetail(data.memory);
    setDetailMode(data.memoryMode);
    setDetailActions(data.actions);
    setDetailAccessContext({ admissionKey: requestedContextAdmission, memoryId: data.memory.id,
      context: data.accessContext });
  }, [memoryId, memoryReads]);

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await memoryReads.retryPendingMutations();
        await refreshList();
        if (memoryId) {
          await refreshDetail();
        } else {
          setDetail(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [auth.viewer.isVerified, memoryId, memoryReads, refreshList, refreshDetail, contextAdmissionKey]);

  // Quiet in-place refetch when the archived filter flips — keeps the current
  // rows visible until the new data swaps in, instead of a full-page loader.
  const archiveMountRef = useRef(false);
  useEffect(() => {
    showArchivedRef.current = showArchived;
    if (!archiveMountRef.current) {
      archiveMountRef.current = true;
      return;
    }
    if (auth.viewer.isVerified) void refreshList();
  }, [showArchived, auth.viewer.isVerified, refreshList]);

  // People directory for the "Who can see" reverse-lens + grant pickers.
  // Best-effort: failure just leaves the free-text @handle fallback.
  useEffect(() => {
    if (!auth.viewer.isVerified) return;
    void (async () => {
      try {
        const humans = await apiClient.listDirectoryHumans();
        setDirectoryHumans(humans);
      } catch {
        setDirectoryHumans([]);
      }
    })();
  }, [auth.viewer.isVerified]);

  // Reverse lens: re-query the list ("what this person can see") when the
  // person filter changes. Quiet in-place refetch, mirrors the archived flip.
  const personMountRef = useRef(false);
  useEffect(() => {
    personFilterRef.current = personFilter;
    privateFilterRef.current = privateFilter;
    if (!personMountRef.current) {
      personMountRef.current = true;
      return;
    }
    // Drop the previous filter's total immediately so the banner can't flash a
    // stale count (e.g. the "Anyone" total) before the new fetch resolves.
    setTotal(null);
    if (auth.viewer.isVerified) void refreshList();
  }, [personFilter, privateFilter, auth.viewer.isVerified, refreshList]);

  if (!auth.viewer.isVerified) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <GuestPlaceholder what="Memory" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-6 py-10 text-sm text-foreground-muted">Loading memories…</div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-10 text-sm text-[var(--error)]" role="alert">
        {error}
      </div>
    );
  }

  if (memoryId && detail && detailActions) {
    return (
      <MemoryEditorView
        initial={detail}
        memoryMode={detailMode}
        canEdit={canEdit}
        directoryHumans={directoryHumans}
        onSaved={() => void refreshDetail()}
        onArchived={() => void refreshList()}
        onDeleted={() => void refreshList()}
        operations={memoryReads}
        actions={detailActions}
        {...(encryptionPolicyMode === "plaintext_only"
          ? { ordinaryAccess: { context: detailAccessContext?.admissionKey === contextAdmissionKey
              && detailAccessContext.memoryId === detail.id ? detailAccessContext.context : null, onChanged: () => {
              void (async () => {
                try {
                  await Promise.all([refreshDetail(), refreshList()]);
                } catch { /* The dialog distinguishes lost authority from a transient refresh failure. */ }
              })();
            }, onAccessLost: (message: string) => {
              setDetail(null);
              toast.show({ variant: "info", title: "Access updated", message });
              void navigate("/memory");
              void refreshList();
            } } }
          : {})}
      />
    );
  }

  return (
    <MemoryListView
      items={items}
      memoryMode={memoryMode}
      nextCursor={nextCursor}
      canEdit={canEdit}
      showArchived={showArchived}
      userId={auth.viewer.sessionUserId ?? "anonymous"}
      directoryHumans={directoryHumans}
      personFilter={personFilter}
      privateFilter={privateFilter}
      total={total}
      onPersonFilterChange={setPersonFilter}
      onPrivateFilterChange={setPrivateFilter}
      onShowArchivedChange={setShowArchived}
      onRefresh={() => void refreshList()}
      onLoadMore={() => void refreshList(nextCursor ?? undefined)}
      memoryReads={memoryReads}
    />
  );
}
