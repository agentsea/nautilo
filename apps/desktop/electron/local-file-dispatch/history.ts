/**
 * M206 — local revision/history commands on the Electron relay.
 */

import type {
  RelayLocalFileHistoryOp,
} from "@nautilo/relay";
import { extractRouting, resolveLocalMutationTransactionId, resolveZonePath, stripRouting } from "./paths.ts";
import type { LocalFileCommandContext } from "./commands.ts";

export async function executeLocalHistoryCommand(
  op: RelayLocalFileHistoryOp,
  ctx: LocalFileCommandContext,
): Promise<unknown> {
  const routing = extractRouting(op.args);
  if (!routing) return "Error: missing routing metadata for local history command";
  const transactionId = resolveLocalMutationTransactionId(routing);
  if (!transactionId) return "Error: turnId or appOperationId required for local history commands";

  const args = stripRouting(op.args);

  switch (op.command) {
    case "list_revisions":
      return listRevisions(args, ctx);
    case "pin_revision":
      return pinRevision(args, ctx);
    case "unpin_revision":
      return unpinRevision(args, ctx);
    case "undo":
      return undo(args, ctx);
    case "redo":
      return redo(args, ctx);
    case "undo_turn":
      return undoTurn(args, ctx);
    default:
      return `Error: unknown local history command ${op.command}`;
  }
}

async function listRevisions(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  let canonicalPath: string | undefined;
  const filterPath = args["path"];
  if (typeof filterPath === "string" && filterPath.length > 0) {
    const zone = (args["zone"] ?? "absolute") as "current" | "absolute";
    const resolved = resolveZonePath(zone, filterPath, ctx.routing);
    if (!resolved.ok) return `Error: ${resolved.reason}`;
    try {
      canonicalPath = await ctx.adapter.canonicalize(resolved.resolved);
    } catch {
      return `Error: path filter outside allowed roots`;
    }
  }

  const result = await ctx.journal.list({
    agentId: ctx.routing.agentId,
    ...(canonicalPath ? { canonicalPath } : {}),
    ...(typeof args["revisionTurnId"] === "string" ? { turnId: args["revisionTurnId"] } : {}),
    ...(typeof args["since"] === "string" ? { since: args["since"] } : {}),
    ...(typeof args["until"] === "string" ? { until: args["until"] } : {}),
    ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    ...(args["includePinnedOnly"] === true ? { includePinnedOnly: true } : {}),
  });

  if (!result.ok) {
    return JSON.stringify({ error: result.code, message: result.message });
  }

  const revisions = result.data.revisions.map((r) => ({
    revisionId: r.revisionRef,
    turnId: r.turnId,
    path: r.requestedPath,
    operation: r.operation,
    createdAt: r.createdAt,
    pinned: r.pinned,
    canonicalPath: r.canonicalPath,
  }));

  return JSON.stringify({ revisions, truncated: result.data.truncated });
}

async function pinRevision(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const revisionId = args["revisionId"];
  if (typeof revisionId !== "string") return "Error: pin_revision requires revisionId";
  const result = await ctx.journal.pin({
    agentId: ctx.routing.agentId,
    revisionRef: revisionId,
  });
  if (!result.ok) {
    return JSON.stringify({
      error: result.code === "revision_not_found" ? "revision_not_found" : result.code,
      revisionId,
      hint: result.message,
    });
  }
  return JSON.stringify({ ok: true, revisionId, pinned: true });
}

async function unpinRevision(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const revisionId = args["revisionId"];
  if (typeof revisionId !== "string") return "Error: unpin_revision requires revisionId";
  const result = await ctx.journal.unpin({
    agentId: ctx.routing.agentId,
    revisionRef: revisionId,
  });
  if (!result.ok) {
    return JSON.stringify({
      error: result.code === "revision_not_found" ? "revision_not_found" : result.code,
      revisionId,
      hint: result.message,
    });
  }
  return JSON.stringify({ ok: true, revisionId, pinned: false });
}

async function undo(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const zone = args["zone"];
  const rawPath = args["path"];
  if (typeof zone !== "string" || (zone !== "current" && zone !== "absolute")) {
    return "Error: undo requires zone current|absolute";
  }
  if (typeof rawPath !== "string") return "Error: undo requires path";
  const resolved = resolveZonePath(zone, rawPath, ctx.routing);
  if (!resolved.ok) return `Error: ${resolved.reason}`;

  if (!ctx.historyCommit || !ctx.routing.mutationRequestId) {
    return JSON.stringify({
      error: "runtime_unavailable",
      message: "Desktop history mutation runtime is unavailable",
    });
  }
  const result = await ctx.historyCommit({
    action: "undo",
    targetPath: resolved.resolved,
    agentId: ctx.routing.agentId,
    turnId: resolveLocalMutationTransactionId(ctx.routing)!,
    mutationRequestId: ctx.routing.mutationRequestId,
    semanticDigest: ctx.mutationSemanticDigest,
    authorizedRoots: ctx.allowedRoots,
    ...(ctx.routing.mutationRetry === true ? { replayOnly: true } : {}),
    ...(typeof args["revisionId"] === "string"
      ? { revisionId: args["revisionId"] }
      : {}),
    ...(typeof args["targetTurnId"] === "string"
      ? { targetTurnId: args["targetTurnId"] }
      : {}),
  });

  if (!result.ok) {
    return JSON.stringify({
      error: result.code,
      message: result.message,
      ...(result.canonicalPath === undefined
        ? {}
        : { canonicalPath: result.canonicalPath }),
    });
  }

  return JSON.stringify({
    applied: true,
    revisionId: result.revisions[0]?.revisionId,
    path: resolved.displayPath,
    zone,
    command: "undo",
    summary: `Reverted ${resolved.displayPath}`,
    unifiedDiff: "(undo restore)",
    stats: { additions: 0, deletions: 0 },
  });
}

async function redo(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const zone = args["zone"];
  const rawPath = args["path"];
  if (typeof zone !== "string" || (zone !== "current" && zone !== "absolute")) {
    return "Error: redo requires zone current|absolute";
  }
  if (typeof rawPath !== "string") return "Error: redo requires path";
  const resolved = resolveZonePath(zone, rawPath, ctx.routing);
  if (!resolved.ok) return `Error: ${resolved.reason}`;

  if (!ctx.historyCommit || !ctx.routing.mutationRequestId) {
    return JSON.stringify({
      error: "runtime_unavailable",
      message: "Desktop history mutation runtime is unavailable",
    });
  }
  const result = await ctx.historyCommit({
    action: "redo",
    targetPath: resolved.resolved,
    agentId: ctx.routing.agentId,
    turnId: resolveLocalMutationTransactionId(ctx.routing)!,
    mutationRequestId: ctx.routing.mutationRequestId,
    semanticDigest: ctx.mutationSemanticDigest,
    authorizedRoots: ctx.allowedRoots,
    ...(ctx.routing.mutationRetry === true ? { replayOnly: true } : {}),
  });

  if (!result.ok) {
    return JSON.stringify({ error: result.code, message: result.message });
  }

  return JSON.stringify({
    applied: true,
    revisionId: result.revisions[0]?.revisionId,
    path: resolved.displayPath,
    zone,
    command: "redo",
    summary: `Redid change on ${resolved.displayPath}`,
    unifiedDiff: "(redo restore)",
    stats: { additions: 0, deletions: 0 },
  });
}

async function undoTurn(
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const targetTurnId = args["targetTurnId"];
  if (typeof targetTurnId !== "string") return "Error: undo_turn requires targetTurnId";

  if (!ctx.historyCommit || !ctx.routing.mutationRequestId) {
    return JSON.stringify({
      error: "runtime_unavailable",
      message: "Desktop history mutation runtime is unavailable",
    });
  }
  const result = await ctx.historyCommit({
    action: "undo_turn",
    targetTurnId,
    agentId: ctx.routing.agentId,
    turnId: resolveLocalMutationTransactionId(ctx.routing)!,
    mutationRequestId: ctx.routing.mutationRequestId,
    semanticDigest: ctx.mutationSemanticDigest,
    authorizedRoots: ctx.allowedRoots,
    ...(ctx.routing.mutationRetry === true ? { replayOnly: true } : {}),
  });

  if (!result.ok) {
    return JSON.stringify({ error: result.code, message: result.message });
  }

  const patches = result.revisions.map((r) => ({
    applied: true as const,
    revisionId: r.revisionId,
    path: r.canonicalPath,
    command: "undo",
    summary: `Reverted ${r.canonicalPath}`,
    unifiedDiff: "(undo_turn)",
  }));

  return JSON.stringify({
    turnId: targetTurnId,
    appliedCount: result.revisions.length,
    summary: `Undo turn ${targetTurnId}: ${result.revisions.length} file(s) reverted`,
    patches,
  });
}
