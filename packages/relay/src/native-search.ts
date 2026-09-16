/**
 * D446 — shared ripgrep argv + incremental result normalizer.
 *
 * Host authority and process lifecycle are injected. Server and Desktop call
 * this with their existing Sandbox/spawnSandboxed path after selecting a root
 * and verifying the packaged binary.
 */

import type {
  RelayGlobSearchArgs,
  RelayGlobSearchEntry,
  RelayGrepSearchArgs,
  RelayGrepSearchMatch,
  RelaySearchCommand,
  RelaySearchResult,
} from "./search";
import { matchesGlob } from "node:path";
import { createHash } from "node:crypto";

const PREVIEW_CHARS = 200;

/**
 * Stateless discovery pages retain only the requested page. A complete streamed
 * re-enumeration fingerprints the ordered result set on every request, so a
 * continuation cannot combine changed result sets or silently skip earlier rows.
 * This version describes discovery output, not an atomic snapshot of file bytes.
 */
export function createDiscoveryPage<T>(identity: unknown, limit: number, rawCursor?: unknown) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid discovery page size");
  const request = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  let offset = 0;
  let priorVersion: string | undefined;
  if (rawCursor !== undefined) {
    try {
      if (typeof rawCursor !== "string") throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      const cursor = parsed as { version?: unknown; request?: unknown; offset?: unknown; sourceVersion?: unknown };
      if (cursor.version !== 1 || cursor.request !== request || typeof cursor.offset !== "number" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 ||
        typeof cursor.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(cursor.sourceVersion)) throw new Error();
      offset = cursor.offset;
      priorVersion = cursor.sourceVersion;
    } catch { throw new Error("Invalid discovery cursor or changed path/filters; restart without discoveryCursor."); }
  }
  const hash = createHash("sha256");
  const entries: T[] = [];
  let totalCount = 0;
  return {
    accept(value: T, fingerprint: unknown = value) {
      hash.update(JSON.stringify(fingerprint)).update("\n");
      if (totalCount >= offset && entries.length < limit) entries.push(value);
      totalCount += 1;
    },
    finish() {
      const sourceVersion = hash.digest("hex");
      if ((priorVersion !== undefined && priorVersion !== sourceVersion) || offset > totalCount) {
        throw new Error("Discovery results changed; restart without discoveryCursor rather than combine versions.");
      }
      const truncated = offset + entries.length < totalCount;
      const nextCursor = truncated ? Buffer.from(JSON.stringify({ version: 1, request, sourceVersion, offset: offset + entries.length })).toString("base64url") : null;
      return { entries, count: entries.length, totalCount, sourceVersion, startOffset: offset, endOffset: offset + entries.length, nextCursor, truncated, complete: !truncated };
    },
  };
}

export interface NativeSearchExecutionInput {
  readonly program: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onStdoutChunk: (chunk: Buffer) => "stop" | void;
}

export interface NativeSearchExecutionResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stoppedEarly: boolean;
}

export type NativeSearchExecutor = (
  input: NativeSearchExecutionInput,
) => Promise<NativeSearchExecutionResult>;

export interface NativeSearchPathIdentity {
  readonly relativePath: string;
  readonly path: string;
}

interface NativeSearchRunBase {
  readonly binaryPath: string;
  readonly cwd: string;
  /** Server-resolved search target relative to cwd; never model-authored. */
  readonly target?: string;
  readonly engineVersion: string;
  readonly signal?: AbortSignal;
  readonly execute: NativeSearchExecutor;
  /** Workspace projections set this so `.gitignore` works without `.git/`. */
  readonly noRequireGit?: boolean;
  /** Map engine-relative paths back to the zone's reusable identity. */
  readonly mapPath: (relativePath: string) => NativeSearchPathIdentity | null;
}

export type NativeSearchRunInput =
  | (NativeSearchRunBase & { readonly command: "glob"; readonly args: RelayGlobSearchArgs })
  | (NativeSearchRunBase & { readonly command: "grep"; readonly args: RelayGrepSearchArgs });

function commonArgv(
  args: RelayGlobSearchArgs | RelayGrepSearchArgs,
  noRequireGit: boolean,
): string[] {
  return [
    "--color",
    "never",
    "--no-messages",
    ...(args.hidden === "include" ? ["--hidden"] : []),
    ...(args.includeIgnored ? ["--no-ignore"] : []),
    ...(noRequireGit ? ["--no-require-git"] : []),
    // `.git/` is never useful search content, even with explicit overrides.
    "--glob",
    "!.git/**",
  ];
}

type RipgrepArgvInput =
  | {
      readonly command: "glob";
      readonly args: RelayGlobSearchArgs;
      readonly noRequireGit?: boolean;
      readonly target?: string;
    }
  | {
      readonly command: "grep";
      readonly args: RelayGrepSearchArgs;
      readonly noRequireGit?: boolean;
      readonly target?: string;
    };

export function buildRipgrepArgv(input: RipgrepArgvInput): string[] {
  const common = commonArgv(input.args, input.noRequireGit === true);
  const target = input.target ?? ".";
  if (input.command === "glob") {
    return ["--files", "--null", "--sort", "path", ...common, target];
  }

  const caseFlag =
    input.args.caseMode === "sensitive"
      ? "--case-sensitive"
      : input.args.caseMode === "insensitive"
        ? "--ignore-case"
        : "--smart-case";
  return [
    "--json",
    "--sort",
    "path",
    ...common,
    caseFlag,
    "--",
    input.args.query,
    target,
  ];
}

function error(
  command: RelaySearchCommand,
  code: Extract<RelaySearchResult, { ok: false }>["error"]["code"],
  message: string,
  engineVersion?: string,
): RelaySearchResult {
  return {
    ok: false,
    command,
    error: { code, message },
    ...(engineVersion ? { engine: { name: "ripgrep", version: engineVersion } } : {}),
  };
}

function normalizedRelativePath(raw: string): string | null {
  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length === 0 || normalized === ".git" || normalized.startsWith(".git/")) {
    return null;
  }
  return normalized;
}

function decodeRgText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["text"] === "string") return record["text"];
  if (typeof record["bytes"] === "string") {
    try {
      return Buffer.from(record["bytes"], "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

function grepMatchFromJson(
  line: string,
  args: RelayGrepSearchArgs,
  mapPath: NativeSearchRunBase["mapPath"],
): RelayGrepSearchMatch | null {
  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope["type"] !== "match") return null;
  const data = envelope["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("ripgrep match event has no data object");
  }
  const record = data as Record<string, unknown>;
  const rawPath = decodeRgText(record["path"]);
  const rawLine = decodeRgText(record["lines"]);
  const lineNumber = record["line_number"];
  const submatches = record["submatches"];
  if (
    rawPath === null ||
    rawLine === null ||
    !Number.isSafeInteger(lineNumber) ||
    !Array.isArray(submatches) ||
    submatches.length === 0
  ) {
    throw new Error("ripgrep match event is malformed");
  }
  if (args.lineRange && ((lineNumber as number) < args.lineRange.from || (lineNumber as number) > args.lineRange.to)) {
    return null;
  }
  const submatch: unknown = (submatches as unknown[])[0];
  if (typeof submatch !== "object" || submatch === null || Array.isArray(submatch)) {
    throw new Error("ripgrep submatch is malformed");
  }
  const submatchRecord = submatch as Record<string, unknown>;
  const match = decodeRgText(submatchRecord["match"]);
  const start = submatchRecord["start"];
  if (match === null || !Number.isSafeInteger(start) || (start as number) < 0) {
    throw new Error("ripgrep submatch has invalid match/start");
  }
  const relativePath = normalizedRelativePath(rawPath);
  if (relativePath === null) return null;
  const identity = mapPath(relativePath);
  if (identity === null) return null;
  const previewLine = rawLine.replace(/[\r\n]+$/, "");
  return {
    ...identity,
    line: lineNumber as number,
    column: (start as number) + 1,
    match,
    preview:
      previewLine.length > PREVIEW_CHARS
        ? `${previewLine.slice(0, PREVIEW_CHARS)}…`
        : previewLine,
  };
}

function classifyEngineError(stderr: string): "SEARCH_INVALID_PATTERN" | "SEARCH_ENGINE_FAILURE" {
  return /regex parse error|error parsing glob|invalid glob|unclosed|repetition operator/i.test(stderr)
    ? "SEARCH_INVALID_PATTERN"
    : "SEARCH_ENGINE_FAILURE";
}

export async function runNativeSearch(input: NativeSearchRunInput): Promise<RelaySearchResult> {
  const globPattern = input.command === "glob" ? input.args.pattern : undefined;
  const pathPattern = globPattern ?? (input.command === "grep" ? input.args.glob : undefined);
  if (pathPattern !== undefined) {
    try {
      matchesGlob("glob-validation-probe", pathPattern);
    } catch {
      return error(
        input.command,
        "SEARCH_INVALID_PATTERN",
        "Search path pattern is invalid.",
        input.engineVersion,
      );
    }
  }
  const argv = buildRipgrepArgv(input);
  const limit = input.args.limit;
  const { limit: _limit, discoveryCursor, ...queryIdentity } = input.args;
  let page: ReturnType<typeof createDiscoveryPage<RelayGlobSearchEntry | RelayGrepSearchMatch>>;
  try {
    page = createDiscoveryPage({ command: input.command, cwd: input.cwd, target: input.target ?? ".", queryIdentity }, limit, discoveryCursor);
  } catch (cause) {
    return error(input.command, "SEARCH_INVALID_ARGS", String(cause), input.engineVersion);
  }
  let parseFailure: Error | null = null;
  let deniedPathCount = 0;
  let buffer = Buffer.alloc(0);


  const acceptGlobPath = (raw: string): void => {
    const relativePath = normalizedRelativePath(raw);
    if (relativePath === null) return;
    if (globPattern === undefined || !matchesGlob(relativePath, globPattern)) return;
    const identity = input.mapPath(relativePath);
    if (identity !== null) page.accept(identity);
    else deniedPathCount += 1;
  };

  const consume = (chunk: Buffer): "stop" | void => {
    if (parseFailure !== null) return "stop";
    buffer = Buffer.concat([buffer, chunk]);
    const delimiter = input.command === "glob" ? 0 : 10;
    while (true) {
      const index = buffer.indexOf(delimiter);
      if (index === -1) break;
      const record = buffer.subarray(0, index).toString("utf8");
      buffer = buffer.subarray(index + 1);
      if (record.length === 0) continue;
      try {
        if (input.command === "glob") {
          acceptGlobPath(record);

        } else {
          const match = grepMatchFromJson(record, input.args, (relativePath) => {
            const identity = input.mapPath(relativePath);
            if (identity === null) deniedPathCount += 1;
            return identity;
          });
          if (
            match !== null &&
            (input.args.glob === undefined || matchesGlob(match.relativePath, input.args.glob))
          ) {
            page.accept(match, { match, raw: record });
          }

        }
      } catch (cause) {
        parseFailure = cause instanceof Error ? cause : new Error(String(cause));
        return "stop";
      }
    }
  };

  let execution: NativeSearchExecutionResult;
  try {
    execution = await input.execute({
      program: input.binaryPath,
      argv,
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
      onStdoutChunk: consume,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return error(
      input.command,
      /ENOENT|not found|unavailable/i.test(message) ? "SEARCH_UNAVAILABLE" : "SEARCH_ENGINE_FAILURE",
      "The packaged search engine could not be started.",
    );
  }

  if (execution.aborted) {
    return error(input.command, "SEARCH_CANCELLED", "Search was cancelled.", input.engineVersion);
  }
  if (execution.timedOut) {
    return error(input.command, "SEARCH_TIMEOUT", "Search exceeded the enclosing host deadline.", input.engineVersion);
  }
  if (parseFailure !== null) {
    const failure = parseFailure as Error;
    return error(
      input.command,
      "SEARCH_ENGINE_FAILURE",
      `Search engine returned malformed structured output: ${failure.message}`,
      input.engineVersion,
    );
  }
  if (buffer.length > 0 && !execution.stoppedEarly) {
    return error(
      input.command,
      "SEARCH_ENGINE_FAILURE",
      "Search engine returned an incomplete structured record.",
      input.engineVersion,
    );
  }
  if (!execution.stoppedEarly && execution.exitCode !== 0 && execution.exitCode !== 1) {
    return error(
      input.command,
      classifyEngineError(execution.stderr),
      "Search engine rejected the pattern or failed to search this root.",
      input.engineVersion,
    );
  }

  if (execution.stoppedEarly) return error(input.command, "SEARCH_OUTPUT_CEILING", "Search ended before the full discovery result set could be validated. No exhaustive page is available.", input.engineVersion);
  let result: ReturnType<typeof page.finish>;
  try { result = page.finish(); }
  catch (cause) { return error(input.command, "SEARCH_STALE_CURSOR", String(cause), input.engineVersion); }
  const { entries, ...pagination } = result;
  const scopeExclusions = [
    ".git internals and symlink traversal are excluded",
    ...(input.args.includeIgnored ? [] : ["repository and ripgrep ignore rules apply; use includeIgnored:true for a separate inventory"]),
    ...(input.args.hidden === "exclude" ? ["hidden files excluded by request"] : []),
    ...(input.command === "grep" ? ["binary files follow ripgrep text-search semantics; matches are leads, not complete file reads"] : []),
  ];
  const recovery = result.truncated
    ? "Continue this same path and filters with discoveryCursor:nextCursor until nextCursor is null. sourceVersion fingerprints discovery results, not all source bytes."
    : undefined;
  const common = {
    ok: true as const,
    engine: { name: "ripgrep" as const, version: input.engineVersion },
    includeIgnored: input.args.includeIgnored,
    hidden: input.args.hidden,
    ...pagination,
    complete: pagination.complete && deniedPathCount === 0,
    sourceVersionScope: "Ordered discovery results, not an atomic file-content snapshot",
    ...(deniedPathCount ? { deniedPathCount, incompleteReasons: [{ reason: "denied", count: deniedPathCount }] } : {}),
    scopeExclusions,
    ...(recovery ? { recovery } : {}),
  };
  if (input.command === "glob") {
    return { ...common, command: "glob", pattern: input.args.pattern, entries };
  }
  return { ...common, command: "grep", query: input.args.query, caseMode: input.args.caseMode, matches: entries as RelayGrepSearchMatch[] };
}
