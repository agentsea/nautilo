/**
 * M206 — Electron relay `local-file` execution class dispatcher.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  parseRelaySearchArgs,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayLocalFileRequest,
  type RelayLocalFileResult,
  type WorkspaceGuard,
} from "@nautilo/relay";
import type { Sandbox } from "@nautilo/sandbox";
import type { NativeSearchExecutor } from "@nautilo/relay/native-search";
import {
  createGuardedNodeAdapter,
  isPathContained,
} from "../local-file-history/file-adapter.ts";
import { LocalFileHistoryJournal } from "../local-file-history/journal.ts";
import { localFileHistoryDirPath } from "../paths.ts";
import {
  executeLocalFileCommand,
  formatCommittedContentMutation,
  type LocalFileCommandContext,
} from "./commands.ts";
import { executeLocalDocumentCommand, isMutatingDocumentCommand } from "./document-chunks.ts";
import { executeLocalHistoryCommand } from "./history.ts";
import {
  executeLocalOfficeOperation,
  type LocalOfficeCommandContext,
} from "./office.ts";
import { executeLocalSearchOperation } from "./search.ts";
import {
  findForbiddenExecutionField,
  rejectForbiddenTopLevelArgs,
  validateFileReadEncodingFields,
} from "./forbidden-payload.ts";
import {
  extractRouting,
  resolveLocalMutationTransactionId,
  resolveZonePath,
} from "./paths.ts";

function resolveJournalRootDir(override?: string): string {
  if (override) return override;
  return localFileHistoryDirPath();
}

function canonicalSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSemanticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "_routing" && key !== "retryRequestId")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalSemanticValue(child)]),
    );
  }
  return value;
}

function mutationSemanticDigest(
  operation: RelayLocalFileRequest["operation"],
  routingRoot: string | null,
  authorizedRoots: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      operation: canonicalSemanticValue(operation),
      routingRoot: routingRoot === null ? null : path.resolve(routingRoot),
      authorizedRoots: authorizedRoots.map((root) => path.resolve(root)).sort(),
    }))
    .digest("hex");
}

const MUTATING_OPS = new Set([
  "create",
  "write",
  "insert",
  "str_replace",
  "move",
  "copy",
  "delete",
  "undo",
  "redo",
  "undo_turn",
  "pin_revision",
  "unpin_revision",
]);

const FORBIDDEN_ARG_KEYS = new Set([
  "executable",
  "argv",
  "commandLine",
  "shell",
  "script",
  "binary",
  "cmd",
]);

function isMutatingLocalFileRequest(req: RelayLocalFileRequest): boolean {
  const op = req.operation;
  if (op.kind === "search") return false;
  if (op.kind === "history") return MUTATING_OPS.has(op.command);
  if (op.kind === "document") {
    return isMutatingDocumentCommand(op.command);
  }
  if (op.kind === "file") return MUTATING_OPS.has(op.command);
  if (op.kind === "office") {
    const wire = op.operation;
    const subkind = wire["subkind"];
    if (subkind === "convert") return true;
    if (subkind === "officeRun") return wire["mode"] === "write";
    if (subkind === "officecli") {
      const command = wire["command"];
      if (typeof command !== "string") return false;
      const readOnly = new Set(["view", "get", "query", "validate", "dump", "raw", "help"]);
      return !readOnly.has(command);
    }
  }
  return false;
}

function rejectForbiddenArgs(
  op: RelayLocalFileRequest["operation"],
  args: Record<string, unknown>,
): string | null {
  if (op.kind === "office") {
    const hit = findForbiddenExecutionField(args);
    return hit
      ? `local-file rejects arbitrary execution field: ${hit.replace("forbidden execution field: ", "")}`
      : null;
  }
  if (op.kind === "document") {
    for (const key of Object.keys(args)) {
      if (FORBIDDEN_ARG_KEYS.has(key)) {
        return `local-file rejects arbitrary execution field: ${key}`;
      }
    }
    return null;
  }
  if (op.kind === "file" && op.command === "read") {
    const encodingErr = validateFileReadEncodingFields(args);
    if (encodingErr) return `local-file rejects invalid read encoding: ${encodingErr}`;
    const hit = rejectForbiddenTopLevelArgs(args, { allowReadEncoding: true });
    return hit
      ? `local-file rejects arbitrary execution field: ${hit.replace("forbidden execution field: ", "")}`
      : null;
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_ARG_KEYS.has(key)) {
      return `local-file rejects arbitrary execution field: ${key}`;
    }
  }
  return null;
}

function parseLocalFileRequest(req: RelayDispatchRequest): RelayLocalFileRequest | null {
  if (req.toolName !== "local-file" || req.executionClass !== "local-file") return null;
  const raw = req.args;
  if (!raw || typeof raw !== "object") return null;
  const operation = raw["operation"];
  const allowedRoots = raw["allowedRoots"];
  if (!operation || typeof operation !== "object") return null;
  if (!Array.isArray(allowedRoots)) return null;
  const roots = allowedRoots.filter((x): x is string => typeof x === "string");
  return { operation: operation as RelayLocalFileRequest["operation"], allowedRoots: roots };
}

export interface LocalFileDispatchOptions {
  relayId: string;
  guard: WorkspaceGuard;
  onFsChange?: ((event: import("@nautilo/relay").RelayFsChangeEvent) => void) | undefined;
  /** Test hook — override journal root (defaults to Electron userData path). */
  journalRootDir?: string | undefined;
  /** Test hook — inject a preconfigured journal (e.g. failing storage). */
  journal?: LocalFileHistoryJournal | undefined;
  /** Test hook — inject desktop OfficeCLI runner (structured ops only). */
  officeRun?: import("@nautilo/config/officecli").OfficeCreateRunFn | undefined;
  officeBinaryPath?: string | undefined;
  /** Test hook — inject local markdown convert runner. */
  convertRunner?: import("./convert.ts").LocalConvertRunner | undefined;
  /** D448 agent OfficeCLI final-byte commit into the process-scoped coordinator. */
  officeCliCommit?: LocalOfficeCommandContext["officeCliCommit"] | undefined;
  /** D448 ordinary agent content commit into the process-scoped coordinator. */
  agentContentCommit?: LocalFileCommandContext["agentContentCommit"] | undefined;
  /** D448 structural agent commit into the process-scoped coordinator. */
  structuralCommit?: LocalFileCommandContext["structuralCommit"] | undefined;
  /** D448 canonical undo/redo commit into the process-scoped coordinator. */
  historyCommit?: LocalFileCommandContext["historyCommit"] | undefined;
  /**
   * D418 — validated local authority for a `desktopFilesystemGrantRequest` dispatch.
   * When present, its roots are the ONLY roots the guarded adapter may use;
   * the server-mirrored `parsed.allowedRoots` are never unioned in. When a
   * dispatch carries a `desktopFilesystemGrantRequest` but this is absent, the
   * dispatch fails closed.
   */
  desktopFilesystemAuthority?: { readonly roots: readonly string[] } | undefined;
  /** Existing per-dispatch Sandbox created by the relay envelope owner. */
  sandbox?: Sandbox | undefined;
  signal?: AbortSignal | undefined;
  /** Unit/integration seam; production uses the canonical Sandbox executor. */
  searchExecute?: NativeSearchExecutor | undefined;
  ripgrepRuntime?:
    | { readonly ok: true; readonly binaryPath: string; readonly version: string }
    | { readonly ok: false; readonly error: string }
    | undefined;
}

export async function handleLocalFileDispatch(
  req: RelayDispatchRequest,
  options: LocalFileDispatchOptions,
): Promise<RelayDispatchResult> {
  const parsed = parseLocalFileRequest(req);
  if (!parsed) {
    return {
      status: "error",
      error: "malformed local-file dispatch",
      errorCode: LOCAL_FILE_EXECUTION_UNSUPPORTED,
    };
  }

  let validatedOp = parsed.operation;

  if (validatedOp.kind === "search") {
    const rawSearchOp = validatedOp;
    if (rawSearchOp.command !== "glob" && rawSearchOp.command !== "grep") {
      return { status: "error", error: "local-file search has an invalid command" };
    }
    if (rawSearchOp.command === "glob") {
      const searchArgs = parseRelaySearchArgs("glob", rawSearchOp.args);
      if (!searchArgs.ok) {
        const payload: RelayLocalFileResult = {
          ok: false,
          code: searchArgs.error.code,
          message: searchArgs.error.message,
        };
        return { status: "ok", result: payload };
      }
      validatedOp = { ...rawSearchOp, command: "glob", args: searchArgs.value };
    } else {
      const searchArgs = parseRelaySearchArgs("grep", rawSearchOp.args);
      if (!searchArgs.ok) {
        const payload: RelayLocalFileResult = {
          ok: false,
          code: searchArgs.error.code,
          message: searchArgs.error.message,
        };
        return { status: "ok", result: payload };
      }
      validatedOp = { ...rawSearchOp, command: "grep", args: searchArgs.value };
    }
  }

  const routingArgs: Record<string, unknown> =
    validatedOp.kind === "file"
      ? validatedOp.args
      : validatedOp.kind === "document"
        ? validatedOp.args
        : validatedOp.kind === "history"
          ? validatedOp.args
          : validatedOp.kind === "search"
            ? { ...validatedOp.args }
            : validatedOp.operation;
  const forbidden = rejectForbiddenArgs(validatedOp, routingArgs);
  if (forbidden) {
    return { status: "error", error: forbidden };
  }

  const routing =
    validatedOp.kind === "office"
      ? extractRouting(validatedOp.operation)
      : validatedOp.kind === "search"
        ? extractRouting({ _routing: validatedOp.routing })
        : extractRouting(routingArgs);
  if (!routing) {
    return { status: "error", error: "local-file dispatch missing routing metadata" };
  }

  if (isMutatingLocalFileRequest({ ...parsed, operation: validatedOp }) && !req.approvalObtained) {
    return {
      status: "error",
      error: "local-file mutation requires approvalObtained=true from server",
    };
  }

  // D418 — a dispatch carrying a desktop-filesystem-grant request is jailed to the
  // locally validated authority ONLY. `parsed.allowedRoots` is an untrusted
  // server mirror and must never widen local filesystem authority for this
  // path. Baseline-only dispatches (no request) keep their preexisting union.
  let allowedRoots: string[];
  if (req.desktopFilesystemGrantRequest !== undefined) {
    if (!options.desktopFilesystemAuthority) {
      return {
        status: "error",
        error:
          "Desktop Filesystem Grant request requires locally validated authority; " +
          "server-provided roots cannot widen this dispatch",
      };
    }
    allowedRoots = [...new Set(options.desktopFilesystemAuthority.roots)];
  } else {
    allowedRoots = [...new Set([...options.guard.roots, ...parsed.allowedRoots])];
  }
  const adapter = createGuardedNodeAdapter({ allowedRoots });

  // Native search is read-only and has no revision-journal side effects. It
  // reuses the guarded adapter + already-created request Sandbox directly.
  if (validatedOp.kind === "search") {
    const searchResult =
      !options.sandbox
        ? {
            ok: false as const,
            command: validatedOp.command,
            error: {
              code: "SEARCH_UNAVAILABLE" as const,
              message: "The authorized search sandbox is unavailable.",
            },
          }
        : !options.ripgrepRuntime || !options.ripgrepRuntime.ok
          ? {
              ok: false as const,
              command: validatedOp.command,
              error: {
                code: "SEARCH_UNAVAILABLE" as const,
                message:
                  options.ripgrepRuntime?.error ??
                  "The packaged search runtime is unavailable.",
              },
            }
        : await executeLocalSearchOperation(validatedOp, {
            adapter,
            allowedRoots,
            routing,
            sandbox: options.sandbox,
            binaryPath: options.ripgrepRuntime.binaryPath,
            engineVersion: options.ripgrepRuntime.version,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.searchExecute ? { execute: options.searchExecute } : {}),
          });
    const payload: RelayLocalFileResult = { ok: true, result: searchResult };
    return { status: "ok", result: payload };
  }

  const journal =
    options.journal ??
    new LocalFileHistoryJournal({
      rootDir: resolveJournalRootDir(options.journalRootDir),
      relayId: options.relayId,
      fileAdapter: adapter,
    });
  // Ordinary reads/listing do not consume revision state. Keep them available
  // while an old, otherwise-safe journal awaits its one-time relay migration;
  // history commands and every mutation still fail closed on a mismatch.
  if (
    validatedOp.kind === "history" ||
    isMutatingLocalFileRequest({ ...parsed, operation: validatedOp })
  ) {
    await journal.init();
  }

  const cmdCtx = {
    adapter,
    signal: options.signal,
    journal,
    relayId: options.relayId,
    allowedRoots,
    routing,
    mutationSemanticDigest: mutationSemanticDigest(
      validatedOp,
      validatedOp.kind === "file" || validatedOp.kind === "document"
        ? validatedOp.zone === "current"
          ? routing.currentFolder
          : path.dirname(
              typeof validatedOp.args["path"] === "string"
                ? path.resolve(validatedOp.args["path"])
                : "/",
            )
        : null,
      allowedRoots,
    ),
    ...(options.agentContentCommit
      ? { agentContentCommit: options.agentContentCommit }
      : {}),
    ...(options.structuralCommit
      ? { structuralCommit: options.structuralCommit }
      : {}),
    ...(options.historyCommit ? { historyCommit: options.historyCommit } : {}),
  };

  if (
    routing.mutationRetry === true &&
    options.agentContentCommit &&
    ((validatedOp.kind === "file" &&
      ["create", "write", "insert", "str_replace"].includes(validatedOp.command)) ||
      (validatedOp.kind === "document" &&
        validatedOp.command === "write_commit"))
  ) {
    const zone = validatedOp.zone;
    const args = validatedOp.args;
    const rawPath = args["path"];
    if (typeof rawPath !== "string") {
      return { status: "error", error: "local file-tool retry is missing path" };
    }
    const resolved = resolveZonePath(zone, rawPath, routing);
    if (!resolved.ok) {
      return { status: "error", error: resolved.reason };
    }
    const lexicalTarget = path.resolve(resolved.resolved);
    const lexicallyAuthorized = allowedRoots.some((root) =>
      isPathContained(lexicalTarget, root)
    );
    if (!lexicallyAuthorized) {
      return {
        status: "error",
        error: "local file-tool retry target is outside authorized roots",
      };
    }
    const turnId = resolveLocalMutationTransactionId(routing);
    if (!turnId || !routing.mutationRequestId) {
      return {
        status: "error",
        error: "local file-tool retry is missing trusted mutation identity",
      };
    }
    const replay = await options.agentContentCommit({
      targetPath: lexicalTarget,
      authorizedRoots: allowedRoots,
      before: null,
      after: new Uint8Array(),
      agentId: routing.agentId,
      turnId,
      command: validatedOp.kind === "document"
        ? "document_write_commit"
        : validatedOp.command,
      mutationRequestId: routing.mutationRequestId,
      semanticDigest: cmdCtx.mutationSemanticDigest,
      replayOnly: true,
    });
    if (replay.ok) {
      const result = formatCommittedContentMutation(replay, {
        relayId: options.relayId,
        displayPath: resolved.displayPath,
        zone,
        command: validatedOp.kind === "document"
          ? "document_write_commit"
          : validatedOp.command,
        includeSha256: validatedOp.kind === "document" ||
          (validatedOp.kind === "file" &&
            (validatedOp.command === "create" || validatedOp.args["expectedSha256"] !== undefined || validatedOp.args["encoding"] === "base64")),
      });
      return { status: "ok", result: { ok: true, result } };
    }
    return {
      status: "ok",
      result: {
        ok: true,
        result: JSON.stringify({
          error: replay.code,
          message: replay.message,
          retryable: false,
        }),
      },
    };
  }

  try {
    let result: unknown;
    if (validatedOp.kind === "office") {
      const officeOutcome = await executeLocalOfficeOperation(validatedOp.operation, {
        adapter,
        allowedRoots,
        routing,
        ...(options.officeRun ? { officeRun: options.officeRun } : {}),
        ...(options.officeBinaryPath ? { binaryPath: options.officeBinaryPath } : {}),
        ...(options.convertRunner ? { convertRunner: options.convertRunner } : {}),
        ...(options.officeCliCommit ? { officeCliCommit: options.officeCliCommit } : {}),
      });
      if (!officeOutcome.ok) {
        const payload: RelayLocalFileResult = { ok: false, message: officeOutcome.message, ...(officeOutcome.code ? { code: officeOutcome.code } : {}) };
        return { status: "ok", result: payload };
      }
      result = officeOutcome.result;
    } else if (validatedOp.kind === "history") {
      result = await executeLocalHistoryCommand(validatedOp, cmdCtx);
    } else if (validatedOp.kind === "document") {
      result = await executeLocalDocumentCommand(validatedOp.command, validatedOp.zone, validatedOp.args, cmdCtx);
    } else {
      result = await executeLocalFileCommand(validatedOp.command, validatedOp.zone, validatedOp.args, cmdCtx);
    }

    const payload: RelayLocalFileResult = { ok: true, result };
    return { status: "ok", result: payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const payload: RelayLocalFileResult = { ok: false, message };
    return { status: "ok", result: payload };
  }
}
