/**
 * M206 — zone path resolution for local-file commands on the Electron relay.
 */

import * as path from "node:path";
import type { RelayLocalFileZone } from "@nautilo/relay";

export interface LocalRoutingContext {
  ownerId: string;
  agentId: string;
  mutationRequestId?: string | undefined;
  mutationRetry?: boolean | undefined;
  /** Active agent graph turn when invoked from an agent tool turn. */
  turnId?: string | undefined;
  /**
   * Host-issued UI/app mutation transaction id (`app:<appId>:<uuid>`).
   * Journaled as the revision grouping key; not an agent turn.
   */
  appOperationId?: string | undefined;
  activeModelId?: string | undefined;
  currentFolder: string | null;
  workspaceRoot: string;
}

/** Revision journal / undo_turn grouping key: agent turn or app-operation transaction id. */
export function resolveLocalMutationTransactionId(routing: LocalRoutingContext): string | undefined {
  if (typeof routing.turnId === "string" && routing.turnId.length > 0) return routing.turnId;
  if (typeof routing.appOperationId === "string" && routing.appOperationId.length > 0) {
    return routing.appOperationId;
  }
  return undefined;
}

export function extractRouting(args: Record<string, unknown>): LocalRoutingContext | null {
  const routing = args["_routing"];
  if (!routing || typeof routing !== "object") return null;
  const r = routing as Record<string, unknown>;
  if (typeof r["ownerId"] !== "string" || typeof r["agentId"] !== "string") return null;
  return {
    ownerId: r["ownerId"],
    agentId: r["agentId"],
    ...(typeof r["turnId"] === "string" ? { turnId: r["turnId"] } : {}),
    ...(typeof r["mutationRequestId"] === "string"
      ? { mutationRequestId: r["mutationRequestId"] }
      : {}),
    ...(r["mutationRetry"] === true ? { mutationRetry: true } : {}),
    ...(typeof r["appOperationId"] === "string" ? { appOperationId: r["appOperationId"] } : {}),
    ...(typeof r["activeModelId"] === "string" ? { activeModelId: r["activeModelId"] } : {}),
    currentFolder: typeof r["currentFolder"] === "string" ? r["currentFolder"] : null,
    workspaceRoot: typeof r["workspaceRoot"] === "string" ? r["workspaceRoot"] : "",
  };
}

export function resolveZonePath(
  zone: RelayLocalFileZone,
  rawPath: string,
  routing: LocalRoutingContext,
): { ok: true; resolved: string; displayPath: string } | { ok: false; reason: string } {
  if (zone !== "current" && zone !== "absolute") {
    return {
      ok: false,
      reason: `unsupported local file zone "${String(zone)}"; only "current" and "absolute" are allowed`,
    };
  }

  if (zone === "absolute") {
    if (!path.isAbsolute(rawPath)) {
      return {
        ok: false,
        reason: `zone="absolute" requires an absolute path (got ${rawPath.slice(0, 80)})`,
      };
    }
    return { ok: true, resolved: path.resolve(rawPath), displayPath: rawPath };
  }

  if (!routing.currentFolder) {
    return {
      ok: false,
      reason: 'zone="current" requires an open Current Folder — none is set for this turn',
    };
  }

  const resolved = path.resolve(routing.currentFolder, rawPath);
  const relative = path.relative(routing.currentFolder, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      reason: `path escapes the current folder root (${routing.currentFolder})`,
    };
  }
  return { ok: true, resolved, displayPath: rawPath };
}

export function stripRouting(args: Record<string, unknown>): Record<string, unknown> {
  const { _routing: _r, ...rest } = args;
  return rest;
}
