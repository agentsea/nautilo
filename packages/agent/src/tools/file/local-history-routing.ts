/**
 * M206 — route zone-less history commands to the owning Electron relay.
 *
 * Workspace history stays on the server revision store. Local authority is
 * selected only when args carry an explicit local zone and/or a `local:<relayId>:<uuid>`
 * revision ref. Bare UUIDs remain server-scoped; insufficient local hints fail closed.
 */

import type { FileToolRawArgs } from "./schema";
import { isLocalFileZone } from "./local-file-routing";

export const LOCAL_REVISION_REF_PREFIX = "local:";

export const LOCAL_HISTORY_INPUT_REQUIRED = "local_history_input_required";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HISTORY_COMMANDS = new Set([
  "undo",
  "redo",
  "undo_turn",
  "list_revisions",
  "pin_revision",
  "unpin_revision",
]);

export interface ParsedLocalRevisionRef {
  relayId: string;
  revisionId: string;
}

export type LocalHistoryRoutingDecision =
  | { kind: "local"; relayIdHint?: string | undefined; args: Record<string, unknown> }
  | { kind: "server" }
  | { kind: "error"; code: string; message: string; hint?: string };

/** Optional turn context for disambiguating zone-less history commands. */
export interface LocalHistoryRoutingHints {
  currentFolder?: string | null;
}

function looksAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export function isHistoryCommand(command: string): boolean {
  return HISTORY_COMMANDS.has(command);
}

export function isLocalRevisionRef(ref: string): boolean {
  return ref.startsWith(LOCAL_REVISION_REF_PREFIX);
}

export function parseLocalRevisionRef(ref: string): ParsedLocalRevisionRef | null {
  if (!ref.startsWith(LOCAL_REVISION_REF_PREFIX)) return null;
  const body = ref.slice(LOCAL_REVISION_REF_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const relayId = body.slice(0, lastColon);
  const revisionId = body.slice(lastColon + 1);
  if (!relayId || !UUID_RE.test(revisionId)) return null;
  return { relayId, revisionId };
}

function commandArgsWithoutCommand(raw: FileToolRawArgs): Record<string, unknown> {
  const { command: _cmd, ...rest } = raw;
  return { ...rest };
}

function localInputRequired(message: string, hint: string): LocalHistoryRoutingDecision {
  return { kind: "error", code: LOCAL_HISTORY_INPUT_REQUIRED, message, hint };
}

function resolveListRevisionsRouting(
  raw: FileToolRawArgs,
  baseArgs: Record<string, unknown>,
): LocalHistoryRoutingDecision {
  const zone = raw.zone;
  if (isLocalFileZone(zone)) {
    return { kind: "local", args: baseArgs };
  }
  if (zone === "workspace") {
    return { kind: "server" };
  }

  const filterPath = raw.path;
  if (typeof filterPath === "string" && filterPath.length > 0) {
    if (looksAbsolutePath(filterPath)) {
      return { kind: "local", args: { ...baseArgs, zone: "absolute" } };
    }
    return localInputRequired(
      "list_revisions path filter for local files requires zone current|absolute",
      'Pass zone:"current" with a path relative to the open Current Folder, or ' +
        'zone:"absolute" with an absolute path. Omit both zone and path for workspace history.',
    );
  }

  return { kind: "server" };
}

function resolvePinRouting(
  raw: FileToolRawArgs,
  baseArgs: Record<string, unknown>,
): LocalHistoryRoutingDecision {
  const revisionId = raw.revisionId;
  if (typeof revisionId !== "string" || revisionId.length === 0) {
    return { kind: "server" };
  }
  const parsed = parseLocalRevisionRef(revisionId);
  if (parsed) {
    return { kind: "local", relayIdHint: parsed.relayId, args: baseArgs };
  }
  return { kind: "server" };
}

function resolveUndoTurnRouting(
  raw: FileToolRawArgs,
  baseArgs: Record<string, unknown>,
  hints?: LocalHistoryRoutingHints,
): LocalHistoryRoutingDecision {
  if (isLocalFileZone(raw.zone)) {
    return { kind: "local", args: baseArgs };
  }
  if (raw.zone === "workspace") {
    return { kind: "server" };
  }
  if (hints?.currentFolder) {
    return localInputRequired(
      "undo_turn without zone is ambiguous while a Current Folder is open",
      'Pass zone:"current" or zone:"absolute" to undo local file mutations on this device, ' +
        'or zone:"workspace" for artifact revisions. Omitting zone only routes to workspace ' +
        "history when no Current Folder is open.",
    );
  }
  return { kind: "server" };
}

function resolveUndoRedoRouting(
  raw: FileToolRawArgs,
  baseArgs: Record<string, unknown>,
): LocalHistoryRoutingDecision {
  if (isLocalFileZone(raw.zone)) {
    const revisionId = raw.revisionId;
    if (typeof revisionId === "string" && isLocalRevisionRef(revisionId)) {
      const parsed = parseLocalRevisionRef(revisionId);
      if (parsed) {
        return { kind: "local", relayIdHint: parsed.relayId, args: baseArgs };
      }
    }
    return { kind: "local", args: baseArgs };
  }

  const revisionId = raw.revisionId;
  if (typeof revisionId === "string" && isLocalRevisionRef(revisionId)) {
    return localInputRequired(
      "undo/redo with a local revision ref requires zone current|absolute and path",
      'Pass zone:"current" or zone:"absolute" with the file path that owns the local revision.',
    );
  }

  return { kind: "server" };
}

/**
 * Decide whether a history command should dispatch to the local relay journal
 * or remain on the workspace Postgres path.
 */
export function resolveLocalHistoryRouting(
  raw: FileToolRawArgs,
  hints?: LocalHistoryRoutingHints,
): LocalHistoryRoutingDecision {
  if (!isHistoryCommand(raw.command)) {
    return { kind: "server" };
  }

  const baseArgs = commandArgsWithoutCommand(raw);

  switch (raw.command) {
    case "list_revisions":
      return resolveListRevisionsRouting(raw, baseArgs);
    case "pin_revision":
    case "unpin_revision":
      return resolvePinRouting(raw, baseArgs);
    case "undo_turn":
      return resolveUndoTurnRouting(raw, baseArgs, hints);
    case "undo":
    case "redo":
      return resolveUndoRedoRouting(raw, baseArgs);
    default:
      return { kind: "server" };
  }
}

/**
 * True when `file-tool` must use `executeLocalFileCommand` instead of
 * `dispatchFileCommand` (Postgres / server filesystem).
 */
export function shouldRouteHistoryViaLocalRelay(
  raw: FileToolRawArgs,
  hints?: LocalHistoryRoutingHints,
): boolean {
  const decision = resolveLocalHistoryRouting(raw, hints);
  return decision.kind === "local";
}

/** True when routing resolved to a structured input-required error. */
export function isLocalHistoryRoutingError(
  raw: FileToolRawArgs,
  hints?: LocalHistoryRoutingHints,
): LocalHistoryRoutingDecision & { kind: "error" } | null {
  const decision = resolveLocalHistoryRouting(raw, hints);
  return decision.kind === "error" ? decision : null;
}
