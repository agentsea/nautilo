import { createHash } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";

export interface ComputeFingerprintOptions {
  /** Distinct human turns in the same session; omit for AI/tool. */
  humanTurnId?: string;
}

/**
 * M070 — stable, fixed-length fingerprint for `(session_id, fingerprint)`
 * dedup. We hash the composite string with sha256 because Postgres btree
 * limits index entries to ~2704 bytes, and raw tool output / long AI
 * replies routinely exceed that — causing the entire batch INSERT to
 * abort with `index row size N exceeds btree version 4 maximum 2704`,
 * losing every row in the batch (the unique-conflict path is irrelevant
 * once the size check fires).
 *
 * `fingerprint:v1:` prefix so a future encoding change can be detected
 * without touching the DB column.
 */
export function computeMessageFingerprint(
  msg: BaseMessage,
  opts: ComputeFingerprintOptions = {},
): string {
  const type = msg instanceof HumanMessage ? "human"
    : msg instanceof ToolMessage ? "tool"
    : AIMessage.isInstance(msg) ? "ai"
    : "unknown";

  let content = "";
  if (typeof msg.content === "string") content = msg.content;
  else if (Array.isArray(msg.content)) content = JSON.stringify(msg.content);
  else content = JSON.stringify(msg.content);
  const normalized = content.trim().replace(/\s+/g, " ");

  let toolCallsHash = "";
  if (AIMessage.isInstance(msg) && msg.tool_calls && msg.tool_calls.length > 0) {
    toolCallsHash = msg.tool_calls
      .map((tc: { id?: string; name?: string }) => tc.id || tc.name || "unknown")
      .join(",");
  }

  let raw = `${type}:${normalized}:${toolCallsHash}`;
  if (type === "human") {
    const replyKw = (msg as HumanMessage).additional_kwargs?.["nautilo_reply_to_message_id"];
    if (typeof replyKw === "number" && Number.isFinite(replyKw)) {
      raw = `${raw}:replyTo:${replyKw}`;
    }
  }
  if (type === "human" && opts.humanTurnId) {
    raw = `${raw}:${opts.humanTurnId}`;
  } else if (AIMessage.isInstance(msg) && typeof msg.id === "string" && msg.id.length > 0) {
    raw = `${raw}:msgid:${msg.id}`;
  } else if (msg instanceof ToolMessage) {
    // M070 follow-up: identical tool output across two invocations
    // (e.g. `list_memory` called twice in one turn, two checks of
    // the same file) must persist as two distinct rows. The LLM
    // assigns a unique `tool_call_id` to each invocation; ToolMessage
    // carries it. Without this qualifier, the partial unique index
    // collapses them via ON CONFLICT DO NOTHING and the second
    // invocation is silently lost.
    const tcid = (msg as ToolMessage).tool_call_id;
    if (typeof tcid === "string" && tcid.length > 0) {
      raw = `${raw}:tcid:${tcid}`;
    }
  }

  const digest = createHash("sha256").update(raw).digest("hex");
  return `fp:v1:${type}:${digest}`;
}
