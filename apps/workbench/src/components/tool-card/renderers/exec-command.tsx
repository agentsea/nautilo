import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLocalExecutionAPI, type LocalExecutionSnapshot, type LocalExecutionUncertainty } from "../../../lib/desktop";
import { redactCredentialMaterialForDisplay } from "../../tool-argument-preview";
import { stripAnsiSgr } from "../../../lib/terminal-output-presentation";
import { observeLocalExecution, parseLocalExecutionSnapshot as snapshotFromResult, isSettledLocalExecution } from "../../../lib/local-execution-observation";
import type { ToolRenderer, ToolRendererProps } from "./types";

type ExecutionState = LocalExecutionSnapshot["state"];

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSnapshot(resultText: string | undefined): Record<string, unknown> | null {
  if (!resultText) return null;
  try {
    return objectValue(JSON.parse(resultText));
  } catch {
    return null;
  }
}

function liveSnapshotFromResult(resultText: string | undefined): LocalExecutionSnapshot | null {
  const snapshot = snapshotFromResult(resultText);
  return snapshot?.archived === true || snapshot?.historical === true ? null : snapshot;
}

function historicalSnapshotFromResult(resultText: string | undefined): LocalExecutionSnapshot | null {
  const snapshot = snapshotFromResult(resultText);
  return snapshot?.historical === true && snapshot.archived !== true ? snapshot : null;
}

function uncertaintyFromResult(resultText: string | undefined): LocalExecutionUncertainty | null {
  const value = parseSnapshot(resultText);
  const keys = ["version", "kind", "generation", "executionId", "session_id", "operation", "outcome", "recovery", "message"];
  if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      value.version !== 1 || value.kind !== "local_execution_outcome_unknown" ||
      typeof value.generation !== "string" || !value.generation ||
      typeof value.executionId !== "string" || !value.executionId ||
      value.session_id !== value.executionId ||
      typeof value.operation !== "string" || !["start", "read", "input", "cancel"].includes(value.operation) ||
      value.outcome !== "unknown" || value.recovery !== "read_or_cancel_same_execution" ||
      typeof value.message !== "string" || !value.message) return null;
  return value as unknown as LocalExecutionUncertainty;
}

/** Only the two managed tools may retain complete, validated routing receipts. */
export function preserveLocalExecutionResultForCard(toolName: string, resultText: string | undefined): string | undefined {
  if (toolName !== "exec_command" && toolName !== "write_stdin") return undefined;
  const parsed = snapshotFromResult(resultText);
  const snapshot = parsed?.archived === true ? null : parsed;
  if (snapshot) {
    // Rebuild the closed presentation receipt rather than copying unrelated
    // provider fields that happen to accompany an otherwise valid snapshot.
    const { executionId, session_id, generation, state, tty, pid, exitCode, signal,
      terminationScope, failureCode, expiresAt, resources, historical } = snapshot;
    const { data, cursor, nextCursor, availableFrom, produced, gap, hasMore } = snapshot.output;
    return JSON.stringify({ executionId, session_id, generation, state, tty, pid, exitCode, signal,
      terminationScope, failureCode, expiresAt, resources,
      ...(historical === true ? { historical: true } : {}),
      ...(snapshot.search ? { search: { matchedAt: snapshot.search.matchedAt,
        nextSearchCursor: snapshot.search.nextSearchCursor, complete: snapshot.search.complete,
        gap: snapshot.search.gap, availableFrom: snapshot.search.availableFrom, produced: snapshot.search.produced } } : {}),
      output: { data, cursor, nextCursor, availableFrom, produced, gap, hasMore } });
  }
  const uncertainty = uncertaintyFromResult(resultText);
  return uncertainty ? JSON.stringify(uncertainty) : undefined;
}

interface ExecutionView {
  readonly key: string;
  readonly snapshot: LocalExecutionSnapshot;
  readonly output: string;
  readonly outputStart: number;
  readonly outputEnd: number;
  readonly gapObserved: boolean;
}

function keyFor(snapshot: LocalExecutionSnapshot): string {
  return `${snapshot.generation}\u0000${snapshot.executionId}`;
}

function keyForUncertainty(value: LocalExecutionUncertainty): string {
  return `${value.generation}\u0000${value.executionId}`;
}

function initialView(snapshot: LocalExecutionSnapshot): ExecutionView {
  return {
    key: keyFor(snapshot),
    snapshot,
    output: snapshot.output.data,
    outputStart: snapshot.output.cursor,
    outputEnd: snapshot.output.nextCursor,
    gapObserved: snapshot.output.gap,
  };
}

function lifecycleRank(state: ExecutionState): number {
  switch (state) {
    case "starting": return 0;
    case "running": return 1;
    case "cancelling": return 2;
    case "completed":
    case "cancelled":
    case "failed":
    case "unknown": return 3;
  }
}

function mergeView(current: ExecutionView | null, incoming: LocalExecutionSnapshot): ExecutionView {
  const key = keyFor(incoming);
  if (!current || current.key !== key) return initialView(incoming);

  const chunk = incoming.output;
  const availableFrom = Math.max(current.snapshot.output.availableFrom, chunk.availableFrom);
  const retained = new TextEncoder().encode(current.output);
  const evicted = Math.min(retained.length, Math.max(0, availableFrom - current.outputStart));
  let output = new TextDecoder("utf-8", { ignoreBOM: true }).decode(retained.subarray(evicted));
  let outputStart = current.outputStart + evicted;
  let outputEnd = current.outputEnd;
  const contiguous = chunk.cursor <= outputEnd;
  if (!contiguous) {
    // A gap is a new retained page, not text adjacent to the previous bytes.
    output = chunk.data;
    outputStart = chunk.cursor;
    outputEnd = chunk.nextCursor;
  } else if (chunk.nextCursor > outputEnd) {
    const encoded = new TextEncoder().encode(chunk.data);
    output += new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded.subarray(Math.max(0, outputEnd - chunk.cursor)));
    outputEnd = chunk.nextCursor;
  }
  const produced = Math.max(current.snapshot.output.produced, chunk.produced);
  const gapObserved = current.gapObserved || chunk.gap || evicted > 0 || !contiguous;
  const snapshot: LocalExecutionSnapshot = {
    ...(!isSettledLocalExecution(current.snapshot) && lifecycleRank(incoming.state) >= lifecycleRank(current.snapshot.state) ? incoming : current.snapshot),
    output: { data: output, cursor: outputStart, nextCursor: outputEnd, availableFrom, produced,
      gap: gapObserved, hasMore: produced > outputEnd },
  };
  return { key, snapshot, output, outputStart, outputEnd, gapObserved };
}

/** Automatic status reads update lifecycle and evictions without turning a
 * literal match page into the shared full output window. Manual paging still
 * uses mergeView to read context after the displayed match. */
function updateSearchView(current: ExecutionView, incoming: LocalExecutionSnapshot): ExecutionView {
  const availableFrom = Math.max(current.snapshot.output.availableFrom, incoming.output.availableFrom);
  const bytes = new TextEncoder().encode(current.output);
  const evicted = Math.min(bytes.length, Math.max(0, availableFrom - current.outputStart));
  const output = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(evicted));
  const outputStart = Math.max(availableFrom, current.outputStart + evicted);
  const outputEnd = Math.max(outputStart, current.outputEnd);
  const produced = Math.max(current.snapshot.output.produced, incoming.output.produced);
  const gapObserved = current.gapObserved || evicted > 0;
  const lifecycle = !isSettledLocalExecution(current.snapshot) && lifecycleRank(incoming.state) >= lifecycleRank(current.snapshot.state)
    ? incoming : current.snapshot;
  return { ...current, output, outputStart, outputEnd, gapObserved,
    snapshot: { ...lifecycle, output: { data: output, cursor: outputStart, nextCursor: outputEnd,
      availableFrom, produced, gap: gapObserved, hasMore: outputEnd < produced } } };
}

function commandLabel(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.cmd === "string") return args.cmd;
  return "Local execution";
}

type ContinuationOperation = "read" | "input" | "cancel" | "search";
function continuationOperation(args: Record<string, unknown>): ContinuationOperation {
  if (args.cancel === true) return "cancel";
  if (typeof args.chars === "string" && args.chars.length > 0) return "input";
  if (typeof args.search === "string" && args.search.length > 0) return "search";
  return "read";
}
const continuationCopy: Record<ContinuationOperation, { label: string; description: string }> = {
  read: { label: "Command output", description: "Read output from the existing command." },
  input: { label: "Command input", description: "Interactive input for the existing command." },
  cancel: { label: "Stop command", description: "Stop request for the existing command." },
  search: { label: "Search command output", description: "Search retained output from the existing command." },
};

function loopbackUrls(output: string): string[] {
  const urls = new Set<string>();
  for (const match of stripAnsiSgr(output).matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const candidate = match[0].replace(/[),.;!?\]}]+$/u, "");
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" || url.username || url.password) continue;
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1") {
        urls.add(url.toString());
      }
    } catch {
      // Text that only resembles a URL is not an actionable preview.
    }
  }
  return [...urls];
}

function cardState(state: ExecutionState): "running" | "success" | "cancelled" | "error" | "blocked" {
  if (state === "starting" || state === "running" || state === "cancelling") return "running";
  if (state === "completed") return "blocked";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "error";
  return "blocked";
}

function semanticState(snapshot: LocalExecutionSnapshot): "running" | "success" | "cancelled" | "error" | "blocked" {
  if (snapshot.state === "completed") {
    return snapshot.exitCode === null ? "blocked" : snapshot.exitCode === 0 ? "success" : "error";
  }
  if (snapshot.state === "cancelled" && snapshot.resources !== "released") return "blocked";
  return cardState(snapshot.state);
}

function canStopExecution(snapshot: LocalExecutionSnapshot): boolean {
  if (snapshot.state === "starting") return true;
  if (snapshot.state === "running") return snapshot.exitCode === null && snapshot.signal === null;
  return (snapshot.state === "unknown" || snapshot.state === "cancelling") &&
    snapshot.resources === "owned" && snapshot.exitCode === null && snapshot.signal === null;
}


function ExecCommandExpanded({ toolName, args, event, resultText, resultTruncated, state, onSemanticStateChange }: ToolRendererProps): React.ReactElement {
  const initial = useMemo(() => liveSnapshotFromResult(resultText) ?? historicalSnapshotFromResult(resultText), [resultText]);
  const initialUncertainty = useMemo(() => uncertaintyFromResult(resultText), [resultText]);
  const [view, setView] = useState<ExecutionView | null>(() => initial ? initialView(initial) : null);
  const [uncertainty, setUncertainty] = useState<LocalExecutionUncertainty | null>(() => initialUncertainty);
  const [busy, setBusy] = useState<"read" | "cancel" | "preview" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [outcomeUnconfirmed, setOutcomeUnconfirmed] = useState(false);
  const initialKey = initial ? keyFor(initial) : null;
  const candidateUncertainty = initialUncertainty && (!uncertainty || keyForUncertainty(uncertainty) !== keyForUncertainty(initialUncertainty))
    ? initialUncertainty
    : initialUncertainty ? uncertainty : null;
  const uncertaintyKey = candidateUncertainty ? keyForUncertainty(candidateUncertainty) : null;
  const receiptKey = initialKey ?? uncertaintyKey;
  const activeView = receiptKey && view?.key === receiptKey ? view : initial ? initialView(initial) : null;
  const active = activeView?.snapshot ?? null;
  const receiptUncertainty = active ? null : candidateUncertainty;
  const activeKey = activeView?.key ?? uncertaintyKey;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const requestSequenceRef = useRef(0);
  const urls = loopbackUrls(activeView?.output ?? "");
  const api = getLocalExecutionAPI();
  const observationRef = useRef<ReturnType<typeof observeLocalExecution> | null>(null);

  useEffect(() => {
    setView((current) => initial ? initial.search ? initialView(initial) : mergeView(current, initial) : null);
    setUncertainty(initialUncertainty);
    setMessage(null);
    setOutcomeUnconfirmed(false);
    setBusy(null);
  }, [initial, initialUncertainty]);

  const accept = useCallback((next: LocalExecutionSnapshot, key: string, requestedCursor: number, requestSequence: number) => {
    const validated = snapshotFromResult(JSON.stringify(next));
    if (requestSequenceRef.current !== requestSequence || activeKeyRef.current !== key || !validated || validated.archived === true || validated.historical === true || keyFor(validated) !== key) {
      return;
    }
    const overlapsRequestedCursor = validated.output.cursor <= requestedCursor && validated.output.nextCursor >= requestedCursor;
    if (!validated.output.gap && validated.output.cursor !== requestedCursor && !overlapsRequestedCursor) {
      setMessage("The returned output cursor did not match the requested position. Refresh status before continuing.");
      return;
    }
    observationRef.current?.publish(validated, true);
    setView((current) => mergeView(current?.key === key ? current : null, validated));
    setUncertainty(null);
    setOutcomeUnconfirmed(false);
  }, []);

  const reportedSemanticState = outcomeUnconfirmed || (receiptUncertainty && !active)
    ? "blocked"
    : active ? semanticState(active) : null;

  useEffect(() => {
    if (!receiptKey || !onSemanticStateChange || reportedSemanticState === null) return;
    onSemanticStateChange(reportedSemanticState);
  }, [receiptKey, onSemanticStateChange, reportedSemanticState]);

  // Share exact execution truth across cards, including collapsed observers.
  useEffect(() => {
    const reference = initial ?? initialUncertainty;
    if (!reference || initial?.archived === true || initial?.historical === true) return;
    const key = initial ? keyFor(initial) : keyForUncertainty(initialUncertainty!);
    const observation = observeLocalExecution(api, reference, (next) => {
      if (activeKeyRef.current !== key) return;
      if (next.snapshot) {
        if (isSettledLocalExecution(next.snapshot)) {
          requestSequenceRef.current += 1;
          setBusy(null);
        }
        setView((current) => initial?.search && current?.key === key
          ? updateSearchView(current, next.snapshot!)
          : next.replaceOutput
          ? { ...initialView(next.snapshot!), gapObserved: next.snapshot!.output.gap || (current?.key === key && current.gapObserved) }
          : mergeView(current?.key === key ? current : null, next.snapshot!));
        setUncertainty(null);
      } else if (next.replaceOutput) {
        setView((current) => current?.key === key && current.snapshot.archived ? null : current);
      }
      setOutcomeUnconfirmed(next.unconfirmed);
      if (next.unconfirmed) setMessage("Outcome unconfirmed. Retry status; the last confirmed process state is shown.");
      else setMessage(null);
    });
    observationRef.current = observation;
    if (initial) observation.publish(initial);
    return () => {
      observation.unsubscribe();
      if (observationRef.current === observation) observationRef.current = null;
      requestSequenceRef.current += 1;
    };
  }, [api, initial, initialUncertainty]);

  const read = async () => {
    const reference = active ?? receiptUncertainty;
    if (!api || !reference || active?.archived === true || active?.historical === true || busy) return;
    const requestSequence = ++requestSequenceRef.current;
    const key = activeKey!;
    const cursor = active?.output.nextCursor ?? 0;
    setBusy("read");
    setMessage(null);
    try {
      const next = await api.read({
        generation: reference.generation,
        executionId: reference.executionId,
        cursor,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
      accept(next, key, cursor, requestSequence);
    } catch {
      if (requestSequenceRef.current === requestSequence && activeKeyRef.current === key) {
        if (receiptUncertainty) {
          setMessage("The outcome remains unknown. Retry status or Stop this exact execution.");
        } else {
          setOutcomeUnconfirmed(true);
          setMessage("Outcome unconfirmed. Retry status; the last confirmed process state is shown.");
        }
      }
    } finally {
      if (requestSequenceRef.current === requestSequence && activeKeyRef.current === key) setBusy(null);
    }
  };

  const cancel = async () => {
    const reference = active ?? receiptUncertainty;
    if (!api || !reference || active?.archived === true || active?.historical === true || busy || (receiptUncertainty && receiptUncertainty.recovery !== "read_or_cancel_same_execution")) return;
    const requestSequence = ++requestSequenceRef.current;
    const key = activeKey!;
    const cursor = active?.output.nextCursor ?? 0;
    setBusy("cancel");
    setMessage(null);
    try {
      const next = await api.cancel({
        generation: reference.generation,
        executionId: reference.executionId,
        cursor,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
      accept(next, key, cursor, requestSequence);
    } catch {
      if (requestSequenceRef.current === requestSequence && activeKeyRef.current === key) {
        if (receiptUncertainty) {
          setMessage("The outcome remains unknown. Retry status or Stop this exact execution.");
        } else {
          setOutcomeUnconfirmed(true);
          setMessage("Outcome unconfirmed. Retry status; the last confirmed process state is shown.");
        }
      }
    } finally {
      if (requestSequenceRef.current === requestSequence && activeKeyRef.current === key) setBusy(null);
    }
  };

  const openPreview = async (url: string) => {
    if (!api || !active || active.archived === true || active.historical === true || active.state !== "running" || active.exitCode !== null || active.signal !== null || busy) return;
    setBusy("preview");
    setMessage(null);
    try {
      await api.openPreview({ generation: active.generation, executionId: active.executionId, url });
    } catch {
      setMessage("The preview could not be opened.");
    } finally {
      if (activeKeyRef.current === activeKey) setBusy(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      {toolName === "write_stdin" ? <p className="text-xs text-foreground-muted">
        {continuationCopy[continuationOperation(args)].description}
      </p> : <section aria-label="command">
        <pre className="rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">$ {commandLabel(args)}</pre>
      </section>}
      {active && (
        <div className="text-xs text-foreground-muted" aria-live="polite">
          {(active.archived === true || active.historical === true) && <>Saved history · </>}Process: <span data-testid="exec-process-state">{active.state === "running" && (active.exitCode !== null || active.signal !== null) ? "Finishing cleanup" : active.state}</span>
          {active.state === "completed" && active.exitCode !== null && <> · exit code <span data-testid="exec-exit-code">{active.exitCode}</span></>}
          {active.signal && <> · signal {redactCredentialMaterialForDisplay(active.signal)}</>}
          {active.failureCode && <> · {redactCredentialMaterialForDisplay(active.failureCode)}</>}
        </div>
      )}
      {receiptUncertainty && !active && <section aria-label="execution outcome" className="text-xs text-tool-error">
        <p data-testid="exec-outcome-unknown">Outcome unknown</p>
        <p>{redactCredentialMaterialForDisplay(receiptUncertainty.message)}</p>
      </section>}
      {(active?.archived === true || active?.historical === true) && active.state === "unknown" && <p role="status" data-testid="exec-archived-unknown" className="text-xs text-tool-error">
        The saved process outcome is unknown. Desktop could not confirm how the command ended.
      </p>}
      {!active && !receiptUncertainty && state !== "running" && state !== "pending" && <p role="status" data-testid="exec-receipt-unavailable" className="text-xs text-tool-error">
        {resultTruncated ? "The execution receipt was truncated. " : "The execution receipt is unavailable or invalid. "}
        Outcome unconfirmed; the process result could not be verified.
      </p>}
      {outcomeUnconfirmed && <p role="status" className="text-xs text-tool-error">Outcome unconfirmed</p>}
      {initial?.search && <section aria-label="output search" className="text-xs text-foreground-muted">
        <p data-testid="exec-search-result">{initial.search.matchedAt !== null
          ? `Match at byte ${initial.search.matchedAt}.`
          : initial.search.complete ? "No match in the retained output searched."
            : "No match in the output searched so far. Search is incomplete."}</p>
        <p>{initial.search.complete
          ? `Search finished through byte ${initial.search.produced}.`
          : `Search observed through byte ${initial.search.produced}. Continue this search from byte ${initial.search.nextSearchCursor}.`}</p>
        {initial.search.gap && <p>Earlier output was discarded and was not searched.</p>}
      </section>}
      {typeof event?.error === "string" && <p role="status" className="text-xs text-tool-error">Tool request failed: {event.error}</p>}
      {activeView?.output && (
        <section aria-label="output">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">Output</div>
          <pre data-testid="exec-output" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">{redactCredentialMaterialForDisplay(stripAnsiSgr(activeView.output))}</pre>
        </section>
      )}
      {active?.historical === true && active.output.data !== "" && (active.output.cursor > active.output.availableFrom || active.output.hasMore) && <p role="status" data-testid="exec-saved-output-range" className="text-xs text-foreground-muted">
        Showing saved output bytes {active.output.cursor + 1}–{active.output.nextCursor} of {active.output.produced}.
      </p>}
      {!api && active?.historical !== true && active?.output.hasMore && <p role="status" data-testid="exec-output-unread" className="text-xs text-foreground-muted">
        {active.output.produced - active.output.nextCursor} output bytes after this page are not shown.
      </p>}
      {activeView?.gapObserved && <p role="status" className="text-xs text-foreground-muted">Some output before this cursor is no longer retained.</p>}
      {active?.archived !== true && active?.historical !== true && active?.state === "running" && active.exitCode === null && active.signal === null && urls.length > 0 && <div className="space-y-1 text-xs">
        <p className="text-foreground-muted">Loopback URL found in output. Availability has not been confirmed.</p>
        {urls.map((url) => <button key={url} type="button" disabled={!api || busy !== null} onClick={() => void openPreview(url)} className="text-accent underline disabled:opacity-50">Open preview</button>)}
      </div>}
      {message && <p role="status" className="text-xs text-foreground-muted">{message}</p>}
      {api && active?.archived !== true && active?.historical !== true && (active || uncertainty) && <div className="flex gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void read()} className="text-xs text-foreground underline disabled:opacity-50">
          {busy === "read" ? "Loading…" : active?.output.hasMore ? "Load more output" : receiptUncertainty && !active ? "Read execution status" : "Refresh status and output"}
        </button>
        {(receiptUncertainty?.recovery === "read_or_cancel_same_execution" || (active && canStopExecution(active))) && <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="text-xs text-tool-error underline disabled:opacity-50">
          {busy === "cancel" ? "Stopping…" : "Stop"}
        </button>}
      </div>}
    </div>
  );
}

export const execCommandRenderer: ToolRenderer = {
  displayName: "Local command",
  // Parse execution identity from the receipt into this fixed presentation;
  // the identifiers route a request but do not grant authority.
  sealedResultParser: true,
  autoExpandWhileRunning: true,
  autoExpandOnResult: true,
  reportsLiveState: true,
  observeWhileCollapsed: true,
  receiptOverridesTransportCancellation: true,
  collapsedSummary: ({ args }) => commandLabel(args),
  stateOverride: ({ resultText, state }) => {
    if (uncertaintyFromResult(resultText)) return "blocked";
    const parsed = snapshotFromResult(resultText);
    if (parsed?.archived === true) return state === "success" ? "blocked" : null;
    // Successful RPC delivery is never evidence of process completion when
    // the canonical execution receipt is missing or corrupt.
    if (!parsed) return state === "success" ? "blocked" : null;
    if (parsed.state === "cancelled" && parsed.resources !== "released") return "blocked";
    if (parsed.state === "completed") {
      if (typeof parsed.exitCode !== "number") return "blocked";
      return parsed.exitCode === 0 ? "success" : "error";
    }
    return cardState(parsed.state);
  },
  ExpandedBody: ExecCommandExpanded,
};

function continuationRenderer(operation: ContinuationOperation): ToolRenderer {
  return {
    ...execCommandRenderer,
    displayName: continuationCopy[operation].label,
    collapsedSummary: () => continuationCopy[operation].description,
    // Reads keep their observation alive without opening a second output view.
    autoExpandWhileRunning: operation !== "read",
    autoExpandOnResult: operation !== "read",
  };
}
const continuationRenderers: Record<ContinuationOperation, ToolRenderer> = {
  read: continuationRenderer("read"), input: continuationRenderer("input"),
  cancel: continuationRenderer("cancel"), search: continuationRenderer("search"),
};

export function getWriteStdinRenderer(args: Record<string, unknown>): ToolRenderer {
  return continuationRenderers[continuationOperation(args)];
}
