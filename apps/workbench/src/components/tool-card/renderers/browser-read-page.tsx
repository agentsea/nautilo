/**
 * D504 Wave 1 — rendered-page read result projection.
 *
 * Page text is an untrusted tool result. This renderer deliberately projects it
 * as text only: it creates no HTML, no links, and no navigation affordances.
 * Human challenge intervention belongs to Wave 2 and is intentionally absent.
 */

import type { ReactElement } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";

const QUALITY_VALUES = new Set([
  "complete",
  "partial",
  "empty",
  "noisy",
  "visual-required",
  "challenge",
  "error",
]);
const FAILURE_VALUES = new Set([
  "none",
  "navigation-error",
  "timeout",
  "evaluation-error",
  "empty-dom",
  "iframe-limited",
  "virtualized",
  "visual-required",
  "challenge",
]);
const ROOT_VALUES = new Set(["article", "main", "body", "none"]);
const READINESS_VALUES = new Set(["loading", "interactive", "complete", "unknown"]);
const BLOCK_KIND_VALUES = new Set(["heading", "paragraph", "list-item", "quote", "preformatted", "table"]);

type BrowserPageQuality =
  | "complete"
  | "partial"
  | "empty"
  | "noisy"
  | "visual-required"
  | "challenge"
  | "error";

interface BrowserPageReadableBlock {
  kind: "heading" | "paragraph" | "list-item" | "quote" | "preformatted" | "table";
  text: string;
  links?: Array<{ text: string; href: string }>;
}

export interface BrowserPageReadResultView {
  targetRole: "interactive" | "research";
  requestedUrl?: string;
  finalUrl: string;
  title: string;
  content: string;
  blocks: BrowserPageReadableBlock[];
  totalCharacters: number;
  totalCharactersCapped: boolean;
  totalBytes: number;
  estimatedTokens: number;
  offsetCharacters: number;
  nextOffsetCharacters: number;
  returnedCharacters: number;
  remainingCharacters: number;
  eof: boolean;
  truncated: boolean;
  contextClamped: boolean;
  continuation?: {
    version: 1;
    reference: string;
    nextOffsetCharacters: number;
    expiresAt: string;
  };
  pageReference?: { version: 1; reference: string; expiresAt: string };
  evictedPageReferences?: Array<{ version: 1; reference: string; title: string; finalUrl: string }>;
  extraction: {
    method: "fixed-dom-semantic-v1" | "mozilla-readability-turndown-v1" | "agent-browser-accessibility-snapshot-v1";
    root: "article" | "main" | "body" | "none";
    iframeCount: number;
  };
  timing: {
    readiness: "loading" | "interactive" | "complete" | "unknown";
    extractionMs?: number;
    elapsedMs?: number;
  };
  quality: BrowserPageQuality;
  challenge: {
    detected: boolean;
    confidence: "none" | "heuristic";
    signals: string[];
  };
  failure: string;
  diagnostics: string[];
  eventProjection?: {
    kind: "browser_read_page";
    totalContentCharacters: number;
    shownContentCharacters: number;
    totalBlocks: number;
    shownBlocks: number;
    contentTruncated: boolean;
    blocksTruncated: boolean;
    truncated: boolean;
  };
}

export type BrowserPageSnapshotInspectionView =
  | {
      operation: "find";
      expiresAt: string;
      caseSensitive: boolean;
      totalMatches: number;
      returnedMatches: number;
      matchesOmitted: number;
      matches: Array<{ offsetCharacters: number; matchCharacters: number; previewOffsetCharacters: number; preview: string; startsMidBlock: boolean; endsMidBlock: boolean; truncatedBlock: boolean }>;
    }
  | {
      operation: "range";
      expiresAt: string;
      offsetCharacters: number;
      startOffsetCharacters: number;
      endOffsetCharacters: number;
      content: string;
      startsMidBlock: boolean;
      endsMidBlock: boolean;
      truncatedBlock: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNoncredentialedHttpUrl(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (allowEmpty && value === "") return true;
  if (value.length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

function redactOpaquePageReferences(value: string): string {
  return value.replace(/\b[A-Za-z0-9_-]{43}\b/g, "[hidden]");
}

function projectLegacyFixedDomResult(parsed: Record<string, unknown>): {
  readonly value: Record<string, unknown>;
  readonly legacy: boolean;
} {
  const extraction = isRecord(parsed.extraction) ? parsed.extraction : null;
  const hasV12Fields = [
    "totalBytes", "estimatedTokens", "offsetCharacters", "nextOffsetCharacters",
    "remainingCharacters", "eof", "contextClamped", "continuation",
  ].some((key) => parsed[key] !== undefined);
  if (hasV12Fields || extraction?.method !== "fixed-dom-semantic-v1" ||
    typeof parsed.content !== "string" || !isNonNegativeNumber(parsed.totalCharacters) ||
    !isNonNegativeNumber(parsed.returnedCharacters) || typeof parsed.truncated !== "boolean" ||
    parsed.returnedCharacters !== parsed.content.length || parsed.totalCharacters < parsed.returnedCharacters) {
    return { value: parsed, legacy: false };
  }
  const nextOffsetCharacters = parsed.returnedCharacters;
  return {
    legacy: true,
    value: {
      ...parsed,
      totalBytes: new TextEncoder().encode(parsed.content).byteLength,
      estimatedTokens: Math.ceil(parsed.totalCharacters / 4),
      offsetCharacters: 0,
      nextOffsetCharacters,
      remainingCharacters: parsed.totalCharacters - nextOffsetCharacters,
      eof: !parsed.truncated,
      contextClamped: false,
    },
  };
}

/** Parse only the stable BrowserPageReadResult wire shape. */
export function parseBrowserPageReadResult(raw: string | undefined): BrowserPageReadResultView | null {
  if (!raw?.trim()) return null;
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!isRecord(decoded)) return null;
    const projection = projectLegacyFixedDomResult(decoded);
    const parsed = projection.value;
    if (!isRecord(parsed.extraction) || !isRecord(parsed.timing) || !isRecord(parsed.challenge)) {
      return null;
    }
    const extraction = parsed.extraction;
    const timing = parsed.timing;
    const challenge = parsed.challenge;
    const parsedContent = typeof parsed.content === "string" ? parsed.content : null;
    const parsedBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : null;
    const eventProjection = isRecord(parsed.eventProjection) && parsed.eventProjection.kind === "browser_read_page"
      ? parsed.eventProjection
      : null;
    const contentLengthIsValid = eventProjection === null
      ? parsedContent !== null && parsed.returnedCharacters === parsedContent.length
      : parsedContent !== null && parsedBlocks !== null &&
        isNonNegativeNumber(eventProjection.totalContentCharacters) &&
        isNonNegativeNumber(eventProjection.shownContentCharacters) &&
        isNonNegativeNumber(eventProjection.totalBlocks) &&
        isNonNegativeNumber(eventProjection.shownBlocks) &&
        typeof eventProjection.contentTruncated === "boolean" &&
        typeof eventProjection.blocksTruncated === "boolean" &&
        typeof eventProjection.truncated === "boolean" &&
        eventProjection.totalContentCharacters === parsed.returnedCharacters &&
        eventProjection.shownContentCharacters === parsedContent.length &&
        eventProjection.shownBlocks === parsedBlocks.length &&
        eventProjection.shownBlocks <= eventProjection.totalBlocks;
    if (
      (parsed.targetRole !== "interactive" && parsed.targetRole !== "research") ||
      (parsed.requestedUrl !== undefined && typeof parsed.requestedUrl !== "string") ||
      typeof parsed.finalUrl !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.content !== "string" ||
      !Array.isArray(parsed.blocks) ||
      !parsed.blocks.every((block) =>
        isRecord(block) &&
        typeof block.kind === "string" &&
        BLOCK_KIND_VALUES.has(block.kind) &&
        typeof block.text === "string" &&
        (block.links === undefined || (
          Array.isArray(block.links) &&
          block.links.every((link) => isRecord(link) && typeof link.text === "string" && typeof link.href === "string")
        )),
      ) ||
      !isNonNegativeNumber(parsed.totalCharacters) ||
      typeof parsed.totalCharactersCapped !== "boolean" ||
      !isNonNegativeNumber(parsed.totalBytes) ||
      !isNonNegativeNumber(parsed.estimatedTokens) ||
      !isNonNegativeNumber(parsed.offsetCharacters) ||
      !isNonNegativeNumber(parsed.nextOffsetCharacters) ||
      !isNonNegativeNumber(parsed.returnedCharacters) ||
      !isNonNegativeNumber(parsed.remainingCharacters) ||
      !contentLengthIsValid ||
      parsed.nextOffsetCharacters - parsed.offsetCharacters !== parsed.returnedCharacters ||
      parsed.remainingCharacters !== parsed.totalCharacters - parsed.nextOffsetCharacters ||
      typeof parsed.eof !== "boolean" ||
      (!projection.legacy && parsed.eof !== (parsed.remainingCharacters === 0)) ||
      typeof parsed.truncated !== "boolean" ||
      (projection.legacy ? parsed.eof === parsed.truncated : parsed.truncated !== !parsed.eof) ||
      typeof parsed.contextClamped !== "boolean" ||
      (extraction.method !== "fixed-dom-semantic-v1" &&
        extraction.method !== "mozilla-readability-turndown-v1" &&
        extraction.method !== "agent-browser-accessibility-snapshot-v1") ||
      typeof extraction.root !== "string" ||
      !ROOT_VALUES.has(extraction.root) ||
      !isNonNegativeNumber(extraction.iframeCount) ||
      typeof timing.readiness !== "string" ||
      !READINESS_VALUES.has(timing.readiness) ||
      typeof parsed.quality !== "string" ||
      !QUALITY_VALUES.has(parsed.quality) ||
      typeof parsed.failure !== "string" ||
      !FAILURE_VALUES.has(parsed.failure) ||
      typeof challenge.detected !== "boolean" ||
      (challenge.confidence !== "none" && challenge.confidence !== "heuristic") ||
      !Array.isArray(challenge.signals) ||
      !challenge.signals.every((signal) => typeof signal === "string") ||
      !Array.isArray(parsed.diagnostics) ||
      !parsed.diagnostics.every((diagnostic) => typeof diagnostic === "string")
    ) {
      return null;
    }
    let continuation: BrowserPageReadResultView["continuation"];
    if (parsed.continuation !== undefined) {
      if (!isRecord(parsed.continuation) || parsed.eof || parsed.continuation.version !== 1 ||
        typeof parsed.continuation.reference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.continuation.reference) ||
        parsed.continuation.nextOffsetCharacters !== parsed.nextOffsetCharacters ||
        typeof parsed.continuation.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.continuation.expiresAt))) {
        return null;
      }
      continuation = {
        version: 1,
        reference: parsed.continuation.reference,
        nextOffsetCharacters: parsed.continuation.nextOffsetCharacters,
        expiresAt: parsed.continuation.expiresAt,
      };
    }
    let pageReference: BrowserPageReadResultView["pageReference"];
    if (parsed.pageReference !== undefined) {
      if (!isRecord(parsed.pageReference) || parsed.pageReference.version !== 1 ||
        typeof parsed.pageReference.reference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.pageReference.reference) ||
        typeof parsed.pageReference.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.pageReference.expiresAt))) return null;
      pageReference = { version: 1, reference: parsed.pageReference.reference, expiresAt: parsed.pageReference.expiresAt };
    }
    let evictedPageReferences: BrowserPageReadResultView["evictedPageReferences"];
    if (parsed.evictedPageReferences !== undefined) {
      if (!Array.isArray(parsed.evictedPageReferences)) return null;
      const projectedEvictions: NonNullable<BrowserPageReadResultView["evictedPageReferences"]> = [];
      for (const entry of parsed.evictedPageReferences) {
        if (!isRecord(entry) || entry.version !== 1 || typeof entry.reference !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(entry.reference) || typeof entry.title !== "string" ||
          entry.title.length > 512 || !isNoncredentialedHttpUrl(entry.finalUrl, true)) return null;
        projectedEvictions.push({ version: 1, reference: entry.reference, title: entry.title, finalUrl: entry.finalUrl });
      }
      evictedPageReferences = projectedEvictions;
    }
    if (pageReference !== undefined && (parsed.content.length === 0 || challenge.detected === true || parsed.quality === "challenge")) return null;
    if (continuation !== undefined && pageReference !== undefined &&
      (continuation.reference !== pageReference.reference || continuation.expiresAt !== pageReference.expiresAt)) return null;
    if (evictedPageReferences !== undefined) {
      if (pageReference === undefined || evictedPageReferences.length > 16) return null;
      const evictedReferences = new Set<string>();
      for (const evicted of evictedPageReferences) {
        if (evicted.reference === pageReference.reference || evictedReferences.has(evicted.reference)) return null;
        evictedReferences.add(evicted.reference);
      }
    }
    if (
      (timing.extractionMs !== undefined && !isNonNegativeNumber(timing.extractionMs)) ||
      (timing.elapsedMs !== undefined && !isNonNegativeNumber(timing.elapsedMs))
    ) {
      return null;
    }
    return {
      targetRole: parsed.targetRole,
      ...(parsed.requestedUrl !== undefined ? { requestedUrl: parsed.requestedUrl } : {}),
      finalUrl: parsed.finalUrl,
      title: parsed.title,
      content: parsed.content,
      blocks: parsed.blocks as BrowserPageReadableBlock[],
      totalCharacters: parsed.totalCharacters,
      totalCharactersCapped: parsed.totalCharactersCapped,
      totalBytes: parsed.totalBytes,
      estimatedTokens: parsed.estimatedTokens,
      offsetCharacters: parsed.offsetCharacters,
      nextOffsetCharacters: parsed.nextOffsetCharacters,
      returnedCharacters: parsed.returnedCharacters,
      remainingCharacters: parsed.remainingCharacters,
      eof: parsed.eof,
      truncated: parsed.truncated,
      contextClamped: parsed.contextClamped,
      ...(continuation === undefined ? {} : { continuation }),
      ...(pageReference === undefined ? {} : { pageReference }),
      ...(evictedPageReferences === undefined ? {} : { evictedPageReferences }),
      extraction: {
        method: extraction.method,
        root: extraction.root as BrowserPageReadResultView["extraction"]["root"],
        iframeCount: extraction.iframeCount,
      },
      timing: {
        readiness: timing.readiness as BrowserPageReadResultView["timing"]["readiness"],
        ...(timing.extractionMs !== undefined ? { extractionMs: timing.extractionMs } : {}),
        ...(timing.elapsedMs !== undefined ? { elapsedMs: timing.elapsedMs } : {}),
      },
      quality: parsed.quality as BrowserPageQuality,
      challenge: {
        detected: challenge.detected,
        confidence: challenge.confidence,
        signals: challenge.signals,
      },
      failure: parsed.failure,
      diagnostics: parsed.diagnostics,
      ...(eventProjection === null ? {} : {
        eventProjection: {
          kind: "browser_read_page" as const,
          totalContentCharacters: eventProjection.totalContentCharacters as number,
          shownContentCharacters: eventProjection.shownContentCharacters as number,
          totalBlocks: eventProjection.totalBlocks as number,
          shownBlocks: eventProjection.shownBlocks as number,
          contentTruncated: eventProjection.contentTruncated as boolean,
          blocksTruncated: eventProjection.blocksTruncated as boolean,
          truncated: eventProjection.truncated as boolean,
        },
      }),
    };
  } catch {
    return null;
  }
}

/** Strict, display-safe projection of v13 inert find/range results. */
export function parseBrowserPageSnapshotInspectionResult(raw: string | undefined): BrowserPageSnapshotInspectionView | null {
  if (!raw?.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const findKeys = new Set(["version", "operation", "reference", "expiresAt", "caseSensitive", "totalMatches", "returnedMatches", "matchesOmitted", "matches"]);
    const matchKeys = new Set(["offsetCharacters", "matchCharacters", "previewOffsetCharacters", "preview", "startsMidBlock", "endsMidBlock", "truncatedBlock"]);
    const rangeKeys = new Set(["version", "operation", "reference", "expiresAt", "offsetCharacters", "startOffsetCharacters", "endOffsetCharacters", "content", "startsMidBlock", "endsMidBlock", "truncatedBlock"]);
    const hasOnly = (record: Record<string, unknown>, keys: Set<string>) => Object.keys(record).every((key) => keys.has(key));
    const isSafe = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
    if (!isRecord(value) || value.version !== 1 || typeof value.reference !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.reference) || typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))) return null;
    if (value.operation === "find") {
      if (!hasOnly(value, findKeys) || typeof value.caseSensitive !== "boolean" || !isSafe(value.totalMatches) ||
        !isSafe(value.returnedMatches) || !isSafe(value.matchesOmitted) ||
        value.returnedMatches + value.matchesOmitted !== value.totalMatches || !Array.isArray(value.matches) ||
        value.matches.length !== value.returnedMatches || value.matches.length > 16 ||
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 12_000) return null;
      let previousOffset = -1;
      let previousEnd = -1;
      for (const match of value.matches) {
        if (!isRecord(match) || !hasOnly(match, matchKeys) || !isSafe(match.offsetCharacters) ||
          !isSafe(match.matchCharacters) || match.matchCharacters === 0 || !isSafe(match.previewOffsetCharacters) ||
          typeof match.preview !== "string" || typeof match.startsMidBlock !== "boolean" ||
          typeof match.endsMidBlock !== "boolean" || typeof match.truncatedBlock !== "boolean" ||
          match.truncatedBlock !== (match.startsMidBlock || match.endsMidBlock) ||
          match.previewOffsetCharacters > match.offsetCharacters ||
          match.offsetCharacters > Number.MAX_SAFE_INTEGER - match.matchCharacters ||
          match.previewOffsetCharacters > Number.MAX_SAFE_INTEGER - match.preview.length ||
          match.offsetCharacters + match.matchCharacters > match.previewOffsetCharacters + match.preview.length ||
          match.offsetCharacters <= previousOffset || match.offsetCharacters < previousEnd) return null;
        previousOffset = match.offsetCharacters;
        previousEnd = match.offsetCharacters + match.matchCharacters;
      }
      return { operation: "find", expiresAt: value.expiresAt, caseSensitive: value.caseSensitive,
        totalMatches: value.totalMatches, returnedMatches: value.returnedMatches, matchesOmitted: value.matchesOmitted,
        matches: value.matches as Extract<BrowserPageSnapshotInspectionView, { operation: "find" }>["matches"] };
    }
    if (value.operation === "range") {
      if (!hasOnly(value, rangeKeys) || !isSafe(value.offsetCharacters) || !isSafe(value.startOffsetCharacters) ||
        !isSafe(value.endOffsetCharacters) || value.startOffsetCharacters > value.offsetCharacters ||
        value.offsetCharacters > value.endOffsetCharacters || typeof value.content !== "string" ||
        value.endOffsetCharacters - value.startOffsetCharacters !== value.content.length ||
        value.content.length > 24_000 ||
        typeof value.startsMidBlock !== "boolean" || typeof value.endsMidBlock !== "boolean" ||
        typeof value.truncatedBlock !== "boolean" || value.truncatedBlock !== (value.startsMidBlock || value.endsMidBlock)) return null;
      return { operation: "range", expiresAt: value.expiresAt, offsetCharacters: value.offsetCharacters,
        startOffsetCharacters: value.startOffsetCharacters, endOffsetCharacters: value.endOffsetCharacters,
        content: value.content, startsMidBlock: value.startsMidBlock, endsMidBlock: value.endsMidBlock, truncatedBlock: value.truncatedBlock };
    }
    return null;
  } catch { return null; }
}

function clipped(value: string, maximum = 72): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function pageLabel(page: BrowserPageReadResultView): string {
  if (page.title) return clipped(page.title);
  if (page.finalUrl) return clipped(page.finalUrl);
  return "Untitled page";
}

function formatCharacters(characters: number): string {
  return new Intl.NumberFormat().format(characters);
}

function qualityDescription(quality: BrowserPageQuality): string {
  switch (quality) {
    case "partial":
      return "Some rendered content may be missing.";
    case "empty":
      return "No readable DOM text was found.";
    case "noisy":
      return "Rendered content may include page boilerplate.";
    case "visual-required":
      return "Visual content needs a screenshot to inspect.";
    case "challenge":
      return "A human-verification challenge was detected.";
    case "error":
      return "The page read did not complete.";
    default:
      return "Rendered page text was extracted.";
  }
}

export function formatBrowserPageReadSummary(resultText: string | undefined): string {
  const page = parseBrowserPageReadResult(resultText);
  if (page) return `Read page · ${pageLabel(page)}`;
  const inspection = parseBrowserPageSnapshotInspectionResult(resultText);
  if (!inspection) return "Read page";
  return inspection.operation === "find"
    ? `Find page text · ${inspection.totalMatches} match${inspection.totalMatches === 1 ? "" : "es"} (${inspection.returnedMatches} shown)`
    : `Expand page context · ${inspection.startOffsetCharacters}–${inspection.endOffsetCharacters}`;
}

export function formatBrowserPageReadExtras(resultText: string | undefined): string | null {
  const page = parseBrowserPageReadResult(resultText);
  if (page) return `${page.quality} · ${formatCharacters(page.returnedCharacters)} chars`;
  const inspection = parseBrowserPageSnapshotInspectionResult(resultText);
  if (!inspection) return null;
  return inspection.operation === "find"
    ? `${inspection.returnedMatches} shown · ${inspection.matchesOmitted} omitted`
    : `around ${inspection.offsetCharacters}`;
}

function BrowserReadPageExpanded({ resultText, resultTruncated, state, event }: ToolRendererProps): ReactElement {
  const page = parseBrowserPageReadResult(resultText);
  const inspection = parseBrowserPageSnapshotInspectionResult(resultText);

  if (inspection) {
    return (
      <div className="border-t border-border px-3 py-2 space-y-3" data-testid="browser-read-page-snapshot-inspection">
        <section className="rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground-muted">
          <p className="font-medium text-foreground">Temporary page context</p>
          <p className="mt-0.5">Available in this session until {inspection.expiresAt}. It was read from retained page content without reopening the page.</p>
        </section>
        {inspection.operation === "find" ? <section aria-label="page text matches" className="space-y-2 text-xs">
          <p>{inspection.totalMatches} match{inspection.totalMatches === 1 ? "" : "es"}; {inspection.returnedMatches} shown{inspection.matchesOmitted ? `; ${inspection.matchesOmitted} not shown` : ""} · {inspection.caseSensitive ? "case-sensitive" : "case-insensitive"}.</p>
          {inspection.matches.map((match, index) => <pre key={`${match.offsetCharacters}-${index}`} className="whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 text-xs" data-testid="browser-read-page-find-preview">
            Offset {match.offsetCharacters} · {match.matchCharacters} chars{match.truncatedBlock ? " · partial block" : ""}\n{match.preview}
          </pre>)}
        </section> : <section aria-label="expanded page context">
          <p className="mb-1 text-xs text-foreground-muted">Offsets {inspection.startOffsetCharacters} → {inspection.endOffsetCharacters} around {inspection.offsetCharacters}{inspection.truncatedBlock ? " · partial block" : ""}.</p>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 text-xs" data-testid="browser-read-page-range-content">{inspection.content}</pre>
        </section>}
      </div>
    );
  }

  if (!page) {
    return (
      <div className="border-t border-border px-3 py-2" data-testid="browser-read-page-raw">
        {resultText ? (
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted">
            {redactOpaquePageReferences(resultText)}
          </pre>
        ) : null}
        {state === "error" && event?.error ? (
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-tool-error">{event.error}</pre>
        ) : null}
      </div>
    );
  }

  const isLimited = page.quality !== "complete" || page.failure !== "none" || page.truncated || resultTruncated;
  const extractionDetails = [
    page.extraction.method,
    `root: ${page.extraction.root}`,
    ...(page.extraction.iframeCount > 0 ? [`${page.extraction.iframeCount} iframe${page.extraction.iframeCount === 1 ? "" : "s"}`] : []),
  ];
  const timingDetails = [
    `readiness: ${page.timing.readiness}`,
    ...(page.timing.extractionMs !== undefined ? [`extracted in ${page.timing.extractionMs}ms`] : []),
    ...(page.timing.elapsedMs !== undefined ? [`completed in ${page.timing.elapsedMs}ms`] : []),
  ];

  return (
    <div className="border-t border-border px-3 py-2 space-y-3" data-testid="browser-read-page-renderer">
      <section aria-label="page identity" className="space-y-1">
        <h3 className="text-xs font-medium text-foreground">{page.title || "Untitled page"}</h3>
        <div className="break-all font-mono text-[0.65rem] text-foreground-muted" data-testid="browser-read-page-final-url">
          {page.finalUrl || "Final URL unavailable"}
        </div>
      </section>

      <section aria-label="page read status" className="rounded border border-border bg-background px-2 py-1.5 text-xs">
        <div className={isLimited ? "font-medium text-[var(--warning,#b58900)]" : "font-medium text-tool-success"}>
          {page.quality}
        </div>
        <p className="mt-0.5 text-foreground-muted">{qualityDescription(page.quality)}</p>
        {page.failure !== "none" ? <p className="mt-1 text-foreground-muted">Failure: {page.failure}</p> : null}
        {page.challenge.detected ? (
          <p className="mt-1 text-foreground-muted">
            Challenge detection is heuristic{page.challenge.signals.length ? `: ${page.challenge.signals.join(", ")}` : "."}
          </p>
        ) : null}
      </section>

      <section aria-label="extraction details" className="space-y-0.5 text-[0.65rem] text-foreground-muted">
        <p>{extractionDetails.join(" · ")}</p>
        <p>{timingDetails.join(" · ")}</p>
      </section>

      <section aria-label="content limits" className="text-[0.65rem] text-foreground-muted">
        <p>
          {formatCharacters(page.returnedCharacters)} returned of {formatCharacters(page.totalCharacters)} characters
          {page.totalCharactersCapped ? " (total count capped)" : ""}; {formatCharacters(page.remainingCharacters)} remaining.
        </p>
        <p className="mt-0.5">
          Offset {formatCharacters(page.offsetCharacters)} → {formatCharacters(page.nextOffsetCharacters)} ·
          {page.eof ? " EOF" : " more available"} · {formatCharacters(page.totalBytes)} UTF-8 bytes ·
          ~{formatCharacters(page.estimatedTokens)} tokens (estimate).
        </p>
        {page.continuation ? (
          <p className="mt-0.5 text-tool-success" data-testid="browser-read-page-continuation">
            Continuation available until {page.continuation.expiresAt}.
          </p>
        ) : null}
        {page.pageReference ? (
          <p className="mt-0.5 text-tool-success" data-testid="browser-read-page-page-reference">
            Temporary page context available until {page.pageReference.expiresAt}.
          </p>
        ) : null}
        {page.evictedPageReferences?.length ? (
          <p className="mt-0.5 text-[var(--warning,#b58900)]">
            Temporary context was replaced for {page.evictedPageReferences.map((entry) => entry.title || entry.finalUrl).join(", ")}. Re-read it if needed.
          </p>
        ) : null}
        {(page.truncated || resultTruncated) ? (
          <p className="mt-0.5 text-[var(--warning,#b58900)]">
            {page.truncated ? "Page content was truncated." : ""}
            {page.truncated && resultTruncated ? " " : ""}
            {page.eventProjection?.contentTruncated
              ? "ToolCard preview clipped; Genie received the full chunk."
              : resultTruncated ? "Tool result was truncated in transit." : ""}
            {page.contextClamped ? " Fixed response ceiling reached." : ""}
          </p>
        ) : null}
      </section>

      {page.content ? (
        <section aria-label="rendered page text">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Rendered page text (untrusted)
          </div>
          <pre
            className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground"
            data-testid="browser-read-page-content"
          >
            {page.content}
          </pre>
        </section>
      ) : null}

      {page.diagnostics.length > 0 ? (
        <section aria-label="stable diagnostics">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Diagnostics
          </div>
          <p className="font-mono text-[0.65rem] text-foreground-muted">{page.diagnostics.join(" · ")}</p>
        </section>
      ) : null}
    </div>
  );
}

export const browserReadPageRenderer: ToolRenderer = {
  collapsedSummary: ({ resultText }) => formatBrowserPageReadSummary(resultText),
  collapsedExtras: ({ resultText }) => formatBrowserPageReadExtras(resultText),
  ExpandedBody: BrowserReadPageExpanded,
};
