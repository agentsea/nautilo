/**
 * D446 — shared native file-search contract.
 *
 * This module owns the strict arguments and normalized result envelopes shared
 * by the agent/server and Desktop relay. It deliberately contains no process,
 * filesystem-authority, timeout, or byte-budget policy; those remain with the
 * existing host owners.
 */

export const SEARCH_DEFAULT_GLOB_LIMIT = 1_000;
export const SEARCH_DEFAULT_GREP_LIMIT = 200;

export type RelaySearchCommand = "glob" | "grep";
export type RelaySearchCaseMode = "smart" | "sensitive" | "insensitive";
export type RelaySearchHiddenMode = "include" | "exclude";

export interface RelaySearchLineRange {
  readonly from: number;
  readonly to: number;
}

interface RelaySearchCommonArgs {
  readonly path: string;
  /** Result page size. This is caller-overridable, not an engine ceiling. */
  readonly limit: number;
  /** Echo nextCursor from the same discovery request; changing limit is allowed. */
  readonly discoveryCursor?: string | undefined;
  readonly includeIgnored: boolean;
  /** Useful hidden files are included by default; `.git/` remains excluded. */
  readonly hidden: RelaySearchHiddenMode;
}

export interface RelayGlobSearchArgs extends RelaySearchCommonArgs {
  readonly pattern: string;
}

export interface RelayGrepSearchArgs extends RelaySearchCommonArgs {
  readonly query: string;
  readonly glob?: string | undefined;
  readonly lineRange?: RelaySearchLineRange | undefined;
  readonly caseMode: RelaySearchCaseMode;
}

export type RelaySearchArgs = RelayGlobSearchArgs | RelayGrepSearchArgs;

export type RelaySearchErrorCode =
  | "SEARCH_STALE_CURSOR"
  | "SEARCH_INVALID_ARGS"
  | "SEARCH_INVALID_PATTERN"
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_DENIED_ROOT"
  | "SEARCH_TIMEOUT"
  | "SEARCH_CANCELLED"
  | "SEARCH_OUTPUT_CEILING"
  | "SEARCH_ENGINE_FAILURE";

export interface RelaySearchError {
  readonly code: RelaySearchErrorCode;
  readonly message: string;
}

export interface RelaySearchEngine {
  readonly name: "ripgrep";
  readonly version: string;
}

export interface RelayGlobSearchEntry {
  /** Normalized identity relative to the searched root. */
  readonly relativePath: string;
  /** Path reusable in a later unified `file` call for the same zone. */
  readonly path: string;
}

export interface RelayGrepSearchMatch extends RelayGlobSearchEntry {
  readonly line: number;
  readonly column: number;
  readonly match: string;
  readonly preview: string;
}

interface RelaySearchSuccessBase {
  readonly ok: true;
  readonly command: RelaySearchCommand;
  readonly engine: RelaySearchEngine;
  readonly count: number;
  readonly truncated: boolean;
  readonly includeIgnored: boolean;
  readonly hidden: RelaySearchHiddenMode;
  readonly recovery?: string | undefined;
  /** Optional only for older relay compatibility. New producers always provide these. */
  readonly nextCursor?: string | null;
  readonly sourceVersion?: string;
  readonly sourceVersionScope?: string;
  readonly complete?: boolean;
  readonly totalCount?: number;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly deniedPathCount?: number;
  readonly incompleteReasons?: readonly { readonly reason: string; readonly count: number }[];
  readonly scopeExclusions?: readonly string[];
}

export interface RelayGlobSearchSuccess extends RelaySearchSuccessBase {
  readonly command: "glob";
  readonly pattern: string;
  readonly entries: readonly RelayGlobSearchEntry[];
}

export interface RelayGrepSearchSuccess extends RelaySearchSuccessBase {
  readonly command: "grep";
  readonly query: string;
  readonly caseMode: RelaySearchCaseMode;
  readonly matches: readonly RelayGrepSearchMatch[];
}

export type RelaySearchSuccess = RelayGlobSearchSuccess | RelayGrepSearchSuccess;

export interface RelaySearchFailure {
  readonly ok: false;
  readonly command: RelaySearchCommand;
  readonly error: RelaySearchError;
  readonly engine?: RelaySearchEngine | undefined;
}

export type RelaySearchResult = RelaySearchSuccess | RelaySearchFailure;

export type RelaySearchParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RelaySearchError };

function invalid(message: string): RelaySearchParseResult<never> {
  return { ok: false, error: { code: "SEARCH_INVALID_ARGS", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): RelaySearchParseResult<never> | null {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  return unknown.length > 0
    ? invalid(`unknown search argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`)
    : null;
}

function nonEmptyString(value: unknown, field: string): RelaySearchParseResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${field} must be a non-empty string`);
  }
  return { ok: true, value };
}

function parseLimit(value: unknown, fallback: number): RelaySearchParseResult<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid("limit must be a positive safe integer");
  }
  return { ok: true, value: value as number };
}

function parseCommon(
  value: Record<string, unknown>,
  defaultLimit: number,
): RelaySearchParseResult<RelaySearchCommonArgs> {
  const path = nonEmptyString(value["path"], "path");
  if (!path.ok) return path;
  const limit = parseLimit(value["limit"], defaultLimit);
  if (!limit.ok) return limit;

  const discoveryCursor = value["discoveryCursor"];
  if (discoveryCursor !== undefined && (typeof discoveryCursor !== "string" || discoveryCursor.length === 0)) {
    return invalid("discoveryCursor must be a non-empty string");
  }
  const includeIgnored = value["includeIgnored"];
  if (includeIgnored !== undefined && typeof includeIgnored !== "boolean") {
    return invalid("includeIgnored must be a boolean");
  }
  const hidden = value["hidden"];
  if (hidden !== undefined && hidden !== "include" && hidden !== "exclude") {
    return invalid('hidden must be "include" or "exclude"');
  }

  return {
    ok: true,
    value: {
      path: path.value,
      limit: limit.value,
      ...(discoveryCursor !== undefined ? { discoveryCursor } : {}),
      includeIgnored: includeIgnored ?? false,
      hidden: hidden ?? "include",
    },
  };
}

function parseLineRange(value: unknown): RelaySearchParseResult<RelaySearchLineRange | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return invalid("lineRange must be an object");
  const unknown = rejectUnknownKeys(value, new Set(["from", "to"]));
  if (unknown) return unknown;
  const from = value["from"];
  const to = value["to"];
  if (!Number.isSafeInteger(from) || (from as number) <= 0) {
    return invalid("lineRange.from must be a positive safe integer");
  }
  if (!Number.isSafeInteger(to) || (to as number) <= 0) {
    return invalid("lineRange.to must be a positive safe integer");
  }
  if ((from as number) > (to as number)) {
    return invalid("lineRange.from must be less than or equal to lineRange.to");
  }
  return { ok: true, value: { from: from as number, to: to as number } };
}

const GLOB_KEYS = new Set(["path", "pattern", "limit", "includeIgnored", "hidden", "discoveryCursor"]);
const GREP_KEYS = new Set([
  "path",
  "query",
  "glob",
  "lineRange",
  "limit",
  "includeIgnored",
  "hidden",
  "caseMode",
  "discoveryCursor",
]);

/** Strictly parse public search args before any native process is started. */
export function parseRelaySearchArgs(
  command: "glob",
  input: unknown,
): RelaySearchParseResult<RelayGlobSearchArgs>;
export function parseRelaySearchArgs(
  command: "grep",
  input: unknown,
): RelaySearchParseResult<RelayGrepSearchArgs>;
export function parseRelaySearchArgs(
  command: RelaySearchCommand,
  input: unknown,
): RelaySearchParseResult<RelaySearchArgs>;
export function parseRelaySearchArgs(
  command: RelaySearchCommand,
  input: unknown,
): RelaySearchParseResult<RelaySearchArgs> {
  if (!isRecord(input)) return invalid("search arguments must be an object");
  const unknown = rejectUnknownKeys(input, command === "glob" ? GLOB_KEYS : GREP_KEYS);
  if (unknown) return unknown;

  if (command === "glob") {
    const common = parseCommon(input, SEARCH_DEFAULT_GLOB_LIMIT);
    if (!common.ok) return common;
    const pattern = nonEmptyString(input["pattern"], "pattern");
    if (!pattern.ok) return pattern;
    return { ok: true, value: { ...common.value, pattern: pattern.value } };
  }

  const common = parseCommon(input, SEARCH_DEFAULT_GREP_LIMIT);
  if (!common.ok) return common;
  const query = nonEmptyString(input["query"], "query");
  if (!query.ok) return query;
  const glob = input["glob"];
  if (glob !== undefined && (typeof glob !== "string" || glob.length === 0)) {
    return invalid("glob must be a non-empty string when provided");
  }
  const lineRange = parseLineRange(input["lineRange"]);
  if (!lineRange.ok) return lineRange;
  const caseMode = input["caseMode"];
  if (
    caseMode !== undefined &&
    caseMode !== "smart" &&
    caseMode !== "sensitive" &&
    caseMode !== "insensitive"
  ) {
    return invalid('caseMode must be "smart", "sensitive", or "insensitive"');
  }

  return {
    ok: true,
    value: {
      ...common.value,
      query: query.value,
      ...(glob !== undefined ? { glob } : {}),
      ...(lineRange.value !== undefined ? { lineRange: lineRange.value } : {}),
      caseMode: caseMode ?? "smart",
    },
  };
}

export const RELAY_SEARCH_ERROR_CODES: ReadonlySet<RelaySearchErrorCode> = new Set([
  "SEARCH_STALE_CURSOR",
  "SEARCH_INVALID_ARGS",
  "SEARCH_INVALID_PATTERN",
  "SEARCH_UNAVAILABLE",
  "SEARCH_DENIED_ROOT",
  "SEARCH_TIMEOUT",
  "SEARCH_CANCELLED",
  "SEARCH_OUTPUT_CEILING",
  "SEARCH_ENGINE_FAILURE",
]);
