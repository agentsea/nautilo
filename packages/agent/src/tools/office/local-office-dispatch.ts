/**
 * M206 Phase 3 — one typed `local-file` / `kind:"office"` relay dispatch per local Office op.
 */

import {
  COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION,
  type RelayLocalFileOfficeOp,
  type RelayLocalFileRequest,
} from "@nautilo/relay";
import { getRelayRegistry } from "../../nodes/tools";
import type { ZoneContext } from "../file/zones";
import {
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  resolveFocusedRelayHintForPath,
} from "../file/local-file-routing";
import {
  isLocalOfficeMutating,
  resolveLocalOfficeRelay,
  type LocalOfficeZone,
} from "./local-office-routing";
import {
  parseOfficeRunReadArgv,
  type OfficeRunReadSpec,
} from "./local-office-read-spec";

export type LocalOfficeRouting = {
  ownerId: string;
  agentId: string;
  /** Active agent graph turn when invoked from an agent tool turn. */
  turnId?: string | undefined;
  /**
   * Host-issued UI/app mutation transaction id (`app:<appId>:<uuid>`).
   * Journaled as the revision grouping key; not an agent turn.
   */
  appOperationId?: string | undefined;
  /** Trusted, semantics-bound identity for the exact local mutation. */
  mutationRequestId?: string | undefined;
  activeModelId?: string | undefined;
  currentFolder: string | null;
  workspaceRoot: string;
};

export type LocalOfficeWireOperation =
  | {
      subkind: "officecli";
      zone: LocalOfficeZone;
      command: string;
      payload: Record<string, unknown>;
      _routing: LocalOfficeRouting;
    }
  | {
      subkind: "officeRun";
      mode: "read";
      inputPath: string;
      readSpec: OfficeRunReadSpec;
      _routing: LocalOfficeRouting;
    }
  | {
      subkind: "officeRun";
      mode: "write";
      outputPath: string;
      ops: unknown[];
      imageInputs?: Array<{ dataUrl: string }>;
      overwrite: boolean;
      officeType: "docx" | "xlsx" | "pptx";
      _routing: LocalOfficeRouting;
    }
  | {
      subkind: "convert";
      sourceZone: LocalOfficeZone;
      sourcePath: string;
      destinationZone: LocalOfficeZone;
      destinationPath: string;
      inputFormat: string;
      outputFormat: string;
      backend: "local";
      summary: string;
      _routing: LocalOfficeRouting;
    };

/** Agent-side input may still carry readArgv from legacy callers; never put it on the wire. */
export type LocalOfficeOperationInput =
  | LocalOfficeWireOperation
  | (Extract<LocalOfficeWireOperation, { subkind: "officeRun"; mode: "read" }> & {
      readArgv?: string[] | undefined;
    });

export interface LocalOfficeDispatchContext {
  ownerId: string;
  agentId: string;
  turnId?: string | undefined;
  appOperationId?: string | undefined;
  mutationRequestId?: string | undefined;
  activeModelId?: string | undefined;
  zoneCtx: ZoneContext;
  approvalObtained: boolean;
}

function buildRouting(ctx: LocalOfficeDispatchContext): LocalOfficeRouting {
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

function formatRelayError(message: string, code?: string): string {
  if (code) return `Error: ${code}: ${message}`;
  return `Error: ${message}`;
}

function stripForbiddenPayloadFields(payload: Record<string, unknown>): Record<string, unknown> {
  const { argv: _a, readArgv: _r, executable: _e, commandLine: _c, shell: _s, script: _sc, binary: _b, cmd: _cmd, ...rest } =
    payload;
  return rest;
}

function sanitizeWireOperation(
  operation: LocalOfficeOperationInput,
  routing: LocalOfficeRouting,
): { ok: true; wire: LocalOfficeWireOperation } | { ok: false; error: string } {
  if (operation.subkind === "officecli") {
    return {
      ok: true,
      wire: {
        subkind: "officecli",
        zone: operation.zone,
        command: operation.command,
        payload: stripForbiddenPayloadFields(operation.payload),
        _routing: routing,
      },
    };
  }

  if (operation.subkind === "officeRun" && operation.mode === "read") {
    let readSpec = operation.readSpec;
    if (!readSpec && "readArgv" in operation && Array.isArray(operation.readArgv)) {
      const parsed = parseOfficeRunReadArgv(operation.readArgv);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      readSpec = parsed.spec;
    }
    if (!readSpec) {
      return { ok: false, error: "officeRun read requires structured readSpec" };
    }
    return {
      ok: true,
      wire: {
        subkind: "officeRun",
        mode: "read",
        inputPath: operation.inputPath,
        readSpec,
        _routing: routing,
      },
    };
  }

  if (operation.subkind === "officeRun" && operation.mode === "write") {
    return {
      ok: true,
      wire: {
        subkind: "officeRun",
        mode: "write",
        outputPath: operation.outputPath,
        ops: operation.ops,
        ...(operation.imageInputs && operation.imageInputs.length > 0
          ? { imageInputs: operation.imageInputs }
          : {}),
        overwrite: operation.overwrite,
        officeType: operation.officeType,
        _routing: routing,
      },
    };
  }

  if (operation.subkind === "convert") {
    return {
      ok: true,
      wire: {
        subkind: "convert",
        sourceZone: operation.sourceZone,
        sourcePath: operation.sourcePath,
        destinationZone: operation.destinationZone,
        destinationPath: operation.destinationPath,
        inputFormat: operation.inputFormat,
        outputFormat: operation.outputFormat,
        backend: operation.backend,
        summary: operation.summary,
        _routing: routing,
      },
    };
  }

  return { ok: false, error: `unsupported local office subkind: ${String((operation as { subkind?: string }).subkind)}` };
}

function looksAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * D423 Phase 5 — resolve the focused ref's exact originating relay for a local
 * Office operation by mapping its input/output/source/destination path back to
 * a focused local-file ref. OfficeCLI / convert carry an explicit zone;
 * `officeRun` paths carry none, so they only match when absolute (a relative
 * officeRun path cannot be reconstructed without a zone and is left to default
 * selection). Returns `undefined` when no ref matches.
 */
function resolveFocusedOfficeRelayHint(
  operation: LocalOfficeOperationInput,
  currentFolder: string | null,
): string | undefined {
  const tryPair = (
    pathValue: string | undefined,
    zone: LocalOfficeZone | undefined,
  ): string | undefined => {
    if (typeof pathValue !== "string" || pathValue.length === 0) return undefined;
    if (zone === "current" || zone === "absolute") {
      return resolveFocusedRelayHintForPath({ path: pathValue, zone, currentFolder });
    }
    // officeRun paths have no explicit zone — only reconstruct as absolute.
    if (looksAbsolutePath(pathValue)) {
      return resolveFocusedRelayHintForPath({ path: pathValue, zone: "absolute", currentFolder });
    }
    return undefined;
  };

  if (operation.subkind === "officecli") {
    const payload = operation.payload as { path?: string; out?: string; file?: string };
    return tryPair(payload.path ?? payload.out ?? payload.file, operation.zone);
  }
  if (operation.subkind === "officeRun" && operation.mode === "read") {
    return tryPair(operation.inputPath, undefined);
  }
  if (operation.subkind === "officeRun" && operation.mode === "write") {
    return tryPair(operation.outputPath, undefined);
  }
  if (operation.subkind === "convert") {
    return (
      tryPair(operation.sourcePath, operation.sourceZone) ??
      tryPair(operation.destinationPath, operation.destinationZone)
    );
  }
  return undefined;
}

export async function executeLocalOfficeOperation(
  operation: LocalOfficeOperationInput,
  ctx: LocalOfficeDispatchContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
  const mutating = isLocalOfficeMutating({
    subkind: operation.subkind,
    ...(operation.subkind === "officecli" ? { command: operation.command } : {}),
    ...(operation.subkind === "officeRun" ? { mode: operation.mode } : {}),
  });

  const registry = getRelayRegistry();
  // D423 Phase 5 — pin to the focused ref's exact originating relay when the
  // operation targets a focused local path. A miss keeps the default Office
  // relay selection; a hint that isn't the paired qualifying relay fails closed.
  const focusHint = resolveFocusedOfficeRelayHint(
    operation,
    ctx.zoneCtx.currentFolder ?? null,
  );
  const selection = resolveLocalOfficeRelay({
    ownerId: ctx.ownerId,
    mutating,
    registry,
    ...(focusHint
      ? { relayIdHint: focusHint, relayHintMismatchMessage: FOCUSED_RELAY_MISMATCH_MESSAGE }
      : {}),
  });
  if (!selection.ok) {
    return { ok: false, error: selection.error, code: selection.code };
  }

  if (!registry?.localFileDispatch) {
    return {
      ok: false,
      error:
        "Office operations on local zones require the Nautilo desktop app with local file execution enabled.",
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
      error: "Local Office writes require a v9 Nautilo desktop relay with coordinated mutation receipts.",
      code: "LOCAL_MUTATION_PROTOCOL_UNSUPPORTED",
    };
  }

  const routing = buildRouting(ctx);
  const sanitized = sanitizeWireOperation(operation, routing);
  if (!sanitized.ok) {
    return { ok: false, error: sanitized.error };
  }

  const req: RelayLocalFileRequest = {
    operation: { kind: "office", operation: sanitized.wire } satisfies RelayLocalFileOfficeOp,
    allowedRoots: selection.allowedRoots,
  };

  const relayResult = await registry.localFileDispatch(selection.relayId, req, {
    mutating,
    approvalObtained: mutating ? ctx.approvalObtained : false,
  });

  if (!relayResult.ok) {
    return { ok: false, error: relayResult.message, ...(relayResult.code ? { code: relayResult.code } : {}) };
  }

  if (
    relayResult.result &&
    typeof relayResult.result === "object" &&
    (relayResult.result as { ok?: boolean }).ok === false
  ) {
    const err = relayResult.result as { message?: string; code?: string };
    return {
      ok: false,
      error: err.message ?? "local office operation failed",
      ...(err.code ? { code: err.code } : {}),
    };
  }

  return { ok: true, result: relayResult.result };
}

export function localOfficeDispatchErrorText(
  outcome: { ok: false; error: string; code?: string },
): string {
  return formatRelayError(outcome.error, outcome.code);
}
