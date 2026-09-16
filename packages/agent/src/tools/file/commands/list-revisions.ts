/**
 * D087 Phase 3 §3.4 — `file.list_revisions` command handler.
 *
 * Read-only enumeration of the agent's edit history. Drives the
 * user-facing questions *"what did you change today?"*, *"what's in
 * my edit history?"*, *"list the last 5 edits to this file"*, and
 * also the `availableRevisions` look-up pattern when the LLM wants
 * to target a specific revisionId before proposing an undo.
 *
 * Input (wire):
 *   {
 *     command: "list_revisions",
 *     path?: string,             // absolute filter; optional
 *     revisionTurnId?: string,   // turn-scoped filter; optional
 *     since?: string,            // ISO-8601 lower bound on createdAt
 *     until?: string,            // ISO-8601 upper bound on createdAt
 *     limit?: number,            // default 20, max 200
 *     includePinnedOnly?: boolean
 *   }
 *
 * Return shape (JSON string):
 *   {
 *     revisions: RevisionSummary[],
 *     truncated: boolean,           // more rows existed past `limit`
 *   }
 *
 * Scoping (shared invariant with undo / undo_turn / redo /
 * pin_revision / unpin_revision):
 *   - All revision rows are filtered by `ctx.agentId`. Another
 *     agent's history is never visible through the `revisions` list.
 *
 * PR-018 MINOR #5 (H-033 enumeration-oracle symmetry): previously
 * this handler returned a `crossAgentCount` field — a count of
 * revisions on the filtered path owned by OTHER agents — as a
 * "transparency field." That field was a per-path existence oracle
 * (an agent could probe `crossAgentCount > 0` on a guessed path to
 * confirm ANOTHER agent has touched it). The sibling commands
 * `pin_revision` / `unpin_revision` close the same oracle at the
 * revisionId level (PR-018 MAJOR #2); keeping the path-level oracle
 * open here would leave the policy asymmetric.
 *
 * The `crossAgentCount` field is GONE. An agent that needs to
 * narrate "I can't see past activity" can simply do so from its
 * own (empty) revisions list; the sibling-agent existence question
 * is not answerable by any one agent and shouldn't be.
 *
 * Trust policy: `read_only`. Pure SELECT over `file_revisions`; no
 * disk, no staging, no side effects. Safe to call mid-turn without
 * any approval dock.
 */

import { log } from "@nautilo/logger";
import type { FileCommandArgs } from "../schema";
import type { DispatchContext } from "../dispatch";
import { fileToolError } from "../file-result-status";
import {
  listNormalizedWorkspaceHistory,
  type NormalizedWorkspaceHistoryRevision,
} from "../workspace-history";

/** Default row cap when the caller omits `limit`. Scales with token
 *  budget — at ~200 chars per summary, 20 rows fits comfortably in a
 *  tool-message without crowding prose. */
const DEFAULT_LIMIT = 20;

/** Hard ceiling regardless of caller `limit`. Prevents a single
 *  list_revisions call from dominating the tool-message token
 *  budget; beyond this, truncated=true signals "paginate by
 *  tightening the filters." */
const MAX_LIMIT = 200;

export type RevisionSummary = NormalizedWorkspaceHistoryRevision;

export interface ListRevisionsResult {
  readonly revisions: readonly RevisionSummary[];
  readonly truncated: boolean;
}

export async function handleListRevisions(
  args: FileCommandArgs<"list_revisions">,
  ctx: DispatchContext,
): Promise<string> {
  if (!ctx.agentId) {
    return fileToolError("Error: list_revisions requires an agent context (ctx.agentId missing; plumbing bug)");
  }

  // ---- Input validation -------------------------------------------

  // Canonical Workspace history uses logical artifact paths. An absolute path
  // remains accepted only for explicitly read-only legacy enumeration.
  let logicalPath: string | undefined;
  let legacyAbsolutePath: string | undefined;
  if (args.path !== undefined) {
    if (typeof args.path !== "string" || args.path.length === 0) {
      return fileToolError("Error: list_revisions 'path' filter must be a non-empty string");
    }
    const looksAbsolute = args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path);
    if (looksAbsolute) {
      legacyAbsolutePath = args.path;
    } else if (args.zone === "workspace") {
      logicalPath = args.path;
    } else {
      return fileToolError(
        "Error: list_revisions logical path filters require zone 'workspace' " +
        `(got: ${args.path.slice(0, 80)})`
      );
    }
  }

  // ISO-8601 sanity. Date.parse accepts bad strings silently; guard
  // with an explicit check so bad `since`/`until` surfaces instead
  // of silently filtering nothing.
  let sinceDate: Date | null = null;
  let untilDate: Date | null = null;
  if (args.since !== undefined) {
    const ms = Date.parse(args.since);
    if (Number.isNaN(ms)) {
      return fileToolError(`Error: list_revisions 'since' must be ISO-8601 (got: ${String(args.since).slice(0, 50)})`);
    }
    sinceDate = new Date(ms);
  }
  if (args.until !== undefined) {
    const ms = Date.parse(args.until);
    if (Number.isNaN(ms)) {
      return fileToolError(`Error: list_revisions 'until' must be ISO-8601 (got: ${String(args.until).slice(0, 50)})`);
    }
    untilDate = new Date(ms);
  }
  if (sinceDate && untilDate && sinceDate > untilDate) {
    return fileToolError("Error: list_revisions 'since' must be <= 'until'");
  }

  // Limit normalization + fetch-one-extra-for-truncation.
  const requestedLimit = typeof args.limit === "number" && args.limit > 0 ? args.limit : DEFAULT_LIMIT;
  const effectiveLimit = Math.min(requestedLimit, MAX_LIMIT);

  const result = await listNormalizedWorkspaceHistory({
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    ...(logicalPath ? { logicalPath } : {}),
    ...(legacyAbsolutePath ? { legacyAbsolutePath } : {}),
    ...(args.revisionTurnId ? { turnId: args.revisionTurnId } : {}),
    ...(sinceDate ? { since: sinceDate } : {}),
    ...(untilDate ? { until: untilDate } : {}),
    ...(args.includePinnedOnly === true ? { pinnedOnly: true } : {}),
    limit: effectiveLimit,
  });

  // PR-018 MINOR #5 — the previous handler computed + returned a
  // `crossAgentCount` field here. That was an existence oracle over
  // the filtered path ("another agent has N revisions on this file")
  // which is asymmetric with the pin/unpin enumeration-defense
  // (MAJOR #2 / H-033). The field has been removed; cross-agent
  // activity is no longer exposed through this surface.

  log(
    `[file:list_revisions] agent=${ctx.agentId} path=${args.path ?? "*"} ` +
      `turn=${args.revisionTurnId ?? "*"} returned=${result.revisions.length} ` +
      `truncated=${result.truncated}`,
  );

  return JSON.stringify(result satisfies ListRevisionsResult);
}
