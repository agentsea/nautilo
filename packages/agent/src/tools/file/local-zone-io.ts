/**
 * M206 Phase 3 — typed local-file read/write for convert and other local-zone I/O.
 *
 * Never touches server `node:fs/promises` for `current`/`absolute` paths.
 */

import {
  COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION,
  RELAY_MEDIA_CHUNK_BYTES,
  RELAY_MEDIA_MAX_BYTES,
  MEDIA_EXTRACTION_PROTOCOL_VERSION,
  type RelayLocalFileRequest,
} from "@nautilo/relay";
import { randomUUID } from "node:crypto";
import * as pathModule from "node:path";
import { getRelayRegistry } from "../../nodes/tools";
import {
  resolveLocalFileRelay,
  resolveFocusedRelayHintForPath,
  FOCUSED_RELAY_MISMATCH_MESSAGE,
} from "./local-file-routing";
import {
  LOCAL_HISTORY_INPUT_REQUIRED,
} from "./local-history-routing";
import type { ZoneContext } from "./zones";
import { rejectIfOpenInWriter } from "./live-review-write-guard";

export interface LocalZoneIoContext {
  ownerId: string;
  agentId: string;
  /** Active agent graph turn when invoked from an agent tool turn. */
  turnId?: string | undefined;
  /**
   * Host-issued UI/app mutation transaction id (`app:<appId>:<uuid>`).
   * Journaled as the revision grouping key; not an agent turn.
   */
  appOperationId?: string | undefined;
  /** Trusted, semantics-bound identity for the exact local content mutation. */
  mutationRequestId?: string | undefined;
  activeModelId?: string | undefined;
  zoneCtx: ZoneContext;
  approvalObtained: boolean;
}

export type LocalMutationTurnIdResult =
  | { ok: true; turnId: string; source: "agent_turn" | "app_operation" }
  | { ok: false; code: typeof LOCAL_HISTORY_INPUT_REQUIRED; message: string; hint: string };

/** Fail closed before local-file dispatch when a mutation lacks turn or app-operation context. */
export function requireLocalMutationTurnId(
  turnId: string | null | undefined,
  operation: string,
  appOperationId?: string | null,
): LocalMutationTurnIdResult {
  if (typeof turnId === "string" && turnId.length > 0) {
    return { ok: true, turnId, source: "agent_turn" };
  }
  if (typeof appOperationId === "string" && appOperationId.length > 0) {
    return { ok: true, turnId: appOperationId, source: "app_operation" };
  }
  return {
    ok: false,
    code: LOCAL_HISTORY_INPUT_REQUIRED,
    message:
      `${operation} requires an active agent turnId or host-issued appOperationId for local revision journaling.`,
    hint:
      "Invoke from an agent turn (turnId) or a UI/app-host operation that supplies appOperationId.",
  };
}

export function formatLocalMutationTurnIdError(
  result: Extract<LocalMutationTurnIdResult, { ok: false }>,
): string {
  return JSON.stringify({
    error: result.code,
    message: result.message,
    hint: result.hint,
  });
}

export type LocalZoneStatDetails = {
  exists: boolean;
  size: number | null;
  mimeType: string | null;
};

function buildRouting(ctx: LocalZoneIoContext) {
  return {
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(ctx.appOperationId ? { appOperationId: ctx.appOperationId } : {}),
    ...(ctx.mutationRequestId ? { mutationRequestId: ctx.mutationRequestId } : {}),
    ...(ctx.activeModelId ? { activeModelId: ctx.activeModelId } : {}),
    currentFolder: ctx.zoneCtx.currentFolder ?? null,
    workspaceRoot: ctx.zoneCtx.workspaceRoot,
  };
}

/**
 * D423 Phase 5 — resolve the exact originating relay for a local-zone path
 * when it maps to a focused local-file ref. Returns `undefined` when no hint
 * matches, so the caller falls back to the default current/absolute selection.
 */
function focusHintForPath(
  path: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
): string | undefined {
  return resolveFocusedRelayHintForPath({
    path,
    zone,
    currentFolder: ctx.zoneCtx.currentFolder ?? null,
  });
}

/** D423 Phase 5 — hint args for `resolveLocalFileRelay`, or `{}` to keep defaults. */
function hintArgs(
  hint: string | undefined,
): { relayIdHint: string; relayHintMismatchMessage: string } | Record<string, never> {
  return hint
    ? { relayIdHint: hint, relayHintMismatchMessage: FOCUSED_RELAY_MISMATCH_MESSAGE }
    : {};
}

function absoluteMutationCandidate(
  pathValue: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
): string | null {
  if (zone === "absolute") {
    return pathModule.isAbsolute(pathValue) ? pathModule.normalize(pathValue) : null;
  }
  const currentFolder = ctx.zoneCtx.currentFolder;
  if (!currentFolder || !pathModule.isAbsolute(currentFolder)) return null;
  return pathModule.resolve(currentFolder, pathValue);
}

async function dispatchLocalFile(
  req: RelayLocalFileRequest,
  ctx: LocalZoneIoContext,
  mutating: boolean,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
  const registry = getRelayRegistry();
  const command = req.operation.kind === "file" ? req.operation.command : "read";
  // D423 Phase 5 — pin to the focused ref's relay when the operation targets
  // a focused local path. The operation carries the model-facing zone + path
  // (stat/read/write/media_read_chunk all set args.path + zone).
  const op = req.operation;
  const opPath = op.kind === "file" ? (op.args as { path?: string } | undefined)?.path : undefined;
  const opZone = op.kind === "file" ? op.zone : undefined;
  const hint =
    typeof opPath === "string" && opZone
      ? focusHintForPath(opPath, opZone, ctx)
      : undefined;
  const selection = resolveLocalFileRelay({
    command,
    ownerId: ctx.ownerId,
    registry,
    ...hintArgs(hint),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error, code: selection.code };
  }
  if (!registry?.localFileDispatch) {
    return {
      ok: false,
      error: "local-file dispatch is unavailable on this server",
      code: "LOCAL_FILE_EXECUTION_UNSUPPORTED",
    };
  }
  if (
    mutating &&
    (registry.getProtocolVersion?.(selection.relayId) ?? 0) <
      COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      error: "Local writes require a v9 Nautilo desktop relay with coordinated mutation receipts.",
      code: "LOCAL_MUTATION_PROTOCOL_UNSUPPORTED",
    };
  }
  if (mutating && op.kind === "file" && typeof opPath === "string" && opZone) {
    const candidate = absoluteMutationCandidate(opPath, opZone, ctx);
    if (candidate) {
      const gateFailure = await rejectIfOpenInWriter({
        surface: "currentFolder",
        ownerId: ctx.ownerId,
        relayId: selection.relayId,
        candidatePaths: [candidate],
      });
      if (gateFailure) return { ok: false, error: gateFailure };
    }
  }

  const relayResult = await registry.localFileDispatch(selection.relayId, req, {
    mutating,
    approvalObtained: mutating ? ctx.approvalObtained : false,
  });
  if (!relayResult.ok) {
    return { ok: false, error: relayResult.message, ...(relayResult.code ? { code: relayResult.code } : {}) };
  }
  return { ok: true, result: relayResult.result };
}

export async function readLocalZoneBytes(
  path: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
  options: { requireBinary?: boolean } = {},
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const hint = focusHintForPath(path, zone, ctx);
  const selection = resolveLocalFileRelay({
    command: "read",
    ownerId: ctx.ownerId,
    registry: getRelayRegistry(),
    ...hintArgs(hint),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }

  const req: RelayLocalFileRequest = {
    operation: {
      kind: "file",
      command: "read",
      zone,
      args: { path, binary: true, _routing: buildRouting(ctx) },
    },
    allowedRoots: [...selection.allowedRoots],
  };

  const dispatched = await dispatchLocalFile(req, ctx, false);
  if (!dispatched.ok) return { ok: false, error: dispatched.error };

  const payload = dispatched.result;
  if (options.requireBinary) {
    try {
      const parsed = (typeof payload === "string" ? JSON.parse(payload) : payload) as { content?: unknown; binary?: unknown } | null;
      if (parsed?.binary !== true || typeof parsed.content !== "string") {
        return { ok: false, error: "local binary read did not return exact file bytes" };
      }
      const bytes = Buffer.from(parsed.content, "base64");
      if (bytes.toString("base64") !== parsed.content) {
        return { ok: false, error: "local binary read returned invalid base64" };
      }
      return { ok: true, bytes };
    } catch {
      return { ok: false, error: "local binary read returned a malformed payload" };
    }
  }
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as { content?: string; binary?: boolean };
      if (parsed.binary && typeof parsed.content === "string") {
        return { ok: true, bytes: Buffer.from(parsed.content, "base64") };
      }
      if (typeof parsed.content === "string") {
        return { ok: true, bytes: Buffer.from(parsed.content, "utf-8") };
      }
    } catch {
      return { ok: false, error: "local read returned non-JSON payload" };
    }
  }
  if (payload && typeof payload === "object" && "content" in payload) {
    const p = payload as { content?: string; binary?: boolean };
    if (p.binary && typeof p.content === "string") {
      return { ok: true, bytes: Buffer.from(p.content, "base64") };
    }
    if (typeof p.content === "string") {
      return { ok: true, bytes: Buffer.from(p.content, "utf-8") };
    }
  }
  return { ok: false, error: "local read did not return file content" };
}

function decodeCanonicalMediaChunk(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      value.length > Math.ceil(RELAY_MEDIA_CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= RELAY_MEDIA_CHUNK_BYTES && bytes.toString("base64") === value ? bytes : null;
}

/**
 * D417 v5-only media read. Generic local reads deliberately continue to use
 * the 16 MiB relay cap. The completed in-memory Buffer is capped at 64 MiB
 * and is returned only after every ordered, validated chunk has arrived.
 */
export async function readLocalZoneMediaBytes(
  path: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const registry = getRelayRegistry();
  const hint = focusHintForPath(path, zone, ctx);
  const selection = resolveLocalFileRelay({ command: "read", ownerId: ctx.ownerId, registry, ...hintArgs(hint) });
  if (!selection.ok) return { ok: false, error: selection.error };
  if (!registry?.localFileDispatch || (registry.getProtocolVersion?.(selection.relayId) ?? 0) < MEDIA_EXTRACTION_PROTOCOL_VERSION) {
    return { ok: false, error: "Chunked media reads require a v5 Nautilo desktop relay." };
  }
  const statRequest: RelayLocalFileRequest = {
    operation: { kind: "file", command: "stat", zone, args: { path, _routing: buildRouting(ctx) } },
    allowedRoots: [...selection.allowedRoots],
  };
  const stat = await dispatchLocalFile(statRequest, ctx, false);
  if (!stat.ok) return { ok: false, error: stat.error };
  const rawStat = typeof stat.result === "string" ? stat.result : JSON.stringify(stat.result);
  let size: number;
  try {
    const parsed = JSON.parse(rawStat) as { size?: unknown };
    size = typeof parsed.size === "number" ? parsed.size : NaN;
  } catch { size = NaN; }
  if (!Number.isSafeInteger(size) || size <= 0 || size > RELAY_MEDIA_MAX_BYTES) {
    return { ok: false, error: `media size must be between 1 and ${RELAY_MEDIA_MAX_BYTES} bytes` };
  }
  const chunkCount = Math.ceil(size / RELAY_MEDIA_CHUNK_BYTES);
  const chunks: Buffer[] = [];
  const sessionId = randomUUID();
  for (let index = 0; index < chunkCount; index++) {
    const req: RelayLocalFileRequest = {
      operation: {
        kind: "file", command: "media_read_chunk", zone,
        args: { path, sessionId, index, chunkCount, offset: index * RELAY_MEDIA_CHUNK_BYTES, _routing: buildRouting(ctx) },
      },
      allowedRoots: [...selection.allowedRoots],
    };
    const response = await dispatchLocalFile(req, ctx, false);
    if (!response.ok) return { ok: false, error: response.error };
    try {
      const value = JSON.parse(typeof response.result === "string" ? response.result : JSON.stringify(response.result)) as Record<string, unknown>;
      if (value["sessionId"] !== sessionId || value["index"] !== index || value["chunkCount"] !== chunkCount || value["totalBytes"] !== size) {
        return { ok: false, error: "relay returned out-of-order media chunk" };
      }
      const chunk = decodeCanonicalMediaChunk(value["data"]);
      if (!chunk || (index < chunkCount - 1 && chunk.byteLength !== RELAY_MEDIA_CHUNK_BYTES)) {
        return { ok: false, error: "relay returned malformed media chunk" };
      }
      chunks.push(chunk);
    } catch { return { ok: false, error: "relay returned malformed media chunk" }; }
  }
  const bytes = Buffer.concat(chunks);
  return bytes.byteLength === size ? { ok: true, bytes } : { ok: false, error: "relay media transfer size mismatch" };
}

export async function writeLocalZoneBytes(
  path: string,
  zone: "current" | "absolute",
  bytes: Buffer,
  ctx: LocalZoneIoContext,
  summary: string,
  options: { expectedSha256?: string | null } = {},
): Promise<{ ok: true; resultText: string } | { ok: false; error: string; code?: string }> {
  const hint = focusHintForPath(path, zone, ctx);
  const selection = resolveLocalFileRelay({
    command: "write",
    ownerId: ctx.ownerId,
    registry: getRelayRegistry(),
    ...hintArgs(hint),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }

  const req: RelayLocalFileRequest = {
    operation: {
      kind: "file",
      command: "write",
      zone,
      args: {
        path,
        content: bytes.toString("base64"),
        encoding: "base64",
        summary,
        ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
        _routing: buildRouting(ctx),
      },
    },
    allowedRoots: [...selection.allowedRoots],
  };

  const dispatched = await dispatchLocalFile(req, ctx, true);
  if (!dispatched.ok) return { ok: false, error: dispatched.error };
  return validateLocalWriteReceipt(dispatched.result);
}

function validateLocalWriteReceipt(
  result: unknown,
):
  | { ok: true; resultText: string }
  | {
      ok: false;
      error: string;
      code?: string;
      currentSha256?: string | null;
    } {
  const resultText = typeof result === "string" ? result : JSON.stringify(result);
  if (typeof resultText !== "string") {
    return { ok: false, error: "local write returned a malformed mutation receipt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return { ok: false, error: "local write returned a malformed mutation receipt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "local write returned a malformed mutation receipt" };
  }
  const receipt = parsed as Record<string, unknown>;
  if (typeof receipt["error"] === "string") {
    const message = typeof receipt["message"] === "string" ? `: ${receipt["message"]}` : "";
    if (receipt["error"] === "stale_sha256") {
      return {
        ok: false,
        code: "stale_sha256",
        error: `${receipt["error"]}${message}`,
        currentSha256:
          typeof receipt["actualSha256"] === "string"
            ? receipt["actualSha256"]
            : null,
      };
    }
    return { ok: false, code: receipt["error"], error: `${receipt["error"]}${message}` };
  }
  if (
    receipt["applied"] !== true ||
    typeof receipt["revisionId"] !== "string" ||
    receipt["revisionId"].length === 0
  ) {
    return { ok: false, error: "local write returned an incomplete mutation receipt" };
  }
  return { ok: true, resultText };
}

export async function readLocalZoneText(
  path: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const bytesResult = await readLocalZoneBytes(path, zone, ctx);
  if (!bytesResult.ok) return bytesResult;
  return { ok: true, text: bytesResult.bytes.toString("utf8") };
}

export async function queryLocalZoneStat(
  path: string,
  zone: "current" | "absolute",
  ctx: LocalZoneIoContext,
): Promise<{ ok: true; stat: LocalZoneStatDetails } | { ok: false; error: string }> {
  const hint = focusHintForPath(path, zone, ctx);
  const selection = resolveLocalFileRelay({
    command: "stat",
    ownerId: ctx.ownerId,
    registry: getRelayRegistry(),
    ...hintArgs(hint),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }

  const req: RelayLocalFileRequest = {
    operation: {
      kind: "file",
      command: "stat",
      zone,
      args: { path, _routing: buildRouting(ctx) },
    },
    allowedRoots: [...selection.allowedRoots],
  };

  const dispatched = await dispatchLocalFile(req, ctx, false);
  if (!dispatched.ok) return { ok: false, error: dispatched.error };

  if (typeof dispatched.result === "string") {
    if (dispatched.result.includes("ENOENT")) {
      return { ok: true, stat: { exists: false, size: null, mimeType: null } };
    }
    if (dispatched.result.startsWith("Error:")) {
      return { ok: false, error: dispatched.result };
    }
    try {
      const parsed = JSON.parse(dispatched.result) as {
        size?: number;
        mimeType?: string;
        exists?: boolean;
      };
      return {
        ok: true,
        stat: {
          exists: parsed.exists !== false,
          size: typeof parsed.size === "number" ? parsed.size : null,
          mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : null,
        },
      };
    } catch {
      return { ok: true, stat: { exists: true, size: null, mimeType: null } };
    }
  }

  return { ok: true, stat: { exists: true, size: null, mimeType: null } };
}

export function parseLocalWriteRevisionId(resultText: string): string | null {
  try {
    const parsed = JSON.parse(resultText) as { revisionId?: unknown };
    return typeof parsed.revisionId === "string" ? parsed.revisionId : null;
  } catch {
    return null;
  }
}

export async function writeLocalZoneText(
  path: string,
  zone: "current" | "absolute",
  text: string,
  ctx: LocalZoneIoContext,
  options: { expectedSha256?: string; createOnly?: boolean } = {},
): Promise<
  | { ok: true; resultText: string }
  | {
      ok: false;
      error: string;
      code?: string;
      currentSha256?: string | null;
    }
> {
  if (options.createOnly && options.expectedSha256 !== undefined) {
    return { ok: false, error: "create-only writes cannot specify an existing document hash" };
  }
  // A distinct command makes older relays reject unsupported creation safely.
  const command = options.createOnly ? "create" : "write";
  const hint = focusHintForPath(path, zone, ctx);
  const selection = resolveLocalFileRelay({
    command,
    ownerId: ctx.ownerId,
    registry: getRelayRegistry(),
    ...hintArgs(hint),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }

  const req: RelayLocalFileRequest = {
    operation: {
      kind: "file",
      command,
      zone,
      args: {
        path,
        content: text,
        ...(options.expectedSha256 === undefined
          ? {}
          : { expectedSha256: options.expectedSha256 }),
        _routing: buildRouting(ctx),
      },
    },
    allowedRoots: [...selection.allowedRoots],
  };

  const dispatched = await dispatchLocalFile(req, ctx, true);
  if (!dispatched.ok) return { ok: false, error: dispatched.error };
  return validateLocalWriteReceipt(dispatched.result);
}
