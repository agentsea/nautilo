/**
 * Server-side display shaping for persisted session history (Option B).
 * Aligns REST `/api/sessions/latest` tool rows with the WebSocket one-liner
 * style (`⚙ name [running|success|error …]`) so Workbench and Electron restore
 * the same labels without re-parsing LangChain
 * tool-call queues client-side.
 */

import { projectSemanticComputerResult } from "@nautilo/agent";

export interface SessionMessageInput {
  id: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  /** Persisted tool name on `role = 'tool'` rows; optional for legacy. */
  toolName?: string | null;
  createdAt?: Date;
  /** D124 — quote-reply FK when set. */
  replyToMessageId?: number | null;
  /** D124 — human author (`sessions.owner_id`) for room-scoped fan-in. */
  sourceUserId?: string;
}

export type SessionMessageWithDisplay<M extends SessionMessageInput = SessionMessageInput> = M & {
  displayContent?: string;
};

interface ParsedToolCall {
  id?: string;
  name?: string;
}

/** Parses LangChain-style `tool_calls` JSON from an assistant row (same shape as workbench). */
export function parseAssistantToolCallsJson(raw: string | null | undefined): ParsedToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ParsedToolCall => Boolean(item) && typeof item === "object")
      .map((item) => ({
        ...(typeof (item as { id?: unknown }).id === "string"
          ? { id: (item as { id: string }).id }
          : {}),
        ...(typeof (item as { name?: unknown }).name === "string"
          ? { name: (item as { name: string }).name }
          : {}),
      }));
  } catch {
    return [];
  }
}

/** Best-effort success vs error for persisted tool message bodies (no WS metadata in DB). */
export function inferToolEndStatusFromContent(content: string): "success" | "error" {
  const t = content.trim();
  if (!t) return "success";
  if (/^error\b/i.test(t) || /^security:/i.test(t)) return "error";
  try {
    const j = JSON.parse(t) as { error?: unknown };
    if (j && typeof j === "object" && j.error != null) return "error";
  } catch {
    /* not JSON */
  }
  return "success";
}

/**
 * Walks messages in DB order, pairs each `tool` row with the next pending
 * assistant `tool_calls` entry (FIFO), and sets `displayContent` on tool rows
 * to a WS-style one-liner. Raw `content` is unchanged (FTS / ToolCard body).
 */
export function enrichSessionMessagesForDisplay<M extends SessionMessageInput>(
  messages: readonly M[],
): SessionMessageWithDisplay<M>[] {
  const pending: ParsedToolCall[] = [];

  return messages.map((m) => {
    const out = { ...m } as SessionMessageWithDisplay<M>;

    // Tool results cannot belong to an earlier Human turn. A cancelled or
    // interrupted turn may persist its assistant tool call without a matching
    // tool row; retaining that orphan across the next user message would
    // shift every later result onto the wrong invocation after cold boot.
    if (m.role === "user") {
      pending.length = 0;
    }

    if (m.role === "assistant") {
      pending.push(...parseAssistantToolCallsJson(m.toolCalls));
    }

    if (m.role === "tool") {
      // A protected-only row has no ordinary body from which status or a
      // semantic result can truthfully be inferred.
      if (m.content === null) return out;
      const call = pending.shift();
      const fromDb = typeof m.toolName === "string" ? m.toolName.trim() : "";
      const name = (fromDb.length > 0 ? fromDb : call?.name?.trim()) || "tool";
      const status = inferToolEndStatusFromContent(m.content);
      // The database intentionally retains Computer Use's scanned host result
      // for diagnostics. REST history must expose only the same strict compact
      // envelope as live tool events; Workbench never parses raw provider bytes.
      out.content = projectSemanticComputerResult(name, m.content);
      out.displayContent = `⚙ ${name} [${status}]`;
    }

    return out;
  });
}

/** Parses `⚙ <name> [<status>…]` from server `displayContent` (best-effort). */
export function toolDisplayNameFromDisplayContent(displayContent: string | null | undefined): string | undefined {
  if (!displayContent?.startsWith("⚙ ")) return undefined;
  const match = displayContent.match(/^⚙\s+(.+?)\s+\[(success|error)(?:\s+\d+ms)?\]/);
  const name = match?.[1]?.trim();
  return name || undefined;
}
