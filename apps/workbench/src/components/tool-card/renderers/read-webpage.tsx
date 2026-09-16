import { useState, type ReactElement, type SyntheticEvent } from "react";
import { desktopAPI } from "../../../lib/desktop";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { parseBrowserPageSnapshotInspectionResult } from "./browser-read-page";

function parseSnapshotEnvelope(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  try {
    const parsed: unknown = JSON.parse(resultText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return Object.keys(record).length === 2 && Object.keys(record).every((key) => key === "kind" || key === "result") &&
      record.kind === "browser_page_snapshot_inspection" && record.result !== undefined
      ? JSON.stringify(record.result)
      : undefined;
  } catch { return undefined; }
}

function redactOpaquePageHandles(text: string): string {
  return text
    .replace(/"reference":"[A-Za-z0-9_-]{43}"/g, '"reference":"[hidden]"')
    .replace(/"reference": "[A-Za-z0-9_-]{43}"/g, '"reference": "[hidden]"')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, "[hidden]");
}

interface WebSearchResultSource {
  number: number;
  title: string;
  url: string;
  evidence: WebSearchResultEvidence;
}

interface WebSearchResultEvidence {
  status: "complete" | "partial" | "unknown" | "failed" | "unread";
  returnedCharacters?: number;
  totalCharacters?: number;
  totalIsLowerBound?: boolean;
  remainingCharacters?: number;
}

interface WebSearchResultCoverage {
  sourcesReturned: number;
  readsRequested: number;
  readsAttempted: number;
  readsSucceeded: number;
  readsFailed: number;
  snippetOnly: number;
}

interface WebSearchResultEnvelope {
  answer: string;
  sources: WebSearchResultSource[];
  coverage: WebSearchResultCoverage;
  warnings?: string[];
}

const WEB_SEARCH_RESULT_KEYS = new Set([
  "kind",
  "version",
  "answer",
  "sources",
  "coverage",
  "warnings",
  "nextAction",
]);
const WEB_SEARCH_SOURCE_KEYS = new Set([
  "number",
  "title",
  "url",
  "evidence",
  "nextAction",
]);
const WEB_SEARCH_COVERAGE_KEYS = new Set([
  "sourcesReturned",
  "readsRequested",
  "readsAttempted",
  "readsSucceeded",
  "readsFailed",
  "snippetOnly",
]);
const WEB_SEARCH_EVIDENCE_KEYS = new Set([
  "status",
  "returnedCharacters",
  "totalCharacters",
  "totalIsLowerBound",
  "remainingCharacters",
]);
const WEB_SEARCH_NEXT_ACTION_KEYS = new Set([
  "operation",
  "url",
  "continuation",
  "snapshot",
]);
const WEB_SEARCH_HIDDEN_RAW_KEYS = new Set([
  "provider",
  "extractionmethod",
  "fallbackreason",
  "nextactions",
  "nextaction",
  "continuation",
  "snapshot",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isSafeWebSearchUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWebSearchCoverage(value: unknown): value is WebSearchResultCoverage {
  const coverage = asRecord(value);
  return Boolean(
    coverage &&
    hasExactKeys(coverage, WEB_SEARCH_COVERAGE_KEYS, [...WEB_SEARCH_COVERAGE_KEYS]) &&
    Object.values(coverage).every(isNonNegativeInteger),
  );
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isWebSearchEvidence(value: unknown): value is WebSearchResultEvidence {
  const evidence = asRecord(value);
  if (!evidence || !hasExactKeys(evidence, WEB_SEARCH_EVIDENCE_KEYS, ["status"]) ||
    !["complete", "partial", "unknown", "failed", "unread"].includes(String(evidence.status))) {
    return false;
  }
  return [
    evidence.returnedCharacters,
    evidence.totalCharacters,
    evidence.remainingCharacters,
  ].every((count) => count === undefined || isNonNegativeInteger(count)) &&
    (evidence.totalIsLowerBound === undefined || typeof evidence.totalIsLowerBound === "boolean") &&
    (evidence.totalIsLowerBound === undefined || evidence.totalCharacters !== undefined);
}

function isWebSearchContinuation(value: unknown): boolean {
  const continuation = asRecord(value);
  return Boolean(
    continuation &&
    hasExactKeys(continuation, new Set(["version", "reference", "offsetCharacters", "mode"]), ["version", "reference", "offsetCharacters", "mode"]) &&
    continuation.version === 1 &&
    isOpaqueHandle(continuation.reference) &&
    isNonNegativeInteger(continuation.offsetCharacters) &&
    (continuation.mode === "page" || continuation.mode === "remainder"),
  );
}

function isWebSearchSnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  if (!snapshot || snapshot.version !== 1 || !isOpaqueHandle(snapshot.reference)) return false;
  if (snapshot.operation === "snapshot") {
    return hasExactKeys(snapshot, new Set(["version", "reference", "operation"]), ["version", "reference", "operation"]);
  }
  if (snapshot.operation === "find") {
    return hasExactKeys(snapshot, new Set(["version", "reference", "operation", "query", "maxMatches"]), ["version", "reference", "operation", "query"]) &&
      typeof snapshot.query === "string" && snapshot.query.length > 0 && snapshot.query.length <= 1_000 &&
      (snapshot.maxMatches === undefined || (isNonNegativeInteger(snapshot.maxMatches) && snapshot.maxMatches > 0 && snapshot.maxMatches <= 100));
  }
  if (snapshot.operation === "range") {
    return hasExactKeys(snapshot, new Set(["version", "reference", "operation", "offsetCharacters", "beforeCharacters", "afterCharacters"]), ["version", "reference", "operation", "offsetCharacters", "beforeCharacters", "afterCharacters"]) &&
      isNonNegativeInteger(snapshot.offsetCharacters) &&
      isNonNegativeInteger(snapshot.beforeCharacters) &&
      isNonNegativeInteger(snapshot.afterCharacters);
  }
  return false;
}

/** Validate machine-only next-action data without ever projecting it into the card. */
function isWebSearchNextAction(value: unknown): boolean {
  const action = asRecord(value);
  if (!action || !hasExactKeys(action, WEB_SEARCH_NEXT_ACTION_KEYS, ["operation"]) ||
    action.operation !== "read_webpage" ||
    (action.url !== undefined && (typeof action.url !== "string" || !isSafeWebSearchUrl(action.url)))) {
    return false;
  }
  return (action.continuation === undefined || isWebSearchContinuation(action.continuation)) &&
    (action.snapshot === undefined || isWebSearchSnapshot(action.snapshot)) &&
    (action.url !== undefined || action.continuation !== undefined || action.snapshot !== undefined);
}

/**
 * The renderer is deliberately a strict consumer. Presentation envelopes are
 * an allowlisted boundary: unrecognized versions, additional fields, and
 * malformed nested values stay on the legacy raw-result path instead of
 * accidentally turning provider/debug data into Human-facing UI.
 */
function parseWebSearchResultEnvelope(
  resultText: string | undefined,
): WebSearchResultEnvelope | undefined {
  if (!resultText) return undefined;
  try {
    const root = asRecord(JSON.parse(resultText));
    if (!root || root.kind !== "web_search_result" || root.version !== 1 ||
      !hasExactKeys(root, WEB_SEARCH_RESULT_KEYS, ["kind", "version", "answer", "sources", "coverage"]) ||
      typeof root.answer !== "string" || !Array.isArray(root.sources) ||
      (root.nextAction !== undefined && !isWebSearchNextAction(root.nextAction))) {
      return undefined;
    }

    if (!isWebSearchCoverage(root.coverage)) {
      return undefined;
    }

    const sourceNumbers = new Set<number>();
    const sources: WebSearchResultSource[] = [];
    for (const candidate of root.sources) {
      const source = asRecord(candidate);
      const sourceNumber = source?.number;
      if (!source || !hasExactKeys(source, WEB_SEARCH_SOURCE_KEYS, ["number", "title", "url"]) ||
        typeof sourceNumber !== "number" || !Number.isSafeInteger(sourceNumber) || sourceNumber <= 0 || sourceNumbers.has(sourceNumber) ||
        typeof source.title !== "string" || !source.title.trim() ||
        typeof source.url !== "string" || !isSafeWebSearchUrl(source.url) ||
        !isWebSearchEvidence(source.evidence) ||
        (source.nextAction !== undefined && !isWebSearchNextAction(source.nextAction))) {
        return undefined;
      }
      sourceNumbers.add(sourceNumber);
      sources.push({
        number: sourceNumber,
        title: source.title,
        url: source.url,
        evidence: source.evidence,
      });
    }

    const normalizedCoverage = root.coverage;
    if (normalizedCoverage.snippetOnly > normalizedCoverage.sourcesReturned ||
      normalizedCoverage.readsSucceeded > normalizedCoverage.readsRequested ||
      normalizedCoverage.readsSucceeded + normalizedCoverage.readsFailed !== normalizedCoverage.readsAttempted ||
      normalizedCoverage.snippetOnly !== normalizedCoverage.sourcesReturned - normalizedCoverage.readsSucceeded) {
      return undefined;
    }

    if (root.warnings !== undefined &&
      (!Array.isArray(root.warnings) || root.warnings.length > 20 ||
        !root.warnings.every((warning) => typeof warning === "string" && warning.length <= 2_000))) {
      return undefined;
    }
    return {
      answer: root.answer,
      sources,
      coverage: normalizedCoverage,
      ...(Array.isArray(root.warnings) ? { warnings: root.warnings } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Legacy raw text remains readable, but JSON debug receipts never expose machinery. */
function redactWebSearchRawResult(text: string): string {
  try {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      const record = asRecord(value);
      if (!record) return value;
      return Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => {
            const normalized = key.toLowerCase();
            return !WEB_SEARCH_HIDDEN_RAW_KEYS.has(normalized) && !normalized.includes("reference");
          })
          .map(([key, nested]) => [key, redact(nested)]),
      );
    };
    return JSON.stringify(redact(JSON.parse(text)), null, 2);
  } catch {
    return redactOpaquePageHandles(text)
      .split("\n")
      .filter((line) => !/^\s*(?:search\s+provider|provider|extraction\s+method|fallback\s+reason|next\s+actions?)\s*:/i.test(line))
      .join("\n");
  }
}

function formatCoverage(
  coverage: WebSearchResultCoverage,
  sources: readonly WebSearchResultSource[],
): string | undefined {
  if (coverage.sourcesReturned === 0 && coverage.readsRequested === 0) return undefined;
  const complete = sources.filter((source) => source.evidence.status === "complete").length;
  const partial = sources.filter((source) => source.evidence.status === "partial").length;
  const unknown = sources.filter((source) => source.evidence.status === "unknown").length;
  const parts = [
    `${coverage.sourcesReturned} ${coverage.sourcesReturned === 1 ? "source" : "sources"} returned`,
    coverage.readsRequested > 0
      ? `${coverage.readsRequested} ${coverage.readsRequested === 1 ? "page read" : "page reads"} requested`
      : undefined,
    coverage.readsAttempted > 0
      ? `${coverage.readsAttempted} attempted`
      : undefined,
    complete > 0 ? `${complete} complete` : undefined,
    partial > 0 ? `${partial} partial` : undefined,
    unknown > 0 ? `${unknown} completeness unknown` : undefined,
    coverage.readsFailed > 0
      ? `${coverage.readsFailed} failed ${coverage.readsFailed === 1 ? "attempt" : "attempts"}`
      : undefined,
    coverage.snippetOnly > 0
      ? `${coverage.snippetOnly} snippet-only`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return `${parts.join("; ")}.`;
}

function formatCharacterCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSourceEvidence(evidence: WebSearchResultEvidence): string {
  if (evidence.status === "unread") return "Snippet only — page URL was not fetched.";
  if (evidence.status === "failed") return "Page URL fetch/read failed; only search-result evidence is available.";

  const returned = evidence.returnedCharacters;
  const total = evidence.totalCharacters;
  const remaining = evidence.remainingCharacters;
  const counts = returned === undefined
    ? ""
    : total === undefined
      ? ` — ${formatCharacterCount(returned)} characters returned`
      : evidence.totalIsLowerBound
        ? ` — ${formatCharacterCount(returned)} characters returned; page is at least ${formatCharacterCount(total)} characters`
        : ` — ${formatCharacterCount(returned)} of ${formatCharacterCount(total)} characters`;
  const remainder = remaining !== undefined && remaining > 0
    ? `; ${formatCharacterCount(remaining)} remaining`
    : "";
  const label = evidence.status === "complete"
    ? "complete"
    : evidence.status === "partial"
      ? "partial"
      : "completeness unknown";
  return `Page URL fetched and read: ${label}${counts}${remainder}.`;
}

function WebSearchResultBody({ result }: { result: WebSearchResultEnvelope }): ReactElement {
  const coverage = formatCoverage(result.coverage, result.sources);
  const warnings = result.warnings?.map((warning) => warning.trim()).filter(Boolean) ?? [];
  return (
    <div className="space-y-3 border-t border-border px-3 py-3" data-testid="web-search-result">
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{result.answer}</p>
      {coverage ? <p className="text-xs text-foreground-muted">{coverage}</p> : null}
      {warnings.length > 0 ? (
        <section aria-label="Research notes" className="rounded border border-[var(--warning,#b58900)]/50 bg-background px-3 py-2">
          <h3 className="text-xs font-semibold text-[var(--warning,#b58900)]">Research notes</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-foreground-muted">
            {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        </section>
      ) : null}
      {result.sources.length > 0 ? (
        <section aria-label="Sources">
          <h3 className="text-xs font-semibold text-foreground">Sources</h3>
          <ol className="mt-1 space-y-2 text-xs text-foreground-muted">
            {result.sources.map((source) => (
              <li key={`${source.number}-${source.url}`}>
                <span className="mr-1 font-mono text-foreground-dim">[{source.number}]</span>
                <span className="text-foreground">{source.title}</span>
                <p className="mt-0.5 select-all break-all font-mono text-[0.65rem] text-foreground-dim">
                  {source.url}
                </p>
                <p className="mt-0.5 text-[0.7rem] text-foreground-muted" data-testid="web-search-source-evidence">
                  {formatSourceEvidence(source.evidence)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function ReadWebpageExpanded({
  toolName,
  args,
  event,
  resultText,
}: ToolRendererProps): ReactElement {
  const isWebSearch = toolName === "run_web_search";
  const intervention = event?.browserResearchIntervention;
  const snapshotResult = parseSnapshotEnvelope(resultText);
  const inspection = parseBrowserPageSnapshotInspectionResult(snapshotResult);
  const webSearchResult = isWebSearch
    ? parseWebSearchResultEnvelope(resultText)
    : undefined;
  const [mode, setMode] = useState<
    "choice" | "human" | "reobserve" | "working" | "stale"
  >("choice");
  const [error, setError] = useState<string | null>(null);

  if (!intervention) {
    if (inspection) {
      return (
        <div className="space-y-2 border-t border-border px-3 py-2" data-testid="read-webpage-snapshot-inspection">
          <p className="text-xs text-foreground-muted">Temporary page context, available in this session until {inspection.expiresAt}.</p>
          {inspection.operation === "find" ? <>
            <p className="text-xs text-foreground-muted">{inspection.totalMatches} matches; {inspection.returnedMatches} shown{inspection.matchesOmitted ? `; ${inspection.matchesOmitted} not shown` : ""}.</p>
            {inspection.matches.map((match, index) => <pre key={`${match.offsetCharacters}-${index}`} className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted" data-testid="read-webpage-find-preview">Offset {match.offsetCharacters}{match.truncatedBlock ? " · partial block" : ""}\n{match.preview}</pre>)}
          </> : <>
            <p className="text-xs text-foreground-muted">Offsets {inspection.startOffsetCharacters} → {inspection.endOffsetCharacters} around {inspection.offsetCharacters}{inspection.truncatedBlock ? " · partial block" : ""}.</p>
            <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted" data-testid="read-webpage-range-content">{inspection.content}</pre>
          </>}
        </div>
      );
    }
    if (webSearchResult) return <WebSearchResultBody result={webSearchResult} />;
    return (
      <div className="border-t border-border px-3 py-2">
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted">
          {resultText ? (isWebSearch ? redactWebSearchRawResult(resultText) : redactOpaquePageHandles(resultText)) :
            (event?.status === "running"
              ? (isWebSearch ? "Searching the web…" : "Reading the rendered page…")
              : (isWebSearch ? "No search result was returned." : "No page result was returned."))}
        </pre>
      </div>
    );
  }

  const stopPropagation = (syntheticEvent: SyntheticEvent): void =>
    syntheticEvent.stopPropagation();
  const call = async (action: "present" | "alternate" | "cancel") => {
    const api = desktopAPI?.browserResearch;
    if (!api) {
      setMode("stale");
      setError(
        "This verification session is no longer available on this Desktop.",
      );
      return false;
    }
    setError(null);
    const result = await api[action](intervention.id);
    if (!result.ok) {
      setMode("stale");
      setError(
        "This temporary verification session expired or is no longer available.",
      );
      return false;
    }
    return true;
  };
  const runAction = (action: "present" | "alternate" | "cancel"): void => {
    void (async () => {
      setMode("working");
      if (!(await call(action))) return;
      setMode(action === "present" ? "human" : "stale");
    })();
  };

  return (
    <div
      className="space-y-3 border-t border-border px-3 py-3"
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
      data-testid="browser-research-intervention"
    >
      <section className="rounded border border-[var(--warning,#b58900)]/50 bg-background px-3 py-2">
        <h3 className="text-sm font-semibold text-[var(--warning,#b58900)]">
          Verification required
        </h3>
        <p className="mt-1 text-xs text-foreground-muted">
          {isWebSearch
            ? `${intervention.host} needs to verify you're human before Genie can continue this search.`
            : <>{intervention.host} needs to verify you're human before Genie can read this page.</>}
        </p>
        <p className="mt-2 text-xs font-medium text-foreground">
          This anonymous Browser session is temporary. Do not sign in or enter
          private information.
        </p>
      </section>

      {mode === "human" ? (
        <p className="text-xs text-foreground-muted">
          Complete the verification in Nautilo's Browser. Genie continues
          automatically when it clears.
        </p>
      ) : null}
      {mode === "reobserve" ? (
        <p className="text-xs text-foreground-muted">
          Checking the page again before Genie continues…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-tool-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {mode !== "human" && mode !== "reobserve" ? (
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={mode === "working" || mode === "stale"}
            onClick={() => runAction("present")}
          >
            Complete verification
          </button>
        ) : null}
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-xs text-foreground"
          disabled={
            mode === "working" || mode === "stale" || mode === "reobserve"
          }
          onClick={() => runAction("alternate")}
        >
          Try another source
        </button>
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-xs text-foreground-muted"
          disabled={
            mode === "working" || mode === "stale" || mode === "reobserve"
          }
          onClick={() => runAction("cancel")}
        >
          Stop research
        </button>
      </div>
      <p className="break-all font-mono text-[0.65rem] text-foreground-dim">
        {typeof args.url === "string" ? args.url : intervention.host}
      </p>
    </div>
  );
}

export const readWebpageRenderer: ToolRenderer = {
  collapsedSummary: ({ args }) =>
    typeof args.url === "string" ? args.url : "Read webpage",
  collapsedExtras: () => null,
  ExpandedBody: ReadWebpageExpanded,
};

export const webSearchRenderer: ToolRenderer = {
  displayName: "Web search",
  collapsedSummary: ({ args }) =>
    typeof args.query === "string" ? args.query : "Web search",
  collapsedExtras: () => null,
  ExpandedBody: ReadWebpageExpanded,
};
