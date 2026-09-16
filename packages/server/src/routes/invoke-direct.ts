/**
 * D087 Phase 3 §3.7 — direct-dispatch endpoint for user-initiated
 * history commands.
 *
 * Parallel to D090's `/api/file/apply-patch-direct`, but narrower:
 * this route dispatches ONE of the history commands
 * (`undo | undo_turn | redo | list_revisions | pin_revision |
 * unpin_revision`) without an LLM turn. Powers:
 *
 *   - `/undo` slash command in the composer
 *   - `⌘Z` / `⌘⇧Z` keybinds
 *   - Undo/Redo toolbar buttons
 *   - Context-menu "Undo last edit" on file-tree rows
 *
 * Why not re-use `apply-patch-direct`? That route is shaped for
 * apply_patch's `{patchId, accept}` payload specifically and emits
 * standard `file` / `{ command: "apply_patch", patchId, accept }`
 * tool-activity events for the review-state UI. Building a
 * generic router here keeps the history-command surfaces distinct
 * and allow-lists exactly the commands that are safe to fire
 * without an LLM prompt (writes / edits / deletes are NOT allowed —
 * those require the agent's intent context).
 *
 * Authn / authz: same as apply-patch-direct — relies on the route's
 * preHandlers (decorating `request.policyContext` +
 * `request.memoryEnvelope`) and then derives the ownerId / agentId
 * from the envelope + env fallback.
 *
 * Feature-flagged behind `NAUTILO_DIRECT_DISPATCH`. Off → 503, same
 * as apply-patch-direct.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  dispatchFileCommand,
  type DispatchContext,
  type ZoneContext,
} from "@nautilo/agent";
import { log, runWithTurn } from "@nautilo/logger";
import { fromRuntimeConfig } from "@nautilo/config";
import { validateClientPathSafe } from "../messaging/attachments";
import { broadcast } from "../realtime/ws-publisher";

/**
 * Allow-list of commands this route accepts. Narrower than the full
 * file-tool command set — only user-initiated history commands are
 * safe to dispatch without the LLM's intent context.
 *
 * Writes (`write`, `str_replace`, etc.) require the agent's
 * understanding of WHY a change is being proposed; a UI-driven
 * direct-invoke can't synthesize that reasoning, so they're
 * deliberately excluded. Apply_patch goes through its own
 * dedicated route (`/api/file/apply-patch-direct`).
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "undo",
  "undo_turn",
  "redo",
  "list_revisions",
  "pin_revision",
  "unpin_revision",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InvokeDirectRequest {
  command: string;
  args?: Record<string, unknown>;
  /** Optional explicit room; rejects if auth resolves to another room. */
  roomId?: string | undefined;
  /** Client's current workspace root, same validation as /api/chat. */
  workspacePath?: string | null;
  /** Client's current-folder, same validation as /api/chat. */
  currentFolder?: string | null;
}

export interface InvokeDirectResponse {
  /** Raw tool-result string. JSON envelopes / error strings land
   *  here verbatim so callers can parse + re-surface them to the
   *  user. */
  result: string;
  duration: number;
  toolCallId: string;
}

export function invokeDirectRoutes(app: FastifyInstance) {
  app.post<{ Body: InvokeDirectRequest }>(
    "/api/file/invoke-direct",
    async (request, reply) => {
      const cfg = fromRuntimeConfig();
      if (!cfg.nautilo_direct_dispatch) {
        return reply.code(503).send({
          error: "direct-dispatch disabled on this server",
        });
      }

      const body = request.body ?? ({} as InvokeDirectRequest);
      const command = typeof body.command === "string" ? body.command : "";
      if (!ALLOWED_COMMANDS.has(command)) {
        return reply.code(400).send({
          error:
            `command must be one of: ${[...ALLOWED_COMMANDS].join(", ")}. ` +
            `'${command}' is not allowed on this endpoint (writes + ` +
            `edits must go through the chat pipeline).`,
        });
      }

      const args =
        body.args && typeof body.args === "object" ? body.args : {};
      const requestedRoomId = typeof body.roomId === "string" ? body.roomId.trim() : "";
      if (body.roomId !== undefined && !UUID_RE.test(requestedRoomId)) {
        return reply.code(400).send({ error: "roomId must be a valid room id" });
      }

      // Auth context — mirrors apply-patch-direct.ts:110-128.
      //
      // PR-018 MAJOR #1 fix (seeded as H-034): `ownerId` MUST come
      // from the authenticated request envelope
      // (`request.memoryEnvelope.ownerId`) when available, NOT from
      // the bootstrap-state-cache (D120 A1.P1; pre-D120 this was
      // the now-retired NAUTILO_OWNER_ID env). The cache fallback
      // is grandfathered single-user local-dev shape that
      // `/api/chat` uses; when `NAUTILO_DIRECT_DISPATCH` flips on
      // in any multi-user or household deployment (imminent per
      // ship plan v3 §5.5 via `manage_*` capabilities), a POST to
      // this route from stranger actor A with a revision id
      // belonging to owner B must resolve to A's ownerId so the
      // downstream agent-scoped `findRevisionById(revId, agentId)`
      // lookup correctly returns null for cross-actor access.
      // Cache fallback remains as the last-resort for local-dev
      // shims.
      //
      // Original PR-79 shape read env-var only — direct regression
      // of PR-016 MINOR #2 that the sibling route apply-patch-direct
      // already fixed. See canonical comment block at
      // apply-patch-direct.ts:110-128.
      const ownerId =
        request.memoryEnvelope?.ownerId ??
        request.sessionUserId ??
        "";
      // M125 Phase 2.3: agentId is envelope-only. Pre-M125 a missing
      // envelope agentId silently borrowed the bootstrap default,
      // attributing direct dispatches to the operator's agent for
      // every non-operator caller. Fail closed with a grep-able code.
      const agentId = request.memoryEnvelope?.agentId ?? "";
      const roomId = request.memoryEnvelope?.roomId ?? "";
      if (requestedRoomId && roomId !== requestedRoomId) {
        return reply.code(404).send({ error: "Room not found or unavailable" });
      }

      if (!ownerId) {
        return reply.code(401).send({ error: "no owner identity resolved" });
      }
      if (!agentId) {
        return reply.code(401).send({
          error: "no_agent_in_context",
          code: "no_agent_in_context",
        });
      }

      // Path validation — same rules as /api/chat for
      // workspacePath + currentFolder.
      // D304 — workspacePath / currentFolder are advisory prompt context; a bad
      // or blocked value drops to null and never blocks the invocation.
      const workspaceRoot = validateClientPathSafe(body.workspacePath ?? null, "workspacePath");
      const currentFolder = validateClientPathSafe(body.currentFolder ?? null, "currentFolder");

      const zoneCtx: ZoneContext = {
        workspaceRoot: workspaceRoot ?? "",
        currentFolder: currentFolder ?? null,
      };

      const toolCallId = randomUUID();
      const turnId = randomUUID();

      // Emit tool-activity start so the UI sees the invoke card the
      // same way it sees chat-driven history calls. `toolName: "file"`
      // matches the LangChain DynamicStructuredTool's name from the
      // chat pipeline — the workbench's file-tool card renderer keys
      // on it to branch into DiffView / read-file / etc. sub-
      // renderers by inspecting `args.command`. If we used a
      // qualified name like `file.undo`, the renderer wouldn't match
      // and the card would show raw JSON instead of a DiffView.
      //
      // argsSummary carries the full {command, ...args} object as
      // JSON so the client can introspect it just like it would for
      // a chat-pipeline file tool call.
      broadcast({
        type: "tool.start",
        ...(request.policyContext?.laneKey ? { laneKey: request.policyContext.laneKey } : {}),
        toolCallId,
        toolName: "file",
        argsSummary: JSON.stringify({ command, ...args }).slice(0, 500),
      });

      const startedAt = Date.now();

      const dispatchCtx: DispatchContext = {
        zoneCtx,
        ownerId,
        turnId,
        ...(agentId ? { agentId } : {}),
        ...(roomId ? { roomId } : {}),
      };

      function stringifyFileDispatchResult(raw: string | { content?: unknown }): string {
        if (typeof raw === "string") return raw;
        return JSON.stringify({
          multimodalToolResult: true,
          content: raw.content,
        });
      }

      let result = "";
      let outcomeStatus: "success" | "error" = "success";
      try {
        result = await runWithTurn(turnId, async () => {
          const flatArgs = { command, ...args } as Parameters<
            typeof dispatchFileCommand
          >[0];
          return stringifyFileDispatchResult(await dispatchFileCommand(flatArgs, dispatchCtx));
        });
        if (result.startsWith("Error:")) outcomeStatus = "error";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = `Error: invoke-direct dispatch failed: ${msg}`;
        outcomeStatus = "error";
      }

      const duration = Date.now() - startedAt;

      // D087 Phase 3 §3.7 — pass the handler's result string through
      // so the workbench's tool-activity consumer can populate the
      // tool-call message's `result` field. DiffView + StagedPatch
      // renderers key off that field to render the reverse-diff
      // preview (for undo / undo_turn / redo) or the list-of-
      // revisions envelope (for list_revisions). Without this the
      // tool card shows "Done (Nms)" fallback and DiffView never
      // fires, which means the user doesn't see the staged restore
      // they need to Accept.
      broadcast({
        type: "tool.end",
        ...(request.policyContext?.laneKey ? { laneKey: request.policyContext.laneKey } : {}),
        toolCallId,
        toolName: "file",
        duration,
        status: outcomeStatus,
        result,
        ...(outcomeStatus === "error" ? { error: result } : {}),
      });

      log(
        `[invoke-direct] command=${command} outcome=${outcomeStatus} ` +
          `duration=${duration}ms toolCallId=${toolCallId}`,
      );

      const response: InvokeDirectResponse = {
        result,
        duration,
        toolCallId,
      };
      return reply.code(200).send(response);
    },
  );
}
