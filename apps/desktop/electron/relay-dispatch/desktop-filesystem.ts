import * as path from "node:path";

import {
  handleFsDispatch,
  type DesktopFilesystemBaselineAuthority,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayFsChangeEvent,
  type RelayFsOp,
  type RelayFsResult,
  type WorkspaceGuard,
} from "@nautilo/relay";
import type { DesktopFilesystemAccessOperation } from "@nautilo/desktop-filesystem-grants";

import {
  prepareRelayApplyPatchDispatch,
  type ApplyPatchDispatchPreparation,
} from "../apply-patch-dispatch.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type DesktopDispatchDecision,
} from "./router.ts";

export type DesktopFilesystemGrantDispatchErrorCode =
  | "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID"
  | "DESKTOP_FILESYSTEM_GRANT_STALE"
  | "SUBJECT_MISMATCH"
  | "REVOKED"
  | "EXPIRED"
  | "ROOT_EXPANSION"
  | "OPERATION_UPGRADE"
  | "IDENTITY_MISMATCH"
  | "PROTECTED_PATH"
  | "GRANT_NOT_FOUND";

export type DesktopFilesystemGrantAuthorityResolution =
  | {
      readonly ok: true;
      /** `false` preserves the legacy path when no authority was requested. */
      readonly hasAuthority: true;
      readonly roots: readonly string[];
      readonly operation: DesktopFilesystemAccessOperation;
      readonly grantIds: readonly string[];
    }
  | {
      readonly ok: true;
      readonly hasAuthority: false;
      readonly roots: readonly [];
    }
  | { readonly ok: false; readonly code: DesktopFilesystemGrantDispatchErrorCode };

export interface DesktopFilesystemGrantAuthorityResolveInput {
  /**
   * The server envelope is optional. Absence is deliberately not an error:
   * callers retain their existing local-authority behavior in that case.
   */
  readonly request?: RelayDispatchRequest["desktopFilesystemGrantRequest"] | undefined;
  /** Concrete operation derived from the dispatch; null when undeterminable. */
  readonly concreteOperation: DesktopFilesystemAccessOperation | null;
  /**
   * D448: a strict apply-patch envelope derives this complete set from its
   * parsed operations. The local resolver checks every member; a server grant
   * cannot reduce it to a scalar or add unrelated authority.
   */
  readonly concreteOperations?: readonly DesktopFilesystemAccessOperation[] | undefined;
  /**
   * Accepted only for compatibility with the future dispatch seam. Baselines
   * are intentionally not authority for this grant factory.
   */
  readonly baselineAuthorities?: readonly DesktopFilesystemBaselineAuthority[] | undefined;
}

export type DesktopFilesystemGrantAuthorityResolver = (
  input: DesktopFilesystemGrantAuthorityResolveInput,
) => Promise<DesktopFilesystemGrantAuthorityResolution>;

export type DesktopFilesystemAuthority = {
  readonly roots: readonly string[];
  readonly readOnlyRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
};

/** fs-relevant operations a baseline (Current Folder / workspace) authority carries. */
export const DESKTOP_FILESYSTEM_BASELINE_ACCESS: readonly DesktopFilesystemAccessOperation[] = [
  "read",
  "create_modify",
  "delete",
];

const WORKSTATION_FS_READ_OPS = new Set<RelayFsOp>([
  "readFile",
  "readdir",
  "stat",
  "lstat",
  "realpath",
]);
const WORKSTATION_FS_CREATE_MODIFY_OPS = new Set<RelayFsOp>([
  "writeFileAtomic",
  "mkdir",
  "rename",
  "cp",
]);
const WORKSTATION_FS_DELETE_OPS = new Set<RelayFsOp>(["unlink", "rm"]);
const WORKSTATION_LOCAL_FILE_MUTATING_COMMANDS = new Set([
  "create",
  "write",
  "insert",
  "str_replace",
  "move",
  "copy",
  "undo",
  "redo",
  "undo_turn",
  "pin_revision",
  "unpin_revision",
]);

function localOfficeIsMutating(wire: Record<string, unknown>): boolean {
  const subkind = wire["subkind"];
  if (subkind === "convert") return true;
  if (subkind === "officeRun") return wire["mode"] === "write";
  if (subkind === "officecli") {
    const command = wire["command"];
    if (typeof command !== "string") return false;
    const readOnly = new Set(["view", "get", "query", "validate", "dump", "raw", "help"]);
    return !readOnly.has(command);
  }
  return false;
}

/**
 * Maps a concrete relay dispatch to the Desktop filesystem access operation it needs.
 * Returns `null` when the operation cannot be determined safely — the D418 path
 * rejects such dispatches rather than defaulting to `read`.
 */
export function deriveDesktopFilesystemAccessOperation(
  req: RelayDispatchRequest,
): DesktopFilesystemAccessOperation | null {
  if (req.executionClass === "fs" || req.toolName === "fs") {
    const op = req.args["op"];
    if (typeof op !== "string") return null;
    if (WORKSTATION_FS_READ_OPS.has(op as RelayFsOp)) return "read";
    if (WORKSTATION_FS_CREATE_MODIFY_OPS.has(op as RelayFsOp)) return "create_modify";
    if (WORKSTATION_FS_DELETE_OPS.has(op as RelayFsOp)) return "delete";
    return null;
  }
  if (req.executionClass === "local-file" || req.toolName === "local-file") {
    const operation = req.args["operation"];
    if (!operation || typeof operation !== "object") return null;
    const kind = (operation as { kind?: unknown }).kind;
    if (kind === "search") return "read";
    if (kind === "file" || kind === "history") {
      const command = (operation as { command?: unknown }).command;
      if (typeof command !== "string") return null;
      if (command === "delete") return "delete";
      if (WORKSTATION_LOCAL_FILE_MUTATING_COMMANDS.has(command)) return "create_modify";
      return "read";
    }
    if (kind === "office") {
      const wire = (operation as { operation?: unknown }).operation;
      if (!wire || typeof wire !== "object") return null;
      return localOfficeIsMutating(wire as Record<string, unknown>)
        ? "create_modify"
        : "read";
    }
    return null;
  }
  if (req.toolName === "run_shell") return "execute";
  if (req.toolName === "terminal" && req.args["action"] === "spawn") return "execute";
  return null;
}

/** Exact D418 effect set for structural local-file mutations. */
export function deriveDesktopFilesystemAccessOperations(
  req: RelayDispatchRequest,
): readonly DesktopFilesystemAccessOperation[] | null {
  if (req.executionClass !== "local-file" && req.toolName !== "local-file") {
    const operation = deriveDesktopFilesystemAccessOperation(req);
    return operation === null ? null : [operation];
  }
  const operation = req.args["operation"];
  if (!operation || typeof operation !== "object") return null;
  const kind = (operation as { kind?: unknown }).kind;
  const command = (operation as { command?: unknown }).command;
  if (kind !== "file" || typeof command !== "string") {
    const scalar = deriveDesktopFilesystemAccessOperation(req);
    return scalar === null ? null : [scalar];
  }
  if (command === "copy") return ["read", "create_modify"];
  if (command === "move") return ["read", "create_modify", "delete"];
  if (command === "delete") return ["read", "delete"];
  const scalar = deriveDesktopFilesystemAccessOperation(req);
  return scalar === null ? null : [scalar];
}

function isApplyPatchRequest(request: RelayDispatchRequest): boolean {
  return request.executionClass === "local-file" &&
    request.toolName === "local-file" &&
    request.args !== null &&
    typeof request.args === "object" &&
    (request.args["operation"] as { kind?: unknown } | undefined)?.kind === "apply_patch";
}

export type ApplyPatchPreflight =
  | {
      readonly ok: true;
      readonly preparation: ApplyPatchDispatchPreparation | undefined;
    }
  | { readonly ok: false; readonly result: RelayDispatchResult };

/**
 * Parse the strict apply-patch request before deciding whether to return it.
 * The historic approval/grant-envelope refusal order is intentionally kept:
 * an unapproved or grant-bearing apply_patch never reveals parser detail.
 */
export function preflightApplyPatch(request: RelayDispatchRequest): ApplyPatchPreflight {
  const isApplyPatch = isApplyPatchRequest(request);
  const parsed = isApplyPatch
    ? prepareRelayApplyPatchDispatch({ args: request.args })
    : undefined;
  if (isApplyPatch && !request.approvalObtained) {
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: "APPLY_PATCH_APPROVAL_REQUIRED",
        error: "apply_patch requires approvalObtained=true from server",
      },
    };
  }
  if (isApplyPatch && request.desktopFilesystemGrantRequest !== undefined) {
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: "invalid_request",
        error: "Current Folder apply_patch does not accept a Desktop Filesystem Grant",
      },
    };
  }
  if (parsed !== undefined && !parsed.ok) {
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: parsed.code,
        error: parsed.message,
      },
    };
  }
  return { ok: true, preparation: parsed?.preparation };
}

export type DesktopFilesystemAuthorityPreparation =
  | { readonly ok: true; readonly authority: DesktopFilesystemAuthority | undefined }
  | { readonly ok: false; readonly result: RelayDispatchResult };

/**
 * Converts a successfully locally resolved grant into the sole authority seen
 * by downstream filesystem adapters. apply_patch has its own Current Folder
 * authority, so it and ordinary no-envelope requests never invoke the resolver.
 */
export async function prepareDesktopFilesystemAuthority(input: {
  readonly request: RelayDispatchRequest;
  readonly baseRoots: readonly string[];
  readonly resolver?: DesktopFilesystemGrantAuthorityResolver | undefined;
  readonly applyPatchPreparation?: ApplyPatchDispatchPreparation | undefined;
}): Promise<DesktopFilesystemAuthorityPreparation> {
  if (
    input.applyPatchPreparation !== undefined ||
    input.request.desktopFilesystemGrantRequest === undefined
  ) {
    return { ok: true, authority: undefined };
  }
  if (input.resolver === undefined) {
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID",
        error:
          "Desktop Filesystem Grant request received but no local authority resolver " +
          "is configured; refusing to derive filesystem authority from the " +
          "server envelope",
      },
    };
  }
  const concreteOperations = deriveDesktopFilesystemAccessOperations(input.request);
  const resolution = await input.resolver({
    request: input.request.desktopFilesystemGrantRequest,
    concreteOperation: deriveDesktopFilesystemAccessOperation(input.request),
    ...(concreteOperations !== null && concreteOperations.length > 1
      ? { concreteOperations }
      : {}),
    baselineAuthorities: input.baseRoots.map((root) => ({
      id: `baseline:${root}`,
      root,
      access: DESKTOP_FILESYSTEM_BASELINE_ACCESS,
    })),
  });
  if (!resolution.ok) {
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: resolution.code,
        error: `Desktop Filesystem Grant request rejected: ${resolution.code}`,
      },
    };
  }
  return { ok: true, authority: { roots: resolution.roots } };
}

const MUTATING_FS_OPS = new Set<RelayFsOp>([
  "writeFileAtomic",
  "mkdir",
  "rename",
  "unlink",
  "rm",
  "cp",
]);

function isRelayFsOkResult(result: unknown): result is RelayFsResult & { ok: true } {
  return Boolean(result && typeof result === "object" && (result as { ok?: unknown }).ok === true);
}

export function fsChangeFromDispatch(request: RelayDispatchRequest): RelayFsChangeEvent | null {
  const op = request.args["op"];
  const targetPath = request.args["path"];
  if (typeof op !== "string" || !MUTATING_FS_OPS.has(op as RelayFsOp)) return null;
  if (typeof targetPath !== "string" || targetPath.length === 0) return null;

  const opts = request.args["opts"];
  const explicit =
    opts && typeof opts === "object"
      ? (opts as Record<string, unknown>)["changeEvent"]
      : undefined;
  if (explicit && typeof explicit === "object") return explicit as RelayFsChangeEvent;

  const roots = Array.isArray(request.args["allowedRoots"])
    ? (request.args["allowedRoots"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const rootPath = roots[0] ?? path.dirname(targetPath);
  return {
    rootPath,
    path: path.dirname(targetPath),
    changedPath: targetPath,
    source: "relay",
    op: op as RelayFsOp,
    reloadRequired: true,
  };
}

/** Execute only the fixed fs lane and publish a mutation receipt after success. */
export async function dispatchFilesystem(input: {
  readonly request: RelayDispatchRequest;
  readonly guard: WorkspaceGuard;
  readonly authority: DesktopFilesystemAuthority | undefined;
  readonly onFsChange?: ((event: RelayFsChangeEvent) => void) | undefined;
}): Promise<DesktopDispatchDecision> {
  if (input.request.executionClass !== "fs") {
    return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
  }
  const result = await handleFsDispatch(input.request, input.guard, {
    ...(input.authority === undefined
      ? {}
      : { desktopFilesystemAuthority: input.authority }),
  });
  if (result.status === "ok" && isRelayFsOkResult(result.result)) {
    const change = fsChangeFromDispatch(input.request);
    if (change !== null) input.onFsChange?.(change);
  }
  return { handled: true, result };
}
