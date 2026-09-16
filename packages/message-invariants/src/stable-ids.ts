import type { ToolMessage } from "@langchain/core/messages";

/**
 * D143 Layer 1 — assign a stable, deterministic message ID to a
 * ToolMessage so LangGraph's messagesStateReducer can dedupe it on
 * tool_call_id (via its native id-based merge mechanism).
 *
 * The scheme is `"tm:" + tool_call_id`. Prefixed so ToolMessage IDs
 * are distinguishable from AIMessage IDs (`"ai:" + …`, future) and
 * HumanMessage IDs (`"hm:" + …`, future) in logs / debugger output
 * and to reserve namespace for further message-class stabilization.
 *
 * Mutates the passed message in place; returns void. Caller pattern
 * is `assignStableToolMessageId(msg)` immediately after construction.
 *
 * If the ToolMessage has no tool_call_id (defensive: should never
 * happen on a well-formed tool result), this is a no-op. We do NOT
 * fall back to a random ID — that would just resurface the bug
 * under a different shape.
 */
export function assignStableToolMessageId(msg: ToolMessage): void {
  if (!msg.tool_call_id) return;
  // BaseMessage's setter also persists the ID in constructor kwargs used by
  // checkpoint serialization. Direct property assignment disappears on load.
  msg._updateId(`tm:${msg.tool_call_id}`);
}

/**
 * Returns true if `id` follows the stable-ID scheme for a
 * ToolMessage tied to `tool_call_id`. Used by tests and by future
 * audit code (the repair script in Layer 6) that needs to detect
 * pre-fix legacy IDs vs. stabilized ones.
 */
export function isStableToolMessageId(id: string | undefined, tool_call_id: string): boolean {
  return id === `tm:${tool_call_id}`;
}
