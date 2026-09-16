/**
 * D187 — search-first member picker shared by two sites.
 *
 * ONE unified list that mixes humans and agents in a single `role="listbox"`,
 * with a shared search box on top. Keyboard model + row visuals follow
 * AskUserPicker / the D210 @-mention popover.
 *
 * The candidate source is INJECTED via the `search` prop — the picker owns the
 * query input, a ~300ms debounce (seeded so the empty-query fetch fires on
 * mount), keepPreviousData (no flicker while a new query is in flight), and a
 * monotonic `seqRef` "latest query wins" guard. It does NOT know where the
 * candidates come from. The create dialog injects `apiClient.searchDirectory`;
 * the manage sheet injects a local filter over a pre-loaded addable list.
 *
 * Two selection modes, discriminated by which callback the caller supplies:
 *
 * - Multi-select mode (`onToggle`): selected members render as removable chips
 *   inside the search box; rows show a checkmark; Backspace removes the last
 *   chip. Selection ids are owned by the caller, which also caches each
 *   member's display metadata so chips persist after the result set moves on
 *   (see `buildChips`). Used by the New Conversation dialog.
 *
 * - Action mode (`onPick`): no chip row; clicking a row (or Enter on the
 *   highlighted row) calls `onPick(candidate)` to act immediately. `busyKey`
 *   marks one in-flight row. Used by immediate-action pickers.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { UserAvatar } from "../../../components/avatar/UserAvatar";
import { MentionAgentAvatar } from "../../../components/composer/MentionAdapter";

export type SelectableCandidate = {
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle: string | undefined;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
  actionable?: boolean;
  actionReason?: "available" | "invoke_agents_required";
};

/**
 * Display metadata cached by the dialog when a member is toggled on, so a
 * chip can still render (and the room can still be named) once the member
 * scrolls out of the current search results.
 */
export type SelectedMeta = SelectableCandidate;

type Candidate = SelectableCandidate;

/** Stable cache/selection key for a member. */
export function memberKey(kind: "user" | "agent", id: string): string {
  return `${kind}:${id}`;
}

/** Map a server directory-search row to a picker candidate. */
export function toSelectableCandidate(row: {
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle: string;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
  actionable: boolean;
  actionReason: "available" | "invoke_agents_required";
}): SelectableCandidate {
  return {
    kind: row.kind,
    id: row.id,
    displayName: row.displayName,
    handle: row.handle,
    agentOwnerUserId: row.agentOwnerUserId,
    agentOwnerHandle: row.agentOwnerHandle,
    agentOwnerDisplayName: row.agentOwnerDisplayName,
    actionable: row.actionable,
    actionReason: row.actionReason,
  };
}

/**
 * Build the selected chips purely from the selection sets + the cached
 * metadata — never from the current search results. This is why a chip
 * persists after a later query returns a different result set. Falls back to
 * the raw id so a selection never silently disappears if its metadata is
 * somehow missing. Pure + exported for unit testing.
 */
export function buildChips(
  selectedUserIds: ReadonlySet<string>,
  selectedAgentIds: ReadonlySet<string>,
  selectedMeta: ReadonlyMap<string, SelectedMeta>,
): SelectableCandidate[] {
  const out: SelectableCandidate[] = [];
  for (const id of selectedUserIds) {
    const m = selectedMeta.get(memberKey("user", id));
    out.push({ kind: "user", id, displayName: m?.displayName ?? id, handle: m?.handle });
  }
  for (const id of selectedAgentIds) {
    const m = selectedMeta.get(memberKey("agent", id));
    out.push({ kind: "agent", id, displayName: m?.displayName ?? id, handle: m?.handle });
  }
  return out;
}

/** Props common to both selection modes. */
interface SelectablePickerBaseProps {
  /**
   * Candidate source. The picker owns the query/debounce/ordering and just
   * calls this with the trimmed query. An empty query should return the
   * "seed" set (recent contacts / the full addable list).
   */
  readonly searchLabel?: string;
  readonly search: (q: string) => Promise<SelectableCandidate[]>;
  /**
   * Optional viewer id. When set, a `user` candidate with this id is dropped
   * defensively (the create dialog passes it; the manage sheet does not).
   */
  readonly viewerUserId?: string;
  /** Message for the empty (no-query) result state. Defaults to "No recent contacts." */
  readonly emptyLabel?: string;
  /** Let the result list consume its container instead of using the popover-height cap. */
  readonly fillAvailableHeight?: boolean;
  /** `memberKey`s to hide from the list (for example, existing room members). */
  readonly disabledKeys?: ReadonlySet<string>;
}

/**
 * Multi-select mode (New Conversation dialog): controlled selection sets +
 * chips. Exactly one of `onToggle` / `onPick` is supplied.
 */
export interface SelectablePickerMultiSelectProps extends SelectablePickerBaseProps {
  readonly selectedUserIds: ReadonlySet<string>;
  readonly selectedAgentIds: ReadonlySet<string>;
  /** Cached display metadata for selected members, keyed by `memberKey`. */
  readonly selectedMeta: ReadonlyMap<string, SelectedMeta>;
  /** Toggle a candidate on/off. Called with full metadata so the caller can cache it. */
  readonly onToggle: (candidate: SelectableCandidate) => void;
  /** Optional guidance displayed between the search field and result list. */
  readonly selectionHint?: string;
  /** Clear every selected candidate. Only shown while the selection is non-empty. */
  readonly onClearSelection?: () => void;
  /** Select or clear the actionable candidates in the current result set. */
  readonly onSetVisibleSelection?: (
    candidates: readonly SelectableCandidate[],
    selected: boolean,
  ) => void;
  readonly onPick?: never;
}

/**
 * Action mode (manage sheet Add-member): clicking a row acts on it immediately.
 * No chip row, no selection sets.
 */
export interface SelectablePickerActionProps extends SelectablePickerBaseProps {
  /** Act on the clicked / Enter-highlighted candidate. */
  readonly onPick: (candidate: SelectableCandidate) => void;
  /** `memberKey` of the row currently being acted on → busy/disabled state. */
  readonly busyKey?: string | null;
  readonly onToggle?: never;
}

export type SelectablePickerProps =
  | SelectablePickerMultiSelectProps
  | SelectablePickerActionProps;

const AGENT_GLYPH = "\u2726"; // ✦
const DEBOUNCE_MS = 300;

// Shared empties for action mode, which has no selection sets/metadata.
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_META: ReadonlyMap<string, SelectedMeta> = new Map();

/**
 * Debounce a value. The debounced value is seeded with the initial value, so
 * the very first (empty-query) fetch fires immediately on mount rather than
 * after the debounce window.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function SelectablePicker(props: SelectablePickerProps): ReactElement {
  const { search, viewerUserId, emptyLabel, fillAvailableHeight = false } = props;
  // Discriminate the two modes by which callback the caller supplied.
  const actionMode = props.onPick != null;
  const selectedUserIds = actionMode ? EMPTY_SET : props.selectedUserIds;
  const selectedAgentIds = actionMode ? EMPTY_SET : props.selectedAgentIds;
  const selectedMeta = actionMode ? EMPTY_META : props.selectedMeta;
  const disabledKeys = props.disabledKeys;
  const busyKey = actionMode ? (props.busyKey ?? null) : null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);

  // The `search` prop is often a fresh closure each render; hold it in a ref so
  // the fetch effect can depend only on the debounced query (not re-run every
  // render) while still calling the latest implementation.
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  // `keepPreviousData`: results are only replaced on a successful, still-current
  // response, so the previous list stays visible while the next query is in
  // flight. `seqRef` gives "latest query wins" — a slow earlier response can't
  // clobber a newer one.
  const seqRef = useRef(0);
  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void searchRef
      .current(debouncedQuery.trim())
      .then((rows) => {
        if (cancelled || seq !== seqRef.current) return;
        setResults(rows);
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : "Could not search.");
      })
      .finally(() => {
        if (cancelled || seq !== seqRef.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // Drop the viewer (create dialog) and any hidden keys (manage sheet: members
  // already in the room). The create-dialog server search already excludes the
  // caller; the viewer filter is a defensive backstop.
  const options = useMemo<Candidate[]>(
    () =>
      results.filter((c) => {
        if (viewerUserId != null && c.kind === "user" && c.id === viewerUserId) return false;
        if (disabledKeys?.has(memberKey(c.kind, c.id))) return false;
        return true;
      }),
    [results, viewerUserId, disabledKeys],
  );

  const chips = useMemo<Candidate[]>(
    () => (actionMode ? [] : buildChips(selectedUserIds, selectedAgentIds, selectedMeta)),
    [actionMode, selectedUserIds, selectedAgentIds, selectedMeta],
  );
  const isSelected = (candidate: Candidate): boolean =>
    candidate.kind === "user"
      ? selectedUserIds.has(candidate.id)
      : selectedAgentIds.has(candidate.id);
  const actionableOptions = useMemo(
    () => options.filter((candidate) => candidate.actionable !== false),
    [options],
  );
  const allActionableSelected =
    actionableOptions.length > 0 && actionableOptions.every(isSelected);

  // Keep the highlight in range as the option list changes.
  useEffect(() => {
    setHighlightedIndex((i) => (options.length === 0 ? 0 : Math.min(i, options.length - 1)));
  }, [options.length]);

  // Route a chosen candidate to the active mode's callback.
  const choose = (candidate: Candidate): void => {
    if (candidate.actionable === false) return;
    if (props.onPick) props.onPick(candidate);
    else props.onToggle(candidate);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      inputRef.current?.blur();
      return;
    }
    if (!actionMode && event.key === "Backspace" && query.length === 0 && chips.length > 0) {
      event.preventDefault();
      const last = chips[chips.length - 1];
      if (last) choose(last);
      return;
    }
    if (options.length === 0) return;
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      setHighlightedIndex((i) => (i + 1) % options.length);
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      setHighlightedIndex((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = options[highlightedIndex];
      if (candidate?.actionable !== false) choose(candidate);
    }
  };

  const hasQuery = query.trim().length > 0;
  const emptyMessage = emptyLabel ?? "No recent contacts.";

  return (
    <div className={`flex min-h-0 flex-col gap-2${fillAvailableHeight ? " flex-1" : ""}`}>
      {!actionMode && props.onSetVisibleSelection ? (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-[11px] font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            disabled={actionableOptions.length === 0}
            onClick={() => props.onSetVisibleSelection?.(actionableOptions, !allActionableSelected)}
          >
            {allActionableSelected
              ? "Clear everyone"
              : `Select everyone (${actionableOptions.length})`}
          </button>
        </div>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-1 rounded border border-border bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-primary"
        onMouseDown={(e) => {
          // Clicking anywhere in the box (not on a chip button) focuses the input.
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {chips.map((chip) => (
          <span
            key={`${chip.kind}:${chip.id}`}
            data-testid="member-chip"
            className="inline-flex items-center gap-1 rounded bg-background-element px-1.5 py-0.5 text-xs text-foreground"
          >
            <span aria-hidden className="shrink-0">
              {chip.kind === "agent" ? AGENT_GLYPH : chip.displayName.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="max-w-[10rem] truncate">{chip.displayName}</span>
            <button
              type="button"
              aria-label={`Remove ${chip.displayName}`}
              className="shrink-0 rounded px-0.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
              onClick={() => choose(chip)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={chips.length === 0 ? (props.searchLabel ?? "Search people and agents…") : "Add more…"}
          aria-label={props.searchLabel ?? "Search people and agents"}
          className="min-w-[6rem] flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-muted"
        />
      </div>
      {!actionMode && (props.selectionHint || (props.onClearSelection && chips.length > 0)) ? (
        <div className="flex min-h-4 items-center justify-between gap-2 text-[11px] text-foreground-muted">
          <span>{props.selectionHint}</span>
          {props.onClearSelection && chips.length > 0 ? (
            <button
              type="button"
              className="shrink-0 font-medium text-primary hover:underline"
              onClick={props.onClearSelection}
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
      <ul
        role="listbox"
        aria-label="People and agents"
        aria-multiselectable={actionMode ? undefined : "true"}
        aria-busy={loading ? "true" : undefined}
        className={`${fillAvailableHeight ? "flex-1" : "max-h-48"} min-h-0 overflow-y-auto rounded border border-border bg-background-panel text-xs`}
      >
        {error ? (
          <li role="alert" className="px-3 py-2 text-amber-700 dark:text-amber-400">
            {error}
          </li>
        ) : null}
        {options.length === 0 && !error ? (
          <li className="px-3 py-2 text-foreground-muted">
            {loading ? "Searching…" : hasQuery ? "No matches." : emptyMessage}
          </li>
        ) : (
          options.map((candidate, index) => {
            const selected = isSelected(candidate);
            const highlighted = index === highlightedIndex;
            const busy = busyKey != null && busyKey === memberKey(candidate.kind, candidate.id);
            const unavailable = candidate.actionable === false;
            return (
              <li key={`${candidate.kind}:${candidate.id}`} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={busy || unavailable}
                  data-testid="picker-option"
                  data-kind={candidate.kind}
                  data-selected={selected ? "true" : "false"}
                  data-highlighted={highlighted ? "true" : "false"}
                  data-busy={busy ? "true" : "false"}
                  title={unavailable ? "Your Server role cannot invoke Genies" : undefined}
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50${
                    highlighted ? " bg-[var(--primary-muted)]" : ""
                  }`}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => choose(candidate)}
                >
                  {candidate.kind === "user" ? (
                    <UserAvatar userId={candidate.id} size={24} displayName={candidate.displayName} />
                  ) : (
                    <MentionAgentAvatar displayName={candidate.displayName} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">
                      {candidate.displayName}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-foreground-muted">
                      {candidate.kind === "agent"
                        ? `${candidate.agentOwnerDisplayName?.trim() || (candidate.agentOwnerHandle ? `@${candidate.agentOwnerHandle}` : "Unknown owner")}’s Genie`
                        : "Human"}
                      {candidate.handle ? ` · @${candidate.handle}` : ""}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="w-4 shrink-0 text-center text-foreground-muted"
                    data-testid="kind-marker"
                  >
                    {candidate.kind === "agent" ? AGENT_GLYPH : ""}
                  </span>
                  {actionMode ? (
                    <span
                      aria-hidden
                      className="shrink-0 text-center text-foreground-muted"
                      data-testid="row-busy"
                    >
                      {busy ? "Adding…" : ""}
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="w-3 shrink-0 text-center text-primary"
                      data-testid="selected-check"
                    >
                      {selected ? "\u2713" : ""}
                    </span>
                  )}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
