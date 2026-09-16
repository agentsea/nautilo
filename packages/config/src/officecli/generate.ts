// D396 Wave 1 — Headless office generation via OfficeCLI.
//
// Server-side orchestration for the full OfficeCLI command surface. Mirrors
// the structure of `office-export.ts` / `office-import.ts` and reuses the
// shared `run.ts` helpers (path/env/run) — never re-implements them.
//
// What this module provides:
//   - Pure argv builders for every SURFACE command in the capability matrix:
//     create, batch, view (all modes incl. screenshot), get, query, set, add,
//     remove, move, swap, validate, dump, merge, raw, raw-set, add-part, close,
//     open, save, refresh, help (the last four added in Wave 2a — see below).
//   - `makeOfficeCreateRun({ binaryPath, timeoutMs })` — injected runner
//     factory, mirroring `makeOfficeExportRun`.
//   - `generateOffice(...)` — create blank (type from extension) → apply a
//     batch command array → close → return `{ bytes, path }`.
//   - `renderOffice(...)` — run `view screenshot` (per-page PNG), `view html`,
//     and `view issues` (structured JSON) against an existing file.
//
// What this module deliberately does NOT do (Wave 2):
//   - artifact-store / zone / patch logic
//   - agent-tool protocol wrapping
// This module is pure OfficeCLI orchestration.
//
// Relocated from packages/server/src/office-create.ts to @nautilo/config
// (D396 Wave 2a) so both @nautilo/agent and @nautilo/server can import the
// pure OfficeCLI core. Node-only subpath — uses node:fs / node:os.
//
// Wave 2a additions: buildOpenArgv / buildSaveArgv / buildRefreshArgv /
// buildHelpArgv complete the SURFACE set from the capability matrix. Their
// flag shapes were probed directly from the vendored binary's `help`
// subcommand (the binary only exposes `--json` on these verbs; `help` also
// takes a `<format>` positional and optional `<verb>` / `<element>` positionals).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOfficeCliRaw, type OfficeCliRunResult } from "./run";

// ============================================================================
// Public types — runner
// ============================================================================

/**
 * Injectable OfficeCLI runner. Already bound to a resolved binary path; the
 * caller only supplies argv. Returns the normalized run result so non-zero
 * exits surface as a normal return value (the helper maps them to
 * `OfficeCreateError`) and spawn failures throw (misconfigured binary).
 */
export type OfficeCreateRunFn = (argv: readonly string[]) => Promise<OfficeCliRunResult>;

// ============================================================================
// Errors
// ============================================================================

export type OfficeCreateErrorCode =
  | "INVALID_FILENAME"
  | "UNSUPPORTED_TYPE"
  | "OFFICECLI_CREATE_FAILED"
  | "OFFICECLI_BATCH_FAILED"
  | "OFFICECLI_CLOSE_FAILED"
  | "OFFICECLI_RENDER_FAILED"
  | "OFFICECLI_VALIDATE_FAILED";

/**
 * Structured error codes mapped from the OfficeCLI error envelope, when
 * available. Mirrors the matrix's enumerated failures:
 * `not_found` / `invalid_value` / `unsupported_property` / etc.
 */
export type OfficeCliErrorKind =
  | "not_found"
  | "invalid_value"
  | "unsupported_property"
  | "unsupported_operation"
  | "schema_validation"
  | "io"
  | "unknown";

export class OfficeCreateError extends Error {
  readonly code: OfficeCreateErrorCode;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly cliErrorKind?: OfficeCliErrorKind;

  constructor(
    message: string,
    info: {
      code: OfficeCreateErrorCode;
      exitCode?: number;
      stderr?: string;
      cliErrorKind?: OfficeCliErrorKind;
    },
  ) {
    super(message);
    this.name = "OfficeCreateError";
    this.code = info.code;
    if (info.exitCode !== undefined) this.exitCode = info.exitCode;
    if (info.stderr !== undefined) this.stderr = info.stderr;
    if (info.cliErrorKind !== undefined) this.cliErrorKind = info.cliErrorKind;
  }
}

// ============================================================================
// Batch command shape
// ============================================================================

/**
 * Generic OfficeCLI batch command. The matrix §6 specifies each item as an
 * object whose `command` is the bare verb with sibling fields (not a CLI
 * string). This type is intentionally permissive — the typed surface for
 * specific elements lives in the per-format mappers (e.g. office-export.ts).
 */
export type OfficeBatchCommand =
  | { readonly command: "add"; readonly parent: string; readonly type?: string; readonly props?: Record<string, string>; readonly from?: string; readonly index?: number; readonly after?: string; readonly before?: string }
  | { readonly command: "set"; readonly path: string; readonly props?: Record<string, string>; readonly find?: string; readonly replace?: string }
  | { readonly command: "remove"; readonly path: string; readonly shift?: "left" | "up"; readonly props?: Record<string, string> }
  | { readonly command: "move"; readonly path: string; readonly to?: string; readonly index?: number; readonly after?: string; readonly before?: string; readonly props?: Record<string, string> }
  | { readonly command: "swap"; readonly path: string; readonly path2: string }
  | { readonly command: "get"; readonly path: string; readonly depth?: number }
  | { readonly command: "query"; readonly selector: string; readonly find?: string }
  | { readonly command: "validate" }
  | { readonly command: "raw"; readonly part?: string }
  | { readonly command: "raw-set"; readonly part: string; readonly xpath: string; readonly action: RawSetAction; readonly xml?: string }
  | { readonly command: "add-part"; readonly parent: string; readonly type: string };

export type RawSetAction =
  | "append"
  | "prepend"
  | "insertbefore"
  | "insertafter"
  | "replace"
  | "remove"
  | "setattr";

// ============================================================================
// Document type helpers
// ============================================================================

export type OfficeDocType = "docx" | "xlsx" | "pptx";

const EXT_TO_TYPE: Readonly<Record<string, OfficeDocType>> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
};

/**
 * Infer the OfficeCLI document type from a file extension. Returns null for
 * unknown extensions so the caller can surface an explicit error rather than
 * letting the binary fail at spawn time.
 */
export function inferOfficeDocType(fileName: string): OfficeDocType | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot).toLowerCase();
  return EXT_TO_TYPE[ext] ?? null;
}

// ============================================================================
// Argv builders — pure, unit-testable, no spawn
// ============================================================================

// --- create -----------------------------------------------------------------

export interface CreateArgvOptions {
  readonly file: string;
  readonly type?: OfficeDocType;
  readonly locale?: string;
  readonly force?: boolean;
  readonly minimal?: boolean;
  readonly json?: boolean;
}

export function buildCreateArgv(options: CreateArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildCreateArgv: file is required");
  }
  const argv: string[] = ["create", options.file];
  if (options.type !== undefined) {
    argv.push("--type", options.type);
  }
  if (options.locale !== undefined && options.locale.length > 0) {
    argv.push("--locale", options.locale);
  }
  if (options.force) argv.push("--force");
  if (options.minimal) argv.push("--minimal");
  if (options.json) argv.push("--json");
  return argv;
}

// --- batch ------------------------------------------------------------------

export interface BatchArgvOptions {
  readonly file: string;
  /** Inline JSON array of commands (alternative to `--input`). */
  readonly commands?: readonly OfficeBatchCommand[];
  /** Path to a JSON file containing commands (alternative to `--commands`). */
  readonly input?: string;
  readonly stopOnError?: boolean;
  readonly json?: boolean;
}

export function buildBatchArgv(options: BatchArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildBatchArgv: file is required");
  }
  if (options.commands === undefined && options.input === undefined) {
    throw new Error("buildBatchArgv: one of commands or input is required");
  }
  if (options.commands !== undefined && options.input !== undefined) {
    throw new Error("buildBatchArgv: commands and input are mutually exclusive");
  }
  const argv: string[] = ["batch", options.file];
  if (options.commands !== undefined) {
    argv.push("--commands", JSON.stringify(options.commands));
  }
  if (options.input !== undefined && options.input.length > 0) {
    argv.push("--input", options.input);
  }
  if (options.stopOnError) argv.push("--stop-on-error");
  if (options.json) argv.push("--json");
  return argv;
}

// --- view -------------------------------------------------------------------

export type ViewMode =
  | "text"
  | "annotated"
  | "outline"
  | "stats"
  | "issues"
  | "html"
  | "svg"
  | "screenshot"
  | "pdf"
  | "forms";

export interface ViewArgvOptions {
  readonly file: string;
  readonly mode: ViewMode;
  readonly start?: number;
  readonly end?: number;
  readonly maxLines?: number;
  readonly type?: string;
  readonly limit?: number;
  readonly cols?: string;
  readonly page?: string;
  readonly browser?: boolean;
  readonly out?: string;
  readonly screenshotWidth?: number;
  readonly screenshotHeight?: number;
  readonly grid?: string | true;
  readonly render?: "auto" | "native" | "html";
  readonly pageCount?: boolean;
  readonly json?: boolean;
}

export function buildViewArgv(options: ViewArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildViewArgv: file is required");
  }
  const argv: string[] = ["view", options.file, options.mode];
  if (options.start !== undefined) argv.push("--start", String(options.start));
  if (options.end !== undefined) argv.push("--end", String(options.end));
  if (options.maxLines !== undefined) argv.push("--max-lines", String(options.maxLines));
  if (options.type !== undefined && options.type.length > 0) argv.push("--type", options.type);
  if (options.limit !== undefined) argv.push("--limit", String(options.limit));
  if (options.cols !== undefined && options.cols.length > 0) argv.push("--cols", options.cols);
  if (options.page !== undefined && options.page.length > 0) argv.push("--page", options.page);
  if (options.browser) argv.push("--browser");
  if (options.out !== undefined && options.out.length > 0) argv.push("--out", options.out);
  if (options.screenshotWidth !== undefined) {
    argv.push("--screenshot-width", String(options.screenshotWidth));
  }
  if (options.screenshotHeight !== undefined) {
    argv.push("--screenshot-height", String(options.screenshotHeight));
  }
  if (options.grid !== undefined) {
    argv.push("--grid", options.grid === true ? "auto" : options.grid);
  }
  if (options.render !== undefined) argv.push("--render", options.render);
  if (options.pageCount) argv.push("--page-count");
  if (options.json) argv.push("--json");
  return argv;
}

// --- get --------------------------------------------------------------------

export interface GetArgvOptions {
  readonly file: string;
  readonly path?: string;
  readonly depth?: number;
  readonly save?: string;
  readonly json?: boolean;
}

export function buildGetArgv(options: GetArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildGetArgv: file is required");
  }
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0)) {
    throw new Error(`buildGetArgv: depth must be a non-negative integer (got ${options.depth})`);
  }
  const argv: string[] = ["get", options.file];
  if (options.path !== undefined && options.path.length > 0) {
    argv.push(options.path);
  }
  if (options.depth !== undefined) argv.push("--depth", String(options.depth));
  if (options.save !== undefined && options.save.length > 0) {
    argv.push("--save", options.save);
  }
  if (options.json) argv.push("--json");
  return argv;
}

// --- query ------------------------------------------------------------------

export interface QueryArgvOptions {
  readonly file: string;
  readonly selector: string;
  readonly find?: string;
  readonly json?: boolean;
}

export function buildQueryArgv(options: QueryArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildQueryArgv: file is required");
  }
  if (options.selector.length === 0) {
    throw new Error("buildQueryArgv: selector is required");
  }
  const argv: string[] = ["query", options.file, options.selector];
  if (options.find !== undefined && options.find.length > 0) argv.push("--find", options.find);
  if (options.json) argv.push("--json");
  return argv;
}

// --- set --------------------------------------------------------------------

export interface SetArgvOptions {
  readonly file: string;
  readonly path: string;
  readonly props?: Record<string, string>;
  readonly find?: string;
  readonly replace?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export function buildSetArgv(options: SetArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildSetArgv: file is required");
  }
  if (options.path.length === 0) {
    throw new Error("buildSetArgv: path is required");
  }
  const argv: string[] = ["set", options.file, options.path];
  if (options.props !== undefined) {
    for (const [key, value] of Object.entries(options.props)) {
      argv.push("--prop", `${key}=${value}`);
    }
  }
  if (options.find !== undefined && options.find.length > 0) argv.push("--find", options.find);
  if (options.replace !== undefined && options.replace.length > 0) {
    argv.push("--replace", options.replace);
  }
  if (options.force) argv.push("--force");
  if (options.json) argv.push("--json");
  return argv;
}

// --- add --------------------------------------------------------------------

export interface AddArgvOptions {
  readonly file: string;
  readonly parent: string;
  readonly type?: string;
  readonly from?: string;
  readonly index?: number;
  readonly after?: string;
  readonly before?: string;
  readonly props?: Record<string, string>;
  readonly force?: boolean;
  readonly json?: boolean;
}

export function buildAddArgv(options: AddArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildAddArgv: file is required");
  }
  if (options.parent.length === 0) {
    throw new Error("buildAddArgv: parent is required");
  }
  const argv: string[] = ["add", options.file, options.parent];
  if (options.type !== undefined && options.type.length > 0) argv.push("--type", options.type);
  if (options.from !== undefined && options.from.length > 0) argv.push("--from", options.from);
  if (options.index !== undefined) argv.push("--index", String(options.index));
  if (options.after !== undefined && options.after.length > 0) argv.push("--after", options.after);
  if (options.before !== undefined && options.before.length > 0) argv.push("--before", options.before);
  if (options.props !== undefined) {
    for (const [key, value] of Object.entries(options.props)) {
      argv.push("--prop", `${key}=${value}`);
    }
  }
  if (options.force) argv.push("--force");
  if (options.json) argv.push("--json");
  return argv;
}

// --- remove -----------------------------------------------------------------

export interface RemoveArgvOptions {
  readonly file: string;
  readonly path: string;
  readonly shift?: "left" | "up";
  readonly props?: Record<string, string>;
  readonly json?: boolean;
}

export function buildRemoveArgv(options: RemoveArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildRemoveArgv: file is required");
  }
  if (options.path.length === 0) {
    throw new Error("buildRemoveArgv: path is required");
  }
  const argv: string[] = ["remove", options.file, options.path];
  if (options.shift !== undefined) argv.push("--shift", options.shift);
  if (options.props !== undefined) {
    for (const [key, value] of Object.entries(options.props)) {
      argv.push("--prop", `${key}=${value}`);
    }
  }
  if (options.json) argv.push("--json");
  return argv;
}

// --- move -------------------------------------------------------------------

export interface MoveArgvOptions {
  readonly file: string;
  readonly path: string;
  readonly to?: string;
  readonly index?: number;
  readonly after?: string;
  readonly before?: string;
  readonly props?: Record<string, string>;
  readonly json?: boolean;
}

export function buildMoveArgv(options: MoveArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildMoveArgv: file is required");
  }
  if (options.path.length === 0) {
    throw new Error("buildMoveArgv: path is required");
  }
  const argv: string[] = ["move", options.file, options.path];
  if (options.to !== undefined && options.to.length > 0) argv.push("--to", options.to);
  if (options.index !== undefined) argv.push("--index", String(options.index));
  if (options.after !== undefined && options.after.length > 0) argv.push("--after", options.after);
  if (options.before !== undefined && options.before.length > 0) argv.push("--before", options.before);
  if (options.props !== undefined) {
    for (const [key, value] of Object.entries(options.props)) {
      argv.push("--prop", `${key}=${value}`);
    }
  }
  if (options.json) argv.push("--json");
  return argv;
}

// --- swap -------------------------------------------------------------------

export interface SwapArgvOptions {
  readonly file: string;
  readonly path1: string;
  readonly path2: string;
  readonly json?: boolean;
}

export function buildSwapArgv(options: SwapArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildSwapArgv: file is required");
  }
  if (options.path1.length === 0) {
    throw new Error("buildSwapArgv: path1 is required");
  }
  if (options.path2.length === 0) {
    throw new Error("buildSwapArgv: path2 is required");
  }
  const argv: string[] = ["swap", options.file, options.path1, options.path2];
  if (options.json) argv.push("--json");
  return argv;
}

// --- validate ---------------------------------------------------------------

export interface ValidateArgvOptions {
  readonly file: string;
  readonly json?: boolean;
}

export function buildValidateArgv(options: ValidateArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildValidateArgv: file is required");
  }
  const argv: string[] = ["validate", options.file];
  if (options.json) argv.push("--json");
  return argv;
}

// --- dump -------------------------------------------------------------------

export interface DumpArgvOptions {
  readonly file: string;
  readonly path?: string;
  readonly format?: string;
  readonly out?: string;
  readonly json?: boolean;
}

export function buildDumpArgv(options: DumpArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildDumpArgv: file is required");
  }
  const argv: string[] = ["dump", options.file];
  if (options.path !== undefined && options.path.length > 0) argv.push(options.path);
  if (options.format !== undefined && options.format.length > 0) {
    argv.push("--format", options.format);
  }
  if (options.out !== undefined && options.out.length > 0) argv.push("--out", options.out);
  if (options.json) argv.push("--json");
  return argv;
}

// --- merge ------------------------------------------------------------------

export interface MergeArgvOptions {
  readonly template: string;
  readonly output: string;
  /** JSON data string OR path to a .json file. */
  readonly data: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export function buildMergeArgv(options: MergeArgvOptions): string[] {
  if (options.template.length === 0) {
    throw new Error("buildMergeArgv: template is required");
  }
  if (options.output.length === 0) {
    throw new Error("buildMergeArgv: output is required");
  }
  if (options.data.length === 0) {
    throw new Error("buildMergeArgv: data is required");
  }
  const argv: string[] = ["merge", options.template, options.output];
  argv.push("--data", options.data);
  if (options.force) argv.push("--force");
  if (options.json) argv.push("--json");
  return argv;
}

// --- raw --------------------------------------------------------------------

export interface RawArgvOptions {
  readonly file: string;
  readonly part?: string;
  readonly start?: number;
  readonly end?: number;
  readonly cols?: string;
  readonly json?: boolean;
}

export function buildRawArgv(options: RawArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildRawArgv: file is required");
  }
  const argv: string[] = ["raw", options.file];
  if (options.part !== undefined && options.part.length > 0) argv.push(options.part);
  if (options.start !== undefined) argv.push("--start", String(options.start));
  if (options.end !== undefined) argv.push("--end", String(options.end));
  if (options.cols !== undefined && options.cols.length > 0) argv.push("--cols", options.cols);
  if (options.json) argv.push("--json");
  return argv;
}

// --- raw-set ----------------------------------------------------------------

export interface RawSetArgvOptions {
  readonly file: string;
  readonly part: string;
  readonly xpath: string;
  readonly action: RawSetAction;
  readonly xml?: string;
  readonly json?: boolean;
}

export function buildRawSetArgv(options: RawSetArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildRawSetArgv: file is required");
  }
  if (options.part.length === 0) {
    throw new Error("buildRawSetArgv: part is required");
  }
  if (options.xpath.length === 0) {
    throw new Error("buildRawSetArgv: xpath is required");
  }
  const argv: string[] = ["raw-set", options.file, options.part];
  argv.push("--xpath", options.xpath);
  argv.push("--action", options.action);
  if (options.xml !== undefined && options.xml.length > 0) argv.push("--xml", options.xml);
  if (options.json) argv.push("--json");
  return argv;
}

// --- add-part ---------------------------------------------------------------

export interface AddPartArgvOptions {
  readonly file: string;
  readonly parent: string;
  readonly type: string;
  readonly json?: boolean;
}

export function buildAddPartArgv(options: AddPartArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildAddPartArgv: file is required");
  }
  if (options.parent.length === 0) {
    throw new Error("buildAddPartArgv: parent is required");
  }
  if (options.type.length === 0) {
    throw new Error("buildAddPartArgv: type is required");
  }
  const argv: string[] = ["add-part", options.file, options.parent];
  argv.push("--type", options.type);
  if (options.json) argv.push("--json");
  return argv;
}

// --- close ------------------------------------------------------------------

export interface CloseArgvOptions {
  readonly file: string;
  readonly json?: boolean;
}

export function buildCloseArgv(options: CloseArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildCloseArgv: file is required");
  }
  const argv: string[] = ["close", options.file];
  if (options.json) argv.push("--json");
  return argv;
}

// --- open (Wave 2a) ---------------------------------------------------------
//
// `officecli open <file> [--json]` — start a resident process to keep the
// document in memory for faster subsequent commands. The binary exposes no
// other flags on this verb (probed via `officecli help open`).

export interface OpenArgvOptions {
  readonly file: string;
  readonly json?: boolean;
}

export function buildOpenArgv(options: OpenArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildOpenArgv: file is required");
  }
  const argv: string[] = ["open", options.file];
  if (options.json) argv.push("--json");
  return argv;
}

// --- save (Wave 2a) ---------------------------------------------------------
//
// `officecli save <file> [--json]` — flush in-memory changes to disk, keeping
// the resident running. Run before a non-officecli program reads the file.

export interface SaveArgvOptions {
  readonly file: string;
  readonly json?: boolean;
}

export function buildSaveArgv(options: SaveArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildSaveArgv: file is required");
  }
  const argv: string[] = ["save", options.file];
  if (options.json) argv.push("--json");
  return argv;
}

// --- refresh (Wave 2a) ------------------------------------------------------
//
// `officecli refresh <file> [--json]` — recalculate derived field values
// (TOC page numbers, PAGE/NUMPAGES, cross-references). Word + Windows required
// for .docx; we still build the argv on other platforms so the caller can
// surface the binary's own error envelope.

export interface RefreshArgvOptions {
  readonly file: string;
  readonly json?: boolean;
}

export function buildRefreshArgv(options: RefreshArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildRefreshArgv: file is required");
  }
  const argv: string[] = ["refresh", options.file];
  if (options.json) argv.push("--json");
  return argv;
}

// --- help (Wave 2a) ---------------------------------------------------------
//
// `officecli help <format> [<verb>] [<element>] [--json]` — schema-driven
// capability reference. `<format>` is required (docx/xlsx/pptx). The optional
// `<verb>` precedes `<element>` when both are present (e.g. `help docx add
// paragraph`). `--json` emits the raw schema JSON for the resolved target.

export type OfficeHelpFormat = "docx" | "xlsx" | "pptx";

export interface HelpArgvOptions {
  readonly format: OfficeHelpFormat;
  /** Verb filter (e.g. "add", "set", "get"). When present, placed before `element`. */
  readonly verb?: string;
  /** Element name (e.g. "paragraph", "cell", "slide"). */
  readonly element?: string;
  readonly json?: boolean;
}

export function buildHelpArgv(options: HelpArgvOptions): string[] {
  if (options.format.length === 0) {
    throw new Error("buildHelpArgv: format is required");
  }
  const argv: string[] = ["help", options.format];
  if (options.verb !== undefined && options.verb.length > 0) {
    argv.push(options.verb);
  }
  if (options.element !== undefined && options.element.length > 0) {
    argv.push(options.element);
  }
  if (options.json) argv.push("--json");
  return argv;
}

// ============================================================================
// Runner factory — wires runOfficeCliRaw to a resolved binary path
// ============================================================================

export function makeOfficeCreateRun(options: {
  binaryPath: string;
  timeoutMs?: number;
}): OfficeCreateRunFn {
  return async (argv: readonly string[]): Promise<OfficeCliRunResult> => {
    return runOfficeCliRaw({
      binaryPath: options.binaryPath,
      argv,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  };
}

// ============================================================================
// High-level: generateOffice — create blank → batch → close → bytes
// ============================================================================

export interface GenerateOfficeOptions {
  /** Output filename, e.g. "report.docx". Extension determines the type. */
  readonly fileName: string;
  /** Batch commands to apply after create. May be empty. */
  readonly commands?: readonly OfficeBatchCommand[];
  /** Injectable runner (required). */
  readonly run: OfficeCreateRunFn;
  /** Optional locale tag (e.g. "en-US", "ja"). */
  readonly locale?: string;
  /** Overwrite if the file exists. Defaults to true. */
  readonly force?: boolean;
  /** Skip Word's Normal.dotm-style baseline (docx only). */
  readonly minimal?: boolean;
  /** Override the temp directory root. Defaults to os.tmpdir(). */
  readonly tempDirRoot?: string;
}

export interface GenerateOfficeResult {
  /** Generated Office document bytes. */
  readonly bytes: Buffer;
  /** Absolute path to the generated file inside the (now-cleaned-up) scratch dir. */
  readonly path: string;
  /** Inferred document type. */
  readonly type: OfficeDocType;
}

/**
 * Headlessly generate an Office document: create a blank file (type inferred
 * from `fileName`'s extension) → apply an array of batch commands → close →
 * return the bytes. The file is written to a unique scratch directory that is
 * always cleaned up, even on failure.
 *
 * Non-zero exits and OfficeCLI structured error envelopes are mapped to a
 * typed `OfficeCreateError`.
 */
export async function generateOffice(options: GenerateOfficeOptions): Promise<GenerateOfficeResult> {
  if (typeof options.fileName !== "string" || options.fileName.trim().length === 0) {
    throw new OfficeCreateError("fileName is required", { code: "INVALID_FILENAME" });
  }
  const fileName = sanitizeOfficeFileName(options.fileName);
  if (fileName.length === 0) {
    throw new OfficeCreateError("fileName is required", { code: "INVALID_FILENAME" });
  }
  const type = inferOfficeDocType(fileName);
  if (type === null) {
    throw new OfficeCreateError(
      `unsupported Office document extension for fileName '${options.fileName}'`,
      { code: "UNSUPPORTED_TYPE" },
    );
  }

  const tempRoot = options.tempDirRoot ?? tmpdir();
  const scratchDir = mkdtempSync(join(tempRoot, "office-create-"));
  const docPath = join(scratchDir, fileName);

  const force = options.force ?? true;
  const commands = options.commands ?? [];

  try {
    await assertCreateSuccess(
      options.run(
        buildCreateArgv({
          file: docPath,
          type,
          ...(options.locale !== undefined ? { locale: options.locale } : {}),
          force,
          ...(options.minimal === true ? { minimal: true } : {}),
          json: true,
        }),
      ),
    );

    if (commands.length > 0) {
      await assertBatchSuccess(
        options.run(
          buildBatchArgv({
            file: docPath,
            commands,
            stopOnError: true,
            json: true,
          }),
        ),
      );
    }

    await assertCloseSuccess(
      options.run(buildCloseArgv({ file: docPath, json: true })),
    );

    return {
      bytes: readFileSync(docPath),
      path: docPath,
      type,
    };
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; preserve the original error.
    }
  }
}

// ============================================================================
// High-level: renderOffice — view screenshot/html/issues
// ============================================================================

export interface RenderOfficeOptions {
  /** Absolute path to an existing Office document. */
  readonly file: string;
  /** Injectable runner (required). */
  readonly run: OfficeCreateRunFn;
  /**
   * Run `view screenshot` for each page in `screenshotPages` and return PNG
   * bytes. Defaults to false.
   */
  readonly screenshot?: boolean;
  /** `--page` value passed to screenshot (e.g. "1", "1-5", "1,3,5"). Defaults to "1". */
  readonly screenshotPages?: string;
  /** Screenshot viewport width (defaults to the binary's default 1600). */
  readonly screenshotWidth?: number;
  /** Screenshot viewport height (defaults to the binary's default 1200). */
  readonly screenshotHeight?: number;
  /** Tile pages into a contact sheet. Pass "auto" or a column count string. */
  readonly screenshotGrid?: string;
  /**
   * Output directory for screenshot PNGs. When set, screenshots are written
   * there by the binary (one file per page) and read back as bytes. When
   * omitted, a unique scratch directory is created and cleaned up.
   */
  readonly screenshotOutDir?: string;
  /** Run `view html` and return the standalone HTML string. Defaults to false. */
  readonly html?: boolean;
  /** Run `view issues --json` and return the parsed JSON envelope. Defaults to false. */
  readonly issues?: boolean;
  /** Optional issue type filter (e.g. "format", "content", "structure"). */
  readonly issuesType?: string;
  /** Override the temp directory root for screenshot output. Defaults to os.tmpdir(). */
  readonly tempDirRoot?: string;
}

export interface RenderOfficeScreenshot {
  /** Page label as returned by the binary (e.g. "1", "2"). */
  readonly page: string;
  /** PNG bytes for the page. */
  readonly bytes: Buffer;
  /** Absolute path where the screenshot was written. */
  readonly path: string;
}

export interface RenderOfficeResult {
  readonly screenshots: readonly RenderOfficeScreenshot[];
  readonly html: string | null;
  readonly issues: OfficeCliIssuesEnvelope | null;
}

/**
 * OfficeCLI `view issues --json` envelope shape (subset). The binary returns
 * `{ success, data: { counts, issues } }`; we expose the parsed object as-is
 * for the Wave-2 agent tool to inspect.
 */
export interface OfficeCliIssuesEnvelope {
  readonly success: boolean;
  readonly data?: {
    readonly counts?: Record<string, number>;
    readonly issues?: readonly unknown[];
  };
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Render an existing Office document via `view screenshot` / `view html` /
 * `view issues`. Each enabled mode produces a slice of the result; disabled
 * modes return `null` (html/issues) or `[]` (screenshots). The screenshot
 * scratch directory is always cleaned up unless `screenshotOutDir` is set.
 */
export async function renderOffice(options: RenderOfficeOptions): Promise<RenderOfficeResult> {
  if (options.file.length === 0) {
    throw new OfficeCreateError("file is required", { code: "INVALID_FILENAME" });
  }

  const wantScreenshots = options.screenshot === true;
  const wantHtml = options.html === true;
  const wantIssues = options.issues === true;

  if (!wantScreenshots && !wantHtml && !wantIssues) {
    return { screenshots: [], html: null, issues: null };
  }

  const tempRoot = options.tempDirRoot ?? tmpdir();
  const scratchDir = options.screenshotOutDir ?? mkdtempSync(join(tempRoot, "office-render-"));
  const ownsScratch = options.screenshotOutDir === undefined;

  try {
    const screenshots: RenderOfficeScreenshot[] = [];
    if (wantScreenshots) {
      const pages = parseScreenshotPages(options.screenshotPages ?? "1");
      for (const page of pages) {
        const outPath = join(scratchDir, `page-${page}.png`);
        const result = await options.run(
          buildViewArgv({
            file: options.file,
            mode: "screenshot",
            page,
            out: outPath,
            ...(options.screenshotWidth !== undefined ? { screenshotWidth: options.screenshotWidth } : {}),
            ...(options.screenshotHeight !== undefined ? { screenshotHeight: options.screenshotHeight } : {}),
            ...(options.screenshotGrid !== undefined ? { grid: options.screenshotGrid } : {}),
            json: true,
          }),
        );
        if (result.exitCode !== 0) {
          throw new OfficeCreateError(
            `officecli view screenshot failed for page ${page}: exit ${result.exitCode}`,
            {
              code: "OFFICECLI_RENDER_FAILED",
              exitCode: result.exitCode,
              stderr: result.stderr,
              ...extractCliErrorKind(result.stdout),
            },
          );
        }
        screenshots.push({
          page,
          bytes: readFileSync(outPath),
          path: outPath,
        });
      }
    }

    let html: string | null = null;
    if (wantHtml) {
      const result = await options.run(
        buildViewArgv({ file: options.file, mode: "html", json: false }),
      );
      if (result.exitCode !== 0) {
        throw new OfficeCreateError(
          `officecli view html failed: exit ${result.exitCode}`,
          {
            code: "OFFICECLI_RENDER_FAILED",
            exitCode: result.exitCode,
            stderr: result.stderr,
            ...extractCliErrorKind(result.stdout),
          },
        );
      }
      html = result.stdout;
    }

    let issues: OfficeCliIssuesEnvelope | null = null;
    if (wantIssues) {
      const result = await options.run(
        buildViewArgv({
          file: options.file,
          mode: "issues",
          ...(options.issuesType !== undefined ? { type: options.issuesType } : {}),
          json: true,
        }),
      );
      if (result.exitCode !== 0) {
        throw new OfficeCreateError(
          `officecli view issues failed: exit ${result.exitCode}`,
          {
            code: "OFFICECLI_RENDER_FAILED",
            exitCode: result.exitCode,
            stderr: result.stderr,
            ...extractCliErrorKind(result.stdout),
          },
        );
      }
      issues = parseIssuesEnvelope(result.stdout);
    }

    return { screenshots, html, issues };
  } finally {
    if (ownsScratch) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; preserve the original error.
      }
    }
  }
}

// ============================================================================
// Internals — assertion helpers + envelope parsing
// ============================================================================

async function assertCreateSuccess(resultPromise: Promise<OfficeCliRunResult>): Promise<OfficeCliRunResult> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new OfficeCreateError(`officecli create failed: exit ${result.exitCode}`, {
      code: "OFFICECLI_CREATE_FAILED",
      exitCode: result.exitCode,
      stderr: result.stderr,
      ...extractCliErrorKind(result.stdout),
    });
  }
  return result;
}

async function assertCloseSuccess(resultPromise: Promise<OfficeCliRunResult>): Promise<OfficeCliRunResult> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new OfficeCreateError(`officecli close failed: exit ${result.exitCode}`, {
      code: "OFFICECLI_CLOSE_FAILED",
      exitCode: result.exitCode,
      stderr: result.stderr,
      ...extractCliErrorKind(result.stdout),
    });
  }
  return result;
}

async function assertBatchSuccess(resultPromise: Promise<OfficeCliRunResult>): Promise<void> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new OfficeCreateError(`officecli batch failed: exit ${result.exitCode}${formatOfficeCliOutput(result)}`, {
      code: "OFFICECLI_BATCH_FAILED",
      exitCode: result.exitCode,
      stderr: result.stderr,
      ...extractCliErrorKind(result.stdout),
    });
  }
  const envelope = parseBatchEnvelope(result.stdout);
  if (envelope.summaryFailed > 0) {
    const cliErrorKind = envelope.cliErrorKind;
    throw new OfficeCreateError(
      `officecli batch reported ${envelope.summaryFailed} failed command(s)`,
      {
        code: "OFFICECLI_BATCH_FAILED",
        stderr: result.stdout,
        ...(cliErrorKind !== undefined ? { cliErrorKind } : {}),
      },
    );
  }
}

function formatOfficeCliOutput(result: OfficeCliRunResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const parts = [
    stdout.length > 0 ? `stdout=${truncateCliOutput(stdout)}` : null,
    stderr.length > 0 ? `stderr=${truncateCliOutput(stderr)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** Shared bounded, whitespace-normalized OfficeCLI diagnostic text. */
export function truncateCliOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized;
}

interface ParsedBatchEnvelope {
  readonly summaryFailed: number;
  readonly cliErrorKind?: OfficeCliErrorKind;
}

function parseBatchEnvelope(stdout: string): ParsedBatchEnvelope {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { summaryFailed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // Non-JSON stdout on a zero exit is unexpected but not fatal — treat as
    // 0 failed since the binary itself reported success.
    return { summaryFailed: 0 };
  }
  const root = asRecord(parsed);
  if (root === null) return { summaryFailed: 0 };
  const errorKind = extractErrorKind(asRecord(root["error"]));
  if (root["success"] === false) {
    return {
      summaryFailed: 1,
      ...(errorKind !== undefined ? { cliErrorKind: errorKind } : {}),
    };
  }
  const data = asRecord(root["data"]);
  if (data === null) return { summaryFailed: 0 };
  const summary = asRecord(data["summary"]);
  if (summary === null) return { summaryFailed: 0 };
  const failed = readNumber(summary, "failed");
  return {
    summaryFailed: failed !== null ? failed : 0,
    ...(errorKind !== undefined ? { cliErrorKind: errorKind } : {}),
  };
}

function parseIssuesEnvelope(stdout: string): OfficeCliIssuesEnvelope {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { success: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { success: false, error: { message: "view issues stdout was not valid JSON" } };
  }
  const root = asRecord(parsed);
  if (root === null) {
    return { success: false, error: { message: "view issues stdout was not a JSON object" } };
  }
  const success = root["success"] !== false;
  const data = asRecord(root["data"]);
  const error = asRecord(root["error"]);
  return {
    success,
    ...(data !== null
      ? {
          data: {
            ...(data["counts"] !== undefined ? { counts: data["counts"] as Record<string, number> } : {}),
            ...(data["issues"] !== undefined ? { issues: data["issues"] as readonly unknown[] } : {}),
          },
        }
      : {}),
    ...(error !== null
      ? {
          error: {
            ...(typeof error["code"] === "string" ? { code: error["code"] } : {}),
            ...(typeof error["message"] === "string" ? { message: error["message"] } : {}),
          },
        }
      : {}),
  };
}

/**
 * Extract a typed `OfficeCliErrorKind` from a stdout envelope, if any. Used
 * to surface the binary's structured `not_found`/`invalid_value`/… codes on
 * non-zero exits and batch failures.
 */
function extractCliErrorKind(stdout: string): { cliErrorKind?: OfficeCliErrorKind } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
  const root = asRecord(parsed);
  if (root === null) return {};
  const kind = extractErrorKind(asRecord(root["error"]));
  return kind === undefined ? {} : { cliErrorKind: kind };
}

function extractErrorKind(error: Record<string, unknown> | null): OfficeCliErrorKind | undefined {
  if (error === null) return undefined;
  const code = readString(error, "code");
  if (code === null) return undefined;
  if (isOfficeCliErrorKind(code)) return code;
  return "unknown";
}

function isOfficeCliErrorKind(value: string): value is OfficeCliErrorKind {
  return (
    value === "not_found" ||
    value === "invalid_value" ||
    value === "unsupported_property" ||
    value === "unsupported_operation" ||
    value === "schema_validation" ||
    value === "io"
  );
}

/**
 * Expand a `--page` value (e.g. "1", "1-3", "1,3,5") into a list of
 * individual page labels. Comma-separated ranges are expanded in order.
 */
function parseScreenshotPages(spec: string): string[] {
  return parseScreenshotPagesImpl(spec);
}

/** @internal Exported for unit testing only. */
export function parseScreenshotPagesForTest(spec: string): string[] {
  return parseScreenshotPagesImpl(spec);
}

function parseScreenshotPagesImpl(spec: string): string[] {
  if (spec.length === 0) return ["1"];
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const dash = trimmed.indexOf("-");
    if (dash < 0) {
      out.push(trimmed);
      continue;
    }
    const lo = parseInt(trimmed.slice(0, dash), 10);
    const hi = parseInt(trimmed.slice(dash + 1), 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      out.push(trimmed);
      continue;
    }
    for (let i = lo; i <= hi; i += 1) out.push(String(i));
  }
  return out.length > 0 ? out : ["1"];
}

/**
 * Reduce a user-supplied filename to a safe basename. Strips path separators
 * and replaces anything that isn't a word char, dot, dash, or underscore.
 * Falls back to "document.<ext>" when the stem is empty.
 */
function sanitizeOfficeFileName(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  const cleaned = base.replace(/[^\w.-]+/g, "_");
  if (cleaned.length === 0) return "";
  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0) {
    // No extension or leading-dot file — caller will surface UNSUPPORTED_TYPE.
    return cleaned;
  }
  return cleaned;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
