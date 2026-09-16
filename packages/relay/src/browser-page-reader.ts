/** D504 Wave 1 — target-agnostic, fixed rendered-page reader contract. */

import { browserArgvPrefix } from "./browser";

export const BROWSER_PAGE_READ_DEFAULT_MAX_CHARS = 24_000;
/** Fixed response ceiling. The agent may explicitly request this much, never more. */
export const BROWSER_PAGE_READ_MAX_CHARS = 256_000;
/** Content cap enforced inside the fixed browser program, before CLI output. */
export const BROWSER_PAGE_READ_PROGRAM_MAX_CHARS = 24_000;
export const BROWSER_PAGE_READ_MAX_TITLE_CHARS = 512;
export const BROWSER_PAGE_READ_MAX_URL_CHARS = 2_048;
export const BROWSER_PAGE_READ_MAX_DIAGNOSTICS = 8;
export const BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS = 96;
export const BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK = 2;
export const BROWSER_PAGE_READ_PROGRAM_MAX_BLOCK_TEXT_CHARS = 4_096;
/** D504 1.5 — fixed limits for immutable snapshot inspection. */
export const BROWSER_PAGE_SNAPSHOT_FIND_MAX_QUERY_CHARS = 1_024;
export const BROWSER_PAGE_SNAPSHOT_FIND_DEFAULT_MAX_MATCHES = 8;
export const BROWSER_PAGE_SNAPSHOT_FIND_MAX_MATCHES = 16;
export const BROWSER_PAGE_SNAPSHOT_FIND_DEFAULT_PREVIEW_CHARACTERS = 240;
export const BROWSER_PAGE_SNAPSHOT_FIND_MAX_PREVIEW_CHARACTERS = 1_024;
export const BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS = 12_000;
export const BROWSER_PAGE_SNAPSHOT_RANGE_DEFAULT_BEFORE_CHARACTERS = 1_000;
export const BROWSER_PAGE_SNAPSHOT_RANGE_DEFAULT_AFTER_CHARACTERS = 2_000;
export const BROWSER_PAGE_SNAPSHOT_RANGE_MAX_BEFORE_CHARACTERS = 8_000;
export const BROWSER_PAGE_SNAPSHOT_RANGE_MAX_AFTER_CHARACTERS = 16_000;
export const BROWSER_PAGE_SNAPSHOT_RANGE_MAX_RESPONSE_CHARACTERS = 24_000;

export type BrowserPageTargetRole = "interactive" | "research";
export type BrowserPageExtractionRoot = "article" | "main" | "body" | "none";
export type BrowserPageExtractionMethod =
  | "fixed-dom-semantic-v1"
  | "mozilla-readability-turndown-v1"
  | "agent-browser-accessibility-snapshot-v1";
export type BrowserPageQuality =
  | "complete"
  | "partial"
  | "empty"
  | "noisy"
  | "visual-required"
  | "challenge"
  | "error";
export type BrowserPageFailure =
  | "none"
  | "navigation-error"
  | "timeout"
  | "evaluation-error"
  | "empty-dom"
  | "iframe-limited"
  | "virtualized"
  | "visual-required"
  | "challenge"
  | "consent-wall";
export type BrowserPageReadiness =
  "loading" | "interactive" | "complete" | "unknown";
export type BrowserPageBlockKind =
  "heading" | "paragraph" | "list-item" | "quote" | "preformatted" | "table";

export interface BrowserPageReadRequest {
  targetRole: BrowserPageTargetRole;
  requestedUrl?: string;
  maxChars?: number;
}

export type BrowserPageContinuationMode = "page" | "remainder";

export interface BrowserPageReadContinuation {
  version: 1;
  reference: string;
  nextOffsetCharacters: number;
  expiresAt: string;
}

/**
 * An opaque, Electron-memory-only handle to an extracted page. Unlike a
 * continuation it remains useful after the first chunk reaches EOF: later
 * bounded operations can inspect the immutable snapshot without reopening the
 * Browser or revisiting the URL.
 */
export interface BrowserPageReadPageReference {
  version: 1;
  reference: string;
  expiresAt: string;
}

/** Metadata for a same-owner snapshot displaced by a new retained page. */
export interface BrowserPageReadEvictedPageReference {
  version: 1;
  reference: string;
  title: string;
  finalUrl: string;
}

/** Opaque handle to an unresolved, temporary anonymous consent surface. */
export interface BrowserResearchConsentRecoveryReference {
  version: 1;
  reference: string;
  expiresAt: string;
  operations: readonly ["snapshot", "screenshot", "click_control", "click_coordinates", "wait", "read", "abandon"];
}

export interface BrowserPageSnapshotFindRequest {
  readonly version: 1;
  readonly operation: "find";
  readonly reference: string;
  readonly query: string;
  readonly caseSensitive?: boolean | undefined;
  readonly maxMatches?: number | undefined;
  readonly previewCharacters?: number | undefined;
}

export interface BrowserPageSnapshotRangeRequest {
  readonly version: 1;
  readonly operation: "range";
  readonly reference: string;
  /** An exact JavaScript character offset in the immutable Markdown snapshot. */
  readonly offsetCharacters: number;
  readonly beforeCharacters?: number | undefined;
  readonly afterCharacters?: number | undefined;
}

export type BrowserPageSnapshotInspectionRequest =
  | BrowserPageSnapshotFindRequest
  | BrowserPageSnapshotRangeRequest;

export interface BrowserPageSnapshotFindMatch {
  readonly offsetCharacters: number;
  readonly matchCharacters: number;
  readonly previewOffsetCharacters: number;
  readonly preview: string;
  readonly startsMidBlock: boolean;
  readonly endsMidBlock: boolean;
  readonly truncatedBlock: boolean;
}

export interface BrowserPageSnapshotFindResult {
  readonly version: 1;
  readonly operation: "find";
  readonly reference: string;
  readonly expiresAt: string;
  readonly caseSensitive: boolean;
  readonly totalMatches: number;
  readonly returnedMatches: number;
  /** Exact non-negative count withheld by response bounds. */
  readonly matchesOmitted: number;
  readonly matches: readonly BrowserPageSnapshotFindMatch[];
}

export interface BrowserPageSnapshotRangeResult {
  readonly version: 1;
  readonly operation: "range";
  readonly reference: string;
  readonly expiresAt: string;
  readonly offsetCharacters: number;
  readonly startOffsetCharacters: number;
  readonly endOffsetCharacters: number;
  readonly content: string;
  readonly startsMidBlock: boolean;
  readonly endsMidBlock: boolean;
  readonly truncatedBlock: boolean;
}

export type BrowserPageSnapshotInspectionResult =
  | BrowserPageSnapshotFindResult
  | BrowserPageSnapshotRangeResult;

export type BrowserPageSnapshotInspectionRequestParseResult =
  | { readonly ok: true; readonly request: BrowserPageSnapshotInspectionRequest }
  | { readonly ok: false };

export interface BrowserPageLink {
  text: string;
  href: string;
}

export interface BrowserPageReadableBlock {
  kind: BrowserPageBlockKind;
  text: string;
  links?: BrowserPageLink[];
}

export interface BrowserPageReadResult {
  targetRole: BrowserPageTargetRole;
  requestedUrl?: string;
  finalUrl: string;
  title: string;
  content: string;
  blocks: BrowserPageReadableBlock[];
  /** Pre-program-cap structured-readable character total; lower-bound only if capped. */
  totalCharacters: number;
  totalCharactersCapped: boolean;
  /** Exact UTF-8 byte count when `totalCharactersCapped` is false. */
  totalBytes: number;
  /** Deterministic character-based estimate, not a model tokenizer count. */
  estimatedTokens: number;
  offsetCharacters: number;
  nextOffsetCharacters: number;
  returnedCharacters: number;
  remainingCharacters: number;
  eof: boolean;
  truncated: boolean;
  /** A requested whole/remainder response hit the fixed response ceiling. */
  contextClamped: boolean;
  continuation?: BrowserPageReadContinuation | undefined;
  /** Present only when the exact Desktop relay negotiated snapshot support. */
  pageReference?: BrowserPageReadPageReference | undefined;
  /** Same-owner snapshot handles displaced while retaining this page. */
  evictedPageReferences?: BrowserPageReadEvictedPageReference[] | undefined;
  /** Present only for a retained research consent wall on a capable Desktop. */
  consentRecovery?: BrowserResearchConsentRecoveryReference | undefined;
  extraction: {
    method: BrowserPageExtractionMethod;
    root: BrowserPageExtractionRoot;
    iframeCount: number;
  };
  timing: {
    readiness: BrowserPageReadiness;
    extractionMs?: number;
    elapsedMs?: number;
  };
  quality: BrowserPageQuality;
  challenge: {
    detected: boolean;
    confidence: "none" | "heuristic";
    signals: string[];
  };
  failure: BrowserPageFailure;
  /** Stable codes only: never raw console, CDP, cookie, path, or parser data. */
  diagnostics: string[];
}

interface BrowserPageReadProgramBlock {
  kind: BrowserPageBlockKind;
  text: string;
  links?: BrowserPageLink[];
}

/** The untrusted, one-level object returned by fixed `agent-browser eval`. */
export interface BrowserPageReadProgramOutput {
  finalUrl?: unknown;
  title?: unknown;
  readiness?: unknown;
  extractionMs?: unknown;
  root?: unknown;
  blocks?: unknown;
  totalCharacters?: unknown;
  totalCharactersCapped?: unknown;
  metadataTruncated?: unknown;
  iframeCount?: unknown;
  canvasCount?: unknown;
  virtualizedHint?: unknown;
  boilerplateHint?: unknown;
  challengeSignals?: unknown;
  sourceTruncated?: unknown;
}

export type BrowserPageReadEvalOutputParseResult =
  | { ok: true; programOutput: BrowserPageReadProgramOutput }
  | {
      ok: false;
      failure: "evaluation-error";
      diagnostic: "evaluation-output-malformed";
    };

export interface BrowserPageReadNormalizationOptions {
  elapsedMs?: number;
  /** A bounded readiness retry could not produce a newer parsed page result. */
  readinessRetryIncomplete?: boolean;
  transportFailure?: Extract<
    BrowserPageFailure,
    "navigation-error" | "timeout" | "evaluation-error"
  >;
}

/**
 * Semantic content captured by Electron from the exact target session.  This
 * intentionally has no block or program cap: the old fixed evaluator is now
 * metadata/readiness/challenge evidence only, not the article source.
 */
export interface BrowserPageReadExtractedContent {
  content: string;
  method: Exclude<BrowserPageExtractionMethod, "fixed-dom-semantic-v1">;
  root: Extract<BrowserPageExtractionRoot, "article" | "none">;
  diagnostics: readonly string[];
}

const BLOCK_KINDS = new Set<BrowserPageBlockKind>([
  "heading",
  "paragraph",
  "list-item",
  "quote",
  "preformatted",
  "table",
]);
const CHALLENGE_SIGNALS = new Set([
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cloudflare",
  "verify-human",
]);
const SENSITIVE_QUERY_PARAMETERS = new Set([
  "token",
  "access_token",
  "auth",
  "key",
  "api_key",
  "password",
  "signature",
  "sig",
  "code",
]);

function asFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

function clipText(
  value: string,
  max: number,
): { value: string; truncated: boolean } {
  return value.length > max
    ? { value: value.slice(0, max), truncated: true }
    : { value, truncated: false };
}

function normalizedText(
  value: unknown,
  max: number,
): { value: string; truncated: boolean } {
  return typeof value === "string"
    ? clipText(normalizeWhitespace(value), max)
    : { value: "", truncated: false };
}

function redactedHttpUrl(
  value: unknown,
  oversized: "page" | "link" = "page",
): { value: string; truncated: boolean } {
  if (typeof value !== "string") return { value: "", truncated: false };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { value: "", truncated: false };
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMETERS.has(key.toLowerCase()))
        parsed.searchParams.delete(key);
    }
    const serialized = parsed.toString();
    // A partial URL could misrepresent the destination. Page URLs retain only
    // their origin; oversized link metadata is omitted altogether.
    return serialized.length > BROWSER_PAGE_READ_MAX_URL_CHARS
      ? {
          value: oversized === "page" ? `${parsed.origin}/` : "",
          truncated: true,
        }
      : { value: serialized, truncated: false };
  } catch {
    return { value: "", truncated: false };
  }
}

function clampRequestedMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined) return BROWSER_PAGE_READ_DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("browser page read maxChars must be a positive integer");
  }
  return Math.min(maxChars, BROWSER_PAGE_READ_MAX_CHARS);
}

function pushDiagnostic(diagnostics: string[], diagnostic: string): void {
  if (diagnostics.length < BROWSER_PAGE_READ_MAX_DIAGNOSTICS)
    diagnostics.push(diagnostic);
}

function parseBlocks(value: unknown): BrowserPageReadProgramBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: BrowserPageReadProgramBlock[] = [];
  for (const candidate of value.slice(
    0,
    BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS,
  )) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const kind = record["kind"];
    const text = normalizedText(
      record["text"],
      BROWSER_PAGE_READ_PROGRAM_MAX_BLOCK_TEXT_CHARS,
    ).value;
    if (
      typeof kind !== "string" ||
      !BLOCK_KINDS.has(kind as BrowserPageBlockKind) ||
      !text
    )
      continue;
    const links = Array.isArray(record["links"])
      ? record["links"]
          .slice(0, BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK)
          .flatMap((link): BrowserPageLink[] => {
            if (!link || typeof link !== "object") return [];
            const item = link as Record<string, unknown>;
            const linkText = normalizedText(item["text"], 80).value;
            const href = redactedHttpUrl(item["href"], "link").value;
            return linkText && href ? [{ text: linkText, href }] : [];
          })
      : [];
    blocks.push({
      kind: kind as BrowserPageBlockKind,
      text,
      ...(links.length ? { links } : {}),
    });
  }
  return blocks;
}

function formatBlock(block: BrowserPageReadProgramBlock): string {
  const links =
    block.links?.map((link) => ` [${link.text}](${link.href})`).join("") ?? "";
  return `${block.text}${links}`;
}

function contentFromBlocks(blocks: BrowserPageReadProgramBlock[]): string {
  return blocks.map(formatBlock).join("\n\n");
}

function truncateBlocks(
  blocks: BrowserPageReadProgramBlock[],
  maxChars: number,
): { blocks: BrowserPageReadableBlock[]; content: string; truncated: boolean } {
  let remaining = maxChars;
  const returned: BrowserPageReadableBlock[] = [];
  for (const block of blocks) {
    const separator = returned.length ? 2 : 0;
    if (remaining <= separator) break;
    const formatted = formatBlock(block);
    if (formatted.length <= remaining - separator) {
      returned.push(block);
      remaining -= separator + formatted.length;
      continue;
    }
    const text = block.text.slice(0, remaining - separator).trimEnd();
    if (text) returned.push({ kind: block.kind, text });
    break;
  }
  const content = contentFromBlocks(returned);
  return {
    blocks: returned,
    content,
    truncated: contentFromBlocks(blocks).length > content.length,
  };
}

function hasProgramOutputShape(
  value: unknown,
): value is BrowserPageReadProgramOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output["finalUrl"] === "string" &&
    typeof output["title"] === "string" &&
    typeof output["readiness"] === "string" &&
    typeof output["extractionMs"] === "number" &&
    typeof output["root"] === "string" &&
    Array.isArray(output["blocks"]) &&
    typeof output["totalCharacters"] === "number" &&
    typeof output["totalCharactersCapped"] === "boolean" &&
    typeof output["metadataTruncated"] === "boolean" &&
    typeof output["iframeCount"] === "number" &&
    typeof output["canvasCount"] === "number" &&
    typeof output["virtualizedHint"] === "boolean" &&
    typeof output["boilerplateHint"] === "boolean" &&
    Array.isArray(output["challengeSignals"]) &&
    typeof output["sourceTruncated"] === "boolean"
  );
}

/**
 * Parses exactly one v0.31.1 pretty-JSON eval result. A JSON string (including
 * a second JSON layer from `JSON.stringify`) is intentionally rejected.
 */
export function parseAgentBrowserPageReadEvalOutput(
  stdout: string,
): BrowserPageReadEvalOutputParseResult {
  try {
    const value: unknown = JSON.parse(stdout);
    return hasProgramOutputShape(value)
      ? { ok: true, programOutput: value }
      : {
          ok: false,
          failure: "evaluation-error",
          diagnostic: "evaluation-output-malformed",
        };
  } catch {
    return {
      ok: false,
      failure: "evaluation-error",
      diagnostic: "evaluation-output-malformed",
    };
  }
}

function transportFailureResult(
  request: BrowserPageReadRequest,
  failure: Extract<
    BrowserPageFailure,
    "navigation-error" | "timeout" | "evaluation-error"
  >,
  elapsedMs: number | undefined,
): BrowserPageReadResult {
  const requestedUrl = request.requestedUrl
    ? redactedHttpUrl(request.requestedUrl)
    : undefined;
  const timing: BrowserPageReadResult["timing"] = { readiness: "unknown" };
  if (elapsedMs !== undefined) timing.elapsedMs = elapsedMs;
  return {
    targetRole: request.targetRole,
    ...(requestedUrl?.value ? { requestedUrl: requestedUrl.value } : {}),
    finalUrl: "",
    title: "",
    content: "",
    blocks: [],
    totalCharacters: 0,
    totalCharactersCapped: false,
    totalBytes: 0,
    estimatedTokens: 0,
    offsetCharacters: 0,
    nextOffsetCharacters: 0,
    returnedCharacters: 0,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: {
      method: "fixed-dom-semantic-v1",
      root: "none",
      iframeCount: 0,
    },
    timing,
    quality: "error",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure,
    diagnostics: [failure],
  };
}

/** Converts fixed-program output into the stable, redacted page-read contract. */
export function normalizeBrowserPageReadResult(
  request: BrowserPageReadRequest,
  programOutput: BrowserPageReadProgramOutput,
  options: BrowserPageReadNormalizationOptions = {},
): BrowserPageReadResult {
  const elapsedMs = asFiniteNonNegativeNumber(options.elapsedMs);
  if (options.transportFailure)
    return transportFailureResult(request, options.transportFailure, elapsedMs);

  const maxChars = clampRequestedMaxChars(request.maxChars);
  const blocks = parseBlocks(programOutput.blocks);
  const allContent = contentFromBlocks(blocks);
  const limited = truncateBlocks(blocks, maxChars);
  const title = normalizedText(
    programOutput.title,
    BROWSER_PAGE_READ_MAX_TITLE_CHARS,
  );
  const requestedUrl = request.requestedUrl
    ? redactedHttpUrl(request.requestedUrl)
    : undefined;
  const finalUrl = redactedHttpUrl(programOutput.finalUrl);
  const diagnostics: string[] = [];
  if (title.truncated) pushDiagnostic(diagnostics, "title-truncated");
  if (requestedUrl?.truncated)
    pushDiagnostic(diagnostics, "requested-url-truncated");
  if (finalUrl.truncated) pushDiagnostic(diagnostics, "final-url-truncated");

  const challengeSignals = Array.isArray(programOutput.challengeSignals)
    ? [
        ...new Set(
          programOutput.challengeSignals.filter(
            (signal): signal is string =>
              typeof signal === "string" && CHALLENGE_SIGNALS.has(signal),
          ),
        ),
      ].slice(0, CHALLENGE_SIGNALS.size)
    : [];
  const iframeCount = Math.floor(
    asFiniteNonNegativeNumber(programOutput.iframeCount) ?? 0,
  );
  const canvasCount = Math.floor(
    asFiniteNonNegativeNumber(programOutput.canvasCount) ?? 0,
  );
  const virtualized = programOutput.virtualizedHint === true;
  const sourceTruncated = programOutput.sourceTruncated === true;
  const totalCharactersCapped = programOutput.totalCharactersCapped === true;
  const metadataTruncated = programOutput.metadataTruncated === true;
  const reportedTotal = Math.floor(
    asFiniteNonNegativeNumber(programOutput.totalCharacters) ?? 0,
  );
  const totalCharacters = Math.max(allContent.length, reportedTotal);
  const root: BrowserPageExtractionRoot =
    programOutput.root === "article" ||
    programOutput.root === "main" ||
    programOutput.root === "body"
      ? programOutput.root
      : "none";
  const challengeDetected = challengeSignals.length > 0;
  let quality: BrowserPageQuality = "complete";
  let failure: BrowserPageFailure = "none";

  if (challengeDetected) {
    quality = "challenge";
    failure = "challenge";
    pushDiagnostic(diagnostics, "challenge-heuristic");
  } else if (!allContent) {
    if (canvasCount > 0) {
      quality = "visual-required";
      failure = "visual-required";
      pushDiagnostic(diagnostics, "canvas-text-unavailable");
      if (virtualized)
        pushDiagnostic(diagnostics, "virtualized-content-may-be-partial");
      if (iframeCount > 0)
        pushDiagnostic(diagnostics, "iframe-content-not-read");
    } else if (virtualized) {
      quality = "partial";
      failure = "virtualized";
      pushDiagnostic(diagnostics, "virtualized-content-may-be-partial");
      if (iframeCount > 0)
        pushDiagnostic(diagnostics, "iframe-content-not-read");
    } else if (iframeCount > 0) {
      quality = "partial";
      failure = "iframe-limited";
      pushDiagnostic(diagnostics, "iframe-content-not-read");
    } else {
      quality = "empty";
      failure = "empty-dom";
      pushDiagnostic(diagnostics, "no-readable-dom-content");
    }
  } else if (virtualized) {
    quality = "partial";
    failure = "virtualized";
    pushDiagnostic(diagnostics, "virtualized-content-may-be-partial");
    if (iframeCount > 0) pushDiagnostic(diagnostics, "iframe-content-not-read");
    if (canvasCount > 0)
      pushDiagnostic(diagnostics, "canvas-content-not-textually-extracted");
  } else if (iframeCount > 0) {
    quality = "partial";
    failure = "iframe-limited";
    pushDiagnostic(diagnostics, "iframe-content-not-read");
    if (canvasCount > 0)
      pushDiagnostic(diagnostics, "canvas-content-not-textually-extracted");
  } else if (canvasCount > 0) {
    quality = "partial";
    pushDiagnostic(diagnostics, "canvas-content-not-textually-extracted");
  } else if (programOutput.boilerplateHint === true) {
    quality = "noisy";
    pushDiagnostic(diagnostics, "boilerplate-heavy-page");
  }

  if (
    quality === "complete" &&
    (sourceTruncated ||
      totalCharactersCapped ||
      limited.truncated ||
      totalCharacters > limited.content.length)
  ) {
    quality = "partial";
  }

  // `document.readyState === "loading"` is a truthful limitation even when
  // the current DOM has useful text. Keep stronger challenge/visual/error
  // classifications intact, but never present an in-flight document as a
  // complete or terminally empty page.
  const documentStillLoading = programOutput.readiness === "loading";
  const hasStrongerClassification =
    quality === "challenge" || quality === "visual-required";
  if (documentStillLoading && !hasStrongerClassification) {
    quality = "partial";
    pushDiagnostic(diagnostics, "document-still-loading");
  }
  if (options.readinessRetryIncomplete && !hasStrongerClassification) {
    quality = "partial";
    pushDiagnostic(diagnostics, "readiness-retry-incomplete");
  }

  if (sourceTruncated) pushDiagnostic(diagnostics, "program-output-capped");
  if (totalCharactersCapped)
    pushDiagnostic(diagnostics, "total-character-count-capped");
  if (metadataTruncated) pushDiagnostic(diagnostics, "metadata-truncated");
  if (limited.truncated)
    pushDiagnostic(diagnostics, "returned-content-truncated");

  const timing: BrowserPageReadResult["timing"] = {
    readiness:
      programOutput.readiness === "loading" ||
      programOutput.readiness === "interactive" ||
      programOutput.readiness === "complete"
        ? programOutput.readiness
        : "unknown",
  };
  const extractionMs = asFiniteNonNegativeNumber(programOutput.extractionMs);
  if (extractionMs !== undefined) timing.extractionMs = extractionMs;
  if (elapsedMs !== undefined) timing.elapsedMs = elapsedMs;

  return {
    targetRole: request.targetRole,
    ...(requestedUrl?.value ? { requestedUrl: requestedUrl.value } : {}),
    finalUrl: finalUrl.value,
    title: title.value,
    content: limited.content,
    blocks: limited.blocks,
    totalCharacters,
    totalCharactersCapped,
    totalBytes: Buffer.byteLength(
      totalCharactersCapped ? limited.content : allContent,
      "utf8",
    ),
    estimatedTokens: estimateBrowserPageTokens(
      totalCharactersCapped ? limited.content : allContent,
    ),
    offsetCharacters: 0,
    nextOffsetCharacters: limited.content.length,
    returnedCharacters: limited.content.length,
    remainingCharacters: Math.max(0, totalCharacters - limited.content.length),
    eof: !(
      sourceTruncated ||
      totalCharactersCapped ||
      limited.truncated ||
      totalCharacters > limited.content.length
    ),
    truncated:
      sourceTruncated ||
      totalCharactersCapped ||
      limited.truncated ||
      totalCharacters > limited.content.length,
    contextClamped:
      limited.truncated && maxChars >= BROWSER_PAGE_READ_MAX_CHARS,
    extraction: { method: "fixed-dom-semantic-v1", root, iframeCount },
    timing,
    quality,
    challenge: {
      detected: challengeDetected,
      confidence: challengeDetected ? "heuristic" : "none",
      signals: challengeSignals,
    },
    failure,
    diagnostics,
  };
}

function normalizeMarkdownContent(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A clear, stable estimate only; tokenizers differ by model and must not be inferred here. */
export function estimateBrowserPageTokens(content: string): number {
  return content.length === 0 ? 0 : Math.ceil(content.length / 4);
}

function safeCharacterBoundary(content: string, offset: number): number {
  if (offset <= 0 || offset >= content.length) return offset;
  const before = content.charCodeAt(offset - 1);
  const after = content.charCodeAt(offset);
  return before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
    ? offset - 1
    : offset;
}

/**
 * Prefer blank-line Markdown block boundaries outside fenced code.  If one
 * semantic block itself exceeds the requested response budget, use a truthful
 * intra-block character split; contiguous offsets always reconstruct exactly.
 */
function structuralChunkEnd(
  content: string,
  offset: number,
  requestedEnd: number,
): number {
  if (requestedEnd >= content.length) return content.length;
  let cursor = 0;
  let inFence: "`" | "~" | null = null;
  let best = -1;
  while (cursor < content.length && cursor < requestedEnd) {
    const lineEndIndex = content.indexOf("\n", cursor);
    const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex + 1;
    const line = content.slice(
      cursor,
      lineEndIndex < 0 ? content.length : lineEndIndex,
    );
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const marker = fence[0] as "`" | "~";
      if (inFence === null) inFence = marker;
      else if (inFence === marker) inFence = null;
    }
    if (
      inFence === null &&
      /^\s*$/.test(line) &&
      lineEnd > offset &&
      lineEnd <= requestedEnd
    ) {
      best = lineEnd;
    }
    cursor = lineEnd;
  }
  return safeCharacterBoundary(content, best > offset ? best : requestedEnd);
}

export function chunkBrowserPageReadResult(
  page: BrowserPageReadResult,
  input: {
    readonly offsetCharacters: number;
    readonly maxChars?: number;
    readonly mode: BrowserPageContinuationMode;
    readonly continuation?: BrowserPageReadContinuation | undefined;
  },
): BrowserPageReadResult {
  const totalCharacters = page.content.length;
  if (
    !Number.isSafeInteger(input.offsetCharacters) ||
    input.offsetCharacters < 0 ||
    input.offsetCharacters > totalCharacters
  ) {
    throw new RangeError(
      "browser page chunk offset is outside the retained page",
    );
  }
  const offsetCharacters = input.offsetCharacters;
  const requested =
    input.mode === "remainder"
      ? BROWSER_PAGE_READ_MAX_CHARS
      : clampRequestedMaxChars(input.maxChars);
  const requestedEnd = Math.min(totalCharacters, offsetCharacters + requested);
  const nextOffsetCharacters = structuralChunkEnd(
    page.content,
    offsetCharacters,
    requestedEnd,
  );
  const content = page.content.slice(offsetCharacters, nextOffsetCharacters);
  const eof = nextOffsetCharacters >= totalCharacters;
  const truncated = !eof;
  const contextClamped =
    !eof &&
    (input.mode === "remainder" || requested >= BROWSER_PAGE_READ_MAX_CHARS);
  const diagnostics = [...page.diagnostics];
  if (truncated && !diagnostics.includes("returned-content-truncated")) {
    pushDiagnostic(diagnostics, "returned-content-truncated");
  }
  if (contextClamped && !diagnostics.includes("response-context-clamped")) {
    pushDiagnostic(diagnostics, "response-context-clamped");
  }
  const quality =
    truncated && (page.quality === "complete" || page.quality === "noisy")
      ? "partial"
      : page.quality;
  return {
    ...page,
    content,
    blocks: offsetCharacters === 0 && eof ? page.blocks : [],
    totalCharacters,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(page.content, "utf8"),
    estimatedTokens: estimateBrowserPageTokens(page.content),
    offsetCharacters,
    nextOffsetCharacters,
    returnedCharacters: content.length,
    remainingCharacters: totalCharacters - nextOffsetCharacters,
    eof,
    truncated,
    contextClamped,
    ...(truncated && input.continuation !== undefined
      ? { continuation: { ...input.continuation, nextOffsetCharacters } }
      : {}),
    quality,
    diagnostics,
  };
}

/**
 * Normalizes locally extracted rendered content while retaining the fixed
 * evaluator for page identity, readiness, and challenge classification.
 * Unlike the legacy evaluator normalizer, its content source is never reduced
 * to evaluator blocks before the caller's requested response bound is applied.
 */
export function normalizeBrowserPageReadExtractedResult(
  request: BrowserPageReadRequest,
  programOutput: BrowserPageReadProgramOutput,
  extracted: BrowserPageReadExtractedContent,
  options: BrowserPageReadNormalizationOptions = {},
): BrowserPageReadResult {
  const elapsedMs = asFiniteNonNegativeNumber(options.elapsedMs);
  if (options.transportFailure)
    return transportFailureResult(request, options.transportFailure, elapsedMs);

  const requestedUrl = request.requestedUrl
    ? redactedHttpUrl(request.requestedUrl)
    : undefined;
  const finalUrl = redactedHttpUrl(programOutput.finalUrl);
  const title = normalizedText(
    programOutput.title,
    BROWSER_PAGE_READ_MAX_TITLE_CHARS,
  );
  const diagnostics: string[] = [];
  if (title.truncated) pushDiagnostic(diagnostics, "title-truncated");
  if (requestedUrl?.truncated)
    pushDiagnostic(diagnostics, "requested-url-truncated");
  if (finalUrl.truncated) pushDiagnostic(diagnostics, "final-url-truncated");

  const challengeSignals = Array.isArray(programOutput.challengeSignals)
    ? [
        ...new Set(
          programOutput.challengeSignals.filter(
            (signal): signal is string =>
              typeof signal === "string" && CHALLENGE_SIGNALS.has(signal),
          ),
        ),
      ].slice(0, CHALLENGE_SIGNALS.size)
    : [];
  const challengeDetected = challengeSignals.length > 0;
  const iframeCount = Math.floor(
    asFiniteNonNegativeNumber(programOutput.iframeCount) ?? 0,
  );
  const canvasCount = Math.floor(
    asFiniteNonNegativeNumber(programOutput.canvasCount) ?? 0,
  );
  const virtualized = programOutput.virtualizedHint === true;
  const content = normalizeMarkdownContent(extracted.content);
  const readiness: BrowserPageReadiness =
    programOutput.readiness === "loading" ||
    programOutput.readiness === "interactive" ||
    programOutput.readiness === "complete"
      ? programOutput.readiness
      : "unknown";

  let quality: BrowserPageQuality = "complete";
  let failure: BrowserPageFailure = "none";
  if (challengeDetected) {
    quality = "challenge";
    failure = "challenge";
    pushDiagnostic(diagnostics, "challenge-heuristic");
  } else if (!content) {
    if (canvasCount > 0) {
      quality = "visual-required";
      failure = "visual-required";
      pushDiagnostic(diagnostics, "canvas-text-unavailable");
    } else if (virtualized) {
      quality = "partial";
      failure = "virtualized";
      pushDiagnostic(diagnostics, "virtualized-content-may-be-partial");
    } else if (iframeCount > 0) {
      quality = "partial";
      failure = "iframe-limited";
      pushDiagnostic(diagnostics, "iframe-content-not-read");
    } else {
      quality = "empty";
      failure = "empty-dom";
      pushDiagnostic(diagnostics, "no-readable-dom-content");
    }
  } else if (extracted.method === "agent-browser-accessibility-snapshot-v1") {
    quality = "partial";
    pushDiagnostic(diagnostics, "accessibility-content-may-be-partial");
  } else if (virtualized) {
    quality = "partial";
    failure = "virtualized";
    pushDiagnostic(diagnostics, "virtualized-content-may-be-partial");
  } else if (iframeCount > 0) {
    quality = "partial";
    failure = "iframe-limited";
    pushDiagnostic(diagnostics, "iframe-content-not-read");
  } else if (canvasCount > 0) {
    quality = "partial";
    pushDiagnostic(diagnostics, "canvas-content-not-textually-extracted");
  } else if (programOutput.boilerplateHint === true) {
    quality = "noisy";
    pushDiagnostic(diagnostics, "boilerplate-heavy-page");
  }

  if (
    readiness === "loading" &&
    quality !== "challenge" &&
    quality !== "visual-required"
  ) {
    quality = "partial";
    pushDiagnostic(diagnostics, "document-still-loading");
  }
  if (
    options.readinessRetryIncomplete &&
    quality !== "challenge" &&
    quality !== "visual-required"
  ) {
    quality = "partial";
    pushDiagnostic(diagnostics, "readiness-retry-incomplete");
  }
  for (const diagnostic of extracted.diagnostics) {
    if (/^[a-z0-9-]{1,64}$/.test(diagnostic))
      pushDiagnostic(diagnostics, diagnostic);
  }

  const timing: BrowserPageReadResult["timing"] = { readiness };
  const extractionMs = asFiniteNonNegativeNumber(programOutput.extractionMs);
  if (extractionMs !== undefined) timing.extractionMs = extractionMs;
  if (elapsedMs !== undefined) timing.elapsedMs = elapsedMs;

  return {
    targetRole: request.targetRole,
    ...(requestedUrl?.value ? { requestedUrl: requestedUrl.value } : {}),
    finalUrl: finalUrl.value,
    title: title.value,
    content: challengeDetected ? "" : content,
    blocks: [],
    totalCharacters: challengeDetected ? 0 : content.length,
    totalCharactersCapped: false,
    totalBytes: challengeDetected ? 0 : Buffer.byteLength(content, "utf8"),
    estimatedTokens: challengeDetected ? 0 : estimateBrowserPageTokens(content),
    offsetCharacters: 0,
    nextOffsetCharacters: challengeDetected ? 0 : content.length,
    returnedCharacters: challengeDetected ? 0 : content.length,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: { method: extracted.method, root: extracted.root, iframeCount },
    timing,
    quality,
    challenge: {
      detected: challengeDetected,
      confidence: challengeDetected ? "heuristic" : "none",
      signals: challengeSignals,
    },
    failure,
    diagnostics,
  };
}

type NormalizedSnapshotProjection = {
  readonly text: string;
  /** Each normalized UTF-16 code unit maps back to an exact Markdown span. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
};

function isMarkdownEscapable(character: string): boolean {
  return character.length === 1 && [33, 35, 40, 41, 42, 43, 45, 46, 60, 62, 91, 92, 93, 95, 96, 123, 124, 125, 126].includes(character.charCodeAt(0));
}

function appendProjectedText(
  input: string,
  sourceOffset: number,
  output: { text: string; starts: number[]; ends: number[] },
  caseSensitive: boolean,
): void {
  let index = 0;
  while (index < input.length) {
    const start = index;
    const first = input.codePointAt(index);
    if (first === undefined) break;
    let cluster = String.fromCodePoint(first);
    index += cluster.length;
    // Keep combining marks with their base before normalizing, so both the
    // composed and decomposed spelling project to the original Markdown span.
    while (index < input.length) {
      const next = input.codePointAt(index);
      if (next === undefined) break;
      const character = String.fromCodePoint(next);
      if (!/^\p{M}$/u.test(character)) break;
      cluster += character;
      index += character.length;
    }
    const end = index;
    if (cluster.length === 1 && cluster.charCodeAt(0) === 92 && index < input.length) {
      const escaped = input.codePointAt(index);
      if (escaped !== undefined) {
        const escapedCharacter = String.fromCodePoint(escaped);
        if (isMarkdownEscapable(escapedCharacter)) {
          index += escapedCharacter.length;
          const normalized = (caseSensitive ? escapedCharacter : escapedCharacter.toLowerCase()).normalize("NFKC");
          for (const normalizedCharacter of normalized) {
            for (let unit = 0; unit < normalizedCharacter.length; unit += 1) {
              output.text += normalizedCharacter[unit];
              output.starts.push(sourceOffset + start);
              output.ends.push(sourceOffset + index);
            }
          }
          continue;
        }
      }
    }
    if (/^\s$/u.test(cluster)) {
      if (!output.text.endsWith(" ")) {
        output.text += " ";
        output.starts.push(sourceOffset + start);
        output.ends.push(sourceOffset + end);
      } else {
        output.ends[output.ends.length - 1] = sourceOffset + end;
      }
      continue;
    }
    const normalized = (caseSensitive ? cluster : cluster.toLowerCase()).normalize("NFKC");
    for (const normalizedCharacter of normalized) {
      for (let unit = 0; unit < normalizedCharacter.length; unit += 1) {
        output.text += normalizedCharacter[unit];
        output.starts.push(sourceOffset + start);
        output.ends.push(sourceOffset + end);
      }
    }
  }
}

/**
 * Produces a comparison-only text projection. Markdown link destinations are
 * deliberately omitted while labels remain, and Markdown escapes compare as
 * their rendered character. Offsets always identify the original immutable
 * Markdown, never this normalized projection.
 */
export function projectBrowserPageSnapshotText(
  content: string,
  caseSensitive = false,
): NormalizedSnapshotProjection {
  const output = { text: "", starts: [] as number[], ends: [] as number[] };
  let cursor = 0;
  while (cursor < content.length) {
    const linkStart = content.indexOf("[", cursor);
    if (linkStart < 0) {
      appendProjectedText(content.slice(cursor), cursor, output, caseSensitive);
      break;
    }
    appendProjectedText(content.slice(cursor, linkStart), cursor, output, caseSensitive);
    const labelEnd = content.indexOf("](", linkStart + 1);
    if (labelEnd < 0) {
      appendProjectedText(content.slice(linkStart), linkStart, output, caseSensitive);
      break;
    }
    let destinationEnd = labelEnd + 2;
    let depth = 1;
    for (; destinationEnd < content.length; destinationEnd += 1) {
      const character = content[destinationEnd];
      if (character !== undefined && character.charCodeAt(0) === 92) {
        destinationEnd += 1;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (destinationEnd >= content.length || depth !== 0) {
      appendProjectedText(content.slice(linkStart), linkStart, output, caseSensitive);
      break;
    }
    appendProjectedText(content.slice(linkStart + 1, labelEnd), linkStart + 1, output, caseSensitive);
    cursor = destinationEnd + 1;
  }
  return output;
}

function isInsideFencedCode(content: string, offset: number): boolean {
  let openFence: { character: "`" | "~"; length: number } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const lineEnd = content.indexOf("\n", lineStart);
    const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      const character = fence[0] as "`" | "~";
      if (openFence === undefined) openFence = { character, length: fence.length };
      else if (openFence.character === character && fence.length >= openFence.length) openFence = undefined;
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return openFence !== undefined;
}

function isBlockStart(content: string, offset: number): boolean {
  return offset === 0 || (!isInsideFencedCode(content, offset) && content.slice(0, offset).endsWith("\n\n"));
}

function isBlockEnd(content: string, offset: number): boolean {
  return offset === content.length || (!isInsideFencedCode(content, offset) && content.slice(offset).startsWith("\n\n"));
}

function snapshotBounds(content: string, start: number, end: number): Pick<BrowserPageSnapshotFindMatch, "startsMidBlock" | "endsMidBlock" | "truncatedBlock"> {
  const startsMidBlock = !isBlockStart(content, start);
  const endsMidBlock = !isBlockEnd(content, end);
  return { startsMidBlock, endsMidBlock, truncatedBlock: startsMidBlock || endsMidBlock };
}

function requireSnapshotFindNumber(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new Error("browser page snapshot request is invalid");
  }
  return result;
}

function isSnapshotRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isSnapshotReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** Strict parser shared by visible and research immutable snapshot dispatches. */
export function parseBrowserPageSnapshotInspectionRequest(
  value: unknown,
): BrowserPageSnapshotInspectionRequestParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const input = value as Record<string, unknown>;
  const operation = input["operation"];
  const reference = input["reference"];
  if (operation === "find") {
    const query = input["query"];
    const caseSensitive = input["caseSensitive"];
    const maxMatches = input["maxMatches"];
    const previewCharacters = input["previewCharacters"];
    const normalizedQuery = typeof query === "string"
      ? projectBrowserPageSnapshotText(query, caseSensitive === true).text.trim()
      : "";
    if (
      !isSnapshotRecord(value, ["version", "operation", "reference", "query", "caseSensitive", "maxMatches", "previewCharacters"]) ||
      input["version"] !== 1 || !isSnapshotReference(reference) ||
      typeof query !== "string" || query.length === 0 ||
      query.length > BROWSER_PAGE_SNAPSHOT_FIND_MAX_QUERY_CHARS ||
      normalizedQuery.length === 0 || normalizedQuery.length > BROWSER_PAGE_SNAPSHOT_FIND_MAX_QUERY_CHARS ||
      (caseSensitive !== undefined && typeof caseSensitive !== "boolean") ||
      (maxMatches !== undefined && (!Number.isSafeInteger(maxMatches) || (maxMatches as number) < 1 || (maxMatches as number) > BROWSER_PAGE_SNAPSHOT_FIND_MAX_MATCHES)) ||
      (previewCharacters !== undefined && (!Number.isSafeInteger(previewCharacters) || (previewCharacters as number) < 0 || (previewCharacters as number) > BROWSER_PAGE_SNAPSHOT_FIND_MAX_PREVIEW_CHARACTERS))
    ) return { ok: false };
    return {
      ok: true,
      request: {
        version: 1,
        operation: "find",
        reference,
        query,
        ...(caseSensitive === undefined ? {} : { caseSensitive }),
        ...(maxMatches === undefined ? {} : { maxMatches: maxMatches as number }),
        ...(previewCharacters === undefined ? {} : { previewCharacters: previewCharacters as number }),
      },
    };
  }
  if (operation === "range") {
    const offsetCharacters = input["offsetCharacters"];
    const beforeCharacters = input["beforeCharacters"];
    const afterCharacters = input["afterCharacters"];
    if (
      !isSnapshotRecord(value, ["version", "operation", "reference", "offsetCharacters", "beforeCharacters", "afterCharacters"]) ||
      input["version"] !== 1 || !isSnapshotReference(reference) ||
      !Number.isSafeInteger(offsetCharacters) || (offsetCharacters as number) < 0 ||
      (beforeCharacters !== undefined && (!Number.isSafeInteger(beforeCharacters) || (beforeCharacters as number) < 0 || (beforeCharacters as number) > BROWSER_PAGE_SNAPSHOT_RANGE_MAX_BEFORE_CHARACTERS)) ||
      (afterCharacters !== undefined && (!Number.isSafeInteger(afterCharacters) || (afterCharacters as number) < 0 || (afterCharacters as number) > BROWSER_PAGE_SNAPSHOT_RANGE_MAX_AFTER_CHARACTERS))
    ) return { ok: false };
    return {
      ok: true,
      request: {
        version: 1,
        operation: "range",
        reference,
        offsetCharacters: offsetCharacters as number,
        ...(beforeCharacters === undefined ? {} : { beforeCharacters: beforeCharacters as number }),
        ...(afterCharacters === undefined ? {} : { afterCharacters: afterCharacters as number }),
      },
    };
  }
  return { ok: false };
}

/** Runs an exhaustive, literal-only scan of already retained Markdown. */
export function findBrowserPageSnapshot(
  content: string,
  request: BrowserPageSnapshotFindRequest,
  expiresAt: string,
): BrowserPageSnapshotFindResult {
  if (request.query.length === 0 || request.query.length > BROWSER_PAGE_SNAPSHOT_FIND_MAX_QUERY_CHARS) {
    throw new Error("browser page snapshot query is invalid");
  }
  const caseSensitive = request.caseSensitive === true;
  const query = projectBrowserPageSnapshotText(request.query, caseSensitive).text.trim();
  if (query.length === 0 || query.length > BROWSER_PAGE_SNAPSHOT_FIND_MAX_QUERY_CHARS) {
    throw new Error("browser page snapshot query is invalid");
  }
  const maxMatches = requireSnapshotFindNumber(
    request.maxMatches,
    BROWSER_PAGE_SNAPSHOT_FIND_DEFAULT_MAX_MATCHES,
    BROWSER_PAGE_SNAPSHOT_FIND_MAX_MATCHES,
  );
  if (maxMatches < 1) throw new Error("browser page snapshot request is invalid");
  const previewCharacters = requireSnapshotFindNumber(
    request.previewCharacters,
    BROWSER_PAGE_SNAPSHOT_FIND_DEFAULT_PREVIEW_CHARACTERS,
    BROWSER_PAGE_SNAPSHOT_FIND_MAX_PREVIEW_CHARACTERS,
  );
  const projection = projectBrowserPageSnapshotText(content, caseSensitive);
  const matches: BrowserPageSnapshotFindMatch[] = [];
  let totalMatches = 0;
  let cursor = 0;
  const resultWith = (nextMatches: readonly BrowserPageSnapshotFindMatch[]): BrowserPageSnapshotFindResult => ({
    version: 1,
    operation: "find",
    reference: request.reference,
    expiresAt,
    caseSensitive,
    totalMatches,
    returnedMatches: nextMatches.length,
    matchesOmitted: totalMatches - nextMatches.length,
    matches: nextMatches,
  });
  while (cursor <= projection.text.length - query.length) {
    const normalizedOffset = projection.text.indexOf(query, cursor);
    if (normalizedOffset < 0) break;
    totalMatches += 1;
    const normalizedEnd = normalizedOffset + query.length;
    const offsetCharacters = projection.starts[normalizedOffset]!;
    const matchEnd = projection.ends[normalizedEnd - 1]!;
    const previewStart = Math.max(0, offsetCharacters - previewCharacters);
    const previewEnd = Math.min(content.length, matchEnd + previewCharacters);
    const preview = content.slice(previewStart, previewEnd);
    const candidate: BrowserPageSnapshotFindMatch = {
        offsetCharacters,
        matchCharacters: matchEnd - offsetCharacters,
        previewOffsetCharacters: previewStart,
        preview,
        ...snapshotBounds(content, previewStart, previewEnd),
    };
    if (
      matches.length < maxMatches &&
      Buffer.byteLength(JSON.stringify(resultWith([...matches, candidate])), "utf8") <=
        BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS
    ) {
      matches.push(candidate);
    }
    // Literal results are non-overlapping, just like ordinary browser find.
    cursor = normalizedEnd;
  }
  while (
    matches.length > 0 &&
    Buffer.byteLength(JSON.stringify(resultWith(matches)), "utf8") > BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS
  ) matches.pop();
  return resultWith(matches);
}

/** Returns one independently bounded window from an immutable Markdown snapshot. */
export function rangeBrowserPageSnapshot(
  content: string,
  request: BrowserPageSnapshotRangeRequest,
  expiresAt: string,
): BrowserPageSnapshotRangeResult {
  if (!Number.isSafeInteger(request.offsetCharacters) || request.offsetCharacters < 0 || request.offsetCharacters > content.length) {
    throw new Error("browser page snapshot offset is invalid");
  }
  const beforeCharacters = requireSnapshotFindNumber(
    request.beforeCharacters,
    BROWSER_PAGE_SNAPSHOT_RANGE_DEFAULT_BEFORE_CHARACTERS,
    BROWSER_PAGE_SNAPSHOT_RANGE_MAX_BEFORE_CHARACTERS,
  );
  const afterCharacters = requireSnapshotFindNumber(
    request.afterCharacters,
    BROWSER_PAGE_SNAPSHOT_RANGE_DEFAULT_AFTER_CHARACTERS,
    BROWSER_PAGE_SNAPSHOT_RANGE_MAX_AFTER_CHARACTERS,
  );
  // Reserve two UTF-16 code units so safe-boundary expansion cannot breach the
  // fixed result ceiling (one surrogate pair can straddle either edge).
  const responseBudget = BROWSER_PAGE_SNAPSHOT_RANGE_MAX_RESPONSE_CHARACTERS - 2;
  const before = Math.min(beforeCharacters, responseBudget);
  const after = Math.min(afterCharacters, responseBudget - before);
  let startOffsetCharacters = Math.max(0, request.offsetCharacters - before);
  let endOffsetCharacters = Math.min(content.length, request.offsetCharacters + after);
  if (
    startOffsetCharacters > 0 && startOffsetCharacters < content.length &&
    /[\uD800-\uDBFF]/.test(content[startOffsetCharacters - 1]!) &&
    /[\uDC00-\uDFFF]/.test(content[startOffsetCharacters]!)
  ) startOffsetCharacters -= 1;
  if (
    endOffsetCharacters > 0 && endOffsetCharacters < content.length &&
    /[\uD800-\uDBFF]/.test(content[endOffsetCharacters - 1]!) &&
    /[\uDC00-\uDFFF]/.test(content[endOffsetCharacters]!)
  ) endOffsetCharacters += 1;
  return {
    version: 1,
    operation: "range",
    reference: request.reference,
    expiresAt,
    offsetCharacters: request.offsetCharacters,
    startOffsetCharacters,
    endOffsetCharacters,
    content: content.slice(startOffsetCharacters, endOffsetCharacters),
    ...snapshotBounds(content, startOffsetCharacters, endOffsetCharacters),
  };
}

/**
 * Fixed Nautilo-owned program for v0.31.1 `eval`. It returns an object (not a
 * JSON string), which the CLI pretty-serializes once from `data.result`.
 */
export const BROWSER_PAGE_READ_EVAL_SOURCE = String.raw`(() => {
  const CONTENT_CAP = ${BROWSER_PAGE_READ_PROGRAM_MAX_CHARS};
  const OUTPUT_CAP = 30000;
  const MAX_BLOCKS = ${BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS};
  const MAX_BLOCK_TEXT = ${BROWSER_PAGE_READ_PROGRAM_MAX_BLOCK_TEXT_CHARS};
  const MAX_LINKS = ${BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK};
  const MAX_COUNTED_LINKS = 32;
  const MAX_LINK_TEXT = 80;
  const MAX_LINK_HREF = 512;
  const MAX_TITLE = ${BROWSER_PAGE_READ_MAX_TITLE_CHARS};
  const MAX_URL = ${BROWSER_PAGE_READ_MAX_URL_CHARS};
  const MAX_COUNTED_BLOCKS = 2048;
  const started = performance.now();
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[\t\r\n ]+/g, ' ').trim();
  const clip = (value, max) => { const text = clean(value); return text.length > max ? text.slice(0, max) : text; };
  const safeUrl = (value, max, oversized) => { try { const url = new URL(String(value || '').trim()); if (!/^https?:$/.test(url.protocol)) return { value: '', truncated: false }; url.username = ''; url.password = ''; url.hash = ''; const sensitive = new Set(['token','access_token','auth','key','api_key','password','signature','sig','code']); [...url.searchParams.keys()].forEach((key) => { if (sensitive.has(key.toLowerCase())) url.searchParams.delete(key); }); const href = url.href; return href.length > max ? { value: oversized === 'link' ? '' : url.origin + '/', truncated: true } : { value: href, truncated: false }; } catch { return { value: '', truncated: false }; } };
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  const rootName = root === document.querySelector('article') ? 'article' : root === document.querySelector('main') ? 'main' : root ? 'body' : 'none';
  const clone = root ? root.cloneNode(true) : null;
  const beforeCleanupLength = clean((clone && clone.textContent) || '').length;
  const remove = ['script','style','noscript','template','svg','form','button','input','select','textarea','nav','header','footer','aside','dialog','[hidden]','[aria-hidden="true"]','[role="navigation"]','[role="banner"]','[role="contentinfo"]','[role="complementary"]','[class*="cookie" i]','[id*="cookie" i]','[class*="consent" i]','[id*="consent" i]','[class*="advert" i]','[id*="advert" i]','[class*="newsletter" i]','[id*="newsletter" i]','[class*="navigation" i]','[id*="navigation" i]'];
  if (clone) clone.querySelectorAll(remove.join(',')).forEach((node) => node.remove());
  const blocks = [];
  let used = 0, totalCharacters = 0, totalItems = 0, countedBlocks = 0;
  let sourceTruncated = false, totalCharactersCapped = false, metadataTruncated = false;
  const addTotal = (amount) => {
    if (amount > Number.MAX_SAFE_INTEGER - totalCharacters) { totalCharacters = Number.MAX_SAFE_INTEGER; totalCharactersCapped = true; sourceTruncated = true; }
    else totalCharacters += amount;
  };
  const add = (kind, sourceText, linkNodes) => {
    const rawText = clean(sourceText);
    if (!rawText) return;
    if (countedBlocks++ >= MAX_COUNTED_BLOCKS) { totalCharactersCapped = true; sourceTruncated = true; return; }
    const rawLinks = [];
    let linkOverflow = false;
    for (const link of linkNodes || []) {
      if (rawLinks.length >= MAX_COUNTED_LINKS) { linkOverflow = true; break; }
      const text = clean(link.textContent);
      const safeHref = safeUrl(link.href, MAX_LINK_HREF, 'link');
      if (safeHref.truncated) metadataTruncated = true;
      const href = safeHref.value;
      if (text && /^https?:/.test(href)) rawLinks.push({ text, href });
    }
    addTotal((totalItems++ ? 2 : 0) + rawText.length + rawLinks.reduce((sum, link) => sum + 5 + link.text.length + link.href.length, 0));
    if (linkOverflow) { totalCharactersCapped = true; sourceTruncated = true; }
    if (blocks.length >= MAX_BLOCKS || used >= CONTENT_CAP) { sourceTruncated = true; return; }
    let text = clip(rawText, MAX_BLOCK_TEXT);
    if (text.length < rawText.length) sourceTruncated = true;
    let links = rawLinks.slice(0, MAX_LINKS).map((link) => ({ text: clip(link.text, MAX_LINK_TEXT), href: link.href.slice(0, MAX_LINK_HREF) }));
    if (rawLinks.length > links.length || links.some((link, index) => link.text.length < rawLinks[index].text.length || link.href.length < rawLinks[index].href.length)) sourceTruncated = true;
    const size = () => text.length + links.reduce((sum, link) => sum + 5 + link.text.length + link.href.length, 0);
    const separator = blocks.length ? 2 : 0;
    if (size() > CONTENT_CAP - used - separator) { links = []; text = text.slice(0, Math.max(0, CONTENT_CAP - used - separator)); sourceTruncated = true; }
    if (!text) return;
    blocks.push(links.length ? { kind, text, links } : { kind, text });
    used += separator + size();
  };
  const readableNodes = clone ? clone.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table') : [];
  for (let index = 0; index < readableNodes.length; index += 1) {
    if (index >= MAX_COUNTED_BLOCKS) { totalCharactersCapped = true; sourceTruncated = true; break; }
    const node = readableNodes[index];
    const tag = node.tagName.toLowerCase();
    if (tag === 'li' && node.parentElement && node.parentElement.closest('li')) continue;
    const kind = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'li' ? 'list-item' : tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'preformatted' : tag === 'table' ? 'table' : 'paragraph';
    const text = tag === 'table' ? Array.from(node.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => clean(cell.textContent)).filter(Boolean).join(' | ')).filter(Boolean).join('\n') : node.textContent;
    add(kind, text, node.querySelectorAll('a[href]'));
  }
  if (!totalItems && clone) add('paragraph', clone.textContent, []);
  const allText = clip((clone && clone.textContent) || '', 16000);
  const rawTitle = clean(document.title);
  const title = rawTitle.slice(0, MAX_TITLE);
  if (title.length < rawTitle.length) metadataTruncated = true;
  const finalUrl = safeUrl(location.href, MAX_URL, 'page');
  if (finalUrl.truncated) metadataTruncated = true;
  if (metadataTruncated) sourceTruncated = true;
  const challengeSurface = clip([title, ...Array.from(document.querySelectorAll('h1,h2,[role="heading"],[role="alert"]')).slice(0, 8).map((node) => node.textContent)].join(' '), 2000).toLowerCase();
  const challengeUrl = finalUrl.value.toLowerCase();
  // A loaded provider script only means the site can request verification; it
  // is not evidence that the current page is blocked. Require a rendered
  // widget/container or challenge iframe before interrupting the Human.
  const hasResponse = (selectors) => selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
    const value = typeof node.value === 'string' ? node.value : node.getAttribute('value');
    return typeof value === 'string' && value.trim().length > 0;
  }));
  // A solved widget remains in the DOM. Detect only unresolved widgets; never
  // return or retain the opaque response token itself.
  const recaptchaSolved = hasResponse(['textarea[name="g-recaptcha-response"]', 'input[name="g-recaptcha-response"]']);
  const hcaptchaSolved = hasResponse(['textarea[name="h-captcha-response"]', 'input[name="h-captcha-response"]', 'textarea[name="hcaptcha-response"]', 'input[name="hcaptcha-response"]']);
  const turnstileSolved = hasResponse(['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]']);
  const challengeSolved = recaptchaSolved || hcaptchaSolved || turnstileSolved;
  const hasRecaptcha = Boolean(document.querySelector('.g-recaptcha, iframe[src*="recaptcha" i]')) && !recaptchaSolved;
  const hasHcaptcha = Boolean(document.querySelector('.h-captcha, iframe[src*="hcaptcha" i]')) && !hcaptchaSolved;
  const hasTurnstile = Boolean(document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com" i]')) && !turnstileSolved;
  const hasCloudflareChallenge = /just a moment|attention required/.test(challengeSurface) || /\/cdn-cgi\/challenge-platform\//.test(challengeUrl) || Boolean(document.querySelector('#challenge-form, [class*="cf-chl-" i], [id*="cf-chl-" i]'));
  const hasBlockingHumanCopy = !challengeSolved && /verify (you are )?human|verify your identity|human verification/.test(challengeSurface) && (allText.length < 5000 || hasRecaptcha || hasHcaptcha || hasTurnstile || hasCloudflareChallenge);
  const challengeSignals = [];
  if (hasRecaptcha) challengeSignals.push('recaptcha');
  if (hasHcaptcha) challengeSignals.push('hcaptcha');
  if (hasTurnstile) challengeSignals.push('turnstile');
  if (hasCloudflareChallenge) challengeSignals.push('cloudflare');
  if (hasRecaptcha || hasHcaptcha || hasTurnstile || !challengeSolved && /captcha/.test(challengeSurface) && allText.length < 5000) challengeSignals.push('captcha');
  if (hasBlockingHumanCopy) challengeSignals.push('verify-human');
  const payload = { finalUrl: finalUrl.value, title, readiness: document.readyState, extractionMs: Math.round(performance.now() - started), root: rootName, blocks, totalCharacters, totalCharactersCapped, metadataTruncated, iframeCount: Math.min(document.querySelectorAll('iframe,frame').length, MAX_COUNTED_BLOCKS), canvasCount: Math.min(document.querySelectorAll('canvas').length, MAX_COUNTED_BLOCKS), virtualizedHint: Boolean(document.querySelector('[aria-rowcount], [data-virtualized], [data-virtualizer], [class*="virtual" i]')), boilerplateHint: rootName === 'body' && allText.length > 0 && beforeCleanupLength > Math.max(allText.length * 3, allText.length + 400), challengeSignals: [...new Set(challengeSignals)].slice(0, 6), sourceTruncated };
  while (JSON.stringify(payload).length > OUTPUT_CAP && blocks.length) { blocks.pop(); sourceTruncated = true; payload.sourceTruncated = true; }
  return payload;
})()`;

/** Exact fixed-eval argv path for both interactive and research executors. */
export function agentBrowserPageReadEvalArgv(
  cfgPath: string,
  session: string,
): string[] {
  return [
    ...browserArgvPrefix(cfgPath, session),
    "eval",
    BROWSER_PAGE_READ_EVAL_SOURCE,
  ];
}
