import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

type PendingWindow = { key: string; command: string; cursor: string; args: Record<string, unknown> };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;

/** Paired successful file receipts remain in the canonical Task history across model windowing. */
export function unfinishedFileDiscovery(messages: readonly BaseMessage[]): string | null {
  const calls = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, PendingWindow>();
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id && call.name === "file") calls.set(call.id, call.args);
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== "file") continue;
    const args = calls.get(message.tool_call_id);
    calls.delete(message.tool_call_id);
    if (!args || typeof message.content !== "string") continue;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(message.content) as Record<string, unknown>; } catch { continue; }
    if (receipt === null || typeof receipt !== "object" || receipt["ok"] === false || receipt["error"]) continue;
    const command = receipt["command"];
    if (typeof command !== "string" || !["read", "grep", "glob", "list"].includes(command)) continue;
    if (!("nextCursor" in receipt)) continue; // Legacy unknown completeness is never invented here.
    const continuation = command === "read" ? args["readCursor"] : args["discoveryCursor"];
    const prior = typeof continuation === "string" ? pending.get(continuation) : undefined;
    const key = prior?.key ?? JSON.stringify(canonical(Object.fromEntries(Object.entries(args)
      .filter(([name]) => !["limit", "maxResults", "readCursor", "discoveryCursor"].includes(name)))));
    // A successful restart of the exact query replaces its stale result version.
    // Narrowing the path/query is a different obligation, never continuation.
    for (const [cursor, window] of pending) if (window.key === key) pending.delete(cursor);
    if (prior) pending.delete(prior.cursor);
    if (typeof receipt["nextCursor"] === "string") {
      const cursor = receipt["nextCursor"];
      // Retain the accepted request, including all filters and caller-selected
      // window sizes. Model context may have rotated since this page arrived;
      // asking the model to rediscover these exact bytes creates a guessing loop.
      const request = Object.fromEntries(Object.entries({ ...prior?.args, ...args })
        .filter(([name]) => name !== "readCursor" && name !== "discoveryCursor"));
      pending.set(cursor, { key, cursor, command, args: request });
    }
  }
  const next = pending.values().next().value;
  if (!next) return null;
  const continuationArgs = { ...next.args, [next.command === "read" ? "readCursor" : "discoveryCursor"]: next.cursor };
  return `${pending.size} file request(s) still have unread continuation pages. Finalization did not run. `
    + `Continue with this exact file call:\n${JSON.stringify(continuationArgs)}\n`
    + "Follow its returned nextCursor until exhausted, then retry finalization to identify any remaining request. "
    + "Do not guess another query or repeat completed research. A narrowed query does not retrieve this remainder.";
}
