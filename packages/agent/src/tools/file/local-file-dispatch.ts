/**
 * M206 — one typed `local-file` relay dispatch per unified `file` command.
 */

import { resolveServerPosture } from "@nautilo/config";
import { buildRelaySandboxProfile } from "../../relay/sandbox-profile-builder";
import * as path from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import {
  parseRelaySearchArgs,
  type RelayLocalFileOperation,
  type RelayLocalFileRequest,
  type RelaySandboxProfile,
} from "@nautilo/relay";
import { getRelayRegistry } from "../../nodes/tools";
import type { FileToolRawArgs } from "./schema";
import type { ZoneContext } from "./zones";
import {
  isLocalFileZone,
  isMutatingLocalFileCommand,
  localFileReadOperation,
  resolveLocalFileRelay,
  resolveFocusedRelayHintForPath,
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  RELAY_OWNERSHIP_MISMATCH,
  type RelayDesktopFilesystemGrantRequest,
} from "./local-file-routing";
import { getRequiredOrdinaryHostContext } from "../../runtime/ordinary-host-dispatch-context";
import {
  LOCAL_HISTORY_INPUT_REQUIRED,
  resolveLocalHistoryRouting,
} from "./local-history-routing";
import { rejectIfOpenInWriter } from "./live-review-write-guard";
import { fileToolError } from "./file-result-status";

export interface LocalFileDispatchContext {
  ownerId: string;
  agentId: string;
  turnId?: string | undefined;
  activeModelId?: string | undefined;
  zoneCtx: ZoneContext;
  /** Server four-verb approval already granted before tool execution. */
  approvalObtained: boolean;
  /** Trusted initial tool-call identity or an explicitly supplied retry identity. */
  mutationRequestId?: string | undefined;
}

const HISTORY_COMMANDS = new Set([
  "undo",
  "redo",
  "undo_turn",
  "list_revisions",
  "pin_revision",
  "unpin_revision",
]);

function commandArgsWithoutCommand(raw: FileToolRawArgs): Record<string, unknown> {
  const { command: _cmd, retryRequestId: _retryRequestId, ...rest } = raw;
  return rest as Record<string, unknown>;
}

function searchArgsFromRaw(raw: FileToolRawArgs): Record<string, unknown> {
  return {
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(raw.command === "glob" && typeof raw.pattern === "string"
      ? { pattern: raw.pattern }
      : {}),
    ...(raw.command === "grep" && typeof raw.query === "string"
      ? { query: raw.query }
      : {}),
    ...(raw.command === "grep" && typeof raw.glob === "string"
      ? { glob: raw.glob }
      : {}),
    ...(raw.lineRange !== undefined ? { lineRange: raw.lineRange } : {}),
    ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
    ...(raw.discoveryCursor !== undefined ? { discoveryCursor: raw.discoveryCursor } : {}),
    ...(raw.includeIgnored !== undefined ? { includeIgnored: raw.includeIgnored } : {}),
    ...(raw.hidden !== undefined ? { hidden: raw.hidden } : {}),
    ...(raw.caseMode !== undefined ? { caseMode: raw.caseMode } : {}),
  };
}

/**
 * D418 — resolve the canonical absolute path a structurally read-only local
 * file command (`read`/`list`/`stat`/`grep`) will touch on the relay machine,
 * so the selection seam can attach at most one advisory grant reference.
 *
 * Returns `undefined` — keeping the pre-D418 baseline (no envelope) — for any
 * command that is not read-only, any non-`current`/`absolute` zone, a missing
 * path, or a `current`-zone command with no absolute current folder to anchor
 * against. The result is always lexically normalized + absolute so it passes
 * the routing seam's canonical-path guard; the relay-local resolver reloads the
 * live grant store and decides the actual access.
 */
function resolveReadOnlyCandidatePath(
  raw: FileToolRawArgs,
  ctx: LocalFileDispatchContext,
): string | undefined {
  if (localFileReadOperation(raw.command) === undefined) return undefined;
  const zone = raw.zone;
  if (!isLocalFileZone(zone)) return undefined;
  const rawPath = raw.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

  if (zone === "absolute") {
    if (!path.isAbsolute(rawPath)) return undefined;
    return path.normalize(rawPath);
  }

  const currentFolder = ctx.zoneCtx.currentFolder;
  if (!currentFolder || !path.isAbsolute(currentFolder)) return undefined;
  return path.resolve(currentFolder, rawPath);
}

function buildOperation(
  raw: FileToolRawArgs,
  ctx: LocalFileDispatchContext,
  historyArgs?: Record<string, unknown>,
): RelayLocalFileOperation {
  const routing = {
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(ctx.mutationRequestId
      ? { mutationRequestId: ctx.mutationRequestId }
      : {}),
    ...(typeof raw.retryRequestId === "string"
      ? { mutationRetry: true }
      : {}),
    ...(ctx.activeModelId ? { activeModelId: ctx.activeModelId } : {}),
    currentFolder: ctx.zoneCtx.currentFolder ?? null,
    workspaceRoot: ctx.zoneCtx.workspaceRoot,
  };

  if (raw.command === "glob" || raw.command === "grep") {
    const zone = raw.zone;
    if (!isLocalFileZone(zone)) {
      throw new Error(`local-file search requires zone current|absolute (got ${String(zone)})`);
    }
    if (raw.command === "glob") {
      const parsed = parseRelaySearchArgs("glob", searchArgsFromRaw(raw));
      if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      return { kind: "search", command: "glob", zone, args: parsed.value, routing };
    }
    const parsed = parseRelaySearchArgs("grep", searchArgsFromRaw(raw));
    if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return { kind: "search", command: "grep", zone, args: parsed.value, routing };
  }

  if (HISTORY_COMMANDS.has(raw.command)) {
    const args = historyArgs ?? commandArgsWithoutCommand(raw);
    return {
      kind: "history",
      command: raw.command,
      args: { ...args, _routing: routing },
    };
  }

  const zone = raw.zone;
  if (!isLocalFileZone(zone)) {
    throw new Error(`local-file dispatch requires zone current|absolute (got ${String(zone)})`);
  }

  return {
    kind: "file",
    command: raw.command,
    zone,
    args: { ...commandArgsWithoutCommand(raw), _routing: routing },
  };
}

function formatRelayError(message: string, code?: string): string {
  if (code) return `Error: ${code}: ${message}`;
  return `Error: ${message}`;
}

function relayResultToToolOutput(result: unknown): string | ToolMessage {
  if (typeof result === "string") return result;
  if (
    result &&
    typeof result === "object" &&
    (result as { kind?: string }).kind === "toolMessage"
  ) {
    const r = result as {
      content: ToolMessage["content"];
      additional_kwargs?: ToolMessage["additional_kwargs"];
    };
    return new ToolMessage({
      content: r.content,
      tool_call_id: "local-file",
      name: "file",
      ...(r.additional_kwargs ? { additional_kwargs: r.additional_kwargs } : {}),
    });
  }
  return JSON.stringify(result);
}

const PATH_MUTATION_GATE_COMMANDS = new Set([
  "write",
  "insert",
  "str_replace",
  "delete",
  "move",
  "copy",
]);

function absoluteLocalCandidate(
  candidate: unknown,
  zone: unknown,
  ctx: LocalFileDispatchContext,
): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (zone === "absolute") {
    return path.isAbsolute(candidate) ? path.normalize(candidate) : null;
  }
  if (zone !== "current") return null;
  const currentFolder = ctx.zoneCtx.currentFolder;
  if (!currentFolder || !path.isAbsolute(currentFolder)) return null;
  return path.resolve(currentFolder, candidate);
}

/**
 * Enumerate every exact target a local mutation can change. The extra
 * destination/basename candidate mirrors mv/cp directory semantics without
 * trusting a server-side stat: the server canonicalizes both through the
 * already-selected relay and nonexistent candidates simply do not match.
 */
export function localMutationGateCandidatePaths(
  raw: FileToolRawArgs,
  ctx: LocalFileDispatchContext,
): readonly string[] {
  if (!PATH_MUTATION_GATE_COMMANDS.has(raw.command)) return [];
  const source = absoluteLocalCandidate(raw.path, raw.zone, ctx);

  if (raw.command !== "move" && raw.command !== "copy") {
    return source ? [source] : [];
  }

  const destinationZone = raw.destinationZone ?? raw.zone;
  const destination = absoluteLocalCandidate(raw.destinationPath, destinationZone, ctx);
  const candidates: string[] = [];
  if (raw.command === "move" && source) candidates.push(source);
  if (destination) {
    candidates.push(destination);
    if (source) candidates.push(path.join(destination, path.basename(source)));
  }
  return [...new Set(candidates)];
}

export function localMutationGateDirectoryCandidatePaths(
  raw: FileToolRawArgs,
  ctx: LocalFileDispatchContext,
): readonly string[] {
  if (raw.command === "move") {
    const source = absoluteLocalCandidate(raw.path, raw.zone, ctx);
    return source ? [source] : [];
  }
  if (raw.command === "delete" && raw.recursive === true) {
    const source = absoluteLocalCandidate(raw.path, raw.zone, ctx);
    return source ? [source] : [];
  }
  return [];
}

const LOCAL_HISTORY_RESTORE_COMMANDS = new Set(["undo", "redo", "undo_turn"]);
const LOCAL_HISTORY_IDENTITY_UNAVAILABLE = "local_history_identity_unavailable";

function historyIdentityFailure(message: string): string {
  return JSON.stringify({
    ok: false,
    status: LOCAL_HISTORY_IDENTITY_UNAVAILABLE,
    code: LOCAL_HISTORY_IDENTITY_UNAVAILABLE,
    message,
  });
}

function parseHistoryRevisionIdentities(result: unknown):
  | { ok: true; canonicalTargetIdentities: string[] }
  | { ok: false; message: string } {
  let parsed = result;
  if (typeof parsed === "string") {
    if (parsed.startsWith("Error:")) return { ok: false, message: parsed };
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return { ok: false, message: "Local history identity preflight returned invalid JSON." };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Local history identity preflight returned an invalid result." };
  }
  const record = parsed as Record<string, unknown>;
  if (record["error"] !== undefined) {
    return { ok: false, message: "Local history identity preflight was rejected." };
  }
  if (record["truncated"] === true) {
    return {
      ok: false,
      message: "Local history identity preflight was truncated; refusing a partial restore.",
    };
  }
  const revisions = record["revisions"];
  if (!Array.isArray(revisions) || revisions.length === 0) {
    return {
      ok: false,
      message: "Local history has no resolvable canonical target identity for this restore.",
    };
  }
  const canonicalTargetIdentities: string[] = [];
  for (const revision of revisions) {
    if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
      return { ok: false, message: "Local history returned a malformed revision target." };
    }
    const canonicalPath = (revision as Record<string, unknown>)["canonicalPath"];
    if (typeof canonicalPath !== "string" || canonicalPath.length === 0) {
      return {
        ok: false,
        message: "Local history revision is missing its canonical target identity.",
      };
    }
    canonicalTargetIdentities.push(canonicalPath);
  }
  return {
    ok: true,
    canonicalTargetIdentities: [...new Set(canonicalTargetIdentities)],
  };
}

async function resolveLocalHistoryMutationIdentities(input: {
  raw: FileToolRawArgs;
  ctx: LocalFileDispatchContext;
  relayId: string;
  allowedRoots: readonly string[];
  historyArgs: Record<string, unknown>;
  localFileDispatch: NonNullable<ReturnType<typeof getRelayRegistry>>["localFileDispatch"];
}): Promise<{ ok: true; canonicalTargetIdentities: string[] } | { ok: false; output: string }> {
  const { raw, ctx, historyArgs } = input;
  if (!LOCAL_HISTORY_RESTORE_COMMANDS.has(raw.command)) {
    return { ok: true, canonicalTargetIdentities: [] };
  }
  if (!input.localFileDispatch) {
    return {
      ok: false,
      output: historyIdentityFailure("Local history identity preflight is unavailable."),
    };
  }
  const mutationOperation = buildOperation(raw, ctx, historyArgs);
  if (mutationOperation.kind !== "history") {
    return {
      ok: false,
      output: historyIdentityFailure("Local history restore routing is unavailable."),
    };
  }
  const routing = mutationOperation.args["_routing"];
  if (!routing || typeof routing !== "object") {
    return {
      ok: false,
      output: historyIdentityFailure("Local history restore routing identity is unavailable."),
    };
  }
  const listArgs: Record<string, unknown> = {
    _routing: routing,
    limit: 200,
    ...(typeof historyArgs["zone"] === "string" ? { zone: historyArgs["zone"] } : {}),
  };
  if (raw.command === "undo_turn") {
    listArgs["revisionTurnId"] = raw.targetTurnId;
  } else {
    if (typeof historyArgs["path"] !== "string" || historyArgs["path"].length === 0) {
      return {
        ok: false,
        output: historyIdentityFailure("Local history restore target path is unavailable."),
      };
    }
    listArgs["path"] = historyArgs["path"];
  }
  const preflight = await input.localFileDispatch(
    input.relayId,
    {
      operation: {
        kind: "history",
        command: "list_revisions",
        args: listArgs,
      },
      allowedRoots: [...input.allowedRoots],
    },
    { mutating: false, approvalObtained: false },
  );
  if (!preflight.ok) {
    return {
      ok: false,
      output: historyIdentityFailure("Local history identity preflight failed safely."),
    };
  }
  const parsed = parseHistoryRevisionIdentities(preflight.result);
  return parsed.ok
    ? parsed
    : { ok: false, output: historyIdentityFailure(parsed.message) };
}

/**
 * Execute a unified `file` command through one `localFileDispatch` round-trip.
 */
function formatRoutingError(
  message: string,
  code?: string,
  hint?: string,
): string {
  if (code === LOCAL_HISTORY_INPUT_REQUIRED) {
    return JSON.stringify({
      error: LOCAL_HISTORY_INPUT_REQUIRED,
      message,
      ...(hint ? { hint } : {}),
    });
  }
  if (code) return `Error: ${code}: ${message}`;
  return `Error: ${message}`;
}

export async function executeLocalFileCommand(
  raw: FileToolRawArgs,
  ctx: LocalFileDispatchContext,
): Promise<string | ToolMessage> {
  if (raw.command === "glob" || raw.command === "grep") {
    const parsedSearch = raw.command === "glob"
      ? parseRelaySearchArgs("glob", searchArgsFromRaw(raw))
      : parseRelaySearchArgs("grep", searchArgsFromRaw(raw));
    if (!parsedSearch.ok) {
      return fileToolError(
        `Error: ${parsedSearch.error.code}: ${parsedSearch.error.message}`,
      );
    }
  }
  const historyRouting = resolveLocalHistoryRouting(raw, {
    currentFolder: ctx.zoneCtx.currentFolder ?? null,
  });
  if (historyRouting.kind === "error") {
    return fileToolError(formatRoutingError(
      historyRouting.message,
      historyRouting.code,
      historyRouting.hint,
    ));
  }

  const registry = getRelayRegistry();

  // D423 Phase 5 — when the model's `file` target maps to a focused local-file
  // ref, pin dispatch to that ref's exact originating relay. The hint is
  // private (AsyncLocalStorage-bound by the tools node); a miss is a non-event
  // and the existing current/absolute selection still applies.
  const focusHint = resolveFocusedRelayHintForPath({
    path: typeof raw.path === "string" ? raw.path : "",
    zone: isLocalFileZone(raw.zone) ? raw.zone : "absolute",
    currentFolder: ctx.zoneCtx.currentFolder ?? null,
  });
  const historyHint =
    historyRouting.kind === "local" ? historyRouting.relayIdHint : undefined;

  // A revision-ref hint and a focus-ref hint must agree on the relay. A
  // divergence means the file was re-focused onto a different device than the
  // one that recorded the edit — fail closed rather than dispatching to either.
  if (historyHint && focusHint && historyHint !== focusHint) {
    return fileToolError(formatRelayError(FOCUSED_RELAY_MISMATCH_MESSAGE, RELAY_OWNERSHIP_MISMATCH));
  }
  const requiredHost = getRequiredOrdinaryHostContext();
  const requiredHostHint = requiredHost?.relayId ?? null;
  const exactTaskDispatchOptions = requiredHost?.requiredRelaySessionId === undefined
      || requiredHost.requiredDesktopSessionId === undefined
      || requiredHost.requiredPairingGeneration === undefined
    ? {}
    : {
        requiredRelaySessionId: requiredHost.requiredRelaySessionId,
        requiredDesktopSessionId: requiredHost.requiredDesktopSessionId,
        requiredPairingGeneration: requiredHost.requiredPairingGeneration,
      };
  if (
    requiredHostHint &&
    ((historyHint && historyHint !== requiredHostHint) ||
      (focusHint && focusHint !== requiredHostHint))
  ) {
    return fileToolError(formatRelayError(FOCUSED_RELAY_MISMATCH_MESSAGE, RELAY_OWNERSHIP_MISMATCH));
  }
  const relayIdHint = requiredHostHint ?? historyHint ?? focusHint;

  const candidatePath = resolveReadOnlyCandidatePath(raw, ctx);
  const selection = resolveLocalFileRelay({
    command: raw.command,
    ownerId: ctx.ownerId,
    registry,
    ...(relayIdHint
      ? { relayIdHint, relayHintMismatchMessage: FOCUSED_RELAY_MISMATCH_MESSAGE }
      : {}),
    ...(candidatePath !== undefined ? { candidatePath } : {}),
  });
  if (!selection.ok) {
    return fileToolError(formatRelayError(selection.error, selection.code));
  }

  if (!registry?.localFileDispatch) {
    return fileToolError(formatRelayError(
      "file operations on zone=\"current\" or zone=\"absolute\" require the Nautilo desktop app with local file execution enabled.",
      "LOCAL_FILE_EXECUTION_UNSUPPORTED",
    ));
  }

  const mutating = isMutatingLocalFileCommand(raw.command);
  const coordinatorContentMutation =
    raw.command === "write" ||
    raw.command === "insert" ||
    raw.command === "str_replace";
  const guardedCandidates = localMutationGateCandidatePaths(raw, ctx);
  const guardedDirectories = localMutationGateDirectoryCandidatePaths(raw, ctx);
  if (
    !coordinatorContentMutation &&
    (guardedCandidates.length > 0 || guardedDirectories.length > 0)
  ) {
    const gateFailure = await rejectIfOpenInWriter({
      surface: "currentFolder",
      ownerId: ctx.ownerId,
      relayId: selection.relayId,
      ...(guardedCandidates.length > 0 ? { candidatePaths: guardedCandidates } : {}),
      ...(guardedDirectories.length > 0
        ? { directoryCandidatePaths: guardedDirectories }
        : {}),
    });
    if (gateFailure) return fileToolError(gateFailure);
  }
  const historyArgs =
    historyRouting.kind === "local" ? historyRouting.args : undefined;
  if (
    historyRouting.kind === "local" &&
    historyArgs &&
    LOCAL_HISTORY_RESTORE_COMMANDS.has(raw.command)
  ) {
    const identities = await resolveLocalHistoryMutationIdentities({
      raw,
      ctx,
      relayId: selection.relayId,
      allowedRoots: selection.allowedRoots,
      historyArgs,
      localFileDispatch: (relayId, request, options) =>
        registry.localFileDispatch!(relayId, request, {
          ...options,
          ...exactTaskDispatchOptions,
        }),
    });
    if (!identities.ok) return fileToolError(identities.output);
    const gateFailure = await rejectIfOpenInWriter({
      surface: "currentFolder",
      ownerId: ctx.ownerId,
      relayId: selection.relayId,
      canonicalTargetIdentities: identities.canonicalTargetIdentities,
    });
    if (gateFailure) return fileToolError(gateFailure);
  }
  const req: RelayLocalFileRequest = {
    operation: buildOperation(raw, ctx, historyArgs),
    allowedRoots: selection.allowedRoots,
  };

  // Search launches ripgrep through the Desktop sandbox. It bypasses the
  // generic tool-dispatch seam, so attach the same server-policy envelope here.
  // Desktop still revalidates local roots and grants before reading anything.
  let sandboxProfile: RelaySandboxProfile | undefined;
  if (req.operation.kind === "search") {
    const relayCaps = registry.getCapabilities(selection.relayId);
    const built = relayCaps == null ? null : buildRelaySandboxProfile({
      posture: resolveServerPosture(),
      relayCaps,
      currentFolder: ctx.zoneCtx.currentFolder,
    });
    if (built === null) {
      return fileToolError(formatRelayError(
        "File search could not start because Desktop has not supplied its security configuration. Reconnect Desktop to this server, then retry the search. No files were searched.",
        "LOCAL_FILE_SANDBOX_UNAVAILABLE",
      ));
    }
    sandboxProfile = built;
  }

  // D418 — carry the selected grant reference as OUTER dispatch/envelope
  // metadata (not inside the operation args). Typed here so the extra optional
  // field passes structurally through the narrower `ToolRelayRegistry` seam;
  // the InMemoryRelayRegistry reads it and forwards it on the relay:dispatch
  // message. Absent for mutating/ambiguous commands (no candidate → no
  // envelope), preserving the baseline.
  const dispatchOptions: {
    mutating: boolean;
    approvalObtained: boolean;
    sandboxProfile?: RelaySandboxProfile;
    desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest;
    requiredRelaySessionId?: string;
    requiredDesktopSessionId?: string;
    requiredPairingGeneration?: string;
  } = {
    mutating,
    ...(sandboxProfile === undefined ? {} : { sandboxProfile }),
    approvalObtained: mutating ? ctx.approvalObtained : false,
    ...(selection.desktopFilesystemGrantRequest
      ? { desktopFilesystemGrantRequest: selection.desktopFilesystemGrantRequest }
      : {}),
    ...exactTaskDispatchOptions,
  };

  const relayResult = await registry.localFileDispatch(
    selection.relayId,
    req,
    dispatchOptions,
  );

  if (!relayResult.ok) {
    return fileToolError(formatRelayError(relayResult.message, relayResult.code));
  }

  if (relayResult.result === undefined) {
    return JSON.stringify({ ok: true });
  }

  return relayResultToToolOutput(relayResult.result);
}
