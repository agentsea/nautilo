/**
 * D087 Phase 3 §3.5 — `file.pin_revision` / `file.unpin_revision`.
 *
 * D448 routes Workspace pins to the canonical
 * `workspace_document_mutations` group. Historical `file_revisions`
 * remain discoverable but are explicitly read-only.
 *
 * Group UPDATE, owner-and-agent scoped, with no filesystem side effects
 * and no staged patch. A revision identity pins every entry in the
 * canonical mutation group.
 *
 * Input (wire):
 *   { command: "pin_revision" | "unpin_revision", revisionId: string }
 *
 * Output (JSON string):
 *   Success: { ok: true, revisionId, pinned: boolean }
 *   Error:   { error: "revision_not_found", revisionId, hint }
 *
 * PR-018 MAJOR #2 (seeded as H-033 enumeration-oracle symmetry):
 * this handler previously distinguished `revision_not_found` (no
 * such id) from `revision_not_owned_by_agent` (id exists but
 * belongs to another agent) as two separate error shapes. The
 * history reader correctly collapses both into a single
 * `revision_not_found` via owner-and-agent scoped lookup — that's
 * the enumeration-defense pattern (agent A can't probe pin_revision
 * with a leaked revision id from agent B to confirm its
 * existence). This handler now uses the same collapsed shape;
 * the SELECT filters on BOTH `id` AND `agentId` so a row owned
 * by another agent is indistinguishable from a missing row at
 * the handler's output surface.
 *
 * Rationale for agent scoping: pins compete for the deployment-
 * wide size cap (`nautilo_backup_total_size_cap_mb`). Letting
 * agent A pin agent B's revisions would let A prevent B's rows
 * from being GC'd, which isn't A's decision to make.
 *
 * Trust policy: `read_only` at the approval-dock layer. A pin
 * flag toggle doesn't touch disk and can't damage anything —
 * worst case the GC evicts a row the user wanted to keep
 * (unpin), or retains one past normal expiry (pin). No HIL gate
 * needed.
 */

import { log, warn } from "@nautilo/logger";
import type { FileCommandArgs } from "../schema";
import type { DispatchContext } from "../dispatch";
import { fileToolError } from "../file-result-status";
import {
  LEGACY_WORKSPACE_HISTORY_READ_ONLY,
  setCanonicalWorkspaceHistoryPinned,
} from "../workspace-history";

export async function handlePinRevision(
  args: FileCommandArgs<"pin_revision">,
  ctx: DispatchContext,
): Promise<string> {
  return setPinned(args.revisionId, true, ctx);
}

export async function handleUnpinRevision(
  args: FileCommandArgs<"unpin_revision">,
  ctx: DispatchContext,
): Promise<string> {
  return setPinned(args.revisionId, false, ctx);
}

async function setPinned(
  revisionId: string | undefined,
  desired: boolean,
  ctx: DispatchContext,
): Promise<string> {
  if (!ctx.agentId) {
    return fileToolError(`Error: ${desired ? "pin" : "unpin"}_revision requires an agent context (ctx.agentId missing; plumbing bug)`);
  }
  if (typeof revisionId !== "string" || revisionId.length === 0) {
    return fileToolError(`Error: ${desired ? "pin" : "unpin"}_revision requires 'revisionId' (string)`);
  }

  try {
    const result = await setCanonicalWorkspaceHistoryPinned({
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      revisionId,
      pinned: desired,
    });
    if (result.kind === "updated") {
      log(
        `[file:${desired ? "pin" : "unpin"}_revision] canonical group ` +
          `${revisionId} pinned=${desired}`,
      );
      return JSON.stringify({ ok: true, revisionId, pinned: desired });
    }
    if (result.kind === "legacy_read_only") {
      return fileToolError(JSON.stringify({
        error: LEGACY_WORKSPACE_HISTORY_READ_ONLY,
        revisionId,
        hint:
          "This stable legacy revision remains enumerable, but legacy history " +
          "is read-only after the canonical Workspace history cutover.",
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[file:${desired ? "pin" : "unpin"}_revision] canonical UPDATE failed for ${revisionId}: ${msg}`);
    return fileToolError(`Error: could not ${desired ? "pin" : "unpin"} revision ${revisionId}: ${msg}`);
  }

  log(
    `[file:${desired ? "pin" : "unpin"}_revision] ${revisionId} ` +
      `not found for owner ${ctx.ownerId} agent ${ctx.agentId}`,
  );
  return fileToolError(JSON.stringify({
    error: "revision_not_found",
    revisionId,
    hint:
      "No revision with that id. Use list_revisions to find a " +
      "valid id, or the row may have been GC'd.",
  }));
}
