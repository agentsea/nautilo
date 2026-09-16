import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolContext } from "@nautilo/catalog";
import type { RoomParticipant } from "@nautilo/trust";
import {
  getOrCreateAgentTurnContextByKey,
  tryRecordAgentRedirectByKey,
  turnContextKey,
  type AgentRedirectRejectionReason,
  type AgentTurnContext,
} from "../runtime/turn-context";

/**
 * D421 Phase 6.4 — `skip` is the ONLY model-facing yield tool. With no
 * `target_handle` it is ordinary silence (D128). With `target_handle` it
 * records the existing immutable one-hop redirect request (D421 Phase 4)
 * and suppresses source output. There is no separate redirect tool; the
 * model reaches the same recorder through `skip`.
 */
export const SKIP_TOOL_DESCRIPTION =
  "Choose not to respond to this message. With no `target_handle`, this is ordinary silence — the conversation doesn't need your input, the message wasn't directed at you, it's human banter you shouldn't interrupt, or someone already handled it. With `target_handle` (the bare slug of one other agent in the room, without the leading `@`), record a one-hop hand-off to that peer instead of answering yourself; use this only when exactly one eligible peer is clearly the right responder and you are not the addressee. The server validates the target and performs the hand-off. Calling this tool ends your turn with no visible output.";

/**
 * D421 Phase 0 contract — `target_handle` ≤ 64 chars (handle column bound).
 * Kept as a named constant so the schema, tests, and any future canonical
 * agent-handle schema share one source of truth.
 */
export const MAX_REDIRECT_TARGET_HANDLE_LENGTH = 64;

/**
 * D421 Phase 0 contract — reject UUIDs. A handle is a room-agent roster
 * slug, never an actor/user id. Matches the canonical 8-4-4-4-12 hex shape.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * D421 Phase 0 contract — reject display-name-like input. Handles are
 * bare slugs (no internal whitespace); a string containing any internal
 * whitespace is treated as a display-name guess and rejected before any
 * turn-context state is touched.
 */
const DISPLAY_NAME_WHITESPACE_PATTERN = /\s/;

/**
 * D421 Phase 0 contract — bare exact handle only. Trims leading/trailing
 * whitespace, rejects empty-after-trim, `@`-prefixed forms, UUIDs, and any
 * display-name-like internal whitespace. Handles are case-sensitive slugs
 * (no lowercasing). The server remains authoritative for canonical
 * roster resolution; this is a tool-time prevalidation only.
 */
export function normalizeRedirectTargetHandle(
  raw: unknown,
): { ok: true; handle: string } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const handle = raw.trim();
  if (!handle) return { ok: false };
  if (handle.startsWith("@")) return { ok: false };
  if (UUID_PATTERN.test(handle)) return { ok: false };
  if (DISPLAY_NAME_WHITESPACE_PATTERN.test(handle)) return { ok: false };
  if (handle.length > MAX_REDIRECT_TARGET_HANDLE_LENGTH) return { ok: false };
  return { ok: true, handle };
}

/**
 * D421 Phase 6.4 — unified yield schema. `target_handle` optional: present
 * ⇒ record a one-hop redirect; absent ⇒ ordinary silence. The schema
 * enforces the target-handle length; `normalizeRedirectTargetHandle` enforces the
 * exact-handle shape rules (no `@` prefix, no UUID, no display-name
 * whitespace) that a plain `z.string()` cannot express, and is applied in
 * the tool `func` before any turn-context state is touched.
 */
export const skipToolSchema = z.object({
  target_handle: z
    .string()
    .min(1)
    .max(MAX_REDIRECT_TARGET_HANDLE_LENGTH)
    .optional()
    .describe(
      "Optional. Omit for ordinary silence. Set to the bare slug of one other agent in the room (without the leading `@`) to record a one-hop hand-off to that peer instead of answering yourself. The server resolves and validates the target.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional note explaining why you are skipping or redirecting. Tool-call arguments can be persisted in audit records and displayed to Humans, so do not put private or sensitive information here.",
    ),
});

export type SkipToolArgs = z.infer<typeof skipToolSchema>;

/** D128 — targetless skip result. */
export type SkipToolResult = {
  skipped: true;
  reason: string | null;
};

/**
 * D421 Phase 4 / 6.4 — structured redirect-record result. `recorded` is
 * true only when the request was accepted by the turn-context
 * compare-and-set; otherwise the `reason` code explains the controlled
 * rejection. The internal model `reason` is never echoed in the result.
 */
export type SkipRedirectResult = {
  recorded: boolean;
  target_handle?: string;
  reason?: AgentRedirectRejectionReason;
};

type SkipToolContext = ToolContext & {
  turnId?: string;
  turnContextId?: string;
  agentId?: string;
  turnContext?: AgentTurnContext;
  skipFlag?: boolean;
  roomRoster?: readonly RoomParticipant[];
};

/**
 * D421 Phase 4 — resolve the source agent's own handle from the tool
 * context's `agentId` + the already-supplied `roomRoster` snapshot, for
 * self-target prevalidation only. The server remains authoritative for
 * the final canonical check. Returns `undefined` when the source agent is
 * not found in the roster (no self-target prevalidation possible).
 */
export function resolveSourceHandle(
  context: SkipToolContext,
): string | undefined {
  const agentId = context.agentId;
  if (!agentId) return undefined;
  const roster = context.roomRoster;
  if (!roster || roster.length === 0) return undefined;
  const self = roster.find(
    (p) => p.kind === "agent" && p.agentId === agentId && p.handle,
  );
  return self?.handle ?? undefined;
}

function markTurnSkipped(context?: SkipToolContext): void {
  if (context?.turnContext) {
    context.turnContext.skipFlag = true;
    context.skipFlag = true;
  }
  const turnId = typeof context?.turnId === "string" ? context.turnId.trim() : "";
  if (turnId) {
    // D421 Phase 4.2 — set skipFlag on the per-agent slot keyed by
    // `turnContextKey(humanTurnId, sourceAgentId)` so two bots sharing one
    // human `turnId` cannot collide on the single skip slot.
    const explicitKey =
      typeof context?.turnContextId === "string"
        ? context.turnContextId.trim()
        : "";
    const agentId =
      typeof context?.agentId === "string" ? context.agentId.trim() : "";
    const key =
      explicitKey || (agentId ? turnContextKey(turnId, agentId) : turnId);
    const turnCtx = getOrCreateAgentTurnContextByKey(key);
    turnCtx.skipFlag = true;
    if (context?.turnContext && context.turnContext !== turnCtx) {
      context.turnContext.skipFlag = true;
    }
    if (context) context.skipFlag = true;
  }
}

/**
 * D421 Phase 4 / 6.4 — pure recorder. Validates the target handle shape,
 * resolves the source handle for self-target prevalidation, then
 * compare-and-sets one immutable request on the source turn context. No
 * DB, no roster query beyond the supplied snapshot, no
 * JobManager/runtime/server/focus imports, and no bus/event emission.
 * Returns a structured JSON result; never echoes the internal `reason`.
 * Reused unchanged by `skip({ target_handle })` so no new server path is
 * created.
 */
export function recordRedirectRequest(
  args: SkipToolArgs,
  context?: SkipToolContext,
): SkipRedirectResult {
  const normalized = normalizeRedirectTargetHandle(args.target_handle);
  if (!normalized.ok) {
    return { recorded: false, reason: "invalid_target" };
  }
  const turnId =
    typeof context?.turnId === "string" ? context.turnId.trim() : "";
  if (!turnId) {
    // Without a turn id there is no turn context to record on. Treat as an
    // invalid target shape so the model sees a controlled rejection rather
    // than a silent no-op.
    return { recorded: false, reason: "invalid_target" };
  }
  const sourceHandle = context ? resolveSourceHandle(context) : undefined;
  const candidate =
    typeof args.reason === "string"
      ? { targetHandle: normalized.handle, reason: args.reason }
      : { targetHandle: normalized.handle };
  // D421 Phase 4.2 — record on the per-agent slot keyed by
  // `turnContextKey(humanTurnId, sourceAgentId)` so two bots sharing one
  // human `turnId` cannot collide on the single redirect-request slot.
  const explicitKey =
    typeof context?.turnContextId === "string"
      ? context.turnContextId.trim()
      : "";
  const agentId =
    typeof context?.agentId === "string" ? context.agentId.trim() : "";
  const key = explicitKey || (agentId ? turnContextKey(turnId, agentId) : turnId);
  const record = tryRecordAgentRedirectByKey(
    key,
    candidate,
    { ...(sourceHandle ? { sourceHandle } : {}) },
  );
  if (record.ok) {
    return { recorded: true, target_handle: record.request.targetHandle };
  }
  return { recorded: false, reason: record.reason };
}

export function createSkipTool(context?: SkipToolContext): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "skip",
    description: SKIP_TOOL_DESCRIPTION,
    schema: skipToolSchema,
    func: (args: SkipToolArgs): Promise<string> => {
      if (args.target_handle !== undefined) {
        // D421 Phase 6.4 — target-bearing skip reuses the existing one-hop
        // redirect recorder. The recorder sets skipFlag on acceptance so
        // source output is suppressed; rejections leave turn state untouched.
        const result = recordRedirectRequest(args, context);
        return Promise.resolve(JSON.stringify(result));
      }
      markTurnSkipped(context);
      const result: SkipToolResult = {
        skipped: true,
        reason: args.reason ?? null,
      };
      return Promise.resolve(JSON.stringify(result));
    },
  });
}
