import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RoomMessageSearchControls } from "../../adapters/runtime-contexts";
import { roomFindEscapeIntent, roomFindKeyDirection, type FindDirection } from "./room-transcript-find-navigation";
import type { RoomFindActivationState } from "./room-transcript-find-activation";

export interface RoomTranscriptFindBarProps {
  search: RoomMessageSearchControls;
  open: boolean;
  /** Use the drawer-safe two-row control layout on narrow transcript surfaces. */
  compact?: boolean;
  onClose: () => void;
  /** Phase 3.2 owns page-boundary selection; this lane only renders its hooks. */
  selectedHitIndex?: number;
  ordinal?: number | null;
  totalLabel?: string | null;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  /** A non-wrap boundary response from the navigation owner. */
  boundaryMessage?: string | null;
  activationState?: RoomFindActivationState;
  onRetryActivation?: () => void;
  showReturnToLatest?: boolean;
  onReturnToLatest?: () => void;
  highlightedMessageId?: number | null;
}

function statusCopy(args: {
  query: string;
  status: RoomMessageSearchControls["status"];
  error: string | null;
}): { text: string; alert: boolean } {
  if (args.status === "invalid" || args.status === "error") {
    return { text: args.error || "Search could not be completed.", alert: true };
  }
  if (args.status === "debouncing" || args.status === "loading") {
    return { text: "Searching in this chat…", alert: false };
  }
  if (args.status === "empty") return { text: "No matching messages.", alert: false };
  if (!args.query.trim()) return { text: "Enter a term to search in this chat.", alert: false };
  return { text: "", alert: false };
}

/**
 * D430 Phase 3.1 — normal-flow Room transcript-find UI. Search paging and
 * keyboard direction are deliberately supplied by the following UI lane.
 */
export function RoomTranscriptFindBar({
  search,
  open,
  compact = false,
  onClose,
  selectedHitIndex = 0,
  ordinal,
  totalLabel,
  onPrevious,
  onNext,
  previousDisabled = true,
  nextDisabled = true,
  boundaryMessage = null,
  activationState = { state: "idle" },
  onRetryActivation,
  showReturnToLatest = false,
  onReturnToLatest,
  highlightedMessageId = null,
}: RoomTranscriptFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [narrowCompact, setNarrowCompact] = useState(false);
  const inputId = useId();
  const statusId = useId();
  const safeIndex = Math.min(Math.max(selectedHitIndex, 0), Math.max(search.hits.length - 1, 0));
  const selectedHit = search.hits[safeIndex];
  const displayedOrdinal = ordinal ?? safeIndex + 1;
  const displayedTotal = totalLabel ?? String(search.hits.length);
  const status = statusCopy(search);
  const activationCopy = activationState.state === "hydrating"
    ? "Opening selected message…"
    : activationState.state === "not-found"
      ? "Selected message is no longer available."
      : activationState.state === "failed"
        ? "Could not open the selected message."
        : null;
  const activationPending = activationState.state === "hydrating";
  const selectedIsHighlighted = selectedHit != null && String(highlightedMessageId) === selectedHit.messageId;
  const resultCopy = selectedHit
    ? `Result ${displayedOrdinal} of ${displayedTotal}${totalLabel ? "" : " on this page"}`
    : "";

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (roomFindEscapeIntent(event.defaultPrevented)) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    const direction = roomFindKeyDirection({
      key: event.key,
      shiftKey: event.shiftKey,
      snippetListOwnsFocus: event.target instanceof Element &&
        event.target.closest('[data-find-snippet-list="true"]') !== null,
    });
    if (!direction) return;
    event.preventDefault();
    const action: Record<FindDirection, (() => void) | undefined> = {
      older: onNext,
      newer: onPrevious,
    };
    action[direction]?.();
  };

  useEffect(() => {
    if (!open) return;
    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    const bar = barRef.current;
    if (!open || !compact || !bar || typeof ResizeObserver === "undefined") {
      setNarrowCompact(false);
      return;
    }
    const update = () => setNarrowCompact(bar.getBoundingClientRect().width < 340);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [compact, open]);

  if (!open) return null;

  return (
    <section
      ref={barRef}
      className="shrink-0 border-b border-border bg-background-panel px-3 py-2"
      data-testid="room-transcript-find-bar"
      data-layout={compact ? "compact" : "default"}
      aria-label="Search in this chat"
      onKeyDown={handleKeyDown}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
        Search in this chat
      </div>
      <div className={`flex min-w-0 items-center ${compact ? "flex-wrap gap-1" : "flex-wrap gap-2"}`}>
        <Search aria-hidden className={`h-3.5 w-3.5 shrink-0 text-foreground-muted${compact ? " order-1" : ""}`} />
        <label className="sr-only" htmlFor={inputId}>Search in this chat</label>
        <input
          ref={inputRef}
          id={inputId}
          aria-describedby={statusId}
          placeholder="Find message text…"
          className={`min-w-0 flex-1 rounded bg-background px-2 py-1 text-xs text-foreground outline-none ring-1 ring-border focus:ring-accent${compact ? " order-1 basis-36" : ""}`}
          value={search.query}
          onInput={(event) => search.setQuery(event.currentTarget.value)}
        />
        {narrowCompact ? <span aria-hidden className="order-2 h-0 basis-full" /> : null}
        {!compact ? (
          <span className="shrink-0 text-[11px] tabular-nums text-foreground-muted">
            {resultCopy}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Older search result"
          title="Older search result (Next)"
          disabled={!onNext || nextDisabled || activationPending}
          className={`rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40${compact ? " order-3" : ""}`}
          onClick={onNext}
        >
          <ChevronUp aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Newer search result"
          title="Newer search result (Previous)"
          disabled={!onPrevious || previousDisabled || activationPending}
          className={`rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40${compact ? " order-3" : ""}`}
          onClick={onPrevious}
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close search in this chat"
          title="Close search in this chat"
          className={`rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground${compact ? narrowCompact ? " order-3" : " order-1" : ""}`}
          onClick={onClose}
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
        {showReturnToLatest ? (
          <button
            type="button"
            className={`rounded px-1.5 py-1 text-[11px] text-foreground-muted hover:bg-muted hover:text-foreground${compact ? " order-3" : ""}`}
            onClick={onReturnToLatest}
          >
            Return to latest
          </button>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground-muted">
        <label className="inline-flex items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            checked={search.mode === "prefix"}
            onChange={(event) => search.setMode(event.currentTarget.checked ? "prefix" : "whole")}
          />
          Partial words
        </label>
        <label className="inline-flex items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            checked={search.ignoreCase}
            onChange={(event) => search.setIgnoreCase(event.currentTarget.checked)}
          />
          Ignore case
        </label>
        {search.currentPageIndex > 0 ? <span>Page {search.currentPageIndex + 1}</span> : null}
        {search.hasMoreOlder ? <span>More older results available</span> : null}
      </div>

      <div
        id={statusId}
        className="mt-1 min-h-4 text-[11px] text-foreground-muted"
        {...(status.alert ? { role: "alert" } : { role: "status", "aria-live": "polite" })}
      >
        {activationCopy ?? boundaryMessage ?? (selectedIsHighlighted
          ? `${compact && resultCopy ? `${resultCopy}. ` : ""}Opened selected message in transcript.`
          : (compact && resultCopy ? resultCopy : status.text))}
      </div>

      {activationState.state === "not-found" || activationState.state === "failed" ? (
        <button
          type="button"
          className="mt-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted"
          onClick={onRetryActivation}
        >
          Retry opening message
        </button>
      ) : null}

    </section>
  );
}
